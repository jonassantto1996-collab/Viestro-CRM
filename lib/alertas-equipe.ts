import 'server-only';
import {serviceClient} from './supabase/server';
import {ALERTA_MODELO, ordemDasContas, telefoneDoAtendente} from './alerta-atendente.mjs';
import {lerAgente} from './agente.mjs';
import {RELATORIO_MODELO, diaDeHoje, envioDoRelatorio, horaDoRelatorio} from './relatorio-diario.mjs';
import {CAMPOS_CONTA, enviarPelaConta, type Conta} from './wa-provedor';

// Mensagens da plataforma para o WhatsApp pessoal da equipe (alerta de passagem e relatório diário).
// Saem pelo número da empresa, com modelo UTILITY aprovado; sem modelo aprovado, nada é enviado.
// A Idempotency-Key é a mesma em todas as tentativas de um envio (por número): repetir não duplica.
// Nunca registram telefone nem conteúdo em log.
type Db = ReturnType<typeof serviceClient>;

async function enviarParaEquipe(db: Db, companyId: string, contaPreferida: string | null, telefone: string,
  modelo: {name: string; language: string}, payload: unknown, chave: string): Promise<{ok: boolean; code?: string}> {
  const {data} = await db.from('wa_accounts').select(CAMPOS_CONTA + ',connection_status').eq('company_id', companyId);
  const contas = (data || []) as unknown as (Conta & {connection_status: string})[];
  if (!contas.length) return {ok: false, code: 'sem_numero'};
  const aprovadas = async () => {
    const {data: t} = await db.from('wa_templates').select('account_id').in('account_id', contas.map(c => c.id))
      .eq('name', modelo.name).eq('language', modelo.language).eq('status', 'APPROVED');
    return new Set((t || []).map(x => x.account_id as string));
  };
  let ok = await aprovadas();
  if (!ok.size) {
    // Modelo ainda não aparece como aprovado no CRM: busca no fornecedor (no máximo a cada 60 s por número).
    try { const {syncTemplates} = await import('./whatsapp-worker'); await syncTemplates(companyId); ok = await aprovadas(); } catch {}
  }
  const ordem = ordemDasContas(contas, contaPreferida, ok);
  if (!ordem.length) return {ok: false, code: 'modelo_nao_aprovado'};
  let code = 'falhou';
  for (const id of ordem) {
    const conta = contas.find(c => c.id === id)!;
    const r = await enviarPelaConta(db, conta, 'template', payload, telefone, {chave: `${chave}-${conta.id}`.slice(0, 255)});
    if (r.ok) return {ok: true};
    code = r.code;
    console.error('[equipe] mensagem para a equipe não saiu por um número; tentando o próximo', {code: r.code});
  }
  return {ok: false, code};
}

/** Coloca o alerta do atendente na fila (sai agora ou na abertura da loja) e já tenta enviar se for a hora. */
export async function agendarAlerta(db: Db, conversationId: string, telefone: string, payload: unknown, quando: Date) {
  const {error} = await db.rpc('wa_alert_enqueue', {p_conversation: conversationId, p_phone: telefone, p_payload: payload, p_due: quando.toISOString()});
  if (error) { console.error('[equipe] alerta não agendado', {conversa: conversationId}); return false; }
  if (quando.getTime() <= Date.now() + 1000) await enviarAlertasPendentes();
  return true;
}

/** Envia os alertas vencidos (worker a cada minuto e logo depois de cada passagem). */
export async function enviarAlertasPendentes() {
  const db = serviceClient();
  const {data, error} = await db.rpc('wa_alert_claim', {p_limit: 10});
  if (error) throw error;
  let enviados = 0;
  for (const a of (data || []) as {id: string; lease_token: string; company_id: string; account_id: string | null; phone: string; payload: unknown}[]) {
    let r: {ok: boolean; code?: string};
    try { r = await enviarParaEquipe(db, a.company_id, a.account_id, a.phone, ALERTA_MODELO, a.payload, `viestro-alerta-${a.id}`); }
    catch { r = {ok: false, code: 'erro'}; }
    await db.rpc('wa_alert_result', {p_id: a.id, p_lease: a.lease_token, p_ok: r.ok, p_error: r.ok ? null : (r.code || 'erro').slice(0, 40)});
    if (r.ok) enviados++;
  }
  return {enviados};
}

/** Relatório diário no fechamento da loja, para o atendente escolhido em settings.agent.daily_report. */
export async function enviarRelatoriosDiarios(agora = new Date()) {
  const db = serviceClient();
  const {data: empresas, error} = await db.from('crm_companies').select('id,settings')
    .eq('settings->agent->>enabled', 'true').eq('settings->agent->>store_hours', 'true').neq('settings->agent->>daily_report', '');
  if (error) throw error;
  let enviados = 0;
  for (const e of empresas || []) {
    const agente = lerAgente(e.settings);
    if (!horaDoRelatorio(agente, agora)) continue;
    const telefone = telefoneDoAtendente(agente, agente.daily_report);
    if (!telefone) continue;
    const dia = diaDeHoje(agora);
    const {data: dados, error: errClaim} = await db.rpc('wa_daily_report_claim', {p_company: e.id, p_day: dia});
    if (errClaim || !dados) continue; // já enviado hoje (ou outra rodada está enviando)
    let r: {ok: boolean; code?: string};
    try { r = await enviarParaEquipe(db, e.id, null, telefone, RELATORIO_MODELO, envioDoRelatorio(agente.daily_report, dados), `viestro-relatorio-${e.id}-${dia}`); }
    catch { r = {ok: false, code: 'erro'}; }
    await db.rpc('wa_daily_report_result', {p_company: e.id, p_day: dia, p_ok: r.ok, p_error: r.ok ? null : (r.code || 'erro').slice(0, 40)});
    if (r.ok) enviados++;
    else console.error('[equipe] relatório diário não enviado', {empresa: e.id, code: r.code});
  }
  return {enviados};
}

/**
 * Remarketing: uma rodada por empresa com o remarketing ligado. O banco (wa_remarketing_run) decide tudo —
 * horário, limite diário distribuído ao longo do dia, modelo aprovado, número e quem recebe — e põe na fila;
 * o envio sai logo depois, no drainOutbox do worker. Sem conteúdo nem telefone no log.
 */
export async function rodarRemarketing(agora = new Date()) {
  const db = serviceClient();
  const {data: empresas, error} = await db.from('crm_companies').select('id').eq('settings->remarketing->>enabled', 'true');
  if (error) throw error;
  let naFila = 0;
  for (const e of empresas || []) {
    const {data, error: err} = await db.rpc('wa_remarketing_run', {p_company: e.id, p_now: agora.toISOString(), p_max: 4});
    if (err) { console.error('[remarketing] rodada adiada', {empresa: e.id, code: err.code}); continue; }
    const n = Number((data as any)?.queued || 0);
    if (n) console.log(`[remarketing] empresa=${e.id} na_fila=${n} cota=${(data as any)?.quota ?? '?'}`);
    naFila += n;
  }
  return {naFila};
}

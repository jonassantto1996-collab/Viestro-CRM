import 'server-only';
import {serviceClient} from './supabase/server';
import {graphBase} from './whatsapp.mjs';
import {chaveDoEnvio} from './wasapflow.mjs';
import {CAMPOS_CONTA, enviarPelaConta, modelosDaPonte, type Conta, type Resultado} from './wa-provedor';
import {algumaEmpresaNoAutomatico, runAgent} from './agente-runner';
import {transcreverPendentes} from './transcricao';

type OutboxJob = {id: string; lease_token: string; kind: string; payload: any; account_id: string; phone_number_id: string; to_wa_id: string};

/** Processa os eventos recebidos (o processamento acontece no banco). */
export async function drainEvents() {
  const db = serviceClient();
  const {data, error} = await db.rpc('wa_process_pending');
  if (error) throw error;
  return data;
}

/** Envia o que estiver na fila, pelo fornecedor de cada número. Nunca registra conteúdo nem token em log. */
export async function drainOutbox() {
  const db = serviceClient();
  const {data, error} = await db.rpc('wa_claim_outbox', {p_limit: 10});
  if (error) throw error;
  const jobs = (data || []) as OutboxJob[];
  if (!jobs.length) return {sent: 0, failed: 0};
  const {data: lista} = await db.from('wa_accounts').select(CAMPOS_CONTA).in('id', [...new Set(jobs.map(j => j.account_id))]);
  const contas = new Map(((lista || []) as Conta[]).map(c => [c.id, c]));
  const tokens = new Map<string, string | null>();
  let sent = 0;
  let failed = 0;
  for (const job of jobs) {
    const conta = contas.get(job.account_id);
    const result: Resultado = conta
      ? await enviarPelaConta(db, conta, job.kind, job.payload, job.to_wa_id, {chave: chaveDoEnvio(job.id), ref: job.id, tokens})
      : {ok: false, code: 'account_missing', retryable: false};
    const {error: e} = await db.rpc('wa_outbox_result', {
      p_id: job.id, p_lease: job.lease_token, p_ok: result.ok,
      p_wamid: result.ok ? result.wamid : null,
      p_error_code: result.ok ? null : result.code,
      p_retryable: result.ok ? false : result.retryable,
    });
    if (e) console.error('WhatsApp: falha ao registrar resultado do envio', {outbox: job.id});
    if (result.ok) sent++;
    else {
      failed++;
      console.error('WhatsApp: envio não concluído', {outbox: job.id, code: result.code});
    }
  }
  return {sent, failed};
}

/** Usado após webhooks e envios: falhas ficam na fila para a próxima rodada. */
export async function drainAll() {
  try { await drainEvents(); } catch { console.error('WhatsApp: eventos pendentes para a próxima rodada'); }
  try { await drainOutbox(); } catch { console.error('WhatsApp: envios pendentes para a próxima rodada'); }
}

/**
 * Depois de chegar mensagem de cliente: processa, espera o cliente terminar de digitar e deixa o
 * agente automático responder (se alguma empresa o ativou). Mensagens seguidas disparam várias
 * rodadas, mas o banco garante uma só resposta para a última mensagem.
 */
export async function drainAllWithAgent() {
  try { await drainEvents(); } catch { console.error('WhatsApp: eventos pendentes para a próxima rodada'); }
  const automatico = await algumaEmpresaNoAutomatico().catch(() => false);
  // Transcreve áudios enquanto espera o cliente terminar de mandar mensagens
  await Promise.all([
    transcreverPendentes().catch(() => console.error('[transcricao] rodada adiada')),
    automatico ? new Promise(r => setTimeout(r, 2_500)) : null,
  ]);
  if (automatico) {
    try { await runAgent(); } catch { console.error('[agente] rodada automática adiada'); }
  }
  try { await drainOutbox(); } catch { console.error('WhatsApp: envios pendentes para a próxima rodada'); }
}

const TPL_NAME = /^[a-z0-9_]{1,512}$/;
const TPL_LANG = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const TPL_CATEGORY = new Set(['MARKETING', 'UTILITY', 'AUTHENTICATION']);
const TPL_STATUS = new Set(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'ARCHIVED']);

type Modelo = {external_template_id: string | null; name: string; language: string; category: string; status: string; components: unknown[]};

// Modelos de um número na Meta (Graph API, com o token do número). null = leitura incompleta.
async function modelosDaMeta(db: ReturnType<typeof serviceClient>, conta: Conta): Promise<{lista: Modelo[]; completo: boolean} | null> {
  const base = graphBase(process.env.WHATSAPP_GRAPH_BASE);
  const t = await db.rpc('wa_account_token', {p_account: conta.id});
  const token = t.error ? null : (t.data as string | null);
  if (!token) return null;
  const lista: Modelo[] = [];
  let url: string | null = `${base}/${conta.waba_id}/message_templates?fields=id,name,status,category,language,components&limit=200`;
  let completo = true;
  for (let page = 0; url && page < 10; page++) {
    const res: Response = await fetch(url, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000), cache: 'no-store'});
    if (!res.ok) { completo = false; console.error('WhatsApp: templates indisponíveis', {status: res.status}); break; }
    const json = await res.json();
    for (const t of json?.data || []) {
      const m = {external_template_id: String(t?.id || '').slice(0, 100) || null, name: String(t?.name || ''), language: String(t?.language || ''),
        category: String(t?.category || '').toUpperCase(), status: String(t?.status || '').toUpperCase(), components: Array.isArray(t?.components) ? t.components : []};
      if (!TPL_NAME.test(m.name) || !TPL_LANG.test(m.language) || !TPL_CATEGORY.has(m.category) || !TPL_STATUS.has(m.status)) continue;
      if (JSON.stringify(m.components).length > 20000) continue;
      lista.push(m);
    }
    // Só segue a paginação dentro da própria API da Meta (o token vai junto)
    const next: string | undefined = json?.paging?.next;
    url = next && next.startsWith(base + '/') ? next : null;
    if (next && !url) completo = false;
  }
  return {lista, completo};
}

/** Atualiza wa_templates de um número (Meta ou WasapFlow, pelo fornecedor). Intervalo mínimo de 60 s, salvo `forcar`. */
export async function syncTemplatesDaConta(conta: Conta, forcar = false) {
  const db = serviceClient();
  if (!forcar) {
    const {data: last} = await db.from('wa_templates').select('last_synced_at')
      .eq('account_id', conta.id).order('last_synced_at', {ascending: false, nullsFirst: false}).limit(1).maybeSingle();
    if (last?.last_synced_at && Date.now() - new Date(last.last_synced_at).getTime() < 60_000) return 0;
  }
  const lido = conta.provider === 'wasapflow'
    ? await modelosDaPonte(db, conta).then(l => (l ? {lista: l as Modelo[], completo: true} : null))
    : await modelosDaMeta(db, conta);
  if (!lido) return 0;
  const agora = new Date().toISOString();
  const found = lido.lista.map(m => ({...m, company_id: conta.company_id, account_id: conta.id, last_synced_at: agora}));
  if (found.length) {
    const {error: e} = await db.from('wa_templates').upsert(found, {onConflict: 'account_id,name,language'});
    if (e) throw e;
  }
  if (lido.completo) {
    // Removidos no fornecedor deixam de aparecer para envio
    const keep = new Set(found.map(f => `${f.name}|${f.language}`));
    const {data: existing} = await db.from('wa_templates').select('id,name,language,status').eq('account_id', conta.id);
    const gone = (existing || []).filter(x => !keep.has(`${x.name}|${x.language}`) && x.status !== 'DELETED').map(x => x.id);
    if (gone.length) await db.from('wa_templates').update({status: 'DELETED', last_synced_at: agora}).in('id', gone);
  }
  return found.length;
}

/**
 * Traz os templates de cada número da empresa e atualiza wa_templates. A Meta não avisa por webhook
 * no EasyCoexistence; por isso a caixa de entrada pede a sincronização ao abrir. No WasapFlow o
 * evento template.status_updated também dispara a sincronização.
 */
export async function syncTemplates(companyId: string) {
  const db = serviceClient();
  const {data: accounts, error} = await db.from('wa_accounts').select(CAMPOS_CONTA)
    .eq('company_id', companyId).neq('connection_status', 'disconnected');
  if (error) throw error;
  let synced = 0;
  for (const acc of (accounts || []) as Conta[]) {
    // Um número com problema (ex.: chave do WasapFlow ausente) não impede os outros.
    try { synced += await syncTemplatesDaConta(acc); } catch { console.error('WhatsApp: modelos de um número adiados', {conta: acc.id}); }
  }
  return {synced};
}

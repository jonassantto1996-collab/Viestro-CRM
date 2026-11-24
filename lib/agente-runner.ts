import 'server-only';
import {serviceClient} from '@/lib/supabase/server';
import {lerAgente, respondeSozinho, MAX_RESPOSTAS_DIA} from '@/lib/agente.mjs';
import {sugerirResposta, resumirConversa} from '@/lib/agente-ia';
import {ALERTA_MODELO, envioDoAlerta, deveAvisar, ehAtendente, telefoneDoAtendente, finalDoNumero, clienteComFinal, ordemDasContas} from '@/lib/alerta-atendente.mjs';
import {buildSendBody, classifyGraphResponse, graphBase} from '@/lib/whatsapp.mjs';

// Modo automático do agente. Roda logo depois que uma mensagem do cliente chega (webhook)
// e também no executor da fila. Quem decide se pode enviar é o banco (wa_agent_send), que
// revalida tudo com a conversa travada: nunca responde duas vezes nem por cima da equipe.
const ESPERA_DIGITANDO_S = 2; // espera o cliente terminar de mandar mensagens seguidas
const IGNORAR = new Set(['revoke', 'edit', 'errors', 'reaction']);

export async function algumaEmpresaNoAutomatico() {
  const db = serviceClient();
  const {count} = await db.from('crm_companies').select('id', {count: 'exact', head: true})
    .eq('settings->agent->>enabled', 'true').eq('settings->agent->>mode', 'automatico');
  return (count || 0) > 0;
}

type Db = ReturnType<typeof serviceClient>;
async function lerConversa(db: Db, companyId: string, conversationId: string) {
  const [conv, msgs] = await Promise.all([
    db.from('wa_conversations').select('account_id,contact:wa_contacts(name,crm_lead_id,wa_id)').eq('id', conversationId).eq('company_id', companyId).single(),
    db.from('wa_messages').select('direction,message_type,body,transcript,provider_timestamp,created_at')
      .eq('company_id', companyId).eq('conversation_id', conversationId).order('created_at', {ascending: false}).limit(40),
  ]);
  const mensagens = (msgs.data || []).filter(m => !IGNORAR.has(m.message_type))
    .map(m => ({...m, at: m.provider_timestamp || m.created_at})).sort((x, y) => x.at.localeCompare(y.at));
  return {contato: (conv.data as any)?.contact?.name || '', leadId: ((conv.data as any)?.contact?.crm_lead_id || null) as string | null,
    waId: ((conv.data as any)?.contact?.wa_id || null) as string | null, accountId: ((conv.data as any)?.account_id || null) as string | null, companyId, mensagens};
}

// Alerta no WhatsApp do atendente. Só sai com o modelo aprovado pela Meta no número da empresa;
// sem modelo aprovado (ou sem telefone), não envia nada. Nunca registra telefone nem conteúdo em log.
async function avisarAtendente(db: Db, companyId: string, accountId: string | null, telefone: string, payload: ReturnType<typeof envioDoAlerta>) {
  const {data: contas} = await db.from('wa_accounts').select('id,phone_number_id,connection_status').eq('company_id', companyId);
  const ids = (contas || []).map(c => c.id);
  if (!ids.length) return false;
  const aprovadas = async () => {
    const {data} = await db.from('wa_templates').select('account_id').in('account_id', ids)
      .eq('name', ALERTA_MODELO.name).eq('language', ALERTA_MODELO.language).eq('status', 'APPROVED');
    return new Set((data || []).map(t => t.account_id as string));
  };
  let ok = await aprovadas();
  if (!ok.size) {
    // A Meta não avisa quando aprova um modelo: busca uma vez (no máximo a cada 60 s por número).
    try { const {syncTemplates} = await import('@/lib/whatsapp-worker'); await syncTemplates(companyId); ok = await aprovadas(); } catch {}
  }
  for (const id of ordemDasContas(contas || [], accountId, ok)) {
    const conta = (contas || []).find(c => c.id === id);
    const {data: token} = await db.rpc('wa_account_token', {p_account: id});
    if (!conta?.phone_number_id || !token) continue;
    try {
      const res = await fetch(`${graphBase(process.env.WHATSAPP_GRAPH_BASE)}/${conta.phone_number_id}/messages`, {
        method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(buildSendBody('template', payload, telefone)), signal: AbortSignal.timeout(15000), cache: 'no-store',
      });
      const r = classifyGraphResponse(res.status, await res.json().catch(() => null));
      if (r.ok) return true;
      console.error('[agente] alerta do atendente não enviado por um número; tentando o próximo', {code: 'code' in r ? r.code : undefined});
    } catch {
      console.error('[agente] alerta do atendente não enviado por um número; tentando o próximo', {code: 'rede'});
    }
  }
  return false;
}

// Lead quente: o agente passou para a equipe. O banco escolhe o atendente (alternado) e cria a tarefa;
// aqui só se escreve o resumo. Falha aqui nunca desfaz a passagem (a conversa já está Pendente).
async function passarParaAtendente(db: Db, empresa: string, agente: Record<string, any>, conversationId: string, motivo: string,
  conversa: Awaited<ReturnType<typeof lerConversa>>, quente = false) {
  try {
    const final = finalDoNumero(conversa.waId);
    // Primeira linha do resumo: o final do número, para achar o cliente no celular mesmo sem contato salvo.
    const resumo = (final ? `WhatsApp: final ${final}\n` : '') + await resumirConversa({empresa, contato: conversa.contato, motivo, mensagens: conversa.mensagens});
    // Tarefa aberta antes desta passagem: decide se o atendente é avisado de novo.
    const {data: antes} = await db.from('crm_records').select('data').eq('kind', 'tasks').eq('data->>source', 'agent_handoff')
      .eq('data->>conversationId', conversationId).eq('data->>done', 'false').limit(1).maybeSingle();
    const {data, error} = await db.rpc('wa_agent_assign', {p_conversation: conversationId, p_summary: resumo, p_hot: quente});
    if (error) throw error;
    const atendente = data as string | null;
    const telefone = telefoneDoAtendente(agente, atendente);
    if (telefone && deveAvisar({antes: antes ? {hot: (antes as any).data?.hot === true} : null, quente})) {
      await avisarAtendente(db, conversa.companyId, conversa.accountId, telefone, envioDoAlerta({atendente, cliente: clienteComFinal(conversa.contato, conversa.waId), motivo, quente}));
    }
    return atendente;
  } catch {
    console.error('[agente] lead passado sem atendente definido', {conversa: conversationId});
    return null;
  }
}

export async function runAgent() {
  if (!process.env.ANTHROPIC_API_KEY) return {respondidas: 0, equipe: 0};
  const db = serviceClient();
  const {data: candidatas, error} = await db.rpc('wa_agent_candidates', {p_quiet_seconds: ESPERA_DIGITANDO_S, p_limit: 10});
  if (error) throw error;
  const empresas = new Map<string, any>();
  let respondidas = 0, equipe = 0, movidos = 0, atribuidos = 0, qualificados = 0;
  for (const c of (candidatas || []) as {conversation_id: string; company_id: string; last_inbound_at: string}[]) {
    try {
      if (!empresas.has(c.company_id)) {
        const {data} = await db.from('crm_companies').select('name,niche,settings').eq('id', c.company_id).single();
        empresas.set(c.company_id, data);
      }
      const empresa = empresas.get(c.company_id);
      const agente = lerAgente(empresa?.settings);
      if (!empresa || !respondeSozinho(agente)) continue;

      // Limite diário por conversa: passa para a equipe em vez de continuar conversando
      const hoje = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Sao_Paulo'}).format(new Date());
      const {data: estado} = await db.from('wa_agent_state').select('day,replies_today').eq('conversation_id', c.conversation_id).maybeSingle();
      if (estado && estado.day === hoje && estado.replies_today >= MAX_RESPOSTAS_DIA) {
        const motivo = 'Limite diário de respostas automáticas';
        await db.rpc('wa_agent_pause', {p_conversation: c.conversation_id, p_reason: motivo});
        equipe++;
        if (await passarParaAtendente(db, empresa.name, agente, c.conversation_id, motivo, await lerConversa(db, c.company_id, c.conversation_id))) atribuidos++;
        continue;
      }

      const conversa = await lerConversa(db, c.company_id, c.conversation_id);
      const {mensagens, leadId} = conversa;
      // Atendente respondeu o alerta pelo WhatsApp: não é cliente, o agente não responde.
      if (ehAtendente(agente, conversa.waId)) {
        await db.rpc('wa_agent_pause', {p_conversation: c.conversation_id, p_reason: 'Conversa de atendente da equipe'});
        continue;
      }
      // Etapa atual do lead (se a conversa já está ligada a um lead), para o agente saber de onde avançar.
      const etapas: string[] = Array.isArray(empresa.settings?.stages) ? empresa.settings.stages : [];
      let etapaAtual: string | null = null;
      if (leadId && agente.funnel) {
        const {data: lead} = await db.from('crm_records').select('data').eq('id', leadId).eq('company_id', c.company_id).eq('kind', 'leads').maybeSingle();
        etapaAtual = (lead as any)?.data?.stage || null;
      }
      const sugestao = await sugerirResposta({
        empresa: empresa.name, nicho: empresa.niche, agente, contato: conversa.contato, mensagens, automatico: true,
        etapas, etapaAtual, criterios: Array.isArray(empresa.settings?.criteria) ? empresa.settings.criteria : [],
      });
      const motivo = sugestao.motivo_humano || (sugestao.precisa_humano ? 'Pediu atendimento da equipe' : null);
      const {data: enviada, error: e} = await db.rpc('wa_agent_send', {
        p_conversation: c.conversation_id, p_inbound_at: c.last_inbound_at, p_text: sugestao.resposta,
        p_handoff: sugestao.precisa_humano, p_reason: motivo,
        p_max_per_day: MAX_RESPOSTAS_DIA,
      });
      if (e) throw e;
      if (enviada) {
        respondidas++; if (sugestao.precisa_humano) equipe++;
        // O banco revalida: só avança, nunca Ganho/Perdido, só lead ligado à conversa.
        if (sugestao.etapa && sugestao.etapa !== etapaAtual) {
          const {data: movido} = await db.rpc('wa_agent_move_stage', {p_conversation: c.conversation_id, p_stage: sugestao.etapa});
          if (movido) movidos++;
        }
        // Qualificação automática: critérios comprovados e temperatura (o banco só marca, nunca desmarca).
        if (sugestao.criterios?.length || sugestao.temperatura) {
          const {data: qualificou} = await db.rpc('wa_agent_qualify', {p_conversation: c.conversation_id,
            p_criteria: sugestao.criterios || [], p_temperature: sugestao.temperatura || null});
          if (qualificou) qualificados++;
        }
        // Depois de mover no funil, para o resumo e a tarefa já saírem com a etapa nova.
        if (sugestao.precisa_humano) {
          conversa.mensagens.push({direction: 'outbound', message_type: 'text', body: sugestao.resposta, transcript: null,
            provider_timestamp: null, created_at: new Date().toISOString(), at: new Date().toISOString()});
          if (await passarParaAtendente(db, empresa.name, agente, c.conversation_id, motivo || '', conversa, sugestao.lead_quente || sugestao.temperatura === 'quente')) atribuidos++;
        }
      }
    } catch {
      // Sem conteúdo no log; a conversa fica para a equipe ver na caixa de entrada.
      console.error('[agente] resposta automática não enviada', {conversa: c.conversation_id});
    }
  }
  if (respondidas || equipe) console.log(`[agente] automatico respondidas=${respondidas} equipe=${equipe} funil=${movidos} atendente=${atribuidos} qualificados=${qualificados}`);
  return {respondidas, equipe};
}

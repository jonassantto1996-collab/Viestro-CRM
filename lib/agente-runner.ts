import 'server-only';
import {serviceClient} from '@/lib/supabase/server';
import {lerAgente, respondeSozinho, quandoAvisar, MAX_RESPOSTAS_DIA} from '@/lib/agente.mjs';
import {sugerirResposta, resumirConversa} from '@/lib/agente-ia';
import {envioDoAlerta, deveAvisar, ehAtendente, telefoneDoAtendente, finalDoNumero, clienteComFinal} from '@/lib/alerta-atendente.mjs';
import {agendarAlerta} from '@/lib/alertas-equipe';
import {fotosParaEnviar, fotosJaEnviadas} from '@/lib/fotos-agente.mjs';

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

// Lead quente: o agente passou para a equipe. O banco escolhe o atendente (alternado) e cria a tarefa;
// aqui só se escreve o resumo. Falha aqui nunca desfaz a passagem (a conversa já está Pendente).
// `soQuente`: lead ficou quente mas o cliente não pediu a equipe; o agente segue atendendo e o dono do
// número é avisado (com a loja aberta, na hora; fechada, na abertura). Se já havia passagem quente
// aberta, não faz nada (nem gasta outro resumo).
async function passarParaAtendente(db: Db, empresa: string, agente: Record<string, any>, conversationId: string, motivo: string,
  conversa: Awaited<ReturnType<typeof lerConversa>>, quente = false, soQuente = false) {
  try {
    // Tarefa aberta antes desta passagem: decide se o atendente é avisado de novo.
    const {data: antes} = await db.from('crm_records').select('data').eq('kind', 'tasks').eq('data->>source', 'agent_handoff')
      .eq('data->>conversationId', conversationId).eq('data->>done', 'false').limit(1).maybeSingle();
    if (soQuente && (antes as any)?.data?.hot === true) return null;
    const final = finalDoNumero(conversa.waId);
    // Primeira linha do resumo: o final do número, para achar o cliente no celular mesmo sem contato salvo.
    const resumo = (final ? `WhatsApp: final ${final}\n` : '') + await resumirConversa({empresa, contato: conversa.contato, motivo, mensagens: conversa.mensagens});
    const {data, error} = await db.rpc('wa_agent_assign', {p_conversation: conversationId, p_summary: resumo, p_hot: quente});
    if (error) throw error;
    const atendente = data as string | null;
    const telefone = telefoneDoAtendente(agente, atendente);
    if (telefone && deveAvisar({antes: antes ? {hot: (antes as any).data?.hot === true} : null, quente})) {
      await agendarAlerta(db, conversationId, telefone,
        envioDoAlerta({atendente, cliente: clienteComFinal(conversa.contato, conversa.waId), motivo, quente}), quandoAvisar(agente));
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
  let respondidas = 0, equipe = 0, movidos = 0, atribuidos = 0, qualificados = 0, fotosEnviadas = 0;
  for (const c of (candidatas || []) as {conversation_id: string; company_id: string; last_inbound_at: string}[]) {
    // Reserva a conversa para esta mensagem: se outra rodada já está pensando nela, pula (uma chamada à IA só).
    const {data: minha, error: errReserva} = await db.rpc('wa_agent_claim', {p_conversation: c.conversation_id, p_inbound_at: c.last_inbound_at});
    // Erro na reserva (ex.: migration ainda não aplicada): segue como antes, sem travar o agente.
    if (!errReserva && !minha) continue;
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
        // Fotos do catálogo logo depois do texto (o banco revalida: só link do catálogo, máx. 2, sem repetir).
        for (const foto of fotosParaEnviar(sugestao.fotos, agente, fotosJaEnviadas(mensagens))) {
          const {data: img} = await db.rpc('wa_agent_send_image', {p_conversation: c.conversation_id, p_inbound_at: c.last_inbound_at,
            p_url: foto.url, p_caption: foto.legenda});
          if (img) fotosEnviadas++;
        }
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
        const quente = Boolean(sugestao.lead_quente || sugestao.temperatura === 'quente');
        // Só empresas com horário da loja ligado (Regtech) passam o lead quente sem o cliente pedir a equipe.
        if (sugestao.precisa_humano || (quente && agente.store_hours)) {
          conversa.mensagens.push({direction: 'outbound', message_type: 'text', body: sugestao.resposta, transcript: null,
            provider_timestamp: null, created_at: new Date().toISOString(), at: new Date().toISOString()});
          // Lead quente sem pedido de equipe: o agente continua e o dono do número é avisado (até 2 min com a loja aberta).
          if (await passarParaAtendente(db, empresa.name, agente, c.conversation_id, motivo || (quente ? 'Lead quente: intenção de compra' : ''),
            conversa, quente, !sugestao.precisa_humano)) atribuidos++;
        }
      }
    } catch {
      // Sem conteúdo no log; a conversa fica para a equipe ver na caixa de entrada.
      console.error('[agente] resposta automática não enviada', {conversa: c.conversation_id});
      // Solta a reserva para a próxima rodada tentar de novo sem esperar.
      await db.rpc('wa_agent_release', {p_conversation: c.conversation_id, p_inbound_at: c.last_inbound_at}).then(() => null, () => null);
    }
  }
  if (respondidas || equipe) console.log(`[agente] automatico respondidas=${respondidas} equipe=${equipe} funil=${movidos} atendente=${atribuidos} qualificados=${qualificados} fotos=${fotosEnviadas}`);
  return {respondidas, equipe};
}

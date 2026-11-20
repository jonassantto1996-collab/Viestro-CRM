import 'server-only';
import {serviceClient} from '@/lib/supabase/server';
import {lerAgente, respondeSozinho, MAX_RESPOSTAS_DIA} from '@/lib/agente.mjs';
import {sugerirResposta} from '@/lib/agente-ia';

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

export async function runAgent() {
  if (!process.env.ANTHROPIC_API_KEY) return {respondidas: 0, equipe: 0};
  const db = serviceClient();
  const {data: candidatas, error} = await db.rpc('wa_agent_candidates', {p_quiet_seconds: ESPERA_DIGITANDO_S, p_limit: 10});
  if (error) throw error;
  const empresas = new Map<string, any>();
  let respondidas = 0, equipe = 0, movidos = 0;
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
        await db.rpc('wa_agent_pause', {p_conversation: c.conversation_id, p_reason: 'Limite diário de respostas automáticas'});
        equipe++;
        continue;
      }

      const [conv, msgs] = await Promise.all([
        db.from('wa_conversations').select('contact:wa_contacts(name,crm_lead_id)').eq('id', c.conversation_id).eq('company_id', c.company_id).single(),
        db.from('wa_messages').select('direction,message_type,body,transcript,provider_timestamp,created_at')
          .eq('company_id', c.company_id).eq('conversation_id', c.conversation_id).order('created_at', {ascending: false}).limit(40),
      ]);
      const mensagens = (msgs.data || []).filter(m => !IGNORAR.has(m.message_type))
        .map(m => ({...m, at: m.provider_timestamp || m.created_at})).sort((x, y) => x.at.localeCompare(y.at));
      // Etapa atual do lead (se a conversa já está ligada a um lead), para o agente saber de onde avançar.
      const etapas: string[] = Array.isArray(empresa.settings?.stages) ? empresa.settings.stages : [];
      const leadId = (conv.data as any)?.contact?.crm_lead_id as string | null;
      let etapaAtual: string | null = null;
      if (leadId && agente.funnel) {
        const {data: lead} = await db.from('crm_records').select('data').eq('id', leadId).eq('company_id', c.company_id).eq('kind', 'leads').maybeSingle();
        etapaAtual = (lead as any)?.data?.stage || null;
      }
      const sugestao = await sugerirResposta({
        empresa: empresa.name, nicho: empresa.niche, agente, contato: (conv.data as any)?.contact?.name || '', mensagens, automatico: true,
        etapas, etapaAtual,
      });
      const {data: enviada, error: e} = await db.rpc('wa_agent_send', {
        p_conversation: c.conversation_id, p_inbound_at: c.last_inbound_at, p_text: sugestao.resposta,
        p_handoff: sugestao.precisa_humano, p_reason: sugestao.motivo_humano || (sugestao.precisa_humano ? 'Pediu atendimento da equipe' : null),
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
      }
    } catch {
      // Sem conteúdo no log; a conversa fica para a equipe ver na caixa de entrada.
      console.error('[agente] resposta automática não enviada', {conversa: c.conversation_id});
    }
  }
  if (respondidas || equipe) console.log(`[agente] automatico respondidas=${respondidas} equipe=${equipe} funil=${movidos}`);
  return {respondidas, equipe};
}

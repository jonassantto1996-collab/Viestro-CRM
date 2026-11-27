import {after} from 'next/server';
import {sessionClient} from '@/lib/supabase/server';
import {reply, body, sameOrigin} from '@/lib/http';
import {drainOutbox, syncTemplates} from '@/lib/whatsapp-worker';
import {serviceClient} from '@/lib/supabase/server';
import {CAMPOS_CONTA, marcarLida, type Conta} from '@/lib/wa-provedor';
import {waMetrics} from '@/lib/whatsapp-metrics.mjs';
import {lerAgente} from '@/lib/agente.mjs';
import {sugerirResposta, ErroAgente} from '@/lib/agente-ia';

export const dynamic = 'force-dynamic';

// API da caixa de entrada do WhatsApp para o operador logado.
// Leituras usam a sessão do usuário (RLS por empresa); escritas passam pelas
// funções crm_wa_* do banco, que validam empresa, papel e regras da Meta.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

// Mensagens das funções do banco (raise exception) já são amigáveis; o resto vira genérico.
function dbError(error: {code?: string; message?: string}) {
  return reply({error: error.code === 'P0001' && error.message ? error.message : 'Não foi possível concluir a ação.'}, 400);
}

function queueSend() {
  if (!process.env.SUPABASE_SECRET_KEY) return;
  after(async () => { try { await drainOutbox(); } catch { console.error('WhatsApp: envio fica na fila'); } });
}

export async function GET(req: Request) {
  try {
    const db = await sessionClient();
    const {data: {user}} = await db.auth.getUser();
    if (!user) return reply({error: 'Faça login para continuar.'}, 401);
    const p = new URL(req.url).searchParams;
    const view = p.get('view') || 'conversations';

    if (view === 'messages') {
      const conversation = p.get('conversation');
      if (!isUuid(conversation)) return reply({error: 'Conversa inválida'}, 400);
      const {data, error} = await db.from('wa_messages')
        .select('id,direction,source,message_type,body,transcript,transcript_status,template_name,message_status,error_code,sent_by_user_id,provider_timestamp,sent_at,delivered_at,read_at,created_at')
        .eq('conversation_id', conversation).order('created_at', {ascending: false}).limit(500);
      if (error) throw error;
      const messages = (data || []).map(m => ({...m, at: m.provider_timestamp || m.created_at}))
        .sort((a, b) => a.at.localeCompare(b.at));
      return reply({messages});
    }

    if (view === 'metrics') {
      const days = [7, 30, 90].includes(Number(p.get('days'))) ? Number(p.get('days')) : 30;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const [convs, msgs] = await Promise.all([
        db.from('wa_conversations')
          .select('id,status,category,assigned_user_id,first_inbound_at,last_inbound_at,last_outbound_at,contact:wa_contacts(crm_lead_id)')
          .limit(5000),
        db.from('wa_messages').select('conversation_id,direction,source,provider_timestamp,created_at')
          .or(`provider_timestamp.gte.${since},and(provider_timestamp.is.null,created_at.gte.${since})`)
          .order('provider_timestamp', {ascending: true}).limit(20000),
      ]);
      if (convs.error) throw convs.error;
      if (msgs.error) throw msgs.error;
      const messages = (msgs.data || []).map(m => ({conversation_id: m.conversation_id, direction: m.direction, source: m.source, at: m.provider_timestamp || m.created_at}));
      return reply({metrics: waMetrics({conversations: convs.data || [], messages, days}), limited: (msgs.data || []).length === 20000});
    }

    if (view === 'summary') {
      const [{data, error}, passagens, numeros] = await Promise.all([
        db.from('wa_conversations').select('unread_count').gt('unread_count', 0).limit(1000),
        // Passagens do agente ainda abertas (alerta do atendente). RLS: só as da empresa de quem está logado.
        db.from('crm_records').select('id,data,created_at').eq('kind', 'tasks')
          .eq('data->>source', 'agent_handoff').eq('data->>done', 'false').order('created_at', {ascending: false}).limit(20),
        // Avisos dos números (pagamento, bloqueio, desconexão no fornecedor). RLS: só os da empresa.
        db.from('wa_accounts').select('id,phone_e164,display_name,provider_alert_code,provider_alert_at').not('provider_alert_code', 'is', null).limit(10),
      ]);
      if (error) throw error;
      const alerts = (passagens.data || []).map((r: any) => ({
        id: r.id as string, title: String(r.data?.title || ''), owner: String(r.data?.owner || 'Equipe'),
        hot: r.data?.hot === true, created: r.created_at as string,
      }));
      return reply({unread: (data || []).reduce((s, c) => s + (c.unread_count || 0), 0), alerts, accountAlerts: numeros.data || []});
    }

    if (view === 'remarketing') {
      // Painel do remarketing: números (função do banco, só a própria empresa) e envios dos últimos 30 dias (RLS).
      const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [resumo, envios] = await Promise.all([
        db.rpc('crm_remarketing_summary'),
        db.from('wa_remarketing_sends')
          .select('id,created_at,attempt,template_name,outcome,responded_at,lead:crm_records(nome:data->>name),account:wa_accounts(phone_e164,display_name),message:wa_messages(message_status,error_code)')
          .gte('created_at', desde).order('created_at', {ascending: false}).limit(2000),
      ]);
      if (resumo.error) throw resumo.error;
      if (envios.error) throw envios.error;
      return reply({resumo: resumo.data, envios: envios.data || []});
    }

    if (view === 'accounts') {
      // Números da empresa (RLS), para escolher o dono de cada número em Configurações.
      const {data, error} = await db.from('wa_accounts').select('id,phone_e164,display_name,provider,connection_status').order('created_at');
      if (error) throw error;
      return reply({accounts: data});
    }

    if (view === 'templates') {
      if (p.get('sync') === '1' && process.env.SUPABASE_SECRET_KEY) {
        const {data: member} = await db.from('crm_members').select('company_id').eq('user_id', user.id).maybeSingle();
        if (member?.company_id) {
          try { await syncTemplates(member.company_id); } catch { console.error('WhatsApp: sincronização de templates adiada'); }
        }
      }
      const {data, error} = await db.from('wa_templates')
        .select('id,account_id,name,language,category,status,components').neq('status', 'DELETED').order('name');
      if (error) throw error;
      return reply({templates: data});
    }

    let q = db.from('wa_conversations')
      .select('id,status,category,unread_count,assigned_user_id,ad_referral,last_message_at,last_message_preview,last_inbound_at,last_outbound_at,first_inbound_at,first_response_at,service_window_expires_at,contact:wa_contacts(id,name,phone_e164,crm_lead_id,marketing_opt_out_at),account:wa_accounts(id,phone_e164,display_name,connection_status,provider,provider_alert_code,provider_alert_at),agent:wa_agent_state(paused_until,paused_reason,handoff_at)')
      .order('last_message_at', {ascending: false, nullsFirst: false}).limit(300);
    const status = p.get('status');
    if (status && ['open', 'pending', 'resolved'].includes(status)) q = q.eq('status', status);
    if (p.get('assigned') === 'me') q = q.eq('assigned_user_id', user.id);
    if (p.get('assigned') === 'none') q = q.is('assigned_user_id', null);
    const {data, error} = await q;
    if (error) throw error;
    const conversations = (data || []).map(c => ({
      ...c,
      awaiting_reply: Boolean(c.last_inbound_at && (!c.last_outbound_at || c.last_inbound_at > c.last_outbound_at)),
      window_open: Boolean(c.service_window_expires_at && new Date(c.service_window_expires_at) > new Date()),
    }));
    queueSend();
    return reply({conversations});
  } catch {
    return reply({error: 'Não foi possível carregar o WhatsApp.'}, 500);
  }
}

export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return reply({error: 'Origem inválida'}, 403);
    const b = await body(req, 20000);
    const db = await sessionClient();
    const {data: {user}} = await db.auth.getUser();
    if (!user) return reply({error: 'Faça login para continuar.'}, 401);

    switch (b.action) {
      case 'send_text': {
        if (!isUuid(b.conversation) || typeof b.text !== 'string' || typeof b.key !== 'string') return reply({error: 'Dados inválidos'}, 400);
        const {data, error} = await db.rpc('crm_wa_send_text', {p_conversation: b.conversation, p_text: b.text, p_key: b.key});
        if (error) return dbError(error);
        queueSend();
        return reply({ok: true, id: data});
      }
      case 'send_template': {
        if (!isUuid(b.conversation) || !isUuid(b.template) || typeof b.key !== 'string') return reply({error: 'Dados inválidos'}, 400);
        const {data, error} = await db.rpc('crm_wa_send_template', {p_conversation: b.conversation, p_template: b.template, p_params: Array.isArray(b.params) ? b.params : [], p_key: b.key});
        if (error) return dbError(error);
        queueSend();
        return reply({ok: true, id: data});
      }
      case 'update': {
        if (!isUuid(b.conversation) || !b.patch || typeof b.patch !== 'object') return reply({error: 'Dados inválidos'}, 400);
        const {error} = await db.rpc('crm_wa_update_conversation', {p_conversation: b.conversation, p_patch: b.patch});
        return error ? dbError(error) : reply({ok: true});
      }
      case 'mark_read': {
        if (!isUuid(b.conversation)) return reply({error: 'Dados inválidos'}, 400);
        const {error} = await db.rpc('crm_wa_mark_read', {p_conversation: b.conversation});
        if (error) return dbError(error);
        // Número do WasapFlow: avisa o cliente que a mensagem foi lida (os dois tiques azuis).
        const {data: conv} = await db.from('wa_conversations').select('account:wa_accounts(provider)').eq('id', b.conversation).maybeSingle();
        if ((conv as any)?.account?.provider === 'wasapflow' && process.env.SUPABASE_SECRET_KEY) {
          const {data: ultima} = await db.from('wa_messages').select('external_message_id').eq('conversation_id', b.conversation)
            .eq('direction', 'inbound').eq('source', 'api_inbound').order('created_at', {ascending: false}).limit(1).maybeSingle();
          const conversa = b.conversation;
          if (ultima?.external_message_id) after(async () => {
            const sdb = serviceClient();
            const {data: c} = await sdb.from('wa_conversations').select('account_id').eq('id', conversa).single();
            const {data: conta} = await sdb.from('wa_accounts').select(CAMPOS_CONTA).eq('id', c?.account_id).single();
            if (conta) await marcarLida(sdb, conta as Conta, ultima.external_message_id!);
          });
        }
        return reply({ok: true});
      }
      case 'create_lead': {
        if (!isUuid(b.conversation)) return reply({error: 'Dados inválidos'}, 400);
        const {data, error} = await db.rpc('crm_wa_create_lead', {p_conversation: b.conversation});
        return error ? dbError(error) : reply({ok: true, lead: data});
      }
      case 'agent_toggle': {
        if (!isUuid(b.conversation) || typeof b.pause !== 'boolean') return reply({error: 'Dados inválidos'}, 400);
        const {error} = await db.rpc('crm_wa_agent_toggle', {p_conversation: b.conversation, p_pause: b.pause});
        if (error) return reply({error: 'Não foi possível alterar o agente nesta conversa.'}, 400);
        return reply({ok: true});
      }
      case 'suggest': {
        // Agente em modo sugestão: só lê (pela sessão, com RLS da empresa) e devolve um texto; quem envia é a pessoa.
        if (!isUuid(b.conversation)) return reply({error: 'Dados inválidos'}, 400);
        const {data: member} = await db.from('crm_members').select('company_id').eq('user_id', user.id).maybeSingle();
        if (!member?.company_id) return reply({error: 'Usuário sem empresa.'}, 403);
        const [co, conv, msgs] = await Promise.all([
          db.from('crm_companies').select('name,niche,settings').eq('id', member.company_id).single(),
          db.from('wa_conversations').select('id,contact:wa_contacts(name)').eq('id', b.conversation).maybeSingle(),
          db.from('wa_messages').select('direction,message_type,body,transcript,transcript_status,provider_timestamp,created_at')
            .eq('conversation_id', b.conversation).order('created_at', {ascending: false}).limit(40),
        ]);
        if (co.error || !co.data) return reply({error: 'Não foi possível carregar a empresa.'}, 400);
        if (!conv.data) return reply({error: 'Conversa não encontrada.'}, 404);
        const agente = lerAgente(co.data.settings);
        if (!agente.enabled) return reply({error: 'Ative o agente de atendimento em Configurações.'}, 400);
        const mensagens = (msgs.data || []).map(m => ({...m, at: m.provider_timestamp || m.created_at})).sort((x, y) => x.at.localeCompare(y.at));
        try {
          const contato = (conv.data as any).contact?.name || '';
          const sugestao = await sugerirResposta({empresa: co.data.name, nicho: co.data.niche, agente, contato, mensagens});
          return reply({ok: true, sugestao});
        } catch (e) {
          return reply({error: e instanceof ErroAgente ? e.message : 'Não foi possível sugerir agora.'}, 502);
        }
      }
      case 'consent': {
        if (!isUuid(b.contact)) return reply({error: 'Dados inválidos'}, 400);
        const {data, error} = await db.rpc('crm_wa_set_consent', {p_contact: b.contact, p_purpose: b.purpose, p_status: b.status, p_evidence: b.evidence ?? null});
        return error ? dbError(error) : reply({ok: true, id: data});
      }
      default:
        return reply({error: 'Ação inválida'}, 400);
    }
  } catch {
    return reply({error: 'Não foi possível concluir. Confira os dados e tente novamente.'}, 400);
  }
}

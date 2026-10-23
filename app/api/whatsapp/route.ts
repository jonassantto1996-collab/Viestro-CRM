import {after} from 'next/server';
import {sessionClient} from '@/lib/supabase/server';
import {reply, body, sameOrigin} from '@/lib/http';
import {drainOutbox} from '@/lib/whatsapp-worker';

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
        .select('id,direction,source,message_type,body,template_name,message_status,error_code,sent_by_user_id,provider_timestamp,sent_at,delivered_at,read_at,created_at')
        .eq('conversation_id', conversation).order('created_at', {ascending: false}).limit(500);
      if (error) throw error;
      const messages = (data || []).map(m => ({...m, at: m.provider_timestamp || m.created_at}))
        .sort((a, b) => a.at.localeCompare(b.at));
      return reply({messages});
    }

    if (view === 'templates') {
      const {data, error} = await db.from('wa_templates')
        .select('id,account_id,name,language,category,status,components').eq('status', 'APPROVED').order('name');
      if (error) throw error;
      return reply({templates: data});
    }

    let q = db.from('wa_conversations')
      .select('id,status,category,unread_count,assigned_user_id,last_message_at,last_message_preview,last_inbound_at,last_outbound_at,first_inbound_at,first_response_at,service_window_expires_at,contact:wa_contacts(id,name,phone_e164,crm_lead_id,marketing_opt_out_at),account:wa_accounts(id,phone_e164,display_name,connection_status)')
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
        return error ? dbError(error) : reply({ok: true});
      }
      case 'create_lead': {
        if (!isUuid(b.conversation)) return reply({error: 'Dados inválidos'}, 400);
        const {data, error} = await db.rpc('crm_wa_create_lead', {p_conversation: b.conversation});
        return error ? dbError(error) : reply({ok: true, lead: data});
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

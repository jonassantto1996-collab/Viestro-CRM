import {sessionClient} from '@/lib/supabase/server';
import {reply, body, sameOrigin} from '@/lib/http';

export const dynamic = 'force-dynamic';

// Financeiro da empresa do usuário logado. Leitura protegida por RLS (só administradores
// da própria empresa); escrita apenas pelas funções crm_finance_*, que validam tudo no banco.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id,kind,occurred_on,description,category,client_name,lead_id,amount_cents,method,status,paid_on,notes,created_at,updated_at';

function dbError(error: {code?: string; message?: string}) {
  return reply({error: error.code === 'P0001' && error.message ? error.message : 'Não foi possível concluir a ação.'}, 400);
}

async function adminOnly(db: Awaited<ReturnType<typeof sessionClient>>) {
  const {data: {user}} = await db.auth.getUser();
  if (!user) return reply({error: 'Faça login para continuar.'}, 401);
  const {data: member} = await db.from('crm_members').select('role').eq('user_id', user.id).maybeSingle();
  if (member?.role !== 'admin') return reply({error: 'Somente administradores acessam o financeiro.'}, 403);
  return null;
}

export async function GET(req: Request) {
  try {
    const db = await sessionClient();
    const denied = await adminOnly(db);
    if (denied) return denied;
    const p = new URL(req.url).searchParams;
    const from = p.get('from') || '';
    const to = p.get('to') || '';
    if (!DAY.test(from) || !DAY.test(to) || from > to) return reply({error: 'Período inválido'}, 400);
    const {data, error} = await db.from('crm_finance_entries').select(COLUMNS)
      .gte('occurred_on', from).lte('occurred_on', to)
      .order('occurred_on', {ascending: false}).order('created_at', {ascending: false}).limit(5000);
    if (error) throw error;
    return reply({entries: data || []});
  } catch {
    return reply({error: 'Não foi possível carregar o financeiro.'}, 500);
  }
}

export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return reply({error: 'Origem inválida'}, 403);
    const b = await body(req, 10000);
    const db = await sessionClient();
    const denied = await adminOnly(db);
    if (denied) return denied;
    if (b.action === 'save') {
      if (!b.entry || typeof b.entry !== 'object' || Array.isArray(b.entry)) return reply({error: 'Dados inválidos'}, 400);
      const {data, error} = await db.rpc('crm_finance_save', {p: b.entry});
      return error ? dbError(error) : reply({ok: true, id: data});
    }
    if (b.action === 'delete') {
      if (typeof b.id !== 'string' || !UUID.test(b.id)) return reply({error: 'Lançamento inválido'}, 400);
      const {error} = await db.rpc('crm_finance_delete', {p_id: b.id});
      return error ? dbError(error) : reply({ok: true});
    }
    return reply({error: 'Ação inválida'}, 400);
  } catch {
    return reply({error: 'Não foi possível concluir. Confira os dados e tente novamente.'}, 400);
  }
}

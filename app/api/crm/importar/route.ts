import {sessionClient} from '@/lib/supabase/server';
import {reply, body, sameOrigin} from '@/lib/http';
export const dynamic = 'force-dynamic';

// Importação de leads em lote (planilha). Validação de verdade e permissão de admin ficam no banco (crm_import_leads).
export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return reply({error: 'Origem inválida'}, 403);
    const b = await body(req, 400000), db = await sessionClient();
    const {data: {user}} = await db.auth.getUser();
    if (!user) return reply({error: 'Faça login para continuar.'}, 401);
    if (!Array.isArray(b.rows) || b.rows.length < 1 || b.rows.length > 500) return reply({error: 'Envie de 1 a 500 linhas por vez.'}, 400);
    const {data, error} = await db.rpc('crm_import_leads', {p_rows: b.rows});
    if (error) return reply({error: error.message}, 400);
    return reply({ok: true, inserted: data?.inserted ?? 0, skipped: data?.skipped ?? 0});
  } catch {
    return reply({error: 'Não foi possível importar. Confira o arquivo e tente novamente.'}, 400);
  }
}

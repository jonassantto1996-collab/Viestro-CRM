import {sessionClient} from '@/lib/supabase/server';
import {reply} from '@/lib/http';
import {chaveConector} from '@/lib/mcp-chave.mjs';

export const dynamic = 'force-dynamic';

// Entrega o endereço do conector do Claude só para o administrador logado da empresa.
export async function GET(req: Request) {
  try {
    const db = await sessionClient();
    const {data: {user}} = await db.auth.getUser();
    if (!user) return reply({error: 'Faça login para continuar.'}, 401);
    const {data: member, error} = await db.from('crm_members').select('company_id,role').eq('user_id', user.id).single();
    if (error || !member) return reply({error: 'Usuário sem empresa.'}, 403);
    if (member.role !== 'admin') return reply({error: 'Só administradores podem ver o endereço do conector.'}, 403);
    const segredo = process.env.SUPABASE_SECRET_KEY;
    if (!segredo || process.env.CRM_MCP_DESLIGADO === '1') return reply({error: 'Conector desativado no servidor.'}, 503);
    const origem = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    return reply({url: `${origem}/api/mcp/${chaveConector(segredo, member.company_id, process.env.CRM_MCP_ROTACAO || '')}`});
  } catch {
    return reply({error: 'Não foi possível gerar o endereço agora.'}, 500);
  }
}

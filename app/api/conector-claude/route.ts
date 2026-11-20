import {serviceClient, sessionClient} from '@/lib/supabase/server';
import {reply} from '@/lib/http';
import {chaveConector} from '@/lib/mcp-chave.mjs';
import {ehDono} from '@/lib/dono.mjs';

export const dynamic = 'force-dynamic';

// Entrega os endereços do conector do Claude SÓ para o dono da plataforma (CRM_DONO_EMAILS),
// um por empresa. Clientes (mesmo administradores da empresa deles) recebem 403.
export async function GET(req: Request) {
  try {
    const db = await sessionClient();
    const {data: {user}} = await db.auth.getUser();
    if (!user) return reply({error: 'Faça login para continuar.'}, 401);
    if (!ehDono(user.email, process.env.CRM_DONO_EMAILS)) return reply({error: 'Disponível só para a Viestro.'}, 403);
    const segredo = process.env.SUPABASE_SECRET_KEY;
    if (!segredo || process.env.CRM_MCP_DESLIGADO === '1') return reply({error: 'Conector desativado no servidor.'}, 503);
    const {data: empresas, error} = await serviceClient().from('crm_companies').select('id,name').order('name');
    if (error) throw error;
    const origem = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
    const rotacao = process.env.CRM_MCP_ROTACAO || '';
    return reply({conectores: (empresas || []).map(e => ({empresa: e.name, url: `${origem}/api/mcp/${chaveConector(segredo, e.id, rotacao)}`}))});
  } catch {
    return reply({error: 'Não foi possível gerar os endereços agora.'}, 500);
  }
}

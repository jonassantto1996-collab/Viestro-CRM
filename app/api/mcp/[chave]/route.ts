import {NextResponse} from 'next/server';
import {serviceClient} from '@/lib/supabase/server';
import {body} from '@/lib/http';
import {conferirChave} from '@/lib/mcp-chave.mjs';
import {responderCorpo} from '@/lib/mcp-protocolo.mjs';
import {criarFerramentas, INSTRUCOES_MCP} from '@/lib/mcp-ferramentas';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Conector do Claude (MCP, HTTP sem estado). O endereço carrega uma chave secreta por empresa;
// sem ela a rota responde 404, como se não existisse. Só consultas: nenhuma escrita no banco.
const cabecalhos = {'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'};
const naoEncontrado = () => new NextResponse(null, {status: 404, headers: cabecalhos});

async function empresaDoEndereco(chave: string) {
  if (process.env.CRM_MCP_DESLIGADO === '1') return null;
  return conferirChave(process.env.SUPABASE_SECRET_KEY || '', chave, process.env.CRM_MCP_ROTACAO || '');
}

export async function POST(req: Request, {params}: {params: Promise<{chave: string}>}) {
  const empresaId = await empresaDoEndereco((await params).chave);
  if (!empresaId) return naoEncontrado();
  let corpo: unknown;
  try { corpo = await body(req, 100_000); } catch {
    return NextResponse.json({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'JSON inválido'}}, {status: 400, headers: cabecalhos});
  }
  const db = serviceClient();
  const resposta = await responderCorpo(corpo, {
    ferramentas: criarFerramentas(db, empresaId),
    servidor: {name: 'viestro-crm', title: 'Viestro CRM', version: '1.0.0'},
    instrucoes: INSTRUCOES_MCP,
    // Registro sem conteúdo nem dados de clientes: só qual ferramenta e se deu certo.
    registrar: (nome: string, ok: boolean) => console.log(`[mcp] ferramenta=${nome} ok=${ok}`),
  });
  if (resposta === null) return new NextResponse(null, {status: 202, headers: cabecalhos});
  return NextResponse.json(resposta, {headers: cabecalhos});
}

// Sem fluxo de eventos (SSE): o protocolo permite responder só por POST.
export async function GET(_req: Request, {params}: {params: Promise<{chave: string}>}) {
  if (!(await empresaDoEndereco((await params).chave))) return naoEncontrado();
  return new NextResponse(null, {status: 405, headers: {...cabecalhos, Allow: 'POST'}});
}
export async function DELETE(_req: Request, {params}: {params: Promise<{chave: string}>}) {
  if (!(await empresaDoEndereco((await params).chave))) return naoEncontrado();
  return new NextResponse(null, {status: 405, headers: {...cabecalhos, Allow: 'POST'}});
}

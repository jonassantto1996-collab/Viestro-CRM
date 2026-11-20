import {serviceClient, sessionClient} from '@/lib/supabase/server';
import {body, reply, sameOrigin} from '@/lib/http';
import {ehDono} from '@/lib/dono.mjs';
import {lerAgente} from '@/lib/agente.mjs';
import {conversaSimulada} from '@/lib/simulador.mjs';
import {ErroAgente, sugerirResposta} from '@/lib/agente-ia';

export const dynamic = 'force-dynamic';

// Simulador do agente: SÓ o dono da plataforma. Usa a configuração salva da empresa escolhida
// e devolve o que o agente responderia. Não envia mensagem, não grava nada, não mexe no funil.
async function dono() {
  const db = await sessionClient();
  const {data: {user}} = await db.auth.getUser();
  if (!user) return reply({error: 'Faça login para continuar.'}, 401);
  if (!ehDono(user.email, process.env.CRM_DONO_EMAILS)) return reply({error: 'Disponível só para a Viestro.'}, 403);
  return null;
}

export async function GET() {
  try {
    const negado = await dono();
    if (negado) return negado;
    const {data, error} = await serviceClient().from('crm_companies').select('id,name,settings').order('name');
    if (error) throw error;
    return reply({empresas: (data || []).map(e => {
      const a = lerAgente(e.settings);
      return {id: e.id, nome: e.name, temBase: a.knowledge.trim().length >= 30, ligado: a.enabled, modo: a.mode,
        etapas: Array.isArray(e.settings?.stages) ? e.settings.stages.filter((x: unknown) => typeof x === 'string') : []};
    })});
  } catch {
    return reply({error: 'Não foi possível carregar as empresas.'}, 500);
  }
}

export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return reply({error: 'Origem inválida.'}, 403);
    const negado = await dono();
    if (negado) return negado;
    const b = await body(req, 60_000);
    const mensagens = conversaSimulada(b?.mensagens);
    if (!mensagens) return reply({error: 'Escreva a mensagem do cliente (até 30 mensagens, 1.500 letras cada).'}, 400);
    if (typeof b?.empresa !== 'string') return reply({error: 'Escolha a empresa.'}, 400);
    const {data: empresa, error} = await serviceClient().from('crm_companies').select('name,niche,settings').eq('id', b.empresa).maybeSingle();
    if (error) throw error;
    if (!empresa) return reply({error: 'Empresa não encontrada.'}, 404);
    const etapas: string[] = Array.isArray(empresa.settings?.stages) ? empresa.settings.stages : [];
    const etapaAtual = typeof b.etapa === 'string' && etapas.includes(b.etapa) ? b.etapa : null;
    const sugestao = await sugerirResposta({
      empresa: empresa.name, nicho: empresa.niche, agente: lerAgente(empresa.settings), contato: 'Cliente (teste)',
      mensagens, automatico: true, etapas, etapaAtual,
    });
    return reply({sugestao});
  } catch (e) {
    if (e instanceof ErroAgente) return reply({error: e.message}, 502);
    return reply({error: 'Não foi possível simular agora.'}, 500);
  }
}

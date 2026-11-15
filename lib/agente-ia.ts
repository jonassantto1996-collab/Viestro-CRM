import 'server-only';
import {FERRAMENTA, lerSugestao, montarPedido} from '@/lib/agente.mjs';

// Chamada ao Claude para o agente de atendimento. Chave só no servidor (ANTHROPIC_API_KEY na Vercel).
// Modelo barato por padrão; CRM_AGENTE_MODELO troca sem mexer no código.
export class ErroAgente extends Error {}

type Entrada = {empresa: string; nicho: string; agente: Record<string, unknown>; contato: string; mensagens: {direction: string; message_type: string; body: string | null; at: string}[]};

export async function sugerirResposta(entrada: Entrada) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) throw new ErroAgente('Falta configurar a chave da IA (ANTHROPIC_API_KEY) na Vercel.');
  const {sistema, usuario} = montarPedido(entrada);
  const modelo = process.env.CRM_AGENTE_MODELO || 'claude-haiku-5-5';
  const r = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01'},
    body: JSON.stringify({
      model: modelo,
      max_tokens: 700,
      system: [{type: 'text', text: sistema, cache_control: {type: 'ephemeral'}}],
      tools: [FERRAMENTA],
      tool_choice: {type: 'tool', name: FERRAMENTA.name},
      messages: [{role: 'user', content: usuario}],
    }),
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);
  if (!r) throw new ErroAgente('A IA não respondeu agora. Tente de novo.');
  const d: any = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = String(d?.error?.message || '');
    if (/credit balance/i.test(msg)) throw new ErroAgente('Acabaram os créditos da IA. Recarregue no Claude Console.');
    if (r.status === 401) throw new ErroAgente('A chave da IA está inválida. Confira na Vercel.');
    if (r.status === 429) throw new ErroAgente('Muitos pedidos seguidos. Espere alguns segundos.');
    throw new ErroAgente('A IA não respondeu agora. Tente de novo.');
  }
  const bloco = (d?.content || []).find((b: any) => b.type === 'tool_use' && b.name === FERRAMENTA.name);
  const sugestao = lerSugestao(bloco?.input);
  // Registro sem conteúdo: só modelo e consumo, para acompanhar custo.
  console.log(`[agente] sugestao modelo=${modelo} ok=${!!sugestao} entrada=${d?.usage?.input_tokens ?? '?'} cache=${d?.usage?.cache_read_input_tokens ?? 0} saida=${d?.usage?.output_tokens ?? '?'}`);
  if (!sugestao) throw new ErroAgente('A IA não conseguiu sugerir uma resposta para esta conversa.');
  return sugestao;
}

import 'server-only';
import {ferramentaPara, etapasDoAgente, lerSugestao, montarPedido, FERRAMENTA_RESUMO, pedidoResumo, lerResumo, resumoReserva, chamadaDoAgente, modeloDoAgente} from '@/lib/agente.mjs';

// Chamada ao Claude para o agente de atendimento. Chave só no servidor (ANTHROPIC_API_KEY na Vercel).
// Modelo barato por padrão; CRM_AGENTE_MODELO troca sem mexer no código.
export class ErroAgente extends Error {}

type Entrada = {empresa: string; nicho: string; agente: Record<string, unknown>; contato: string; mensagens: {direction: string; message_type: string; body: string | null; transcript?: string | null; at: string}[]; automatico?: boolean; etapas?: string[]; etapaAtual?: string | null; modelo?: string};

export async function sugerirResposta(entrada: Entrada) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) throw new ErroAgente('Falta configurar a chave da IA (ANTHROPIC_API_KEY) na Vercel.');
  const {sistema, usuario} = montarPedido(entrada);
  const ferramenta = ferramentaPara(etapasDoAgente(entrada.agente, entrada.etapas));
  // Modelo da empresa (rápido/avançado); o simulador do dono pode forçar outro para comparar.
  const modelo = entrada.modelo || modeloDoAgente(entrada.agente, process.env.CRM_AGENTE_MODELO);
  const {beta, body} = chamadaDoAgente({modelo, sistema, usuario, ferramenta});
  const r = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01', ...(beta ? {'anthropic-beta': beta} : {})},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  }).catch(() => null);
  if (!r) throw new ErroAgente('A IA não respondeu agora. Tente de novo.');
  const d: any = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = String(d?.error?.message || '');
    console.error('[agente] erro da IA', {modelo, status: r.status, tipo: d?.error?.type, detalhe: msg.slice(0, 160)});
    if (/credit balance/i.test(msg)) throw new ErroAgente('Acabaram os créditos da IA. Recarregue no Claude Console.');
    if (r.status === 401) throw new ErroAgente('A chave da IA está inválida. Confira na Vercel.');
    if (r.status === 429) throw new ErroAgente('Muitos pedidos seguidos. Espere alguns segundos.');
    throw new ErroAgente('A IA não respondeu agora. Tente de novo.');
  }
  const bloco = (d?.content || []).find((b: any) => b.type === 'tool_use' && b.name === ferramenta.name);
  const sugestao = lerSugestao(bloco?.input, etapasDoAgente(entrada.agente, entrada.etapas));
  // Registro sem conteúdo: só modelo e consumo, para acompanhar custo.
  console.log(`[agente] ${entrada.automatico ? 'automatico' : 'sugestao'} modelo=${d?.model || modelo} ok=${!!sugestao} parada=${d?.stop_reason ?? '?'} entrada=${d?.usage?.input_tokens ?? '?'} cache=${d?.usage?.cache_read_input_tokens ?? 0} saida=${d?.usage?.output_tokens ?? '?'}`);
  if (!sugestao) throw new ErroAgente('A IA não conseguiu sugerir uma resposta para esta conversa.');
  return sugestao;
}

// Resumo para o atendente que assume a conversa. Nunca lança erro: se a IA falhar, usa o resumo reserva
// (motivo + últimas mensagens do cliente), para a tarefa da equipe nunca ficar sem nada.
export async function resumirConversa(entrada: {empresa: string; contato: string; motivo: string; mensagens: Entrada['mensagens']}): Promise<string> {
  const reserva = () => resumoReserva({mensagens: entrada.mensagens, motivo: entrada.motivo});
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return reserva();
  const {sistema, usuario} = pedidoResumo(entrada);
  const modelo = process.env.CRM_AGENTE_MODELO || 'claude-haiku-5-5';
  try {
    const r = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01'},
      body: JSON.stringify({
        model: modelo, max_tokens: 500, system: sistema,
        tools: [FERRAMENTA_RESUMO], tool_choice: {type: 'tool', name: FERRAMENTA_RESUMO.name},
        messages: [{role: 'user', content: usuario}],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const d: any = await r.json().catch(() => null);
    const bloco = r.ok ? (d?.content || []).find((b: any) => b.type === 'tool_use' && b.name === FERRAMENTA_RESUMO.name) : null;
    const resumo = lerResumo(bloco?.input, entrada.motivo);
    console.log(`[agente] resumo modelo=${modelo} ok=${!!resumo} entrada=${d?.usage?.input_tokens ?? '?'} saida=${d?.usage?.output_tokens ?? '?'}`);
    return resumo || reserva();
  } catch {
    return reserva();
  }
}

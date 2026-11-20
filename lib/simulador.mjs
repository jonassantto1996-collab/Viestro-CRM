// Simulador do agente (só o dono da plataforma): transforma a conversa de teste digitada na tela
// no formato de mensagens que o agente lê. Nada é enviado nem gravado.
export const SIM_MAX_MENSAGENS = 30;
export const SIM_MAX_TEXTO = 1500;

// Entrada: [{de: 'cliente' | 'empresa', texto}] (ordem da conversa). Saída: mensagens com horário
// crescente terminando agora, ou null se a conversa for inválida.
/** @param {unknown} lista @param {Date} [agora] */
export function conversaSimulada(lista, agora = new Date()) {
  if (!Array.isArray(lista) || !lista.length || lista.length > SIM_MAX_MENSAGENS) return null;
  const limpas = [];
  for (const m of lista) {
    if (!m || typeof m !== 'object') return null;
    const de = /** @type {any} */ (m).de, texto = /** @type {any} */ (m).texto;
    if (de !== 'cliente' && de !== 'empresa') return null;
    if (typeof texto !== 'string' || !texto.trim() || texto.length > SIM_MAX_TEXTO) return null;
    limpas.push({de, texto: texto.trim()});
  }
  if (limpas[limpas.length - 1].de !== 'cliente') return null; // o agente responde à última mensagem do cliente
  const fim = agora.getTime();
  return limpas.map((m, i) => ({
    direction: m.de === 'cliente' ? 'inbound' : 'outbound', message_type: 'text', body: m.texto, transcript: null,
    at: new Date(fim - (limpas.length - 1 - i) * 60_000).toISOString(), // 1 minuto entre mensagens
  }));
}

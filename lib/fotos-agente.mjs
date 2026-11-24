// Fotos do catálogo que o agente pode mandar no WhatsApp (regras puras, testadas em
// tests/fotos-agente.test.mjs). Catálogo em settings.agent.photos = {"Nome do modelo": "https://..."}.
// O banco (wa_agent_send_image) só aceita link que esteja nesse catálogo.
export const MAX_FOTOS_POR_RESPOSTA = 2;
export const MAX_FOTOS_CATALOGO = 40;
export const PREFIXO_LEGENDA = '📷 ';

/** @param {unknown} m */
export function fotosValidas(m) {
  if (m === undefined || m === null) return true;
  if (typeof m !== 'object' || Array.isArray(m)) return false;
  const entradas = Object.entries(m);
  if (entradas.length > MAX_FOTOS_CATALOGO) return false;
  return entradas.every(([nome, url]) => nome.trim() && nome.length <= 60 && typeof url === 'string'
    && url.length <= 500 && /^https:\/\/[^\s]+$/i.test(url));
}

/** Nomes dos modelos com foto, na ordem do catálogo. @param {any} agente */
export function modelosComFoto(agente) {
  const m = agente?.photos;
  return m && typeof m === 'object' && !Array.isArray(m) && fotosValidas(m) ? Object.keys(m) : [];
}

export const legendaDaFoto = (/** @type {string} */ nome) => PREFIXO_LEGENDA + nome;

/** Modelos cuja foto o agente já mandou nesta conversa (pela legenda). @param {{direction:string, message_type:string, body:string|null}[]} mensagens */
export function fotosJaEnviadas(mensagens) {
  return (mensagens || []).filter(m => m.direction === 'outbound' && m.message_type === 'image' && typeof m.body === 'string' && m.body.startsWith(PREFIXO_LEGENDA))
    .map(m => /** @type {string} */ (m.body).slice(PREFIXO_LEGENDA.length).trim());
}

/** O que enviar agora: só modelos do catálogo, sem repetir, no máximo 2.
 * @param {unknown} pedidas @param {any} agente @param {string[]} jaEnviadas */
export function fotosParaEnviar(pedidas, agente, jaEnviadas = []) {
  if (!Array.isArray(pedidas)) return [];
  const catalogo = agente?.photos && fotosValidas(agente.photos) ? agente.photos : {};
  const vistos = new Set(jaEnviadas);
  const saida = [];
  for (const nome of pedidas) {
    if (typeof nome !== 'string' || !Object.hasOwn(catalogo, nome) || vistos.has(nome)) continue;
    vistos.add(nome);
    saida.push({nome, url: catalogo[nome], legenda: legendaDaFoto(nome)});
    if (saida.length >= MAX_FOTOS_POR_RESPOSTA) break;
  }
  return saida;
}

// Agente lê imagens e documentos que o cliente manda, e trata áudio que não deu para ouvir.
// Regras puras (sem rede nem banco), testadas em tests/anexos-agente.test.mjs.
// O arquivo vai para o Claude só uma vez: a descrição que ele devolve fica gravada em
// wa_messages.transcript e é o que aparece nas próximas respostas, no resumo e no CRM.

export const MAX_ANEXOS = 3;              // por resposta
export const JANELA_ANEXO_MS = 15 * 60_000; // só anexos recentes (o que ficou para trás é a equipe que vê)
export const ESPERA_TRANSCRICAO_MS = 90_000; // áudio ainda transcrevendo há menos que isso: espera a próxima rodada
const IMAGENS = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXTOS = new Set(['text/plain', 'text/csv']);
export const LIMITE = {image: 5 * 1024 * 1024, document: 10 * 1024 * 1024};

const quando = m => Date.parse(m?.at || m?.provider_timestamp || m?.created_at || '');

/**
 * Imagens e documentos do cliente que ainda não foram lidos, mandados depois da última mensagem da empresa,
 * nos últimos 15 min (no máximo 3, os mais recentes). Figurinha não conta (é enfeite).
 * @param {any[]} mensagens em ordem @param {Date} [agora]
 * @returns {{id:string, media_id:string, tipo:'image'|'document'}[]}
 */
export function anexosParaLer(mensagens, agora = new Date()) {
  const lista = Array.isArray(mensagens) ? mensagens : [];
  let inicio = 0;
  lista.forEach((m, i) => { if (m?.direction === 'outbound') inicio = i + 1; });
  return lista.slice(inicio).filter(m => m?.direction === 'inbound' && ['image', 'document'].includes(m.message_type)
    && typeof m.id === 'string' && typeof m.media_id === 'string' && m.media_id && m.transcript_status == null
    && agora.getTime() - quando(m) <= JANELA_ANEXO_MS)
    .slice(-MAX_ANEXOS).map(m => ({id: m.id, media_id: m.media_id, tipo: m.message_type}));
}

/**
 * Bloco do anexo para a API do Claude, ou null se o formato não abre (Word, Excel, áudio dentro de documento...).
 * @param {{tipo:string, mime:string, bytes:ArrayBuffer|Uint8Array}} a
 */
export function blocoDoAnexo({tipo, mime, bytes}) {
  const buf = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  const declarado = String(mime || '').split(';')[0].trim().toLowerCase();
  // O tipo informado pelo fornecedor pode faltar ou vir genérico: confere pelos primeiros bytes.
  const tipoMime = mimePeloConteudo(buf) || declarado;
  if (!buf.length || buf.length > (LIMITE[tipo] || 0)) return null;
  if (IMAGENS.has(tipoMime)) return {type: 'image', source: {type: 'base64', media_type: tipoMime, data: buf.toString('base64')}};
  if (tipoMime === 'application/pdf') return {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: buf.toString('base64')}};
  if (TEXTOS.has(tipoMime)) return {type: 'document', source: {type: 'text', media_type: 'text/plain', data: buf.toString('utf8').slice(0, 50_000)}};
  return null;
}

/** Tipo real do arquivo pelos primeiros bytes (JPEG, PNG, GIF, WEBP, PDF); null se não reconhece. */
export function mimePeloConteudo(buf) {
  const b = Buffer.from(buf || []);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** Áudio do cliente que não vai ter transcrição (falhou, veio vazio ou travou). */
export function audioSemLeitura(m, agora = new Date()) {
  if (m?.direction !== 'inbound' || m.message_type !== 'audio') return false;
  if (typeof m.transcript === 'string' && m.transcript.trim()) return false;
  if (m.transcript_status === 'failed' || m.transcript_status === 'skipped') return true;
  return agora.getTime() - quando(m) > ESPERA_TRANSCRICAO_MS; // nunca transcrito (sem chave, travado em running)
}

/**
 * O que fazer com os áudios que o cliente acabou de mandar:
 * - 'esperar': ainda transcrevendo; o agente responde na próxima rodada, com o texto.
 * - 'pedir_texto': o último áudio não deu para ouvir; pede para escrever (ou mandar de novo).
 * - 'passar': é o 2º áudio sem leitura em 3 h; passa para a equipe ouvir (o cliente nunca fica sem resposta).
 * - null: nada de especial.
 * @param {any[]} mensagens em ordem @param {Date} [agora]
 */
export function situacaoDoAudio(mensagens, agora = new Date()) {
  const lista = Array.isArray(mensagens) ? mensagens : [];
  let inicio = 0;
  lista.forEach((m, i) => { if (m?.direction === 'outbound') inicio = i + 1; });
  const novos = lista.slice(inicio).filter(m => m?.direction === 'inbound' && m.message_type === 'audio');
  if (!novos.length) return null;
  const pendente = novos.some(m => !audioSemLeitura(m, agora) && !(typeof m.transcript === 'string' && m.transcript.trim()));
  if (pendente) return 'esperar';
  const ultimo = lista.slice(inicio).filter(m => m?.direction === 'inbound').at(-1);
  if (!audioSemLeitura(ultimo, agora)) return null; // depois do áudio ruim o cliente já escreveu
  const semLeitura3h = lista.filter(m => audioSemLeitura(m, agora) && agora.getTime() - quando(m) <= 3 * 3600_000).length;
  return semLeitura3h >= 2 ? 'passar' : 'pedir_texto';
}

/** Descrições que o agente devolveu, uma por anexo (na ordem); nunca confia no formato. */
export function lerDescricoes(v, quantos) {
  if (!Array.isArray(v) || !quantos) return [];
  return v.slice(0, quantos).map(d => typeof d === 'string' ? d.trim().slice(0, 300) : '');
}

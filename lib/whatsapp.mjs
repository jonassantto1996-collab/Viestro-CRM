// Funções puras do WhatsApp (sem acesso a rede ou banco): normalização dos
// webhooks da Meta, checagem da chave secreta da URL e classificação de erros
// da Cloud API. Testadas em tests/whatsapp.test.mjs.
import {createHash, timingSafeEqual} from 'node:crypto';

const MEDIA_LABEL = {image: '[Imagem]', video: '[Vídeo]', audio: '[Áudio]', document: '[Documento]', sticker: '[Figurinha]'};
const digits = value => String(value ?? '').replace(/\D/g, '');
const clip = (value, max) => (value == null ? undefined : String(value).slice(0, max));

// Identificador de usuário da Meta quando o cliente esconde o telefone (BSUID, ex.: "BR.13491208655302741918").
// É o que o CRM guarda em wa_contacts.wa_id nesse caso (o banco aceita o mesmo formato) e o destino das respostas.
const BSUID = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;
/** BSUID válido (sem o prefixo "whatsapp:") ou null. */
export function bsuidDe(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^whatsapp:/, '');
  return BSUID.test(s) ? s : null;
}
/** Telefone (8 a 15 dígitos) ou null; BSUID ou texto com letras nunca vira telefone. */
export function telefoneDe(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (bsuidDe(s) || /[A-Za-z]/.test(s)) return null;
  const d = digits(s);
  return /^[0-9]{8,15}$/.test(d) ? d : null;
}
/** Destino de envio: telefone (só dígitos) ou BSUID; outra coisa = erro. */
export function destinoDoEnvio(to) {
  const b = bsuidDe(to);
  if (b) return {recipient: b};
  const d = digits(to);
  if (!/^[0-9]{8,15}$/.test(d)) throw new Error('Destino inválido');
  return {to: d};
}

/**
 * Dados do anúncio Clique para WhatsApp (objeto `referral` da Meta), só os campos úteis e com limite de
 * tamanho. null quando não veio do anúncio.
 */
export function referralDoAnuncio(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const campo = (v, max) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim().slice(0, max) : undefined;
  const url = campo(r.source_url, 500);
  const out = {
    source_type: campo(r.source_type, 20), source_id: campo(r.source_id, 60),
    source_url: url && /^https:\/\//.test(url) ? url : undefined,
    headline: campo(r.headline, 200), body: campo(r.body, 300), media_type: campo(r.media_type, 20),
    ctwa_clid: campo(r.ctwa_clid, 200),
  };
  const limpo = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  return Object.keys(limpo).length ? limpo : null;
}

/** Timestamp Unix (segundos, como a Meta envia) → ISO 8601. */
export function unixToIso(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

/** Conteúdo legível de uma mensagem da Meta: tipo, texto e id de mídia (nunca o arquivo). */
export function messageContent(m = {}) {
  const type = String(m.type || 'unknown').slice(0, 40);
  let body;
  let mediaId;
  if (type === 'text') body = m.text?.body;
  else if (MEDIA_LABEL[type]) {
    mediaId = m[type]?.id;
    body = m[type]?.caption || (type === 'document' && m.document?.filename ? `[Documento] ${m.document.filename}` : MEDIA_LABEL[type]);
  } else if (type === 'interactive') body = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '[Resposta interativa]';
  else if (type === 'button') body = m.button?.text || '[Botão]';
  else if (type === 'reaction') body = `[Reação ${m.reaction?.emoji || ''}]`.replace(' ]', ']');
  else if (type === 'location') body = ['[Localização]', m.location?.name, m.location?.address].filter(Boolean).join(' ');
  else if (type === 'contacts') body = '[Contato compartilhado]';
  else body = `[Mensagem do tipo ${type}]`;
  return {type, body: clip(body, 6000), media_id: clip(mediaId, 200)};
}

/**
 * Converte o corpo de um webhook da Meta (object = whatsapp_business_account) em eventos
 * para public.wa_ingest(). Campos tratados: messages, statuses, message_echoes
 * (smb_message_echoes), history e state_sync (smb_app_state_sync).
 * A chave de cada evento inclui o phone_number_id para deduplicar sem colisão entre números.
 */
export function normalizeWhatsApp(body) {
  const out = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const change of entry?.changes || []) {
      const v = change?.value;
      const pnid = digits(v?.metadata?.phone_number_id);
      if (!pnid) continue;
      const business = digits(v?.metadata?.display_phone_number);
      const push = (type, key, payload) => out.push({type, key: `${pnid}:${key}`.slice(0, 300), phone_number_id: pnid, payload});

      for (const m of v.messages || []) {
        // Telefone oculto (usernames): vem só o BSUID (from_user_id / contacts[].user_id).
        const fone = telefoneDe(m?.from);
        const contato = v.contacts?.find(c => (fone && digits(c?.wa_id) === fone) || (m?.from_user_id && c?.user_id === m.from_user_id));
        const bsuid = bsuidDe(m?.from_user_id) || bsuidDe(contato?.user_id) || bsuidDe(m?.from);
        if (!m?.id || (!fone && !bsuid)) continue;
        const referral = referralDoAnuncio(m.referral);
        push('message', `msg:${m.id}`, {...(fone ? {wa_id: fone} : {}), ...(bsuid ? {bsuid} : {}), name: clip(contato?.profile?.name, 120),
          wamid: m.id, ts: unixToIso(m.timestamp), ...messageContent(m), ...(referral ? {referral} : {})});
      }
      for (const s of v.statuses || []) {
        if (!s?.id || !s.status) continue;
        push('status', `st:${s.id}:${s.status}`, {wamid: s.id, status: String(s.status), ts: unixToIso(s.timestamp),
          error_code: s.errors?.[0]?.code != null ? String(s.errors[0].code).slice(0, 40) : undefined});
      }
      for (const m of v.message_echoes || []) {
        if (!m?.id || !m.to) continue;
        push('echo', `echo:${m.id}`, {wa_id: digits(m.to), wamid: m.id, ts: unixToIso(m.timestamp), ...messageContent(m)});
      }
      for (const h of v.history || []) {
        for (const thread of h?.threads || []) {
          const customer = digits(thread?.id);
          if (!customer) continue;
          for (const m of thread.messages || []) {
            if (!m?.id) continue;
            const outbound = Boolean(m.to) || (business && digits(m.from) === business);
            push('history', `hist:${m.id}`, {wa_id: customer, wamid: m.id, ts: unixToIso(m.timestamp),
              direction: outbound ? 'outbound' : 'inbound',
              status: String(m.history_context?.status || '').toLowerCase() || undefined, ...messageContent(m)});
          }
        }
      }
      for (const s of v.state_sync || []) {
        const phone = digits(s?.contact?.phone_number);
        if (s?.type !== 'contact' || !phone) continue;
        push('contacts_sync', `cs:${phone}:${s.metadata?.timestamp || ''}:${s.action || ''}`,
          {wa_id: phone, name: clip(s.contact.full_name || s.contact.first_name, 120), action: String(s.action || '')});
      }
    }
  }
  return out;
}

/** Compara a chave secreta da URL em tempo constante. Exige chave configurada com 32+ caracteres. */
export function keyMatches(provided, expected) {
  if (typeof expected !== 'string' || expected.length < 32 || typeof provided !== 'string' || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Só aceita a API oficial da Meta como destino do token (evita vazamento por configuração errada). */
export function graphBase(value) {
  const base = String(value || 'https://graph.facebook.com/v26.0').replace(/\/+$/, '');
  if (!/^https:\/\/graph\.facebook\.com\/v\d+\.\d+$/.test(base)) throw new Error('WHATSAPP_GRAPH_BASE inválido');
  return base;
}

/** Corpo da chamada POST /{phone_number_id}/messages. */
export function buildSendBody(kind, payload, to) {
  const base = {messaging_product: 'whatsapp', recipient_type: 'individual', ...destinoDoEnvio(to)};
  if (kind === 'text') return {...base, type: 'text', text: {body: String(payload?.text || ''), preview_url: false}};
  if (kind === 'template' && payload?.template?.name) return {...base, type: 'template', template: payload.template};
  // Foto do catálogo enviada pelo agente: só link https público (a Meta baixa a imagem).
  if (kind === 'image' && typeof payload?.image?.link === 'string' && payload.image.link.startsWith('https://'))
    return {...base, type: 'image', image: {link: payload.image.link, ...(payload.image.caption ? {caption: String(payload.image.caption).slice(0, 1024)} : {})}};
  throw new Error('Tipo de envio inválido');
}

// Erros em que a Meta garante que nada foi enviado e vale tentar de novo.
const RETRYABLE_CODES = new Set([4, 80007, 130429, 131016, 133004]);
const NEVER_CONNECTED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

/** Resultado de uma resposta HTTP da Cloud API. */
export function classifyGraphResponse(status, json) {
  const wamid = json?.messages?.[0]?.id;
  if (status >= 200 && status < 300 && wamid) return {ok: true, wamid: String(wamid)};
  const code = json?.error?.code;
  const retryable = status === 429 || RETRYABLE_CODES.has(Number(code));
  return {ok: false, code: String(code ?? `http_${status}`).slice(0, 40), retryable};
}

/**
 * Falha de rede antes da resposta. Só é seguro repetir quando a conexão nunca
 * foi aberta; timeout ou conexão interrompida podem ter entregue a mensagem.
 */
export function classifyNetworkError(error) {
  const cause = error?.cause?.code || error?.code;
  if (NEVER_CONNECTED.has(cause)) return {ok: false, code: `net_${cause}`.toLowerCase(), retryable: true};
  return {ok: false, code: 'unknown_result', retryable: false};
}

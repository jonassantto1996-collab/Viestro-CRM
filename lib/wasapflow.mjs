// WasapFlow Bridge (https://officialapi.wasapflow.com/bridge/v1) — regras puras, sem rede nem banco.
// Testadas em tests/wasapflow.test.mjs. O WasapFlow guarda o token da Meta: o CRM só usa a chave de
// parceiro (WF_PARTNER_KEY) e o segredo do webhook (WF_WEBHOOK_SECRET), ambos só no servidor.
import {createHmac, timingSafeEqual} from 'node:crypto';
import {messageContent, unixToIso} from './whatsapp.mjs';

export const WF_BASE = 'https://officialapi.wasapflow.com/bridge/v1';
const digits = v => String(v ?? '').replace(/\D/g, '');
const clip = (v, max) => (v == null ? undefined : String(v).slice(0, max));
// Identificador de usuário da Meta (BSUID, ex.: "BR.123..."): nunca vira telefone.
const BSUID = /^(?:whatsapp:)?[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;
/** Telefone do cliente só com dígitos (8 a 15). BSUID ou texto com letras → null. */
export function telefoneDoCliente(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (BSUID.test(s) || /[A-Za-z]/.test(s)) return null;
  const d = digits(s);
  return /^[0-9]{8,15}$/.test(d) ? d : null;
}

/**
 * Chave secreta do caminho do webhook (/api/webhooks/wasapflow/<chave>), derivada do segredo do webhook:
 * não precisa de outra variável. Trocar WF_WEBHOOK_SECRET troca o endereço.
 * @param {string|undefined} segredo
 */
export function chaveDoCaminho(segredo) {
  if (typeof segredo !== 'string' || segredo.length < 16) return null;
  return createHmac('sha256', segredo).update('viestro-crm/webhook-wasapflow/v1').digest('base64url');
}

/**
 * Confere x-wasapflow-signature ("sha256=<hex>", HMAC-SHA256 do corpo bruto com o segredo do webhook),
 * em tempo constante. Sem segredo configurado (16+ caracteres), nada é aceito.
 * @param {Buffer|string} corpo @param {string|null|undefined} cabecalho @param {string|undefined} segredo
 */
export function assinaturaValida(corpo, cabecalho, segredo) {
  if (typeof segredo !== 'string' || segredo.length < 16 || typeof cabecalho !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(cabecalho.trim());
  if (!m) return false;
  const esperado = createHmac('sha256', segredo).update(corpo).digest();
  return timingSafeEqual(esperado, Buffer.from(m[1], 'hex'));
}

// Conteúdo da mensagem: prefere o objeto original da Meta (data.raw.message / raw.echo), que traz o id
// da mídia; sem ele, usa os campos simples do WasapFlow (type + text).
function conteudo(d, rawKey = 'message') {
  const raw = d?.raw?.[rawKey] || d?.raw?.message;
  if (raw && typeof raw === 'object' && raw.type) return messageContent(raw);
  const type = String(d?.type || 'unknown');
  const text = typeof d?.text === 'string' ? d.text : d?.text?.body;
  if (type === 'text') return messageContent({type, text: {body: text}});
  return messageContent({type, [type]: {caption: text}});
}

// Avisos que aparecem no CRM (códigos guardados em wa_accounts.provider_alert_code).
export const AVISO = {
  PAGAMENTO: 'wf_pagamento', SUSPENSO: 'wf_suspenso', CHAVE: 'wf_chave', SEM_NUMERO: 'wf_numero_nao_registrado',
  DESCONECTADO: 'wf_desconectado', REMOVIDO: 'wf_acesso_removido', RESTRITO: 'wf_conta_restrita', AGENTE_META: 'wf_agente_meta',
};
const AVISO_DA_CONEXAO = [AVISO.DESCONECTADO, AVISO.REMOVIDO];

/**
 * Converte um webhook do WasapFlow em eventos para wa_ingest_wasapflow (mesmo formato de wa_ingest)
 * e diz o que mais fazer: atualizar modelos, ligar/desligar aviso do número, registrar evento novo.
 * Mensagem sem telefone (só BSUID) é descartada e contada: o CRM identifica contato pelo número.
 */
export function normalizeWasapflow(env) {
  const out = {waba_id: digits(env?.waba_id), phone_number_id: digits(env?.phone_number_id) || null,
    events: /** @type {{type:string, key:string, phone_number_id:string|null, payload:Record<string, unknown>}[]} */ ([]), templates: false, aviso: /** @type {null|{set?:string, clear?:string[]}} */ (null), semTelefone: 0, desconhecido: /** @type {string|null} */ (null)};
  const evento = String(env?.event || '');
  const d = env?.data && typeof env.data === 'object' ? env.data : {};
  if (!out.waba_id || !evento) return out;
  const prefixo = out.phone_number_id || `wf${out.waba_id}`;
  const push = (type, key, payload) => out.events.push({type, key: `${prefixo}:${key}`.slice(0, 300), phone_number_id: out.phone_number_id, payload});
  const ts = unixToIso(d.timestamp ?? env.timestamp);
  const wamid = clip(d.message_id, 200);

  switch (evento) {
    case 'message.received': {
      out.aviso = {clear: [AVISO.AGENTE_META]}; // voltou a chegar mensagem normal: o CRM é quem responde de novo
      const wa = telefoneDoCliente(d.from);
      if (!wamid) break;
      if (!wa) { out.semTelefone++; break; }
      push('message', `msg:${wamid}`, {wa_id: wa, name: clip(d.contact_name, 120), wamid, ts, ...conteudo(d)});
      break;
    }
    case 'message.echo': { // resposta digitada no WhatsApp Business do celular: deixa o agente quieto
      const wa = telefoneDoCliente(d.recipient);
      if (!wamid) break;
      if (!wa) { out.semTelefone++; break; }
      push('echo', `echo:${wamid}`, {wa_id: wa, wamid, ts, ...conteudo(d, 'echo')});
      break;
    }
    case 'message.history': { // histórico importado uma vez depois da conexão: nunca aciona o agente
      const wa = telefoneDoCliente(d.contact_wa_id ?? d.thread_id);
      if (!wamid) break;
      if (!wa) { out.semTelefone++; break; }
      push('history', `hist:${wamid}`, {wa_id: wa, wamid, ts, direction: d.direction === 'outbound' ? 'outbound' : 'inbound',
        status: ['sent', 'delivered', 'read'].includes(d.status) ? d.status : undefined, ...conteudo(d)});
      break;
    }
    case 'standby.message_received':
    case 'standby.message_echo': { // o agente da Meta está atendendo: guarda só como contexto (sem resposta automática)
      out.aviso = {set: AVISO.AGENTE_META};
      const echo = evento === 'standby.message_echo';
      const wa = telefoneDoCliente(echo ? (d.recipient ?? d.contact_wa_id) : (d.from ?? d.contact_wa_id));
      if (!wamid || !wa) { if (wamid) out.semTelefone++; break; }
      push('history', `hist:${wamid}`, {wa_id: wa, wamid, ts, direction: echo ? 'outbound' : 'inbound', ...conteudo(d, echo ? 'echo' : 'message')});
      break;
    }
    case 'standby.message_status':
      out.aviso = {set: AVISO.AGENTE_META};
      break;
    case 'contact.synced': {
      const wa = telefoneDoCliente(d.phone_number);
      if (!wa) break;
      const acao = ['add', 'update', 'remove'].includes(d.action) ? d.action : 'update';
      push('contacts_sync', `cs:${wa}:${d.version ?? d.timestamp ?? env.timestamp ?? ''}:${acao}`, {wa_id: wa, name: clip(d.full_name || d.first_name, 120), action: acao});
      break;
    }
    case 'message.sent': case 'message.delivered': case 'message.read': case 'message.failed': {
      const status = evento.slice(8);
      if (!wamid) break;
      const erro = Array.isArray(d.errors) ? d.errors[0]?.code : undefined;
      push('status', `st:${wamid}:${status}`, {wamid, status, ts, error_code: erro != null ? String(erro).slice(0, 40) : undefined});
      break;
    }
    case 'template.status_updated': case 'template.quality_updated': case 'template.category_updated':
      out.templates = true;
      break;
    case 'waba.offboarded': out.aviso = {set: AVISO.DESCONECTADO}; break;
    case 'waba.partner_removed': out.aviso = {set: AVISO.REMOVIDO}; break;
    case 'waba.reconnected': out.aviso = {clear: AVISO_DA_CONEXAO}; break;
    case 'waba.account_updated':
      if (['DISABLED_UPDATE', 'ACCOUNT_RESTRICTION'].includes(String(d.event || ''))) out.aviso = {set: AVISO.RESTRITO};
      break;
    case 'waba.quality_updated': case 'waba.tier_updated': case 'waba.review_updated': case 'waba.alert': case 'waba.pricing_tier_updated':
      break; // sem efeito no CRM por enquanto
    default:
      out.desconhecido = evento.slice(0, 60);
  }
  return out;
}

// Evento desconhecido: registra 1ª, 2ª, 4ª, 8ª... ocorrência (aprende sobre novidades sem lotar o log).
export function deveRegistrar(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Caminho e corpo do envio no WasapFlow (mesmos tipos da fila: text, template, image).
 * `ref` (id da fila, sem dado pessoal) vai em biz_opaque_callback_data e volta nos status.
 */
export function pedidoDeEnvio(kind, payload, to, ref) {
  const base = {to: digits(to), ...(ref ? {biz_opaque_callback_data: String(ref).slice(0, 512)} : {})};
  if (!/^[0-9]{8,15}$/.test(base.to)) throw new Error('Destino inválido');
  if (kind === 'text') return {path: '/messages/send', body: {...base, text: String(payload?.text || ''), preview_url: false}};
  if (kind === 'template' && payload?.template?.name) return {path: '/messages/template', body: {...base, template: payload.template}};
  if (kind === 'image' && typeof payload?.image?.link === 'string' && payload.image.link.startsWith('https://'))
    return {path: '/messages/media', body: {...base, type: 'image', media: {link: payload.image.link,
      ...(payload.image.caption ? {caption: String(payload.image.caption).slice(0, 1024)} : {})}}};
  throw new Error('Tipo de envio inválido');
}

const PAGAMENTO = new Set(['PAYMENT_REQUIRED', 'PAYMENT_FAILED', 'PAYMENT_ACTION_REQUIRED', 'TRIAL_EXPIRED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_INACTIVE', 'CARD_REQUIRED']);
const CHAVE = new Set(['UNAUTHORIZED', 'INVALID_PARTNER_KEY', 'INVALID_KEY']);
const SEM_NUMERO = new Set(['WABA_NOT_REGISTERED', 'WABA_NOT_FOUND', 'NO_ACTIVE_WABA']);
// Erros da Meta (meta_code) em que nada foi enviado e vale tentar de novo.
const META_REPETE = new Set([4, 80007, 130429, 131016, 133004]);

/** Aviso do número para um código de erro do WasapFlow (pagamento, bloqueio, chave, número). */
export function avisoDoErro(status, code) {
  const c = String(code || '');
  if (status === 402 || PAGAMENTO.has(c)) return AVISO.PAGAMENTO;
  if (c === 'PARTNER_SUSPENDED') return AVISO.SUSPENSO;
  if (status === 401 || CHAVE.has(c)) return AVISO.CHAVE;
  if (SEM_NUMERO.has(c)) return AVISO.SEM_NUMERO;
  return null;
}

/**
 * Resultado de uma resposta do WasapFlow. Com Idempotency-Key, repetir é seguro em 429, 409
 * IDEMPOTENCY_IN_PROGRESS, 5xx do próprio WasapFlow e em erro de rede (a mesma chave devolve a resposta
 * original em vez de enviar de novo).
 */
export function classificarResposta(status, json) {
  const wamid = json?.message_id || json?.messages?.[0]?.id;
  if (status >= 200 && status < 300 && json?.success !== false && wamid) return {ok: true, wamid: String(wamid)};
  const code = String(json?.error?.code || `http_${status}`);
  const meta = json?.error?.meta_code ?? json?.error?.meta_error_code;
  const retryable = status === 429 || code === 'IDEMPOTENCY_IN_PROGRESS' || code === 'RATE_LIMIT_EXCEEDED'
    || (code === 'META_ERROR' ? META_REPETE.has(Number(meta)) : status >= 500);
  return {ok: false, code: (code === 'META_ERROR' && meta != null ? `meta_${meta}` : `wf_${code}`).slice(0, 40), retryable,
    aviso: avisoDoErro(status, code)};
}

/** Falha de rede: com a mesma Idempotency-Key, tentar de novo não duplica a mensagem. */
export function classificarErroDeRede() {
  return {ok: false, code: 'wf_rede', retryable: true, aviso: null};
}

/** Chave de idempotência do envio de um item da fila (a mesma em todas as tentativas). */
export function chaveDoEnvio(outboxId) {
  return `viestro-outbox-${outboxId}`.slice(0, 255);
}

const TPL_NAME = /^[a-z0-9_]{1,512}$/;
const TPL_LANG = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const TPL_CATEGORY = new Set(['MARKETING', 'UTILITY', 'AUTHENTICATION']);
const TPL_STATUS = new Set(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'ARCHIVED']);
/** GET /templates → linhas válidas para wa_templates (o resto é ignorado). */
export function modelosDaResposta(json) {
  const lista = Array.isArray(json?.templates) ? json.templates : [];
  return lista.map(t => ({
    external_template_id: String(t?.id || '').slice(0, 100) || null,
    name: String(t?.name || ''), language: String(t?.language || ''),
    category: String(t?.category || '').toUpperCase(), status: String(t?.status || '').toUpperCase(),
    components: Array.isArray(t?.components) ? t.components : [],
  })).filter(t => TPL_NAME.test(t.name) && TPL_LANG.test(t.language) && TPL_CATEGORY.has(t.category)
    && TPL_STATUS.has(t.status) && JSON.stringify(t.components).length <= 20000);
}

/**
 * Corpo de POST /templates para um modelo UTILITY com variáveis {{1}}, {{2}}...
 * @param {{name:string, language:string, text:string, examples:string[]}} m
 */
export function corpoDoModelo({name, language, text, examples}) {
  return {name, language, category: 'UTILITY', parameter_format: 'POSITIONAL',
    components: [{type: 'BODY', text, example: {body_text: [examples]}}]};
}

/**
 * Número conectado, a partir de GET /clients (procura pelo waba_id + phone_number_id que o popup devolveu).
 * null = não está registrado na conta de parceiro.
 */
export function numeroDaLista(json, wabaId, phoneNumberId) {
  const lista = Array.isArray(json?.clients) ? json.clients : [];
  const c = lista.find(x => digits(x?.waba_id) === digits(wabaId) && digits(x?.phone_number_id) === digits(phoneNumberId));
  const fone = digits(c?.phone_number);
  if (!c || !/^[1-9][0-9]{7,14}$/.test(fone)) return null;
  return {waba_id: digits(c.waba_id), phone_number_id: digits(c.phone_number_id), phone_e164: `+${fone}`,
    display_name: typeof c.display_name === 'string' ? c.display_name.slice(0, 120) : null, status: String(c.status || '')};
}

/** Link do popup de conexão: só aceita o domínio do WasapFlow. */
export function linkDeConexao(json) {
  const url = json?.connect_url;
  return typeof url === 'string' && url.startsWith('https://officialapi.wasapflow.com/') ? url : null;
}

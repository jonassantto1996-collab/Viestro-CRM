import 'server-only';
import {serviceClient} from './supabase/server';
import {buildSendBody, classifyGraphResponse, classifyNetworkError, graphBase} from './whatsapp.mjs';
import {WF_BASE, pedidoDeEnvio, classificarResposta, classificarErroDeRede, modelosDaResposta, avisoDoErro} from './wasapflow.mjs';

// Caminho de cada número pelo fornecedor (wa_accounts.provider):
//   easycoexistence → Graph API da Meta com o token do número (cofre do Supabase);
//   wasapflow       → WasapFlow Bridge com a chave de parceiro (WF_PARTNER_KEY); o token da Meta fica com eles.
// Nunca registra token, chave, telefone nem conteúdo em log.
type Db = ReturnType<typeof serviceClient>;
export type Conta = {id: string; company_id: string; provider: string; phone_number_id: string; waba_id: string; provider_alert_code?: string | null};
export type Resultado = {ok: true; wamid: string} | {ok: false; code: string; retryable: boolean; aviso?: string | null};
export const CAMPOS_CONTA = 'id,company_id,provider,phone_number_id,waba_id,provider_alert_code';

const avisados = new Set<string>();
// O WasapFlow avisa mudanças da Meta em todo retorno; só "ação necessária" e "quebra" vão para o log (uma vez).
function lerAvisosDaPonte(h: Headers) {
  const nivel = h.get('x-bridge-notice-level');
  const ids = h.get('x-bridge-notice') || '';
  if ((nivel === 'action_required' || nivel === 'breaking') && !avisados.has(ids)) {
    avisados.add(ids);
    console.warn('[wasapflow] aviso da plataforma', {nivel, avisos: ids.slice(0, 200)});
  }
}

/** Chamada ao WasapFlow Bridge. Lança erro só se a chave de parceiro não estiver configurada. */
export async function ponte(path: string, {method = 'GET', conta, body, chave, timeout = 15_000}: {method?: string; conta?: Pick<Conta, 'waba_id' | 'phone_number_id'>; body?: unknown; chave?: string; timeout?: number} = {}) {
  const parceiro = process.env.WF_PARTNER_KEY;
  if (!parceiro) throw new Error('WF_PARTNER_KEY ausente');
  const res = await fetch(WF_BASE + path, {
    method, cache: 'no-store', signal: AbortSignal.timeout(timeout),
    headers: {
      'x-partner-key': parceiro,
      ...(conta ? {'x-waba-id': conta.waba_id, 'x-phone-number-id': conta.phone_number_id} : {}),
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(chave ? {'Idempotency-Key': chave} : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  lerAvisosDaPonte(res.headers);
  return res;
}

async function tokenDaConta(db: Db, contaId: string, cache?: Map<string, string | null>) {
  if (cache?.has(contaId)) return cache.get(contaId) ?? null;
  const t = await db.rpc('wa_account_token', {p_account: contaId});
  const token = t.error ? null : (t.data as string | null);
  cache?.set(contaId, token);
  return token;
}

/**
 * Liga ou desliga o aviso do número no CRM (pagamento, bloqueio, desconexão...).
 * Só grava quando muda; desligar só apaga os códigos indicados (ou qualquer um, se nenhum).
 */
export async function registrarAviso(db: Db, conta: Pick<Conta, 'id' | 'provider_alert_code'>, code: string | null, limpar?: string[]) {
  if (code && conta.provider_alert_code === code) return;
  if (!code && (!conta.provider_alert_code || (limpar && !limpar.includes(conta.provider_alert_code)))) return;
  const {error} = await db.rpc('wa_account_alert', {p_account: conta.id, p_code: code, p_clear: limpar ?? null});
  if (error) console.error('[wasapflow] aviso do número não registrado', {conta: conta.id});
  else conta.provider_alert_code = code;
  if (code) console.error('[wasapflow] número com aviso', {conta: conta.id, aviso: code});
}

/** Envia texto, modelo ou imagem pelo caminho do número. `chave` = Idempotency-Key (WasapFlow). */
export async function enviarPelaConta(db: Db, conta: Conta, kind: string, payload: any, to: string,
  {chave, ref, tokens}: {chave?: string; ref?: string; tokens?: Map<string, string | null>} = {}): Promise<Resultado> {
  if (conta.provider === 'wasapflow') {
    let r: Resultado;
    try {
      const {path, body} = pedidoDeEnvio(kind, payload, to, ref);
      const res = await ponte(path, {method: 'POST', conta, body, chave});
      r = classificarResposta(res.status, await res.json().catch(() => null)) as Resultado;
    } catch (e) {
      r = (e as Error)?.message === 'WF_PARTNER_KEY ausente' ? {ok: false, code: 'wf_sem_chave', retryable: false}
        : /inválido/.test(String((e as Error)?.message)) ? {ok: false, code: 'payload_invalido', retryable: false}
        : classificarErroDeRede() as Resultado;
    }
    if (r.ok) await registrarAviso(db, conta, null, ['wf_pagamento', 'wf_suspenso', 'wf_chave', 'wf_numero_nao_registrado']);
    else if (r.aviso) await registrarAviso(db, conta, r.aviso);
    return r;
  }
  const token = await tokenDaConta(db, conta.id, tokens);
  if (!token) return {ok: false, code: 'token_missing', retryable: false};
  try {
    const res = await fetch(`${graphBase(process.env.WHATSAPP_GRAPH_BASE)}/${conta.phone_number_id}/messages`, {
      method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(buildSendBody(kind, payload, to)), signal: AbortSignal.timeout(15000), cache: 'no-store',
    });
    return classifyGraphResponse(res.status, await res.json().catch(() => null)) as Resultado;
  } catch (error) {
    return classifyNetworkError(error) as Resultado;
  }
}

const ORIGENS_META = /(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net|fbcdn\.net)$/;
async function lerAteLimite(res: Response, max: number) {
  if (Number(res.headers.get('content-length')) > max) return null;
  const bytes = await res.arrayBuffer();
  return bytes.byteLength > max ? null : bytes;
}

/** Baixa uma mídia recebida (áudio para transcrição). `grande` = passou do limite. */
export async function baixarMidia(db: Db, conta: Conta, mediaId: string, max: number, tokens?: Map<string, string | null>)
  : Promise<{bytes: ArrayBuffer; mime: string} | {grande: true}> {
  const id = encodeURIComponent(mediaId);
  if (conta.provider === 'wasapflow') {
    // Rota da tabela de endpoints; a referência antiga usa /contacts/media/:id.
    let res = await ponte(`/media/${id}`, {conta, timeout: 20_000});
    if (res.status === 404) res = await ponte(`/contacts/media/${id}`, {conta, timeout: 20_000});
    const mime = String(res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || mime === 'application/json') {
      const j: any = await res.json().catch(() => null);
      const aviso = avisoDoErro(res.status, j?.error?.code);
      if (aviso) await registrarAviso(db, conta, aviso);
      throw new Error(`mídia ${res.status}`);
    }
    const bytes = await lerAteLimite(res, max);
    return bytes ? {bytes, mime: mime || 'audio/ogg'} : {grande: true};
  }
  const token = await tokenDaConta(db, conta.id, tokens);
  if (!token) throw new Error('sem token');
  const base = graphBase(process.env.WHATSAPP_GRAPH_BASE);
  const info = await fetch(`${base}/${id}`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10_000), cache: 'no-store'});
  const meta: any = await info.json().catch(() => null);
  if (!info.ok || typeof meta?.url !== 'string') throw new Error('mídia indisponível');
  if (Number(meta.file_size) > max) return {grande: true};
  // O arquivo só é baixado do servidor da Meta, com o token do número
  const url = new URL(meta.url);
  if (!ORIGENS_META.test(url.hostname)) throw new Error('origem inesperada');
  const arquivo = await fetch(url, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15_000), cache: 'no-store'});
  if (!arquivo.ok) throw new Error('download falhou');
  const bytes = await lerAteLimite(arquivo, max);
  return bytes ? {bytes, mime: String(meta.mime_type || 'audio/ogg').split(';')[0]} : {grande: true};
}

/** Confirmação de leitura para o cliente (só WasapFlow; no EasyCoexistence o CRM não envia). */
export async function marcarLida(db: Db, conta: Conta, wamid: string) {
  if (conta.provider !== 'wasapflow' || !wamid) return false;
  try {
    const res = await ponte('/messages/read', {method: 'POST', conta, body: {message_id: wamid}, chave: `viestro-read-${wamid}`.slice(0, 255)});
    if (res.ok) return true;
    const j: any = await res.json().catch(() => null);
    const aviso = avisoDoErro(res.status, j?.error?.code);
    if (aviso) await registrarAviso(db, conta, aviso);
  } catch {}
  return false;
}

/** Modelos do número no WasapFlow (GET /templates). null = não foi possível ler. */
export async function modelosDaPonte(db: Db, conta: Conta) {
  const res = await ponte('/templates', {conta});
  const json: any = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) {
    const aviso = avisoDoErro(res.status, json?.error?.code);
    if (aviso) await registrarAviso(db, conta, aviso);
    console.error('[wasapflow] modelos indisponíveis', {status: res.status, code: String(json?.error?.code || '').slice(0, 40)});
    return null;
  }
  return modelosDaResposta(json);
}

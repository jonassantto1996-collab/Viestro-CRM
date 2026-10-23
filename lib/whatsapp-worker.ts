import 'server-only';
import {serviceClient} from './supabase/server';
import {buildSendBody, classifyGraphResponse, classifyNetworkError, graphBase} from './whatsapp.mjs';

type OutboxJob = {id: string; lease_token: string; kind: string; payload: any; account_id: string; phone_number_id: string; to_wa_id: string};

/** Processa os eventos recebidos (o processamento acontece no banco). */
export async function drainEvents() {
  const db = serviceClient();
  const {data, error} = await db.rpc('wa_process_pending');
  if (error) throw error;
  return data;
}

async function sendOne(job: OutboxJob, token: string) {
  try {
    const res = await fetch(`${graphBase(process.env.WHATSAPP_GRAPH_BASE)}/${job.phone_number_id}/messages`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(buildSendBody(job.kind, job.payload, job.to_wa_id)),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    const json = await res.json().catch(() => null);
    return classifyGraphResponse(res.status, json);
  } catch (error) {
    return classifyNetworkError(error);
  }
}

/** Envia o que estiver na fila. Nunca registra conteúdo nem token em log. */
export async function drainOutbox() {
  const db = serviceClient();
  const {data, error} = await db.rpc('wa_claim_outbox', {p_limit: 10});
  if (error) throw error;
  const tokens = new Map<string, string | null>();
  let sent = 0;
  let failed = 0;
  for (const job of (data || []) as OutboxJob[]) {
    if (!tokens.has(job.account_id)) {
      const t = await db.rpc('wa_account_token', {p_account: job.account_id});
      tokens.set(job.account_id, t.error ? null : (t.data as string | null));
    }
    const token = tokens.get(job.account_id);
    const result = token ? await sendOne(job, token) : {ok: false, code: 'token_missing', retryable: false};
    const {error: e} = await db.rpc('wa_outbox_result', {
      p_id: job.id, p_lease: job.lease_token, p_ok: result.ok,
      p_wamid: 'wamid' in result ? result.wamid : null,
      p_error_code: 'code' in result ? result.code : null,
      p_retryable: 'retryable' in result ? result.retryable : false,
    });
    if (e) console.error('WhatsApp: falha ao registrar resultado do envio', {outbox: job.id});
    if (result.ok) sent++;
    else {
      failed++;
      console.error('WhatsApp: envio não concluído', {outbox: job.id, code: 'code' in result ? result.code : undefined});
    }
  }
  return {sent, failed};
}

/** Usado após webhooks e envios: falhas ficam na fila para a próxima rodada. */
export async function drainAll() {
  try { await drainEvents(); } catch { console.error('WhatsApp: eventos pendentes para a próxima rodada'); }
  try { await drainOutbox(); } catch { console.error('WhatsApp: envios pendentes para a próxima rodada'); }
}

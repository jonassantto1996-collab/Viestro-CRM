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

const TPL_NAME = /^[a-z0-9_]{1,512}$/;
const TPL_LANG = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const TPL_CATEGORY = new Set(['MARKETING', 'UTILITY', 'AUTHENTICATION']);
const TPL_STATUS = new Set(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'ARCHIVED']);

/**
 * Traz da Meta os templates de cada número da empresa e atualiza wa_templates.
 * A Meta não avisa por webhook quando um template é aprovado; por isso a caixa de entrada
 * pede a sincronização ao abrir. Intervalo mínimo de 60 s por número. Token nunca vai para log.
 */
export async function syncTemplates(companyId: string) {
  const db = serviceClient();
  const base = graphBase(process.env.WHATSAPP_GRAPH_BASE);
  const {data: accounts, error} = await db.from('wa_accounts').select('id,waba_id')
    .eq('company_id', companyId).neq('connection_status', 'disconnected');
  if (error) throw error;
  let synced = 0;
  for (const acc of accounts || []) {
    const {data: last} = await db.from('wa_templates').select('last_synced_at')
      .eq('account_id', acc.id).order('last_synced_at', {ascending: false, nullsFirst: false}).limit(1).maybeSingle();
    if (last?.last_synced_at && Date.now() - new Date(last.last_synced_at).getTime() < 60_000) continue;
    const t = await db.rpc('wa_account_token', {p_account: acc.id});
    const token = t.error ? null : (t.data as string | null);
    if (!token) continue;

    const found: Record<string, unknown>[] = [];
    let url: string | null = `${base}/${acc.waba_id}/message_templates?fields=id,name,status,category,language,components&limit=200`;
    let complete = true;
    for (let page = 0; url && page < 10; page++) {
      const res: Response = await fetch(url, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000), cache: 'no-store'});
      if (!res.ok) { complete = false; console.error('WhatsApp: templates indisponíveis', {status: res.status}); break; }
      const json = await res.json();
      for (const t of json?.data || []) {
        const name = String(t?.name || '');
        const language = String(t?.language || '');
        const category = String(t?.category || '').toUpperCase();
        const status = String(t?.status || '').toUpperCase();
        const components = Array.isArray(t?.components) ? t.components : [];
        if (!TPL_NAME.test(name) || !TPL_LANG.test(language) || !TPL_CATEGORY.has(category) || !TPL_STATUS.has(status)) continue;
        if (JSON.stringify(components).length > 20000) continue;
        found.push({company_id: companyId, account_id: acc.id, external_template_id: String(t.id || '').slice(0, 100) || null,
          name, language, category, status, components, last_synced_at: new Date().toISOString()});
      }
      // Só segue a paginação dentro da própria API da Meta (o token vai junto)
      const next: string | undefined = json?.paging?.next;
      url = next && next.startsWith(base + '/') ? next : null;
      if (next && !url) complete = false;
    }
    if (found.length) {
      const {error: e} = await db.from('wa_templates').upsert(found, {onConflict: 'account_id,name,language'});
      if (e) throw e;
    }
    if (complete) {
      // Removidos na Meta deixam de aparecer para envio
      const keep = new Set(found.map(f => `${f.name}|${f.language}`));
      const {data: existing} = await db.from('wa_templates').select('id,name,language,status').eq('account_id', acc.id);
      const gone = (existing || []).filter(x => !keep.has(`${x.name}|${x.language}`) && x.status !== 'DELETED').map(x => x.id);
      if (gone.length) await db.from('wa_templates').update({status: 'DELETED', last_synced_at: new Date().toISOString()}).in('id', gone);
    }
    synced += found.length;
  }
  return {synced};
}

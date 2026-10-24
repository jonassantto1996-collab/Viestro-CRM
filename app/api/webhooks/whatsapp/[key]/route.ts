import {after} from 'next/server';
import {serviceClient} from '@/lib/supabase/server';
import {reply} from '@/lib/http';
import {keyMatches, normalizeWhatsApp} from '@/lib/whatsapp.mjs';
import {drainAll} from '@/lib/whatsapp-worker';

export const dynamic = 'force-dynamic';

// A Meta assina as entregas com o segredo do app do provedor (EasyCoexistence), que não é
// compartilhado. A autenticação é a chave longa e aleatória no caminho da URL, conforme a
// documentação do provedor, mais o mapeamento phone_number_id → empresa no servidor.
type Ctx = {params: Promise<{key: string}>};
const MAX_BODY = 4_000_000;
const notFound = () => new Response('Not found', {status: 404, headers: {'Cache-Control': 'no-store'}});

export async function GET(req: Request, {params}: Ctx) {
  const {key} = await params;
  if (!keyMatches(key, process.env.WHATSAPP_WEBHOOK_KEY)) return notFound();
  const p = new URL(req.url).searchParams;
  const challenge = p.get('hub.challenge') || '';
  if (p.get('hub.mode') === 'subscribe' && keyMatches(p.get('hub.verify_token') || '', process.env.WHATSAPP_VERIFY_TOKEN) && /^[\w-]{1,200}$/.test(challenge)) {
    return new Response(challenge, {headers: {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'}});
  }
  return reply({error: 'Verificação recusada'}, 403);
}

export async function POST(req: Request, {params}: Ctx) {
  const {key} = await params;
  if (!keyMatches(key, process.env.WHATSAPP_WEBHOOK_KEY)) return notFound();

  let raw: Buffer;
  try {
    const reader = req.body?.getReader();
    if (!reader) return reply({error: 'Corpo ausente'}, 400);
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return reply({error: 'Payload excedido'}, 413); }
      parts.push(value);
    }
    raw = Buffer.concat(parts);
  } catch {
    return reply({error: 'Corpo inválido'}, 400);
  }

  let events;
  try { events = normalizeWhatsApp(JSON.parse(raw.toString('utf8'))); }
  catch { return reply({error: 'JSON inválido'}, 400); }
  if (!events.length) return reply({received: true});

  try {
    const db = serviceClient();
    for (let i = 0; i < events.length; i += 1000) {
      const {error} = await db.rpc('wa_ingest', {p_events: events.slice(i, i + 1000)});
      if (error) throw error;
    }
  } catch (err) {
    // 503 faz a Meta reenviar; a deduplicação no banco impede duplicidade.
    // Só o código e a mensagem técnica (sem dígitos) vão para o log: nada de conteúdo ou telefone.
    const e = err as {code?: string; message?: string; status?: number};
    console.error('WhatsApp: evento não persistido; a Meta vai reenviar', {
      count: events.length, code: e?.code, status: e?.status,
      reason: String(e?.message || '').replace(/\d+/g, '#').slice(0, 160),
    });
    return reply({error: 'Indisponível'}, 503);
  }
  after(drainAll);
  return reply({received: true});
}

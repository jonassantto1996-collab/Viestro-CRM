import {after} from 'next/server';
import {serviceClient} from '@/lib/supabase/server';
import {reply} from '@/lib/http';
import {keyMatches} from '@/lib/whatsapp.mjs';
import {assinaturaValida, chaveDoCaminho, deveRegistrar, normalizeWasapflow} from '@/lib/wasapflow.mjs';
import {drainAll, drainAllWithAgent, syncTemplatesDaConta} from '@/lib/whatsapp-worker';
import {CAMPOS_CONTA, registrarAviso, type Conta} from '@/lib/wa-provedor';

export const dynamic = 'force-dynamic';

// Entrada do WasapFlow Bridge (números com provider = 'wasapflow').
// Três travas: chave secreta no caminho (derivada de WF_WEBHOOK_SECRET), assinatura x-wasapflow-signature
// (HMAC-SHA256 do corpo bruto, comparação em tempo constante) e o waba_id do envelope precisa ser de um
// número do WasapFlow cadastrado no CRM. O evento é só gravado (rápido, deduplicado) antes do 200; o
// processamento, o agente e a transcrição rodam depois da resposta. O prazo do WasapFlow é 10 s.
type Ctx = {params: Promise<{key: string}>};
const MAX_BODY = 4_000_000;
const notFound = () => new Response('Not found', {status: 404, headers: {'Cache-Control': 'no-store'}});
const desconhecidos = new Map<string, number>();

export async function POST(req: Request, {params}: Ctx) {
  const {key} = await params;
  const segredo = process.env.WF_WEBHOOK_SECRET;
  const esperado = chaveDoCaminho(segredo);
  if (!esperado || !keyMatches(key, esperado)) return notFound();

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
  if (!assinaturaValida(raw, req.headers.get('x-wasapflow-signature'), segredo)) return reply({error: 'Assinatura inválida'}, 401);

  let n: ReturnType<typeof normalizeWasapflow>;
  try { n = normalizeWasapflow(JSON.parse(raw.toString('utf8'))); }
  catch { return reply({error: 'JSON inválido'}, 400); }

  if (n.events.length) {
    try {
      const {error} = await serviceClient().rpc('wa_ingest_wasapflow', {p_waba_id: n.waba_id, p_phone_number_id: n.phone_number_id, p_events: n.events});
      if (error) throw error;
    } catch (err) {
      // 503 faz o WasapFlow reenviar (por 24 h); a deduplicação no banco impede duplicidade.
      const e = err as {code?: string; message?: string};
      console.error('[wasapflow] evento não persistido; o WasapFlow vai reenviar', {
        count: n.events.length, code: e?.code, reason: String(e?.message || '').replace(/\d+/g, '#').slice(0, 160),
      });
      return reply({error: 'Indisponível'}, 503);
    }
  }

  after(async () => {
    if (n.desconhecido) {
      // Evento novo do WasapFlow/Meta: registra 1ª, 2ª, 4ª, 8ª... vez (só o nome, sem conteúdo).
      const vezes = (desconhecidos.get(n.desconhecido) || 0) + 1;
      desconhecidos.set(n.desconhecido, vezes);
      if (deveRegistrar(vezes)) console.warn('[wasapflow] evento não tratado', {evento: n.desconhecido, vezes});
    }
    if (n.semTelefone) console.warn('[wasapflow] mensagem sem telefone e sem ID do cliente ignorada', {quantas: n.semTelefone});
    if (n.aviso || n.templates) {
      try {
        const db = serviceClient();
        let q = db.from('wa_accounts').select(CAMPOS_CONTA).eq('provider', 'wasapflow').eq('waba_id', n.waba_id);
        if (n.phone_number_id) q = q.eq('phone_number_id', n.phone_number_id);
        const {data} = await q.limit(5);
        for (const conta of (data || []) as Conta[]) {
          if (n.aviso?.set) await registrarAviso(db, conta, n.aviso.set);
          else if (n.aviso?.clear) await registrarAviso(db, conta, null, n.aviso.clear);
          if (n.templates) await syncTemplatesDaConta(conta, true);
        }
      } catch { console.error('[wasapflow] aviso ou modelos do número adiados'); }
    }
    if (n.events.length) await (n.events.some(e => e.type === 'message') ? drainAllWithAgent() : drainAll());
  });
  return reply({received: true});
}

import {timingSafeEqual} from 'node:crypto';
import {reply} from '@/lib/http';
import {drainEvents, drainOutbox} from '@/lib/whatsapp-worker';
import {runAgent} from '@/lib/agente-runner';
import {transcreverPendentes} from '@/lib/transcricao';

export const dynamic = 'force-dynamic';

// Executor manual/agendado da fila do WhatsApp. Mesmo padrão de /api/worker:
// exige "Authorization: Bearer CRON_SECRET" (nunca na URL).
export async function GET(req: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  const actual = req.headers.get('authorization') || '';
  if (!process.env.CRON_SECRET || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    return reply({error: 'Não autorizado'}, 401);
  }
  try {
    const events = await drainEvents();
    const audios = await transcreverPendentes().catch(() => null);
    const agente = await runAgent().catch(() => null);
    return reply({events, audios, agente, outbox: await drainOutbox()});
  } catch {
    return reply({error: 'Worker indisponível'}, 503);
  }
}

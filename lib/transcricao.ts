import 'server-only';
import {serviceClient} from '@/lib/supabase/server';
import {baixarMidia, CAMPOS_CONTA, type Conta} from '@/lib/wa-provedor';

// Transcreve os áudios que os clientes mandam no WhatsApp (OpenAI, chave só no servidor).
// Só áudios recebidos nos últimos 15 minutos; cada áudio é "reservado" antes (status running)
// para duas rodadas simultâneas não pagarem a mesma transcrição. Nada de conteúdo no log.
const MAX_BYTES = 8 * 1024 * 1024;
const pausa = (ms: number) => new Promise(r => setTimeout(r, ms));
// Falha passageira (rede, 5xx, 429, timeout): tenta mais uma vez depois de 1,5 s.
async function comRepeticao<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (!/rede|fetch|timeout|abort|5\d\d|429|indisponível|download/i.test(String((e as Error)?.message || ''))) throw e;
    await pausa(1500);
    return fn();
  }
}

export async function transcreverPendentes(limite = 5) {
  const chave = process.env.OPENAI_API_KEY;
  if (!chave) return {transcritos: 0};
  const db = serviceClient();
  const desde = new Date(Date.now() - 15 * 60_000).toISOString();
  const {data, error} = await db.from('wa_messages')
    .select('id,company_id,media_id,conversa:wa_conversations(account_id)')
    .eq('direction', 'inbound').eq('message_type', 'audio').is('transcript_status', null)
    .gte('created_at', desde).order('created_at').limit(limite);
  if (error) throw error;
  let transcritos = 0;
  const tokens = new Map<string, string | null>();
  const contas = new Map<string, Conta | null>();
  for (const m of (data || []) as any[]) {
    // Reserva: se outra rodada já pegou, pula
    const {data: reservado} = await db.from('wa_messages').update({transcript_status: 'running'})
      .eq('id', m.id).is('transcript_status', null).select('id');
    if (!reservado?.length) continue;
    const conta = (Array.isArray(m.conversa) ? m.conversa[0] : m.conversa)?.account_id as string | undefined;
    let status: 'done' | 'failed' | 'skipped' = 'failed';
    let texto: string | null = null;
    try {
      if (!m.media_id || !conta) { status = 'skipped'; throw new Error('sem mídia'); }
      if (!contas.has(conta)) {
        const {data: c} = await db.from('wa_accounts').select(CAMPOS_CONTA).eq('id', conta).maybeSingle();
        contas.set(conta, (c as Conta | null) ?? null);
      }
      const dadosConta = contas.get(conta);
      if (!dadosConta) throw new Error('sem conta');
      // Meta (EasyCoexistence) ou WasapFlow, pelo fornecedor do número
      const midia = await comRepeticao(() => baixarMidia(db, dadosConta, m.media_id, MAX_BYTES, tokens));
      if ('grande' in midia) { status = 'skipped'; throw new Error('grande'); }
      const {bytes} = midia;
      const tipo = midia.mime || 'audio/ogg';
      const j: any = await comRepeticao(async () => {
        const form = new FormData();
        form.append('file', new Blob([bytes], {type: tipo}), tipo.includes('mpeg') ? 'audio.mp3' : tipo.includes('mp4') ? 'audio.m4a' : 'audio.ogg');
        form.append('model', process.env.CRM_TRANSCRICAO_MODELO || 'gpt-4o-mini-transcribe');
        form.append('language', 'pt');
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST', headers: {Authorization: `Bearer ${chave}`}, body: form, signal: AbortSignal.timeout(30_000),
        });
        const d: any = await r.json().catch(() => null);
        if (!r.ok || typeof d?.text !== 'string') throw new Error(`openai ${r.status}`);
        return d;
      });
      texto = j.text.trim().slice(0, 6000) || null;
      status = texto ? 'done' : 'skipped';
      // Sem texto (silêncio, ruído): o agente pede para escrever ou passa para a equipe.
      if (!texto) console.warn('[transcricao] áudio sem fala reconhecida', {mensagem: m.id});
    } catch (e) {
      console.error('[transcricao] áudio não transcrito', {mensagem: m.id, motivo: String((e as Error)?.message || '').slice(0, 40)});
    }
    await db.from('wa_messages').update({transcript: texto, transcript_status: status}).eq('id', m.id).eq('company_id', m.company_id);
    if (status === 'done') transcritos++;
  }
  return {transcritos};
}

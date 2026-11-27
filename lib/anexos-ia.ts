import 'server-only';
import {serviceClient} from '@/lib/supabase/server';
import {baixarMidia, CAMPOS_CONTA, type Conta} from '@/lib/wa-provedor';
import {blocoDoAnexo, LIMITE} from '@/lib/anexos-agente.mjs';

// Baixa as imagens e documentos que o cliente acabou de mandar (Meta ou WasapFlow, pelo número) e monta
// os blocos para o Claude. Nada de conteúdo no log. Anexo que não abre fica marcado como 'failed'
// (o agente vê "não deu para abrir" e pede para escrever).
type Db = ReturnType<typeof serviceClient>;
export type Anexo = {id: string; media_id: string; tipo: 'image' | 'document'};

export async function carregarAnexos(db: Db, accountId: string | null, anexos: Anexo[]) {
  const blocos: unknown[] = [];
  const lidos: string[] = [];
  if (!anexos.length || !accountId) return {blocos, lidos};
  const {data: conta} = await db.from('wa_accounts').select(CAMPOS_CONTA).eq('id', accountId).maybeSingle();
  if (!conta) return {blocos, lidos};
  const tokens = new Map<string, string | null>();
  for (const a of anexos) {
    // Reserva: duas rodadas ao mesmo tempo não baixam o mesmo arquivo.
    const {data: meu} = await db.from('wa_messages').update({transcript_status: 'running'}).eq('id', a.id).is('transcript_status', null).select('id');
    if (!meu?.length) continue;
    let bloco: unknown = null;
    try {
      const midia = await baixarMidia(db, conta as Conta, a.media_id, LIMITE[a.tipo], tokens);
      if (!('grande' in midia)) bloco = blocoDoAnexo({tipo: a.tipo, mime: midia.mime, bytes: midia.bytes});
    } catch (e) {
      console.error('[agente] anexo não baixado', {mensagem: a.id, motivo: String((e as Error)?.message || '').slice(0, 40)});
    }
    if (bloco) { blocos.push(bloco); lidos.push(a.id); }
    else await db.from('wa_messages').update({transcript_status: 'failed'}).eq('id', a.id);
  }
  return {blocos, lidos};
}

/** Grava o que o agente viu em cada anexo (vira a "transcrição" da imagem/documento). Sem descrição = 'skipped' (não lê de novo). */
export async function gravarDescricoes(db: Db, lidos: string[], descricoes: string[] | undefined) {
  await Promise.all(lidos.map((id, i) => {
    const d = (descricoes || [])[i];
    return db.from('wa_messages').update(d ? {transcript: d, transcript_status: 'done'} : {transcript_status: 'skipped'})
      .eq('id', id).eq('transcript_status', 'running');
  }));
}

/** A IA falhou: solta os anexos para a próxima rodada tentar de novo. */
export async function soltarAnexos(db: Db, lidos: string[]) {
  if (lidos.length) await db.from('wa_messages').update({transcript_status: null}).in('id', lidos).eq('transcript_status', 'running');
}

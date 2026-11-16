-- Transcrição dos áudios recebidos no WhatsApp (feita pelo backend com a OpenAI).
-- transcript_status: running (em andamento), done, failed, skipped (grande demais ou sem mídia).
alter table public.wa_messages add column transcript text check (length(transcript) <= 6000);
alter table public.wa_messages add column transcript_status text check (transcript_status in ('running','done','failed','skipped'));
create index wa_messages_audio_pendente on public.wa_messages (created_at)
  where direction = 'inbound' and message_type = 'audio' and transcript_status is null;

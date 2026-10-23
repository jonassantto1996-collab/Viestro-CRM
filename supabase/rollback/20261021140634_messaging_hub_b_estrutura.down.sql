-- Rollback da Migration B (Messaging Hub · estrutura).
-- Remove SOMENTE objetos criados pela Migration B. Apaga dados de mensagens: exportar antes, se houver.
begin;
do $$ begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'wa_messages') then
    alter publication supabase_realtime drop table public.wa_conversations, public.wa_messages;
  end if;
end $$;
drop table if exists public.wa_audit_logs, public.wa_outbox, public.wa_consents, public.wa_templates,
  public.wa_webhook_events, public.wa_messages, public.wa_conversations, public.wa_contacts,
  public.wa_accounts;
drop function if exists crm_private.wa_touch(), crm_private.wa_check_account(), crm_private.wa_check_contact(),
  crm_private.wa_check_conversation(), crm_private.wa_block_mutation();
commit;

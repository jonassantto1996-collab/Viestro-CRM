-- Desfaz 20261025200000_agenda_e_financeiro.sql
-- ATENÇÃO: apaga os lançamentos financeiros e a agenda guardada.
drop function if exists public.crm_finance_save(jsonb), public.crm_finance_delete(uuid),
  crm_private.finance_save(jsonb), crm_private.finance_delete(uuid);
drop table if exists public.crm_finance_entries;
drop table if exists public.wa_address_book;
-- Em seguida, reaplicar as definições originais de crm_private.wa_contact e
-- crm_private.wa_process_event da migration 20261023130000_whatsapp_funcoes.sql
-- (trocando "create function" por "create or replace function") e os revokes da seção 7.

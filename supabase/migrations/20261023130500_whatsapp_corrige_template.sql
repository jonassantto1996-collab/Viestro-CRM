-- =====================================================================
-- WhatsApp no CRM · Correção da regra do nome do template (Migration B)
-- O PostgreSQL limita repetições de regex a 255; '{1,512}' recusava qualquer template.
-- Executada manualmente no Editor SQL do Supabase (exige confirmação do dono do projeto).
-- =====================================================================
alter table public.wa_templates drop constraint wa_templates_name_check;
alter table public.wa_templates add constraint wa_templates_name_check
  check (name ~ '^[a-z0-9_]+$' and length(name) between 1 and 512);

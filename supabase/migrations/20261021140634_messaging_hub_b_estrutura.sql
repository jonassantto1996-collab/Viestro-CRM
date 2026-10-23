-- =====================================================================
-- Vértice Messaging Hub · Migration B · Estrutura de dados
-- Projeto: vertice-motor-automacao (jucsyhcamxwgkshzkazv)
-- STATUS: APLICADA em 21/10/2026 (versão remota 20261021140634).
--
-- Princípios:
--   * Nenhuma tabela existente é alterada.
--   * Reaproveita crm_companies, crm_members, crm_records, crm_channels e
--     as funções crm_private.company() / crm_private.is_admin().
--   * Isolamento por company_id com chaves estrangeiras COMPOSTAS
--     (company_id, id): o banco recusa uma conversa de uma empresa
--     apontando para conta/contato de outra.
--   * Leitura pelo app: RLS por empresa. Escrita: somente por funções
--     SECURITY DEFINER (Migration C) ou pelo backend com chave de serviço.
--   * O Supabase concede ALL a anon/authenticated em tabelas novas de
--     public por padrão. Esta migration revoga isso explicitamente.
--   * Tokens nunca ficam em tabela: apenas a referência ao Supabase Vault.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- Funções auxiliares (schema privado, sem acesso de anon/authenticated)
-- ---------------------------------------------------------------------
create function crm_private.wa_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function crm_private.wa_check_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.crm_channels c
    where c.id = new.crm_channel_id
      and c.company_id = new.company_id
      and c.provider = 'whatsapp'
      and c.external_id = new.phone_number_id
  ) then
    raise exception 'Canal WhatsApp inconsistente com a empresa ou o phone_number_id';
  end if;
  return new;
end $$;

create function crm_private.wa_check_contact() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.crm_lead_id is not null and not exists (
    select 1 from public.crm_records r
    where r.id = new.crm_lead_id and r.company_id = new.company_id and r.kind = 'leads'
  ) then
    raise exception 'Lead inexistente ou de outra empresa';
  end if;
  return new;
end $$;

create function crm_private.wa_check_conversation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_user_id is not null and not exists (
    select 1 from public.crm_members m
    where m.user_id = new.assigned_user_id and m.company_id = new.company_id
  ) then
    raise exception 'Responsável não pertence à empresa';
  end if;
  return new;
end $$;

create function crm_private.wa_block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- única alteração permitida: anonimizar o autor quando o usuário é excluído (FK on delete set null)
  if old.actor_user_id is not null and new.actor_user_id is null
     and (to_jsonb(new) - 'actor_user_id') = (to_jsonb(old) - 'actor_user_id') then
    return new;
  end if;
  raise exception 'Registro de auditoria é somente inclusão';
end $$;

revoke all on function crm_private.wa_touch(), crm_private.wa_check_account(),
  crm_private.wa_check_contact(), crm_private.wa_check_conversation(),
  crm_private.wa_block_mutation() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1. Números conectados
-- ---------------------------------------------------------------------
create table public.wa_accounts (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.crm_companies(id) on delete cascade,
  crm_channel_id         uuid not null unique references public.crm_channels(id) on delete restrict,
  provider               text not null default 'easycoexistence'
                           check (provider in ('easycoexistence','meta_cloud')),
  phone_number_id        text not null unique check (phone_number_id ~ '^[0-9]{5,30}$'),
  waba_id                text not null check (waba_id ~ '^[0-9]{5,30}$'),
  phone_e164             text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name           text check (length(display_name) <= 120),
  coexistence            boolean not null default true,
  connection_status      text not null default 'pending'
                           check (connection_status in ('pending','connected','degraded','disconnected')),
  access_token_secret_id uuid,          -- id em vault.secrets; nunca o token em si
  connected_at           timestamptz,
  last_health_check_at   timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (company_id, id)
);
create index wa_accounts_company_idx on public.wa_accounts (company_id);
create trigger wa_accounts_check before insert or update on public.wa_accounts
  for each row execute function crm_private.wa_check_account();
create trigger wa_accounts_touch before update on public.wa_accounts
  for each row execute function crm_private.wa_touch();

-- ---------------------------------------------------------------------
-- 2. Contatos (por empresa; compartilhados entre os números da empresa)
-- ---------------------------------------------------------------------
create table public.wa_contacts (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.crm_companies(id) on delete cascade,
  wa_id                text not null check (wa_id ~ '^[0-9]{8,15}$'),
  phone_e164           text generated always as ('+' || wa_id) stored,
  name                 text check (length(name) <= 120),
  crm_lead_id          uuid references public.crm_records(id) on delete set null,
  marketing_opt_out_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (company_id, wa_id),
  unique (company_id, id)
);
create index wa_contacts_lead_idx on public.wa_contacts (crm_lead_id) where crm_lead_id is not null;
create trigger wa_contacts_check before insert or update of crm_lead_id, company_id on public.wa_contacts
  for each row execute function crm_private.wa_check_contact();
create trigger wa_contacts_touch before update on public.wa_contacts
  for each row execute function crm_private.wa_touch();

-- ---------------------------------------------------------------------
-- 3. Conversas (uma por número + contato)
-- ---------------------------------------------------------------------
create table public.wa_conversations (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.crm_companies(id) on delete cascade,
  account_id                uuid not null,
  contact_id                uuid not null,
  assigned_user_id          uuid references public.crm_members(user_id) on delete set null,
  status                    text not null default 'open' check (status in ('open','pending','resolved')),
  category                  text check (length(category) between 1 and 60),
  unread_count              integer not null default 0 check (unread_count >= 0),
  first_inbound_at          timestamptz,
  first_response_at         timestamptz,
  last_inbound_at           timestamptz,
  last_outbound_at          timestamptz,
  last_message_at           timestamptz,
  last_message_preview      text check (length(last_message_preview) <= 160),
  service_window_expires_at timestamptz,   -- last_inbound_at + 24h (mantido pela função de ingestão)
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (account_id, contact_id),
  unique (company_id, id),
  foreign key (company_id, account_id) references public.wa_accounts (company_id, id) on delete cascade,
  foreign key (company_id, contact_id) references public.wa_contacts (company_id, id) on delete cascade
);
create index wa_conversations_inbox_idx on public.wa_conversations (company_id, status, last_message_at desc);
create index wa_conversations_assignee_idx on public.wa_conversations (assigned_user_id) where assigned_user_id is not null;
create index wa_conversations_account_idx on public.wa_conversations (company_id, account_id);
create index wa_conversations_contact_idx on public.wa_conversations (company_id, contact_id);
create trigger wa_conversations_check before insert or update of assigned_user_id, company_id on public.wa_conversations
  for each row execute function crm_private.wa_check_conversation();
create trigger wa_conversations_touch before update on public.wa_conversations
  for each row execute function crm_private.wa_touch();

-- ---------------------------------------------------------------------
-- 4. Mensagens
-- ---------------------------------------------------------------------
create table public.wa_messages (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null,
  conversation_id     uuid not null,
  external_message_id text check (length(external_message_id) <= 200),   -- wamid
  direction           text not null check (direction in ('inbound','outbound')),
  source              text not null check (source in ('api_inbound','crm','app_echo','history_sync')),
  message_type        text not null default 'text' check (length(message_type) <= 40),
  body                text check (length(body) <= 6000),
  media_id            text check (length(media_id) <= 200),             -- referência Meta; sem download no MVP
  template_name       text check (length(template_name) <= 512),
  sent_by_user_id     uuid references auth.users(id) on delete set null,
  message_status      text not null
                        check (message_status in ('received','queued','sent','delivered','read','failed')),
  error_code          text check (length(error_code) <= 40),
  provider_timestamp  timestamptz,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  created_at          timestamptz not null default now(),
  foreign key (company_id, conversation_id) references public.wa_conversations (company_id, id) on delete cascade,
  check (direction = 'outbound' or source in ('api_inbound','history_sync')),
  check (direction = 'inbound'  or source in ('crm','app_echo','history_sync')),
  check (source <> 'crm' or sent_by_user_id is not null or template_name is not null)
);
create unique index wa_messages_external_uidx on public.wa_messages (company_id, external_message_id)
  where external_message_id is not null;
create index wa_messages_conversation_idx on public.wa_messages (company_id, conversation_id, created_at desc);

-- ---------------------------------------------------------------------
-- 5. Eventos de webhook (fila de ingestão; payload com retenção curta)
-- ---------------------------------------------------------------------
create table public.wa_webhook_events (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid references public.crm_companies(id) on delete cascade,
  account_id         uuid,
  event_type         text not null check (event_type in ('message','status','echo','history','contacts_sync','unknown')),
  external_event_id  text not null unique check (length(external_event_id) <= 300),
  payload_restricted jsonb not null
                       check (jsonb_typeof(payload_restricted) = 'object'
                              and octet_length(payload_restricted::text) <= 60000),
  processing_status  text not null default 'pending'
                       check (processing_status in ('pending','running','done','failed','dead')),
  attempts           integer not null default 0 check (attempts >= 0),
  next_run           timestamptz not null default now(),
  lease_until        timestamptz,
  lease_token        uuid,
  last_error         text check (length(last_error) <= 200),
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  purge_after        timestamptz not null default (now() + interval '30 days'),
  foreign key (company_id, account_id) references public.wa_accounts (company_id, id) on delete set null (account_id)
);
create index wa_webhook_events_ready_idx on public.wa_webhook_events (next_run, received_at)
  where processing_status in ('pending','running');
create index wa_webhook_events_purge_idx on public.wa_webhook_events (purge_after);
create index wa_webhook_events_account_idx on public.wa_webhook_events (company_id, account_id);

-- ---------------------------------------------------------------------
-- 6. Templates aprovados pela Meta (cache sincronizado)
-- ---------------------------------------------------------------------
create table public.wa_templates (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  account_id           uuid not null,
  external_template_id text check (length(external_template_id) <= 100),
  name                 text not null check (name ~ '^[a-z0-9_]{1,512}$'),
  language             text not null check (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  category             text not null check (category in ('MARKETING','UTILITY','AUTHENTICATION')),
  status               text not null check (status in ('APPROVED','PENDING','REJECTED','PAUSED','DISABLED','IN_APPEAL','PENDING_DELETION','DELETED','LIMIT_EXCEEDED','ARCHIVED')),
  components           jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(components) = 'array' and octet_length(components::text) <= 20000),
  last_synced_at       timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (account_id, name, language),
  foreign key (company_id, account_id) references public.wa_accounts (company_id, id) on delete cascade
);
create index wa_templates_company_idx on public.wa_templates (company_id, account_id);
create trigger wa_templates_touch before update on public.wa_templates
  for each row execute function crm_private.wa_touch();

-- ---------------------------------------------------------------------
-- 7. Consentimentos (LGPD + política da Meta)
-- ---------------------------------------------------------------------
create table public.wa_consents (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  contact_id  uuid not null,
  purpose     text not null check (purpose in ('service','utility','marketing')),
  status      text not null check (status in ('granted','revoked')),
  source      text not null check (source in ('whatsapp_inbound','form','manual','import')),
  evidence    text check (length(evidence) <= 1000),
  recorded_by uuid references auth.users(id) on delete set null,
  granted_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (company_id, contact_id) references public.wa_contacts (company_id, id) on delete cascade,
  -- lista importada nunca vale como autorização de marketing sem evidência registrada
  check (not (purpose = 'marketing' and status = 'granted' and source = 'import' and evidence is null)),
  check ((status = 'granted' and granted_at is not null) or (status = 'revoked' and revoked_at is not null))
);
create index wa_consents_lookup_idx on public.wa_consents (company_id, contact_id, purpose, created_at desc);

-- ---------------------------------------------------------------------
-- 8. Fila de envio (idempotente; envio só após checagem de regras)
-- ---------------------------------------------------------------------
create table public.wa_outbox (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  conversation_id uuid not null,
  kind            text not null check (kind in ('text','template')),
  payload         jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 20000),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  requested_by    uuid references auth.users(id) on delete set null,
  status          text not null default 'pending'
                    check (status in ('pending','running','sent','failed','dead','blocked')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_run        timestamptz not null default now(),
  lease_until     timestamptz,
  lease_token     uuid,
  last_error      text check (length(last_error) <= 200),
  message_id      uuid references public.wa_messages(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, idempotency_key),
  foreign key (company_id, conversation_id) references public.wa_conversations (company_id, id) on delete cascade
);
create index wa_outbox_ready_idx on public.wa_outbox (next_run, created_at) where status in ('pending','running');
create index wa_outbox_conversation_idx on public.wa_outbox (company_id, conversation_id);
create index wa_outbox_message_idx on public.wa_outbox (message_id) where message_id is not null;
create trigger wa_outbox_touch before update on public.wa_outbox
  for each row execute function crm_private.wa_touch();

-- ---------------------------------------------------------------------
-- 9. Auditoria (somente inclusão; sem dados pessoais em metadata)
-- ---------------------------------------------------------------------
create table public.wa_audit_logs (
  id            bigint generated always as identity primary key,
  company_id    uuid not null references public.crm_companies(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_kind    text not null check (actor_kind in ('user','system','webhook','platform_admin')),
  action        text not null check (length(action) between 1 and 80),
  target_type   text check (length(target_type) <= 40),
  target_id     uuid,
  metadata      jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4000),
  created_at    timestamptz not null default now()
);
create index wa_audit_logs_company_idx on public.wa_audit_logs (company_id, created_at desc);
create index wa_audit_logs_actor_idx on public.wa_audit_logs (actor_user_id) where actor_user_id is not null;
create trigger wa_audit_logs_immutable before update on public.wa_audit_logs
  for each row execute function crm_private.wa_block_mutation();

-- ---------------------------------------------------------------------
-- Privilégios: revoga o padrão do Supabase e concede só leitura
-- ---------------------------------------------------------------------
revoke all on public.wa_accounts, public.wa_contacts, public.wa_conversations, public.wa_messages,
              public.wa_webhook_events, public.wa_templates, public.wa_consents, public.wa_outbox,
              public.wa_audit_logs
  from anon, authenticated;
revoke all on sequence public.wa_audit_logs_id_seq from anon, authenticated;

-- service_role: tudo, exceto alterar/apagar auditoria
grant select, insert, update, delete on public.wa_accounts, public.wa_contacts, public.wa_conversations,
  public.wa_messages, public.wa_webhook_events, public.wa_templates, public.wa_consents, public.wa_outbox
  to service_role;
revoke update, delete, truncate on public.wa_audit_logs from service_role;
grant select, insert on public.wa_audit_logs to service_role;

-- authenticated: somente leitura, filtrada por RLS. Coluna do cofre fica de fora.
grant select (id, company_id, crm_channel_id, provider, phone_number_id, waba_id, phone_e164, display_name,
              coexistence, connection_status, connected_at, last_health_check_at, created_at, updated_at)
  on public.wa_accounts to authenticated;
grant select on public.wa_contacts, public.wa_conversations, public.wa_messages, public.wa_templates,
                public.wa_consents, public.wa_audit_logs
  to authenticated;
-- wa_webhook_events e wa_outbox: nenhum acesso pelo app (somente backend).

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.wa_accounts       enable row level security;
alter table public.wa_contacts       enable row level security;
alter table public.wa_conversations  enable row level security;
alter table public.wa_messages       enable row level security;
alter table public.wa_webhook_events enable row level security;
alter table public.wa_templates      enable row level security;
alter table public.wa_consents       enable row level security;
alter table public.wa_outbox         enable row level security;
alter table public.wa_audit_logs     enable row level security;

create policy wa_accounts_read      on public.wa_accounts      for select to authenticated
  using (company_id = (select crm_private.company()));
create policy wa_contacts_read      on public.wa_contacts      for select to authenticated
  using (company_id = (select crm_private.company()));
create policy wa_conversations_read on public.wa_conversations for select to authenticated
  using (company_id = (select crm_private.company()));
create policy wa_messages_read      on public.wa_messages      for select to authenticated
  using (company_id = (select crm_private.company()));
create policy wa_templates_read     on public.wa_templates     for select to authenticated
  using (company_id = (select crm_private.company()));
create policy wa_consents_read      on public.wa_consents      for select to authenticated
  using (company_id = (select crm_private.company()));
create policy wa_audit_logs_admin_read on public.wa_audit_logs for select to authenticated
  using (company_id = (select crm_private.company()) and (select crm_private.is_admin()));
-- wa_webhook_events e wa_outbox: RLS ligado e sem políticas = nenhum acesso por anon/authenticated.

-- ---------------------------------------------------------------------
-- Realtime para a caixa de entrada (RLS também se aplica ao Realtime)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.wa_conversations, public.wa_messages;
  end if;
end $$;

commit;

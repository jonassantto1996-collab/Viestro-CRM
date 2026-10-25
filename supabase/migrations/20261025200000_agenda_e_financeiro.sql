-- =====================================================================
-- Viestro CRM · Agenda do WhatsApp e Financeiro
-- ---------------------------------------------------------------------
-- 1. wa_address_book: nomes da agenda do celular (só nome + número),
--    usados para batizar conversas novas com o nome salvo. Uso interno:
--    nenhum acesso direto pelo navegador.
-- 2. Ajustes nas funções do WhatsApp:
--    - wa_contact: conversa nova já nasce com o nome da agenda;
--    - wa_process_event: a agenda é guardada sem depender de conversa
--      (antes, o evento ficava tentando de novo até "morrer");
--      mensagem ao vivo que já veio no histórico deixa de ser "histórico".
-- 3. crm_finance_entries: lançamentos financeiros (entradas e despesas)
--    por empresa, visíveis só para administradores da própria empresa.
--    Escrita apenas pelas funções crm_finance_save / crm_finance_delete.
-- Nenhuma tabela existente tem a estrutura alterada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Agenda do WhatsApp
-- ---------------------------------------------------------------------
create table public.wa_address_book (
  company_id uuid not null references public.crm_companies (id) on delete cascade,
  wa_id      text not null check (wa_id ~ '^[0-9]{8,15}$'),
  name       text not null check (length(name) between 1 and 120),
  updated_at timestamptz not null default now(),
  primary key (company_id, wa_id)
);
alter table public.wa_address_book enable row level security;
revoke all on public.wa_address_book from anon, authenticated;
grant all on public.wa_address_book to service_role;

-- ---------------------------------------------------------------------
-- 2. Funções do WhatsApp
-- ---------------------------------------------------------------------
create or replace function crm_private.wa_contact(p_company uuid, p_wa_id text, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_book text;
  v_name text := nullif(left(trim(coalesce(p_name,'')),120),'');
begin
  -- Nome salvo na agenda do celular vale mais que o nome do perfil do WhatsApp
  select name into v_book from public.wa_address_book where company_id = p_company and wa_id = p_wa_id;
  v_name := coalesce(v_book, v_name);
  select id into v_id from public.wa_contacts where company_id = p_company and wa_id = p_wa_id;
  if v_id is null then
    insert into public.wa_contacts (company_id, wa_id, name) values (p_company, p_wa_id, v_name)
    on conflict (company_id, wa_id) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.wa_contacts where company_id = p_company and wa_id = p_wa_id;
    end if;
  elsif v_name is not null then
    update public.wa_contacts set name = v_name where id = v_id and name is null;
  end if;
  return v_id;
end $$;

create or replace function crm_private.wa_process_event(ev public.wa_webhook_events) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := ev.payload_restricted;
  v_ts timestamptz; v_contact uuid; v_conv uuid; v_body text; v_dir text; v_status text; n int;
  v_settings jsonb; v_name text;
begin
  v_ts := coalesce((p->>'ts')::timestamptz, ev.received_at);
  v_body := nullif(left(coalesce(p->>'body',''), 6000), '');

  if ev.event_type in ('message','echo','history') then
    if coalesce(p->>'wa_id','') !~ '^[0-9]{8,15}$' or coalesce(p->>'wamid','') = '' then
      return;  -- sem dados mínimos: descarta (não faz sentido tentar de novo)
    end if;
    v_contact := crm_private.wa_contact(ev.company_id, p->>'wa_id', case when ev.event_type = 'message' then p->>'name' end);
    v_conv := crm_private.wa_conversation(ev.company_id, ev.account_id, v_contact);
    v_dir := case ev.event_type when 'message' then 'inbound' when 'echo' then 'outbound'
                  else case when p->>'direction' = 'outbound' then 'outbound' else 'inbound' end end;
    v_status := case when v_dir = 'inbound' then 'received'
                     when p->>'status' in ('delivered','read') then p->>'status' else 'sent' end;

    insert into public.wa_messages (company_id, conversation_id, external_message_id, direction, source,
      message_type, body, media_id, message_status, provider_timestamp, sent_at, delivered_at, read_at)
    values (ev.company_id, v_conv, p->>'wamid', v_dir,
      case ev.event_type when 'message' then 'api_inbound' when 'echo' then 'app_echo' else 'history_sync' end,
      left(coalesce(p->>'type','text'),40), v_body, nullif(left(coalesce(p->>'media_id',''),200),''),
      v_status, v_ts,
      case when v_dir = 'outbound' then v_ts end,
      case when v_status in ('delivered','read') then v_ts end,
      case when v_status = 'read' then v_ts end)
    on conflict (company_id, external_message_id) where external_message_id is not null do nothing;
    get diagnostics n = row_count;
    if n = 0 then
      -- Já registrada. Se veio primeiro pelo histórico, passa a valer a origem ao vivo.
      if ev.event_type in ('message','echo') then
        update public.wa_messages
           set source = case ev.event_type when 'message' then 'api_inbound' else 'app_echo' end
         where company_id = ev.company_id and external_message_id = p->>'wamid' and source = 'history_sync';
      end if;
      return;
    end if;

    if v_dir = 'inbound' then
      update public.wa_conversations set
        unread_count = unread_count + case when ev.event_type = 'message' then 1 else 0 end,
        first_inbound_at = least(coalesce(first_inbound_at, v_ts), v_ts),
        last_inbound_at = greatest(coalesce(last_inbound_at, v_ts), v_ts),
        last_message_preview = case when v_ts >= coalesce(last_message_at, v_ts)
                                    then left(coalesce(v_body, '[' || coalesce(p->>'type','mensagem') || ']'), 160)
                                    else last_message_preview end,
        last_message_at = greatest(coalesce(last_message_at, v_ts), v_ts),
        service_window_expires_at = greatest(coalesce(service_window_expires_at, '-infinity'::timestamptz), v_ts + interval '24 hours'),
        status = case when ev.event_type = 'message' and status = 'resolved' then 'open' else status end
      where id = v_conv;

      if ev.event_type = 'message' then
        -- Descadastro por palavra-chave (vale para marketing; atendimento continua permitido)
        if upper(trim(coalesce(v_body,''))) in ('SAIR','PARAR','STOP','CANCELAR','DESCADASTRAR') then
          update public.wa_contacts set marketing_opt_out_at = coalesce(marketing_opt_out_at, v_ts) where id = v_contact;
          insert into public.wa_consents (company_id, contact_id, purpose, status, source, evidence, revoked_at)
          values (ev.company_id, v_contact, 'marketing', 'revoked', 'whatsapp_inbound', 'Palavra-chave de descadastro', v_ts);
        end if;
        -- Lead automático só se a empresa ativar (padrão: manual, para não poluir o funil)
        select settings into v_settings from public.crm_companies where id = ev.company_id;
        if coalesce((v_settings->>'wa_auto_lead')::boolean, false) then
          perform crm_private.wa_link_lead(ev.company_id, v_contact);
        end if;
      end if;
    else
      update public.wa_conversations set
        last_outbound_at = greatest(coalesce(last_outbound_at, v_ts), v_ts),
        first_response_at = case when ev.event_type = 'echo' and first_response_at is null
                                      and first_inbound_at is not null and v_ts >= first_inbound_at
                                 then v_ts else first_response_at end,
        unread_count = case when ev.event_type = 'echo' and v_ts >= coalesce(last_inbound_at, v_ts) then 0 else unread_count end,
        last_message_preview = case when v_ts >= coalesce(last_message_at, v_ts)
                                    then left(coalesce(v_body, '[' || coalesce(p->>'type','mensagem') || ']'), 160)
                                    else last_message_preview end,
        last_message_at = greatest(coalesce(last_message_at, v_ts), v_ts)
      where id = v_conv;
    end if;

  elsif ev.event_type = 'status' then
    v_status := p->>'status';
    if v_status not in ('sent','delivered','read','failed') or coalesce(p->>'wamid','') = '' then return; end if;
    update public.wa_messages m set
      message_status = case
        when v_status = 'failed' then case when crm_private.wa_status_rank(m.message_status) >= 2 then m.message_status else 'failed' end
        when m.message_status = 'failed' then v_status
        when crm_private.wa_status_rank(v_status) > crm_private.wa_status_rank(m.message_status) then v_status
        else m.message_status end,
      sent_at = case when v_status in ('sent','delivered','read') then coalesce(m.sent_at, v_ts) else m.sent_at end,
      delivered_at = case when v_status in ('delivered','read') then coalesce(m.delivered_at, v_ts) else m.delivered_at end,
      read_at = case when v_status = 'read' then coalesce(m.read_at, v_ts) else m.read_at end,
      failed_at = case when v_status = 'failed' then coalesce(m.failed_at, v_ts) else m.failed_at end,
      error_code = case when v_status = 'failed' then nullif(left(coalesce(p->>'error_code',''),40),'') else m.error_code end
    where m.company_id = ev.company_id and m.external_message_id = p->>'wamid' and m.direction = 'outbound';
    get diagnostics n = row_count;
    if n = 0 and ev.received_at > now() - interval '15 minutes' then
      raise exception 'Mensagem ainda não registrada';  -- chegou antes do registro do envio: tenta de novo
    end if;

  elsif ev.event_type = 'contacts_sync' then
    -- Agenda do celular: guarda nome + número e atualiza a conversa, se já existir.
    if coalesce(p->>'wa_id','') !~ '^[0-9]{8,15}$' then return; end if;
    v_name := nullif(left(trim(coalesce(p->>'name','')),120),'');
    if p->>'action' = 'remove' then
      delete from public.wa_address_book where company_id = ev.company_id and wa_id = p->>'wa_id';
    elsif v_name is not null then
      insert into public.wa_address_book (company_id, wa_id, name) values (ev.company_id, p->>'wa_id', v_name)
      on conflict (company_id, wa_id) do update set name = excluded.name, updated_at = now();
      update public.wa_contacts set name = v_name where company_id = ev.company_id and wa_id = p->>'wa_id';
    end if;
  end if;
end $$;

-- Mensagens recebidas/enviadas depois da conexão que chegaram junto do histórico
update public.wa_messages m
   set source = case m.direction when 'inbound' then 'api_inbound' else 'app_echo' end
  from public.wa_conversations c
  join public.wa_accounts a on a.id = c.account_id
 where m.conversation_id = c.id and m.source = 'history_sync'
   and a.connected_at is not null and m.provider_timestamp >= a.connected_at;

-- Reprocessa a agenda que já chegou (os eventos ainda estão guardados)
update public.wa_webhook_events
   set processing_status = 'pending', attempts = 0, next_run = now(), last_error = null
 where event_type = 'contacts_sync' and processing_status = 'dead';

-- ---------------------------------------------------------------------
-- 3. Financeiro
-- ---------------------------------------------------------------------
create table public.crm_finance_entries (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.crm_companies (id) on delete cascade,
  kind         text not null check (kind in ('income','expense')),
  occurred_on  date not null,
  description  text not null check (length(description) between 1 and 300),
  category     text not null check (length(category) between 1 and 80),
  client_name  text check (length(client_name) <= 120),
  lead_id      uuid references public.crm_records (id) on delete set null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000000),
  method       text check (method in ('pix','dinheiro','cartao_credito','cartao_debito','boleto','transferencia','outro')),
  status       text not null check (status in ('paid','pending')),
  paid_on      date,
  notes        text check (length(notes) <= 2000),
  created_by   uuid references auth.users (id) on delete set null,
  updated_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((status = 'paid') = (paid_on is not null))
);
create index crm_finance_company_date_idx on public.crm_finance_entries (company_id, occurred_on desc);
create index crm_finance_lead_idx on public.crm_finance_entries (lead_id) where lead_id is not null;
create index crm_finance_created_by_idx on public.crm_finance_entries (created_by);
create index crm_finance_updated_by_idx on public.crm_finance_entries (updated_by);

alter table public.crm_finance_entries enable row level security;
create policy finance_read on public.crm_finance_entries for select to authenticated
  using (company_id = (select crm_private.company()) and (select crm_private.is_admin()));
revoke all on public.crm_finance_entries from anon, authenticated;
grant select on public.crm_finance_entries to authenticated;
grant all on public.crm_finance_entries to service_role;

create function crm_private.finance_save(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  tid uuid := crm_private.company();
  rid uuid;
  v_kind text := p->>'kind';
  v_date date;
  v_paid date;
  v_status text := p->>'status';
  v_amount bigint;
  v_lead uuid;
  v_method text := nullif(p->>'method','');
begin
  if tid is null then raise exception 'Faça login'; end if;
  if not crm_private.is_admin() then raise exception 'Somente administradores acessam o financeiro'; end if;
  if jsonb_typeof(p) <> 'object' or octet_length(p::text) > 8000 then raise exception 'Dados inválidos'; end if;
  if v_kind not in ('income','expense') then raise exception 'Tipo de lançamento inválido'; end if;
  if coalesce(p->>'occurred_on','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Informe a data'; end if;
  v_date := (p->>'occurred_on')::date;
  if length(trim(coalesce(p->>'description',''))) = 0 then raise exception 'Informe a descrição'; end if;
  if length(trim(coalesce(p->>'category',''))) = 0 then raise exception 'Informe o serviço ou a categoria'; end if;
  if coalesce(p->>'amount_cents','') !~ '^\d{1,12}$' then raise exception 'Valor inválido'; end if;
  v_amount := (p->>'amount_cents')::bigint;
  if v_amount <= 0 or v_amount > 100000000000 then raise exception 'Valor inválido'; end if;
  if v_status not in ('paid','pending') then raise exception 'Situação inválida'; end if;
  if v_method is not null and v_method not in ('pix','dinheiro','cartao_credito','cartao_debito','boleto','transferencia','outro') then
    raise exception 'Forma de pagamento inválida';
  end if;
  if v_status = 'paid' then
    if coalesce(p->>'paid_on','') ~ '^\d{4}-\d{2}-\d{2}$' then v_paid := (p->>'paid_on')::date; else v_paid := v_date; end if;
  end if;
  if coalesce(p->>'lead_id','') <> '' then
    if p->>'lead_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Lead inválido'; end if;
    v_lead := (p->>'lead_id')::uuid;
    if not exists (select 1 from public.crm_records where id = v_lead and company_id = tid and kind = 'leads') then
      raise exception 'Lead inválido';
    end if;
  end if;

  if coalesce(p->>'id','') = '' then
    insert into public.crm_finance_entries (company_id, kind, occurred_on, description, category, client_name, lead_id,
      amount_cents, method, status, paid_on, notes, created_by, updated_by)
    values (tid, v_kind, v_date, left(trim(p->>'description'),300), left(trim(p->>'category'),80),
      nullif(left(trim(coalesce(p->>'client_name','')),120),''), v_lead, v_amount, v_method, v_status, v_paid,
      nullif(left(trim(coalesce(p->>'notes','')),2000),''), auth.uid(), auth.uid())
    returning id into rid;
  else
    if p->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Lançamento não encontrado'; end if;
    update public.crm_finance_entries set
      kind = v_kind, occurred_on = v_date, description = left(trim(p->>'description'),300),
      category = left(trim(p->>'category'),80), client_name = nullif(left(trim(coalesce(p->>'client_name','')),120),''),
      lead_id = v_lead, amount_cents = v_amount, method = v_method, status = v_status, paid_on = v_paid,
      notes = nullif(left(trim(coalesce(p->>'notes','')),2000),''), updated_by = auth.uid(), updated_at = now()
    where id = (p->>'id')::uuid and company_id = tid
    returning id into rid;
    if rid is null then raise exception 'Lançamento não encontrado'; end if;
  end if;
  return rid;
end $$;

create function crm_private.finance_delete(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare tid uuid := crm_private.company();
begin
  if tid is null then raise exception 'Faça login'; end if;
  if not crm_private.is_admin() then raise exception 'Somente administradores acessam o financeiro'; end if;
  delete from public.crm_finance_entries where id = p_id and company_id = tid;
  if not found then raise exception 'Lançamento não encontrado'; end if;
end $$;

create function public.crm_finance_save(p jsonb) returns uuid
language sql security invoker set search_path = '' as $$ select crm_private.finance_save(p) $$;
create function public.crm_finance_delete(p_id uuid) returns void
language sql security invoker set search_path = '' as $$ select crm_private.finance_delete(p_id) $$;

-- ---------------------------------------------------------------------
-- 4. Permissões (o Supabase concede EXECUTE a PUBLIC por padrão)
-- ---------------------------------------------------------------------
revoke all on function
  crm_private.wa_contact(uuid,text,text), crm_private.wa_process_event(public.wa_webhook_events),
  crm_private.finance_save(jsonb), crm_private.finance_delete(uuid),
  public.crm_finance_save(jsonb), public.crm_finance_delete(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  crm_private.finance_save(jsonb), crm_private.finance_delete(uuid),
  public.crm_finance_save(jsonb), public.crm_finance_delete(uuid)
to authenticated;

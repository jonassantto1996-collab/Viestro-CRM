-- =====================================================================
-- WhatsApp no CRM · Migration C · Funções de recebimento, processamento e envio
-- Projeto: vertice-motor-automacao (jucsyhcamxwgkshzkazv)
--
-- Fluxo:
--   Meta → /api/webhooks/whatsapp/<chave> → public.wa_ingest()  (só grava o evento, deduplicado)
--   pg_cron (1/min) e o próprio webhook → crm_private.wa_run_events()  (processa em SQL)
--   Operador → public.crm_wa_send_text()/crm_wa_send_template()  (valida regras e enfileira)
--   Backend → public.wa_claim_outbox() → Cloud API → public.wa_outbox_result()
--
-- Segurança:
--   * Funções de backend: EXECUTE somente para service_role.
--   * Funções do operador: wrapper "security invoker" em public chamando a
--     implementação "security definer" em crm_private (mesmo padrão do CRM),
--     sempre validando a empresa por crm_private.company().
--   * Nenhum conteúdo de mensagem vai para last_error ou auditoria.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0b. Índices apontados pelo Advisor de performance
-- ---------------------------------------------------------------------
create index wa_consents_recorded_by_idx on public.wa_consents (recorded_by);
create index wa_messages_sent_by_idx     on public.wa_messages (sent_by_user_id);
create index wa_outbox_requested_by_idx  on public.wa_outbox (requested_by);

-- ---------------------------------------------------------------------
-- 1. Ingestão (chamada pelo webhook com a chave de serviço)
--    p_events: [{type, key, phone_number_id, payload}]
-- ---------------------------------------------------------------------
create function public.wa_ingest(p_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e jsonb; v_account uuid; v_company uuid; n int;
  v_inserted int := 0; v_dup int := 0; v_ignored int := 0;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 5000 then
    raise exception 'Lote inválido';
  end if;
  for e in select value from jsonb_array_elements(p_events) loop
    if coalesce(e->>'type','') not in ('message','status','echo','history','contacts_sync')
       or length(coalesce(e->>'key','')) not between 1 and 300
       or jsonb_typeof(e->'payload') <> 'object' then
      v_ignored := v_ignored + 1; continue;
    end if;
    select a.id, a.company_id into v_account, v_company
      from public.wa_accounts a
      join public.crm_channels c on c.id = a.crm_channel_id
     where a.phone_number_id = e->>'phone_number_id'
       and c.enabled and a.connection_status <> 'disconnected';
    if not found then v_ignored := v_ignored + 1; continue; end if;
    insert into public.wa_webhook_events (company_id, account_id, event_type, external_event_id, payload_restricted)
    values (v_company, v_account, e->>'type', e->>'key', e->'payload')
    on conflict (external_event_id) do nothing;
    get diagnostics n = row_count;
    if n = 1 then v_inserted := v_inserted + 1; else v_dup := v_dup + 1; end if;
  end loop;
  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_dup, 'ignored', v_ignored);
end $$;

-- ---------------------------------------------------------------------
-- 2. Auxiliares de processamento
-- ---------------------------------------------------------------------
create function crm_private.wa_contact(p_company uuid, p_wa_id text, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := nullif(left(trim(coalesce(p_name,'')),120),'');
begin
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

create function crm_private.wa_conversation(p_company uuid, p_account uuid, p_contact uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.wa_conversations where account_id = p_account and contact_id = p_contact;
  if v_id is null then
    insert into public.wa_conversations (company_id, account_id, contact_id) values (p_company, p_account, p_contact)
    on conflict (account_id, contact_id) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.wa_conversations where account_id = p_account and contact_id = p_contact;
    end if;
  end if;
  return v_id;
end $$;

create function crm_private.wa_status_rank(p text) returns int
language sql immutable set search_path = '' as $$
  select case p when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else -1 end
$$;

-- Cria (ou reaproveita) o lead do CRM para um contato. Mesmo padrão de
-- crm_process: trava por contato, contact_links, tarefa de primeiro contato e atividade.
create function crm_private.wa_link_lead(p_company uuid, p_contact uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.wa_contacts%rowtype; s jsonb; v_lead uuid; v_key text; v_short text; v_name text;
begin
  select * into c from public.wa_contacts where id = p_contact and company_id = p_company for update;
  if not found then raise exception 'Contato não encontrado'; end if;
  if c.crm_lead_id is not null then return c.crm_lead_id; end if;

  v_key := 'phone:' || c.wa_id;
  v_short := case when c.wa_id like '55%' then 'phone:' || substr(c.wa_id, 3) end;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || v_key, 0));
  select lead_id into v_lead from crm_private.contact_links
   where company_id = p_company and contact_key in (v_key, coalesce(v_short, v_key))
   order by (contact_key = v_key) desc limit 1;

  if v_lead is null then
    select settings into s from public.crm_companies where id = p_company;
    v_lead := gen_random_uuid();
    v_name := coalesce(c.name, 'Contato do WhatsApp');
    insert into public.crm_records (id, company_id, kind, data) values (v_lead, p_company, 'leads',
      jsonb_build_object('id', v_lead, 'name', v_name, 'source', 'WhatsApp', 'phone', c.phone_e164,
        'email', '', 'business', '', 'notes', '', 'utm_campaign', '', 'stage', s->'stages'->>0,
        'owner', 'Equipe', 'value', 0, 'score', 0, 'checks', '[false,false,false,false]'::jsonb, 'created', now()));
    insert into crm_private.contact_links (company_id, contact_key, lead_id) values (p_company, v_key, v_lead)
    on conflict do nothing;
    if coalesce((s->>'followup')::boolean, false) then
      insert into public.crm_records (company_id, kind, data) values (p_company, 'tasks',
        jsonb_build_object('title', 'Primeiro contato · ' || v_name, 'leadId', v_lead,
          'due', (current_date + 1)::text, 'done', false, 'owner', 'Equipe', 'created', now()));
    end if;
    insert into public.crm_records (company_id, kind, data) values (p_company, 'activity',
      jsonb_build_object('text', 'Lead criado a partir do WhatsApp: ' || v_name, 'leadId', v_lead, 'created', now()));
  end if;

  update public.wa_contacts set crm_lead_id = v_lead where id = p_contact;
  return v_lead;
end $$;

-- ---------------------------------------------------------------------
-- 3. Processamento de um evento
--    Lança exceção quando deve ser tentado de novo (ex.: status antes da mensagem).
-- ---------------------------------------------------------------------
create function crm_private.wa_process_event(ev public.wa_webhook_events) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := ev.payload_restricted;
  v_ts timestamptz; v_contact uuid; v_conv uuid; v_body text; v_dir text; v_status text; n int;
  v_settings jsonb;
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
    if n = 0 then return; end if;  -- já registrada (reentrega ou eco de algo já gravado)

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
    -- Agenda do app: só atualiza o nome de contatos que já conversam (minimização de dados)
    if p->>'action' = 'add' and coalesce(p->>'wa_id','') ~ '^[0-9]{8,15}$' and nullif(trim(coalesce(p->>'name','')),'') is not null then
      update public.wa_contacts set name = left(trim(p->>'name'),120)
       where company_id = ev.company_id and wa_id = p->>'wa_id';
      get diagnostics n = row_count;
      if n = 0 and ev.received_at > now() - interval '45 minutes' then
        raise exception 'Contato ainda sem conversa';  -- o histórico pode chegar depois
      end if;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Executor da fila de eventos (pg_cron a cada minuto + chamado após o webhook)
-- ---------------------------------------------------------------------
create function crm_private.wa_run_events(p_limit int default 300) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.wa_webhook_events%rowtype; v_ok int := 0; v_retry int := 0; v_dead int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('viestro-wa-events-worker', 0)) then
    return '{"busy":true}'::jsonb;
  end if;
  for r in
    select * from public.wa_webhook_events
     where processing_status = 'pending' and next_run <= now()
     order by received_at, id
     limit greatest(1, least(p_limit, 1000))
     for update skip locked
  loop
    begin
      perform crm_private.wa_process_event(r);
      update public.wa_webhook_events
         set processing_status = 'done', processed_at = now(), attempts = attempts + 1,
             last_error = null, purge_after = now() + interval '7 days'
       where id = r.id;
      v_ok := v_ok + 1;
    exception when others then
      update public.wa_webhook_events
         set attempts = attempts + 1,
             processing_status = case when attempts + 1 >= 8 then 'dead' else 'pending' end,
             next_run = now() + make_interval(secs => least(3600, (15 * power(2, attempts))::int) + floor(random() * 10)::int),
             last_error = left(sqlstate || ' ' || sqlerrm, 200)
       where id = r.id;
      if r.attempts + 1 >= 8 then v_dead := v_dead + 1; else v_retry := v_retry + 1; end if;
    end;
  end loop;
  return jsonb_build_object('processed', v_ok, 'retry', v_retry, 'dead', v_dead);
end $$;

create function public.wa_process_pending() returns jsonb
language sql security invoker set search_path = '' as $$ select crm_private.wa_run_events(300) $$;

-- ---------------------------------------------------------------------
-- 5. Fila de envio (backend)
-- ---------------------------------------------------------------------
create function public.wa_claim_outbox(p_limit int default 10)
returns table (id uuid, lease_token uuid, kind text, payload jsonb, account_id uuid, phone_number_id text, to_wa_id text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  -- a) Texto livre com a janela de 24h já fechada: bloqueia
  with b as (
    update public.wa_outbox o set status = 'blocked', last_error = 'Janela de 24h encerrada', lease_until = null
      from public.wa_conversations c
     where o.status = 'pending' and o.kind = 'text' and c.id = o.conversation_id
       and coalesce(c.service_window_expires_at, '-infinity'::timestamptz) <= now()
    returning o.message_id)
  update public.wa_messages m set message_status = 'failed', failed_at = now(), error_code = 'window_expired'
    from b where m.id = b.message_id;

  -- b) Envio antigo demais (evita mensagem chegando horas depois) ou número sem token/desconectado
  with b as (
    update public.wa_outbox o set status = 'blocked', lease_until = null,
           last_error = case when a.access_token_secret_id is null then 'Número sem token configurado'
                             when a.connection_status = 'disconnected' then 'Número desconectado'
                             else 'Envio expirado' end
      from public.wa_conversations c join public.wa_accounts a on a.id = c.account_id
     where o.status = 'pending' and c.id = o.conversation_id
       and (a.access_token_secret_id is null or a.connection_status = 'disconnected'
            or o.created_at < now() - case when o.kind = 'text' then interval '10 minutes' else interval '1 hour' end)
    returning o.message_id, o.last_error)
  update public.wa_messages m set message_status = 'failed', failed_at = now(),
         error_code = case b.last_error when 'Envio expirado' then 'expired' when 'Número desconectado' then 'disconnected' else 'token_missing' end
    from b where m.id = b.message_id;

  -- c) Execução interrompida sem resultado: NÃO reenvia (evita mensagem duplicada ao cliente)
  with b as (
    update public.wa_outbox o set status = 'failed', lease_until = null,
           last_error = 'Resultado desconhecido: confira no WhatsApp antes de reenviar'
     where o.status = 'running' and o.lease_until < now()
    returning o.message_id)
  update public.wa_messages m set message_status = 'failed', failed_at = now(), error_code = 'unknown_result'
    from b where m.id = b.message_id and m.message_status = 'queued';

  return query
  with claimed as (
    update public.wa_outbox o
       set status = 'running', attempts = o.attempts + 1, lease_until = now() + interval '2 minutes',
           lease_token = gen_random_uuid()
     where o.id in (
       select x.id from public.wa_outbox x
        where x.status = 'pending' and x.next_run <= now() and x.attempts < 5
        order by x.next_run, x.created_at
        limit greatest(1, least(p_limit, 20))
        for update skip locked)
    returning o.id, o.lease_token, o.kind, o.payload, o.conversation_id)
  select cl.id, cl.lease_token, cl.kind, cl.payload, a.id, a.phone_number_id, ct.wa_id
    from claimed cl
    join public.wa_conversations c on c.id = cl.conversation_id
    join public.wa_accounts a on a.id = c.account_id
    join public.wa_contacts ct on ct.id = c.contact_id;
end $$;

create function public.wa_outbox_result(p_id uuid, p_lease uuid, p_ok boolean, p_wamid text,
                                        p_error_code text, p_retryable boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.wa_outbox%rowtype;
begin
  select * into o from public.wa_outbox where id = p_id and status = 'running' and lease_token = p_lease for update;
  if not found then raise exception 'Lease inválido'; end if;

  if p_ok then
    if coalesce(p_wamid,'') = '' or length(p_wamid) > 200 then raise exception 'wamid inválido'; end if;
    -- Se um eco com o mesmo wamid já entrou, fica só o registro do CRM
    delete from public.wa_messages
     where company_id = o.company_id and external_message_id = p_wamid and id <> o.message_id and source = 'app_echo';
    update public.wa_messages
       set external_message_id = p_wamid,
           message_status = case when message_status = 'queued' then 'sent' else message_status end,
           sent_at = coalesce(sent_at, now())
     where id = o.message_id;
    update public.wa_outbox set status = 'sent', lease_until = null, last_error = null where id = p_id;
  elsif coalesce(p_retryable, false) and o.attempts < 5 then
    update public.wa_outbox
       set status = 'pending', lease_until = null,
           next_run = now() + make_interval(secs => least(300, (10 * power(2, o.attempts))::int)),
           last_error = left('Falha temporária ' || coalesce(p_error_code,''), 200)
     where id = p_id;
  else
    update public.wa_outbox
       set status = 'dead', lease_until = null, last_error = left('Falha no envio ' || coalesce(p_error_code,''), 200)
     where id = p_id;
    update public.wa_messages
       set message_status = 'failed', failed_at = now(), error_code = left(coalesce(p_error_code,'send_failed'),40)
     where id = o.message_id;
  end if;
end $$;

-- Token de acesso do número (Supabase Vault). Somente backend.
create function public.wa_account_token(p_account uuid) returns text
language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret
    from public.wa_accounts a
    join vault.decrypted_secrets ds on ds.id = a.access_token_secret_id
   where a.id = p_account
$$;

-- ---------------------------------------------------------------------
-- 6. Ações do operador (CRM)
-- ---------------------------------------------------------------------
create function crm_private.wa_my_conversation(p_conversation uuid) returns public.wa_conversations
language plpgsql security definer set search_path = '' as $$
declare v_tid uuid := crm_private.company(); c public.wa_conversations%rowtype;
begin
  if v_tid is null then raise exception 'Faça login'; end if;
  select * into c from public.wa_conversations where id = p_conversation and company_id = v_tid for update;
  if not found then raise exception 'Conversa não encontrada'; end if;
  return c;
end $$;

create function crm_private.wa_send_text(p_conversation uuid, p_text text, p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations%rowtype; v_msg uuid; v_text text := trim(coalesce(p_text,''));
begin
  c := crm_private.wa_my_conversation(p_conversation);
  if length(coalesce(p_key,'')) not between 8 and 200 then raise exception 'Chave de envio inválida'; end if;
  select message_id into v_msg from public.wa_outbox where company_id = c.company_id and idempotency_key = p_key;
  if found then return v_msg; end if;
  if length(v_text) not between 1 and 4096 then raise exception 'Mensagem vazia ou longa demais'; end if;
  if coalesce(c.service_window_expires_at, '-infinity'::timestamptz) <= now() then
    raise exception 'Janela de 24h encerrada: use um template aprovado';
  end if;
  if exists (select 1 from public.wa_accounts where id = c.account_id and connection_status = 'disconnected') then
    raise exception 'Número desconectado';
  end if;

  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body,
                                  sent_by_user_id, message_status)
  values (c.company_id, c.id, 'outbound', 'crm', 'text', v_text, auth.uid(), 'queued')
  returning id into v_msg;
  insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key, requested_by, message_id)
  values (c.company_id, c.id, 'text', jsonb_build_object('text', v_text), p_key, auth.uid(), v_msg);
  update public.wa_conversations set
    last_outbound_at = now(), last_message_at = now(), last_message_preview = left(v_text, 160),
    first_response_at = case when first_response_at is null and first_inbound_at is not null then now() else first_response_at end,
    unread_count = 0
  where id = c.id;
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (c.company_id, auth.uid(), 'user', 'message.send_text', 'message', v_msg);
  return v_msg;
end $$;

create function crm_private.wa_send_template(p_conversation uuid, p_template uuid, p_params jsonb, p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.wa_conversations%rowtype; t public.wa_templates%rowtype; ct public.wa_contacts%rowtype;
  v_msg uuid; v_body text; v_params jsonb := coalesce(p_params, '[]'::jsonb); v_payload jsonb; i int;
begin
  c := crm_private.wa_my_conversation(p_conversation);
  if length(coalesce(p_key,'')) not between 8 and 200 then raise exception 'Chave de envio inválida'; end if;
  select message_id into v_msg from public.wa_outbox where company_id = c.company_id and idempotency_key = p_key;
  if found then return v_msg; end if;

  select * into t from public.wa_templates where id = p_template and company_id = c.company_id and account_id = c.account_id;
  if not found then raise exception 'Template não encontrado para este número'; end if;
  if t.status <> 'APPROVED' then raise exception 'Template não aprovado pela Meta'; end if;
  if jsonb_typeof(v_params) <> 'array' or jsonb_array_length(v_params) > 20
     or exists (select 1 from jsonb_array_elements(v_params) x where jsonb_typeof(x) <> 'string' or length(x #>> '{}') not between 1 and 1024) then
    raise exception 'Variáveis do template inválidas';
  end if;

  select * into ct from public.wa_contacts where id = c.contact_id;
  if t.category = 'MARKETING' then
    if ct.marketing_opt_out_at is not null then raise exception 'Contato pediu para não receber marketing'; end if;
    if coalesce((select status from public.wa_consents
                  where company_id = c.company_id and contact_id = ct.id and purpose = 'marketing'
                  order by created_at desc limit 1), 'none') <> 'granted' then
      raise exception 'Sem consentimento registrado para marketing';
    end if;
    if exists (select 1 from public.wa_messages m join public.wa_templates tt
                 on tt.company_id = m.company_id and tt.account_id = c.account_id and tt.name = m.template_name and tt.category = 'MARKETING'
                where m.conversation_id = c.id and m.created_at > now() - interval '24 hours') then
      raise exception 'Limite: um template de marketing por contato a cada 24h';
    end if;
  end if;

  select x->>'text' into v_body from jsonb_array_elements(t.components) x where upper(x->>'type') = 'BODY' limit 1;
  for i in 1 .. jsonb_array_length(v_params) loop
    v_body := replace(v_body, '{{' || i || '}}', v_params->>(i - 1));
  end loop;

  v_payload := jsonb_build_object('template', jsonb_build_object('name', t.name, 'language', jsonb_build_object('code', t.language)));
  if jsonb_array_length(v_params) > 0 then
    v_payload := jsonb_set(v_payload, '{template,components}', jsonb_build_array(jsonb_build_object('type', 'body',
      'parameters', (select jsonb_agg(jsonb_build_object('type', 'text', 'text', x #>> '{}')) from jsonb_array_elements(v_params) x))));
  end if;

  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, template_name,
                                  sent_by_user_id, message_status)
  values (c.company_id, c.id, 'outbound', 'crm', 'template', left(v_body, 6000), t.name, auth.uid(), 'queued')
  returning id into v_msg;
  insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key, requested_by, message_id)
  values (c.company_id, c.id, 'template', v_payload, p_key, auth.uid(), v_msg);
  update public.wa_conversations set
    last_outbound_at = now(), last_message_at = now(),
    last_message_preview = left(coalesce(v_body, '[Template ' || t.name || ']'), 160)
  where id = c.id;
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
  values (c.company_id, auth.uid(), 'user', 'message.send_template', 'message', v_msg,
          jsonb_build_object('template', t.name, 'category', t.category));
  return v_msg;
end $$;

-- p_patch: {"status": "...", "category": "...", "assigned_user_id": "uuid" | null} (só as chaves enviadas mudam)
create function crm_private.wa_update_conversation(p_conversation uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations%rowtype; v_assignee uuid; v_admin boolean := crm_private.is_admin();
begin
  c := crm_private.wa_my_conversation(p_conversation);
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'Dados inválidos'; end if;

  if p_patch ? 'status' then
    if p_patch->>'status' not in ('open','pending','resolved') then raise exception 'Status inválido'; end if;
    update public.wa_conversations set status = p_patch->>'status' where id = c.id;
  end if;
  if p_patch ? 'category' then
    update public.wa_conversations set category = nullif(left(trim(coalesce(p_patch->>'category','')),60),'') where id = c.id;
  end if;
  if p_patch ? 'assigned_user_id' then
    v_assignee := nullif(p_patch->>'assigned_user_id','')::uuid;
    if not v_admin and not (v_assignee = auth.uid() or (v_assignee is null and c.assigned_user_id = auth.uid())) then
      raise exception 'Somente administradores atribuem conversas a outras pessoas';
    end if;
    update public.wa_conversations set assigned_user_id = v_assignee where id = c.id;
  end if;
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
  values (c.company_id, auth.uid(), 'user', 'conversation.update', 'conversation', c.id,
          jsonb_build_object('fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_patch) k
                                        where k in ('status','category','assigned_user_id'))));
end $$;

create function crm_private.wa_mark_read(p_conversation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations%rowtype;
begin
  c := crm_private.wa_my_conversation(p_conversation);
  if c.unread_count > 0 then update public.wa_conversations set unread_count = 0 where id = c.id; end if;
end $$;

create function crm_private.wa_create_lead(p_conversation uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations%rowtype; v_lead uuid;
begin
  c := crm_private.wa_my_conversation(p_conversation);
  v_lead := crm_private.wa_link_lead(c.company_id, c.contact_id);
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (c.company_id, auth.uid(), 'user', 'contact.link_lead', 'contact', c.contact_id);
  return v_lead;
end $$;

create function crm_private.wa_set_consent(p_contact uuid, p_purpose text, p_status text, p_evidence text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_tid uuid := crm_private.company(); v_id uuid; v_ev text := nullif(left(trim(coalesce(p_evidence,'')),1000),'');
begin
  if v_tid is null then raise exception 'Faça login'; end if;
  if not exists (select 1 from public.wa_contacts where id = p_contact and company_id = v_tid) then
    raise exception 'Contato não encontrado';
  end if;
  if p_purpose not in ('service','utility','marketing') or p_status not in ('granted','revoked') then
    raise exception 'Dados inválidos';
  end if;
  if p_status = 'granted' and p_purpose = 'marketing' and v_ev is null then
    raise exception 'Descreva como o cliente autorizou (evidência)';
  end if;
  insert into public.wa_consents (company_id, contact_id, purpose, status, source, evidence, recorded_by, granted_at, revoked_at)
  values (v_tid, p_contact, p_purpose, p_status, 'manual', v_ev, auth.uid(),
          case when p_status = 'granted' then now() end, case when p_status = 'revoked' then now() end)
  returning id into v_id;
  if p_purpose = 'marketing' then
    update public.wa_contacts set marketing_opt_out_at = case when p_status = 'revoked' then coalesce(marketing_opt_out_at, now()) end
     where id = p_contact;
  end if;
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
  values (v_tid, auth.uid(), 'user', 'consent.' || p_status, 'contact', p_contact, jsonb_build_object('purpose', p_purpose));
  return v_id;
end $$;

-- Wrappers públicos (security invoker), mesmo padrão de crm_save
create function public.crm_wa_send_text(p_conversation uuid, p_text text, p_key text) returns uuid
language sql security invoker set search_path = '' as $$ select crm_private.wa_send_text(p_conversation, p_text, p_key) $$;
create function public.crm_wa_send_template(p_conversation uuid, p_template uuid, p_params jsonb, p_key text) returns uuid
language sql security invoker set search_path = '' as $$ select crm_private.wa_send_template(p_conversation, p_template, p_params, p_key) $$;
create function public.crm_wa_update_conversation(p_conversation uuid, p_patch jsonb) returns void
language sql security invoker set search_path = '' as $$ select crm_private.wa_update_conversation(p_conversation, p_patch) $$;
create function public.crm_wa_mark_read(p_conversation uuid) returns void
language sql security invoker set search_path = '' as $$ select crm_private.wa_mark_read(p_conversation) $$;
create function public.crm_wa_create_lead(p_conversation uuid) returns uuid
language sql security invoker set search_path = '' as $$ select crm_private.wa_create_lead(p_conversation) $$;
create function public.crm_wa_set_consent(p_contact uuid, p_purpose text, p_status text, p_evidence text) returns uuid
language sql security invoker set search_path = '' as $$ select crm_private.wa_set_consent(p_contact, p_purpose, p_status, p_evidence) $$;

-- ---------------------------------------------------------------------
-- 7. Permissões (o Supabase concede EXECUTE a PUBLIC por padrão)
-- ---------------------------------------------------------------------
revoke all on function
  crm_private.wa_contact(uuid,text,text), crm_private.wa_conversation(uuid,uuid,uuid),
  crm_private.wa_status_rank(text), crm_private.wa_link_lead(uuid,uuid),
  crm_private.wa_process_event(public.wa_webhook_events), crm_private.wa_run_events(int),
  crm_private.wa_my_conversation(uuid), crm_private.wa_send_text(uuid,text,text),
  crm_private.wa_send_template(uuid,uuid,jsonb,text), crm_private.wa_update_conversation(uuid,jsonb),
  crm_private.wa_mark_read(uuid), crm_private.wa_create_lead(uuid), crm_private.wa_set_consent(uuid,text,text,text),
  public.wa_ingest(jsonb), public.wa_process_pending(), public.wa_claim_outbox(int),
  public.wa_outbox_result(uuid,uuid,boolean,text,text,boolean), public.wa_account_token(uuid),
  public.crm_wa_send_text(uuid,text,text), public.crm_wa_send_template(uuid,uuid,jsonb,text),
  public.crm_wa_update_conversation(uuid,jsonb), public.crm_wa_mark_read(uuid),
  public.crm_wa_create_lead(uuid), public.crm_wa_set_consent(uuid,text,text,text)
from public, anon, authenticated, service_role;

-- Backend (chave de serviço)
grant execute on function public.wa_ingest(jsonb), public.wa_process_pending(), public.wa_claim_outbox(int),
  public.wa_outbox_result(uuid,uuid,boolean,text,text,boolean), public.wa_account_token(uuid),
  crm_private.wa_run_events(int)
to service_role;

-- Operador logado
grant execute on function
  crm_private.wa_send_text(uuid,text,text),
  crm_private.wa_send_template(uuid,uuid,jsonb,text), crm_private.wa_update_conversation(uuid,jsonb),
  crm_private.wa_mark_read(uuid), crm_private.wa_create_lead(uuid), crm_private.wa_set_consent(uuid,text,text,text),
  public.crm_wa_send_text(uuid,text,text), public.crm_wa_send_template(uuid,uuid,jsonb,text),
  public.crm_wa_update_conversation(uuid,jsonb), public.crm_wa_mark_read(uuid),
  public.crm_wa_create_lead(uuid), public.crm_wa_set_consent(uuid,text,text,text)
to authenticated;

-- ---------------------------------------------------------------------
-- 8. Agendamentos (pg_cron já ativo no projeto)
-- ---------------------------------------------------------------------
select cron.schedule('viestro-wa-process-events', '* * * * *', 'select crm_private.wa_run_events(300);');
select cron.schedule('viestro-wa-purge-events', '17 6 * * *',
  $$delete from public.wa_webhook_events where purge_after < now() and processing_status in ('done','dead')$$);

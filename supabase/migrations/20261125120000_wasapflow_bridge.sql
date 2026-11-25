-- =====================================================================
-- Viestro CRM · WasapFlow Bridge por número + dono do número + alertas e relatório da equipe
-- ---------------------------------------------------------------------
-- 1. wa_accounts.provider aceita 'wasapflow'. O número da Viestro continua 'easycoexistence'.
--    Cada número só recebe pelo caminho do seu fornecedor:
--      /api/webhooks/whatsapp/<chave>  → wa_ingest()            (só números easycoexistence/meta_cloud)
--      /api/webhooks/wasapflow/<chave> → wa_ingest_wasapflow()  (só números wasapflow, achados pelo waba_id)
--    wa_claim_outbox deixa de exigir token da Meta dos números do WasapFlow (o token fica com eles).
-- 2. Aviso do número no CRM (pagamento, bloqueio, desconexão, agente da Meta): wa_accounts.provider_alert_code,
--    gravado só por wa_account_alert (service_role). A caixa de entrada mostra; nunca quebra a conversa.
-- 3. wa_account_use_wasapflow: troca um número da empresa para o WasapFlow depois do "Conectar" (service_role).
-- 4. wa_agent_assign: a passagem vai para o dono do número (settings.agent.number_owners) quando ele está
--    na lista de atendentes; sem dono, continua a divisão de antes.
-- 5. wa_team_alerts: fila do alerta no WhatsApp do atendente (sai na hora com a loja aberta, na abertura com a
--    loja fechada; até 3 tentativas em ~2 minutos).
-- 6. wa_daily_reports: relatório diário (um por empresa por dia), com os números calculados aqui.
-- 7. Relógio: pg_cron chama o worker do WhatsApp a cada minuto via pg_net, só depois que os segredos
--    crm_worker_url e crm_cron_secret forem guardados no Vault (sem eles, não faz nada).
-- Nenhuma coluna existente muda de tipo; nenhum dado é apagado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Fornecedor e aviso do número
-- ---------------------------------------------------------------------
alter table public.wa_accounts drop constraint wa_accounts_provider_check;
alter table public.wa_accounts add constraint wa_accounts_provider_check
  check (provider in ('easycoexistence','meta_cloud','wasapflow'));
alter table public.wa_accounts
  add column provider_alert_code text check (provider_alert_code ~ '^[a-z_]{1,40}$'),
  add column provider_alert_at timestamptz;
grant select (provider_alert_code, provider_alert_at) on public.wa_accounts to authenticated;

-- Ingestão comum: grava os eventos (deduplicados pela chave) só dos números do caminho certo.
create function crm_private.wa_ingest_events(p_events jsonb, p_wasapflow boolean) returns jsonb
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
       and (a.provider = 'wasapflow') = p_wasapflow
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

-- Webhook antigo (EasyCoexistence/Meta): mesma assinatura de antes, agora ignora números do WasapFlow.
create or replace function public.wa_ingest(p_events jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select crm_private.wa_ingest_events(p_events, false)
$$;

-- Webhook do WasapFlow: acha o número pelo waba_id do envelope (e pelo phone_number_id, se vier).
create function public.wa_ingest_wasapflow(p_waba_id text, p_phone_number_id text, p_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_pnid text; v_n int; v_events jsonb;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 5000 then
    raise exception 'Lote inválido';
  end if;
  if coalesce(p_waba_id, '') ~ '^[0-9]{5,30}$' then
    select count(*), min(a.phone_number_id) into v_n, v_pnid
      from public.wa_accounts a
      join public.crm_channels c on c.id = a.crm_channel_id
     where a.provider = 'wasapflow' and a.waba_id = p_waba_id
       and (nullif(p_phone_number_id, '') is null or a.phone_number_id = p_phone_number_id)
       and c.enabled and a.connection_status <> 'disconnected';
  end if;
  -- Nenhum número (ou mais de um sem phone_number_id para escolher): não grava nada.
  if coalesce(v_n, 0) <> 1 then
    return jsonb_build_object('inserted', 0, 'duplicates', 0, 'ignored', jsonb_array_length(p_events));
  end if;
  select coalesce(jsonb_agg(e || jsonb_build_object('phone_number_id', v_pnid)), '[]'::jsonb) into v_events
    from jsonb_array_elements(p_events) e;
  return crm_private.wa_ingest_events(v_events, true);
end $$;

-- Liga/desliga o aviso do número. p_code null = desligar (só os códigos de p_clear, se informados).
create function public.wa_account_alert(p_account uuid, p_code text, p_clear text[] default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_antes text;
begin
  if p_code is not null and p_code !~ '^[a-z_]{1,40}$' then raise exception 'Aviso inválido'; end if;
  select company_id, provider_alert_code into v_company, v_antes from public.wa_accounts where id = p_account for update;
  if v_company is null then return false; end if;
  if p_code is not null and v_antes is not distinct from p_code then return false; end if;
  if p_code is null and (v_antes is null or (p_clear is not null and not (v_antes = any(p_clear)))) then return false; end if;
  update public.wa_accounts set provider_alert_code = p_code, provider_alert_at = case when p_code is null then null else now() end
   where id = p_account;
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
  values (v_company, null, 'system', case when p_code is null then 'account.alert_cleared' else 'account.alert' end, 'account', p_account,
          jsonb_build_object('code', coalesce(p_code, v_antes)));
  return true;
end $$;

-- Fila de envio: igual à anterior, mas número do WasapFlow não precisa de token da Meta no cofre.
create or replace function public.wa_claim_outbox(p_limit int default 10)
returns table (id uuid, lease_token uuid, kind text, payload jsonb, account_id uuid, phone_number_id text, to_wa_id text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  -- a) Texto livre com a janela de 24h já fechada: bloqueia
  with b as (
    update public.wa_outbox o set status = 'blocked', last_error = 'Janela de 24h encerrada', lease_until = null
      from public.wa_conversations c
     where o.status = 'pending' and o.kind in ('text','image') and c.id = o.conversation_id
       and coalesce(c.service_window_expires_at, '-infinity'::timestamptz) <= now()
    returning o.message_id)
  update public.wa_messages m set message_status = 'failed', failed_at = now(), error_code = 'window_expired'
    from b where m.id = b.message_id;

  -- b) Envio antigo demais (evita mensagem chegando horas depois) ou número sem token/desconectado.
  --    Número do WasapFlow não tem token da Meta no CRM (fica com o WasapFlow): não é bloqueado por isso.
  with b as (
    update public.wa_outbox o set status = 'blocked', lease_until = null,
           last_error = case when a.access_token_secret_id is null and a.provider <> 'wasapflow' then 'Número sem token configurado'
                             when a.connection_status = 'disconnected' then 'Número desconectado'
                             else 'Envio expirado' end
      from public.wa_conversations c join public.wa_accounts a on a.id = c.account_id
     where o.status = 'pending' and c.id = o.conversation_id
       and ((a.access_token_secret_id is null and a.provider <> 'wasapflow') or a.connection_status = 'disconnected'
            or o.created_at < now() - case when o.kind in ('text','image') then interval '10 minutes' else interval '1 hour' end)
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

-- ---------------------------------------------------------------------
-- 3. Trocar um número para o WasapFlow (depois do "Conectar WhatsApp" do dono da plataforma)
-- ---------------------------------------------------------------------
create function public.wa_account_use_wasapflow(p_company uuid, p_phone_e164 text, p_waba_id text, p_phone_number_id text, p_display text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_channel uuid; v_old_pnid text; v_nome text := nullif(left(trim(coalesce(p_display, '')), 120), '');
begin
  if p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' or p_waba_id !~ '^[0-9]{5,30}$' or p_phone_number_id !~ '^[0-9]{5,30}$' then
    raise exception 'Dados do número inválidos';
  end if;
  if not exists (select 1 from public.crm_companies where id = p_company) then raise exception 'Empresa não encontrada'; end if;
  if exists (select 1 from public.wa_accounts where phone_number_id = p_phone_number_id and company_id <> p_company) then
    raise exception 'Este número já está ligado a outra empresa';
  end if;

  select id, crm_channel_id, phone_number_id into v_id, v_channel, v_old_pnid from public.wa_accounts
   where company_id = p_company and (phone_number_id = p_phone_number_id or phone_e164 = p_phone_e164)
   order by (phone_number_id = p_phone_number_id) desc limit 1 for update;

  if v_id is null then
    insert into public.crm_channels (company_id, provider, external_id, label, enabled)
    values (p_company, 'whatsapp', p_phone_number_id, left('WhatsApp ' || coalesce(v_nome, p_phone_e164), 120), true)
    returning id into v_channel;
    insert into public.wa_accounts (company_id, crm_channel_id, provider, phone_number_id, waba_id, phone_e164, display_name,
                                    coexistence, connection_status, connected_at)
    values (p_company, v_channel, 'wasapflow', p_phone_number_id, p_waba_id, p_phone_e164, v_nome, true, 'connected', now())
    returning id into v_id;
  else
    -- O canal acompanha o phone_number_id (a trava de consistência confere os dois).
    if v_old_pnid <> p_phone_number_id then
      update public.crm_channels set external_id = p_phone_number_id where id = v_channel;
    end if;
    update public.crm_channels set enabled = true where id = v_channel and not enabled;
    update public.wa_accounts set provider = 'wasapflow', waba_id = p_waba_id, phone_number_id = p_phone_number_id,
           display_name = coalesce(v_nome, display_name), coexistence = true, connection_status = 'connected',
           connected_at = coalesce(connected_at, now()), provider_alert_code = null, provider_alert_at = null
     where id = v_id;
  end if;
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
  values (p_company, null, 'platform_admin', 'account.provider_wasapflow', 'account', v_id, jsonb_build_object('provider', 'wasapflow'));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 4. Passagem do agente: dono do número primeiro
-- ---------------------------------------------------------------------
create or replace function public.wa_agent_assign(p_conversation uuid, p_summary text, p_hot boolean default false)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid; v_lead uuid; v_contato text; v_settings jsonb; v_lista text[]; v_n int; v_numero text; v_dono text;
  v_lead_data jsonb; v_owner text; v_ultimo text; v_pos int; v_tarefa uuid; v_tarefa_owner text; v_nome text;
  v_resumo text := left(trim(coalesce(p_summary, '')), 2000);
  v_hoje text := ((now() at time zone 'America/Sao_Paulo')::date)::text;
  v_quente boolean := coalesce(p_hot, false);
begin
  select c.company_id, k.crm_lead_id, k.name, a.phone_e164 into v_company, v_lead, v_contato, v_numero
  from public.wa_conversations c
  join public.wa_contacts k on k.id = c.contact_id and k.company_id = c.company_id
  join public.wa_accounts a on a.id = c.account_id
  where c.id = p_conversation;
  if v_company is null then return null; end if;

  -- Trava a empresa: as passagens dela entram em fila, uma de cada vez.
  select settings into v_settings from public.crm_companies where id = v_company for update;
  select coalesce(array_agg(n order by i), '{}') into v_lista
  from (select left(trim(x), 40) n, i
        from jsonb_array_elements_text(case when jsonb_typeof(v_settings->'agent'->'attendants') = 'array'
                                            then v_settings->'agent'->'attendants' else '[]'::jsonb end) with ordinality e(x, i)
        where trim(x) <> '' limit 5) a;
  v_n := cardinality(v_lista);
  -- Dono do número em que o cliente chamou (ex.: 6088 → Agna, 1715 → Cleudo)
  if jsonb_typeof(v_settings->'agent'->'number_owners') = 'object' then
    v_dono := left(trim(v_settings->'agent'->'number_owners'->>ltrim(v_numero, '+')), 40);
  end if;

  -- Já existe tarefa aberta de passagem para esta conversa: só atualiza o resumo.
  select id, data->>'owner' into v_tarefa, v_tarefa_owner from public.crm_records
  where company_id = v_company and kind = 'tasks' and data->>'source' = 'agent_handoff'
    and data->>'conversationId' = p_conversation::text and coalesce(data->>'done', 'false') <> 'true'
  order by created_at desc limit 1 for update;
  if v_tarefa is not null then
    -- Se agora ficou quente, a tarefa sobe para quente (nunca desce).
    update public.crm_records
    set data = data || jsonb_build_object('notes', v_resumo, 'updated', now())
               || case when v_quente and coalesce(data->>'hot', 'false') <> 'true'
                       then jsonb_build_object('hot', true, 'title', '🔥 ' || (data->>'title'), 'hot_at', now()) else '{}'::jsonb end,
        updated_at = now()
    where id = v_tarefa;
    if v_quente and v_lead is not null then
      update public.crm_records set data = data || jsonb_build_object('temperature', 'quente', 'temperature_at', now()), updated_at = now()
      where id = v_lead and company_id = v_company and kind = 'leads';
    end if;
    return v_tarefa_owner;
  end if;

  if v_lead is not null then
    select data into v_lead_data from public.crm_records
    where id = v_lead and company_id = v_company and kind = 'leads' for update;
    if v_lead_data is null then v_lead := null; end if;
  end if;

  if v_n = 0 then
    v_owner := 'Equipe';
  elsif v_dono = any(v_lista) then
    v_owner := v_dono; -- o número tem dono: a conversa é dele
  elsif v_lead_data->>'owner' = any(v_lista) then
    v_owner := v_lead_data->>'owner'; -- cliente que volta fica com quem já atendia
  else
    select data->>'owner' into v_ultimo from public.crm_records
    where company_id = v_company and kind = 'tasks' and data->>'source' = 'agent_handoff' and data->>'owner' = any(v_lista)
    order by created_at desc limit 1;
    v_pos := coalesce(array_position(v_lista, v_ultimo), 0);
    v_owner := v_lista[(v_pos % v_n) + 1];
  end if;

  v_nome := left(coalesce(nullif(trim(v_lead_data->>'name'), ''), nullif(trim(v_contato), ''), 'cliente do WhatsApp'), 80);
  if v_lead is not null and ((v_lead_data->>'owner' is distinct from v_owner and v_owner <> 'Equipe') or v_quente) then
    update public.crm_records
    set data = data || case when v_owner <> 'Equipe' then jsonb_build_object('owner', v_owner) else '{}'::jsonb end
               || case when v_quente then jsonb_build_object('temperature', 'quente', 'temperature_at', now()) else '{}'::jsonb end
               || jsonb_build_object('updated', now()),
        updated_at = now()
    where id = v_lead;
  end if;

  -- clock_timestamp: a ordem das passagens (quem foi o último) vale mesmo dentro de uma transação só.
  insert into public.crm_records (company_id, kind, created_at, data)
  values (v_company, 'tasks', clock_timestamp(), jsonb_strip_nulls(jsonb_build_object(
    'title', case when v_quente then '🔥 ' else '' end || 'Atender ' || v_nome || ' (passado pelo agente)', 'due', v_hoje, 'done', false, 'owner', v_owner,
    'hot', case when v_quente then true end, 'hot_at', case when v_quente then clock_timestamp() end,
    'leadId', v_lead, 'notes', nullif(v_resumo, ''), 'source', 'agent_handoff', 'conversationId', p_conversation, 'created', clock_timestamp())));
  insert into public.crm_records (company_id, kind, data)
  values (v_company, 'activity', jsonb_build_object('text', case when v_quente then '🔥 Lead quente: ' else '' end || 'Agente passou ' || v_nome || ' para ' || v_owner, 'created', now()));
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (v_company, null, 'agent', 'agent.assign', case when v_lead is null then 'conversation' else 'lead' end, coalesce(v_lead, p_conversation));
  return v_owner;
end $$;

-- ---------------------------------------------------------------------
-- 5. Fila do alerta no WhatsApp do atendente
-- ---------------------------------------------------------------------
create table public.wa_team_alerts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.crm_companies(id) on delete cascade,
  conversation_id uuid not null,
  phone           text not null check (phone ~ '^[1-9][0-9]{9,14}$'),
  payload         jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4000),
  status          text not null default 'pending' check (status in ('pending','running','sent','failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  due_at          timestamptz not null,
  next_run        timestamptz not null,
  lease_until     timestamptz,
  lease_token     uuid,
  last_error      text check (length(last_error) <= 40),
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (company_id, conversation_id) references public.wa_conversations (company_id, id) on delete cascade
);
-- Um alerta pendente por conversa (passagem repetida só atualiza o texto).
create unique index wa_team_alerts_open_uidx on public.wa_team_alerts (conversation_id) where status in ('pending','running');
create index wa_team_alerts_ready_idx on public.wa_team_alerts (next_run) where status in ('pending','running');
create index wa_team_alerts_company_idx on public.wa_team_alerts (company_id, created_at desc);
create trigger wa_team_alerts_touch before update on public.wa_team_alerts
  for each row execute function crm_private.wa_touch();
alter table public.wa_team_alerts enable row level security;
revoke all on public.wa_team_alerts from anon, authenticated;
grant select, insert, update, delete on public.wa_team_alerts to service_role;

create function public.wa_alert_enqueue(p_conversation uuid, p_phone text, p_payload jsonb, p_due timestamptz) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; v_id uuid; v_due timestamptz := greatest(coalesce(p_due, now()), now());
begin
  if coalesce(p_phone, '') !~ '^[1-9][0-9]{9,14}$' or jsonb_typeof(p_payload) <> 'object' then raise exception 'Alerta inválido'; end if;
  select company_id into v_company from public.wa_conversations where id = p_conversation;
  if v_company is null then return null; end if;
  select id into v_id from public.wa_team_alerts where conversation_id = p_conversation and status = 'pending' for update;
  if v_id is not null then
    -- Já tinha alerta esperando (ex.: loja fechada): fica o texto novo e o horário mais cedo.
    update public.wa_team_alerts set payload = p_payload, phone = p_phone,
           due_at = least(due_at, v_due), next_run = least(next_run, v_due) where id = v_id;
    return v_id;
  end if;
  insert into public.wa_team_alerts (company_id, conversation_id, phone, payload, due_at, next_run)
  values (v_company, p_conversation, p_phone, p_payload, v_due, v_due)
  on conflict do nothing
  returning id into v_id;
  return v_id;
end $$;

create function public.wa_alert_claim(p_limit int default 10)
returns table (id uuid, lease_token uuid, company_id uuid, account_id uuid, phone text, payload jsonb, attempts int)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with alvo as (
    select t.id from public.wa_team_alerts t
     where (t.status = 'pending' and t.next_run <= now()) or (t.status = 'running' and t.lease_until < now())
     order by t.next_run limit least(greatest(coalesce(p_limit, 10), 1), 50)
     for update skip locked
  )
  update public.wa_team_alerts t set status = 'running', attempts = t.attempts + 1,
         lease_token = gen_random_uuid(), lease_until = now() + interval '1 minute'
    from alvo where t.id = alvo.id
  returning t.id, t.lease_token, t.company_id,
            (select c.account_id from public.wa_conversations c where c.id = t.conversation_id), t.phone, t.payload, t.attempts;
end $$;

-- Até 3 tentativas, 40 s entre elas: com a loja aberta, o alerta sai ou falha em ~2 minutos.
create function public.wa_alert_result(p_id uuid, p_lease uuid, p_ok boolean, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.wa_team_alerts%rowtype;
begin
  select * into t from public.wa_team_alerts where id = p_id and lease_token = p_lease and status = 'running' for update;
  if not found then return; end if;
  if p_ok then
    update public.wa_team_alerts set status = 'sent', sent_at = now(), lease_token = null, lease_until = null, last_error = null where id = p_id;
  elsif t.attempts < 3 then
    update public.wa_team_alerts set status = 'pending', next_run = now() + interval '40 seconds', lease_token = null, lease_until = null,
           last_error = left(coalesce(p_error, 'erro'), 40) where id = p_id;
  else
    update public.wa_team_alerts set status = 'failed', lease_token = null, lease_until = null, last_error = left(coalesce(p_error, 'erro'), 40) where id = p_id;
    insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (t.company_id, null, 'system', 'agent.alert_failed', 'conversation', t.conversation_id, jsonb_build_object('code', left(coalesce(p_error, 'erro'), 40)));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Relatório diário
-- ---------------------------------------------------------------------
create table public.wa_daily_reports (
  company_id uuid not null references public.crm_companies(id) on delete cascade,
  day        date not null,
  status     text not null check (status in ('running','sent','failed')),
  attempts   integer not null default 1 check (attempts >= 0),
  last_error text check (length(last_error) <= 40),
  sent_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, day)
);
create trigger wa_daily_reports_touch before update on public.wa_daily_reports
  for each row execute function crm_private.wa_touch();
alter table public.wa_daily_reports enable row level security;
revoke all on public.wa_daily_reports from anon, authenticated;
grant select, insert, update, delete on public.wa_daily_reports to service_role;

-- Reserva o relatório do dia (um só por empresa e dia; falha pode tentar até 3 vezes) e devolve os números.
-- null = já enviado ou outra rodada está enviando.
create function public.wa_daily_report_claim(p_company uuid, p_day date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ok boolean; v_novas int; v_quentes int; v_abertas int; v_passagens jsonb;
begin
  insert into public.wa_daily_reports as r (company_id, day, status) values (p_company, p_day, 'running')
  on conflict (company_id, day) do update set status = 'running', attempts = r.attempts + 1
   where (r.status = 'failed' and r.attempts < 3) or (r.status = 'running' and r.updated_at < now() - interval '10 minutes')
  returning true into v_ok;
  if v_ok is null then return null; end if;

  select count(*) into v_novas from public.wa_conversations
   where company_id = p_company and (first_inbound_at at time zone 'America/Sao_Paulo')::date = p_day;
  select count(*) filter (where data->>'hot' = 'true'
           and (coalesce((data->>'hot_at')::timestamptz, created_at) at time zone 'America/Sao_Paulo')::date = p_day),
         count(*) filter (where coalesce(data->>'done', 'false') <> 'true')
    into v_quentes, v_abertas
    from public.crm_records where company_id = p_company and kind = 'tasks' and data->>'source' = 'agent_handoff';
  select coalesce(jsonb_object_agg(dono, n), '{}'::jsonb) into v_passagens from (
    select left(coalesce(data->>'owner', 'Equipe'), 40) dono, count(*) n from public.crm_records
     where company_id = p_company and kind = 'tasks' and data->>'source' = 'agent_handoff'
       and (created_at at time zone 'America/Sao_Paulo')::date = p_day
     group by 1) x;
  return jsonb_build_object('novas', v_novas, 'quentes', v_quentes, 'abertas', v_abertas, 'passagens', v_passagens);
end $$;

create function public.wa_daily_report_result(p_company uuid, p_day date, p_ok boolean, p_error text) returns void
language sql security definer set search_path = '' as $$
  update public.wa_daily_reports set status = case when p_ok then 'sent' else 'failed' end,
         sent_at = case when p_ok then now() end, last_error = case when p_ok then null else left(coalesce(p_error, 'erro'), 40) end
   where company_id = p_company and day = p_day and status = 'running';
$$;

-- ---------------------------------------------------------------------
-- 7. Relógio do worker (pg_cron + pg_net). Sem pg_net ou sem os segredos no Vault: não faz nada.
--    Guardar no Vault: crm_worker_url = https://<domínio>/api/whatsapp/worker e crm_cron_secret = CRON_SECRET.
-- ---------------------------------------------------------------------
create function crm_private.wa_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  if to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is null then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'crm_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'crm_cron_secret';
  if v_url is null or v_secret is null or v_url !~ '^https://[^/]+/api/whatsapp/worker$' then return; end if;
  execute 'select net.http_get(url := $1, params := ''{}''::jsonb, headers := $2, timeout_milliseconds := 55000)'
    using v_url, jsonb_build_object('Authorization', 'Bearer ' || v_secret);
end $$;
select cron.schedule('viestro-wa-relogio', '* * * * *', 'select crm_private.wa_tick();');

-- ---------------------------------------------------------------------
-- Permissões: tudo novo é só do backend (service_role)
-- ---------------------------------------------------------------------
revoke all on function crm_private.wa_ingest_events(jsonb, boolean), crm_private.wa_tick() from public, anon, authenticated, service_role;
revoke all on function public.wa_ingest(jsonb), public.wa_ingest_wasapflow(text, text, jsonb), public.wa_account_alert(uuid, text, text[]),
  public.wa_account_use_wasapflow(uuid, text, text, text, text), public.wa_agent_assign(uuid, text, boolean),
  public.wa_alert_enqueue(uuid, text, jsonb, timestamptz), public.wa_alert_claim(int), public.wa_alert_result(uuid, uuid, boolean, text),
  public.wa_daily_report_claim(uuid, date), public.wa_daily_report_result(uuid, date, boolean, text)
  from public, anon, authenticated;
grant execute on function public.wa_ingest(jsonb), public.wa_ingest_wasapflow(text, text, jsonb), public.wa_account_alert(uuid, text, text[]),
  public.wa_account_use_wasapflow(uuid, text, text, text, text), public.wa_agent_assign(uuid, text, boolean),
  public.wa_alert_enqueue(uuid, text, jsonb, timestamptz), public.wa_alert_claim(int), public.wa_alert_result(uuid, uuid, boolean, text),
  public.wa_daily_report_claim(uuid, date), public.wa_daily_report_result(uuid, date, boolean, text)
  to service_role;

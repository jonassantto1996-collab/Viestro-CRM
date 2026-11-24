-- Agente manda a foto do modelo no WhatsApp (catálogo em settings.agent.photos).
-- 1) A fila de envio passa a aceitar "image" (mensagem livre: só na janela de 24 h, validade de 10 min,
--    como o texto). 2) wa_agent_send_image: só o servidor; o banco decide se pode mandar:
--    agente ligado no automático; janela aberta; número conectado; o agente acabou de responder ESTA
--    mensagem do cliente (e o cliente não escreveu de novo); ninguém da equipe falou nas últimas 12 h;
--    conversa não pausada; link precisa estar no catálogo da empresa; no máximo 2 fotos por resposta.

alter table public.wa_outbox drop constraint wa_outbox_kind_check;
alter table public.wa_outbox add constraint wa_outbox_kind_check check (kind in ('text','template','image'));

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

  -- b) Envio antigo demais (evita mensagem chegando horas depois) ou número sem token/desconectado
  with b as (
    update public.wa_outbox o set status = 'blocked', lease_until = null,
           last_error = case when a.access_token_secret_id is null then 'Número sem token configurado'
                             when a.connection_status = 'disconnected' then 'Número desconectado'
                             else 'Envio expirado' end
      from public.wa_conversations c join public.wa_accounts a on a.id = c.account_id
     where o.status = 'pending' and c.id = o.conversation_id
       and (a.access_token_secret_id is null or a.connection_status = 'disconnected'
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

create function public.wa_agent_send_image(p_conversation uuid, p_inbound_at timestamptz, p_url text, p_caption text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.wa_conversations%rowtype;
  s public.wa_agent_state%rowtype;
  v_msg uuid;
  v_caption text := left(trim(coalesce(p_caption, '')), 200);
  v_base text;
begin
  select * into c from public.wa_conversations where id = p_conversation for update;
  if not found then return null; end if;
  if c.last_inbound_at is distinct from p_inbound_at then return null; end if;
  if coalesce(c.service_window_expires_at, '-infinity'::timestamptz) <= now() then return null; end if;
  if exists (select 1 from public.wa_accounts where id = c.account_id and connection_status = 'disconnected') then return null; end if;
  if not exists (select 1 from public.crm_companies co where co.id = c.company_id
                 and co.settings->'agent'->>'enabled' = 'true' and co.settings->'agent'->>'mode' = 'automatico'
                 and jsonb_typeof(co.settings->'agent'->'photos') = 'object'
                 and exists (select 1 from jsonb_each_text(co.settings->'agent'->'photos') f where f.value = p_url)) then
    return null;
  end if;
  if exists (select 1 from public.wa_messages m where m.conversation_id = c.id and m.direction = 'outbound'
             and m.source in ('crm','app_echo') and coalesce(m.provider_timestamp, m.created_at) > now() - interval '12 hours') then
    return null;
  end if;
  select * into s from public.wa_agent_state where conversation_id = c.id;
  if not found or s.last_answered_inbound_at is distinct from p_inbound_at then return null; end if;
  if s.paused_until is not null and s.paused_until > now() then return null; end if;
  if length(v_caption) < 1 then return null; end if;

  v_base := 'agent-img:' || c.id || ':' || floor(extract(epoch from p_inbound_at) * 1000)::bigint || ':';
  if (select count(*) from public.wa_outbox o where o.company_id = c.company_id and o.idempotency_key like v_base || '%') >= 2 then
    return null;
  end if;
  if exists (select 1 from public.wa_outbox o where o.company_id = c.company_id and o.idempotency_key = v_base || md5(p_url)) then
    return null;
  end if;

  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, message_status)
  values (c.company_id, c.id, 'outbound', 'agent', 'image', v_caption, 'queued')
  returning id into v_msg;
  insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key, requested_by, message_id)
  values (c.company_id, c.id, 'image', jsonb_build_object('image', jsonb_build_object('link', p_url, 'caption', v_caption)),
          v_base || md5(p_url), null, v_msg);
  update public.wa_conversations set last_outbound_at = now(), last_message_at = now(), last_message_preview = left(v_caption, 160)
  where id = c.id;
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (c.company_id, null, 'agent', 'agent.send_image', 'conversation', c.id);
  return v_msg;
end $$;

revoke all on function public.wa_agent_send_image(uuid, timestamptz, text, text) from public, anon, authenticated, service_role;
grant execute on function public.wa_agent_send_image(uuid, timestamptz, text, text) to service_role;

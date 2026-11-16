-- =====================================================================
-- Agente de atendimento do WhatsApp — modo automático
-- O agente responde sozinho só quando: a empresa ativou o modo automático,
-- a janela de 24h está aberta, ninguém respondeu depois da última mensagem
-- do cliente, nenhuma pessoa da equipe falou na conversa nas últimas 12h,
-- a conversa não está pausada e o limite diário por conversa não estourou.
-- Toda escrita passa por funções; o app (authenticated) só lê o estado.
-- =====================================================================

-- 1. Mensagens enviadas pelo agente ganham origem própria ('agent')
alter table public.wa_messages drop constraint wa_messages_source_check;
alter table public.wa_messages add constraint wa_messages_source_check
  check (source = any (array['api_inbound','crm','app_echo','history_sync','agent']));
alter table public.wa_messages drop constraint wa_messages_check1;
alter table public.wa_messages add constraint wa_messages_check1
  check (direction = 'inbound' or source = any (array['crm','app_echo','history_sync','agent']));

alter table public.wa_audit_logs drop constraint wa_audit_logs_actor_kind_check;
alter table public.wa_audit_logs add constraint wa_audit_logs_actor_kind_check
  check (actor_kind = any (array['user','system','webhook','platform_admin','agent']));

-- 2. Estado do agente por conversa
create table public.wa_agent_state (
  conversation_id          uuid primary key,
  company_id               uuid not null,
  day                      date not null default ((now() at time zone 'America/Sao_Paulo')::date),
  replies_today            int  not null default 0 check (replies_today >= 0),
  last_answered_inbound_at timestamptz,
  paused_until             timestamptz,
  paused_reason            text check (length(paused_reason) <= 200),
  handoff_at               timestamptz,
  updated_at               timestamptz not null default now(),
  foreign key (company_id, conversation_id) references public.wa_conversations (company_id, id) on delete cascade
);
create index wa_agent_state_company on public.wa_agent_state (company_id);

revoke all on public.wa_agent_state from anon, authenticated;
grant select, insert, update, delete on public.wa_agent_state to service_role;
grant select on public.wa_agent_state to authenticated;
alter table public.wa_agent_state enable row level security;
create policy wa_agent_state_read on public.wa_agent_state for select to authenticated
  using (company_id = (select crm_private.company()));

-- 3. Conversas que o agente deve responder agora (backend)
-- p_quiet_seconds: espera o cliente terminar de digitar (várias mensagens seguidas).
create function public.wa_agent_candidates(p_quiet_seconds int default 10, p_limit int default 10)
returns table (conversation_id uuid, company_id uuid, last_inbound_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, c.company_id, c.last_inbound_at
  from public.wa_conversations c
  join public.crm_companies co on co.id = c.company_id
  left join public.wa_agent_state s on s.conversation_id = c.id
  where co.settings->'agent'->>'enabled' = 'true'
    and co.settings->'agent'->>'mode' = 'automatico'
    and c.last_inbound_at is not null
    and (c.last_outbound_at is null or c.last_outbound_at < c.last_inbound_at)
    and c.last_inbound_at between now() - interval '15 minutes' and now() - make_interval(secs => greatest(0, least(p_quiet_seconds, 60)))
    and c.service_window_expires_at > now()
    and (s.paused_until is null or s.paused_until <= now())
    and (s.last_answered_inbound_at is null or s.last_answered_inbound_at <> c.last_inbound_at)
    and not exists (select 1 from public.wa_messages m where m.conversation_id = c.id and m.direction = 'outbound'
                    and m.source in ('crm','app_echo') and coalesce(m.provider_timestamp, m.created_at) > now() - interval '12 hours')
  order by c.last_inbound_at
  limit greatest(1, least(p_limit, 50));
$$;

-- 4. Envio pelo agente (backend). Revalida tudo com a conversa travada: se algo mudou
-- (cliente mandou outra mensagem, alguém respondeu, pausaram), não envia e devolve null.
create function public.wa_agent_send(p_conversation uuid, p_inbound_at timestamptz, p_text text,
                                     p_handoff boolean, p_reason text, p_max_per_day int)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.wa_conversations%rowtype;
  s public.wa_agent_state%rowtype;
  v_msg uuid;
  v_text text := trim(coalesce(p_text, ''));
  v_day date := (now() at time zone 'America/Sao_Paulo')::date;
  v_max int := greatest(1, least(coalesce(p_max_per_day, 10), 50));
begin
  select * into c from public.wa_conversations where id = p_conversation for update;
  if not found then return null; end if;
  if c.last_inbound_at is distinct from p_inbound_at then return null; end if;
  if c.last_outbound_at is not null and c.last_outbound_at >= c.last_inbound_at then return null; end if;
  if coalesce(c.service_window_expires_at, '-infinity'::timestamptz) <= now() then return null; end if;
  if exists (select 1 from public.wa_accounts where id = c.account_id and connection_status = 'disconnected') then return null; end if;
  if not exists (select 1 from public.crm_companies where id = c.company_id
                 and settings->'agent'->>'enabled' = 'true' and settings->'agent'->>'mode' = 'automatico') then return null; end if;
  if exists (select 1 from public.wa_messages m where m.conversation_id = c.id and m.direction = 'outbound'
             and m.source in ('crm','app_echo') and coalesce(m.provider_timestamp, m.created_at) > now() - interval '12 hours') then
    return null;
  end if;
  select * into s from public.wa_agent_state where conversation_id = c.id for update;
  if found then
    if s.paused_until is not null and s.paused_until > now() then return null; end if;
    if s.last_answered_inbound_at is not distinct from p_inbound_at then return null; end if;
    if s.day = v_day and s.replies_today >= v_max then return null; end if;
  end if;
  if length(v_text) not between 1 and 1500 then raise exception 'Mensagem do agente inválida'; end if;

  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, message_status)
  values (c.company_id, c.id, 'outbound', 'agent', 'text', v_text, 'queued')
  returning id into v_msg;
  insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key, requested_by, message_id)
  values (c.company_id, c.id, 'text', jsonb_build_object('text', v_text),
          'agent:' || c.id || ':' || floor(extract(epoch from p_inbound_at) * 1000)::bigint, null, v_msg);
  update public.wa_conversations set
    last_outbound_at = now(), last_message_at = now(), last_message_preview = left(v_text, 160),
    first_response_at = case when first_response_at is null and first_inbound_at is not null then now() else first_response_at end,
    status = case when p_handoff then 'pending' else status end
  where id = c.id;
  insert into public.wa_agent_state as st (conversation_id, company_id, day, replies_today, last_answered_inbound_at,
                                           paused_until, paused_reason, handoff_at, updated_at)
  values (c.id, c.company_id, v_day, 1, p_inbound_at,
          case when p_handoff then now() + interval '24 hours' end,
          case when p_handoff then left(nullif(trim(p_reason), ''), 200) end,
          case when p_handoff then now() end, now())
  on conflict (conversation_id) do update set
    replies_today = case when st.day = v_day then st.replies_today + 1 else 1 end,
    day = v_day,
    last_answered_inbound_at = p_inbound_at,
    paused_until = case when p_handoff then now() + interval '24 hours' else st.paused_until end,
    paused_reason = case when p_handoff then left(nullif(trim(p_reason), ''), 200) else st.paused_reason end,
    handoff_at = case when p_handoff then now() else st.handoff_at end,
    updated_at = now();
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (c.company_id, null, 'agent', case when p_handoff then 'agent.handoff' else 'agent.reply' end, 'message', v_msg);
  return v_msg;
end $$;

-- 5. Passa a conversa para a equipe sem enviar mensagem (ex.: limite diário atingido)
create function public.wa_agent_pause(p_conversation uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations%rowtype;
begin
  select * into c from public.wa_conversations where id = p_conversation for update;
  if not found then return; end if;
  insert into public.wa_agent_state as st (conversation_id, company_id, paused_until, paused_reason, handoff_at, updated_at)
  values (c.id, c.company_id, now() + interval '24 hours', left(nullif(trim(p_reason), ''), 200), now(), now())
  on conflict (conversation_id) do update set
    paused_until = excluded.paused_until, paused_reason = excluded.paused_reason, handoff_at = excluded.handoff_at, updated_at = now();
  update public.wa_conversations set status = 'pending' where id = c.id and status = 'open';
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (c.company_id, null, 'agent', 'agent.handoff', 'conversation', c.id);
end $$;

-- 6. Operador pausa ou reativa o agente numa conversa
create function crm_private.wa_agent_toggle(p_conversation uuid, p_pause boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations%rowtype;
begin
  c := crm_private.wa_my_conversation(p_conversation);
  insert into public.wa_agent_state as st (conversation_id, company_id, paused_until, paused_reason, handoff_at, updated_at)
  values (c.id, c.company_id, case when p_pause then 'infinity'::timestamptz end,
          case when p_pause then 'Pausado pela equipe' end, null, now())
  on conflict (conversation_id) do update set
    paused_until = excluded.paused_until, paused_reason = excluded.paused_reason,
    handoff_at = case when p_pause then st.handoff_at else null end, updated_at = now();
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (c.company_id, auth.uid(), 'user', case when p_pause then 'agent.pause' else 'agent.resume' end, 'conversation', c.id);
end $$;

create function public.crm_wa_agent_toggle(p_conversation uuid, p_pause boolean) returns void
language sql security invoker set search_path = '' as $$ select crm_private.wa_agent_toggle(p_conversation, p_pause) $$;

-- 7. Privilégios
revoke all on function public.wa_agent_candidates(int,int), public.wa_agent_send(uuid,timestamptz,text,boolean,text,int),
  public.wa_agent_pause(uuid,text), crm_private.wa_agent_toggle(uuid,boolean), public.crm_wa_agent_toggle(uuid,boolean)
from public, anon, authenticated, service_role;
grant execute on function public.wa_agent_candidates(int,int), public.wa_agent_send(uuid,timestamptz,text,boolean,text,int),
  public.wa_agent_pause(uuid,text)
to service_role;
grant execute on function crm_private.wa_agent_toggle(uuid,boolean), public.crm_wa_agent_toggle(uuid,boolean)
to authenticated;

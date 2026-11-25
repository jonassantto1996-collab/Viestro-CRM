-- =====================================================================
-- Viestro CRM · Agente automático: uma chamada à IA por mensagem do cliente
-- ---------------------------------------------------------------------
-- Cada mensagem que chega abre uma rodada do agente (webhook). Quando chegam várias juntas, todas as
-- rodadas pegavam a mesma conversa em wa_agent_candidates e chamavam a IA; o banco só deixava UMA
-- resposta sair (wa_agent_send), mas a IA era paga várias vezes (até ~10x num pico).
-- Agora a rodada reserva a conversa antes de chamar a IA (wa_agent_claim): as outras pulam.
-- A reserva vale para aquela mensagem (last_inbound_at) por 90 s; mensagem mais nova do cliente pode
-- ser reservada na hora (a resposta antiga deixa de valer em wa_agent_send, como antes).
-- Nenhum dado é apagado; só duas colunas novas em wa_agent_state.
-- =====================================================================

alter table public.wa_agent_state
  add column thinking_inbound_at timestamptz,
  add column thinking_until timestamptz;

-- Reserva a conversa para esta mensagem do cliente. true = esta rodada chama a IA; false = outra já está.
create function public.wa_agent_claim(p_conversation uuid, p_inbound_at timestamptz) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_company uuid; n int;
begin
  select company_id into v_company from public.wa_conversations where id = p_conversation;
  if v_company is null or p_inbound_at is null then return false; end if;
  insert into public.wa_agent_state as s (conversation_id, company_id, thinking_inbound_at, thinking_until, updated_at)
  values (p_conversation, v_company, p_inbound_at, now() + interval '90 seconds', now())
  on conflict (conversation_id) do update
     set thinking_inbound_at = excluded.thinking_inbound_at, thinking_until = excluded.thinking_until, updated_at = now()
   where s.thinking_until is null or s.thinking_until <= now()
      or s.thinking_inbound_at is null or s.thinking_inbound_at < excluded.thinking_inbound_at;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Solta a reserva (a IA falhou): a próxima rodada pode tentar de novo sem esperar os 90 s.
create function public.wa_agent_release(p_conversation uuid, p_inbound_at timestamptz) returns void
language sql security definer set search_path = '' as $$
  update public.wa_agent_state set thinking_until = now(), updated_at = now()
   where conversation_id = p_conversation and thinking_inbound_at = p_inbound_at and thinking_until > now();
$$;

-- Mesmas regras de antes + não devolve conversa já reservada para a mesma mensagem.
create or replace function public.wa_agent_candidates(p_quiet_seconds int default 10, p_limit int default 10)
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
    and not coalesce(s.thinking_until > now() and s.thinking_inbound_at >= c.last_inbound_at, false)
    and not exists (select 1 from public.wa_messages m where m.conversation_id = c.id and m.direction = 'outbound'
                    and m.source in ('crm','app_echo') and coalesce(m.provider_timestamp, m.created_at) > now() - interval '12 hours')
  order by c.last_inbound_at
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function public.wa_agent_claim(uuid, timestamptz), public.wa_agent_release(uuid, timestamptz),
  public.wa_agent_candidates(int, int) from public, anon, authenticated;
grant execute on function public.wa_agent_claim(uuid, timestamptz), public.wa_agent_release(uuid, timestamptz),
  public.wa_agent_candidates(int, int) to service_role;

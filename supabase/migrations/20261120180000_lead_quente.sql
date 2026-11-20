-- Lead quente: o agente diz se o cliente mostrou intenção de compra (preço, ir à loja,
-- comprar/reservar). A tarefa da passagem sai com 🔥 e "hot", e o lead fica com
-- temperature = 'quente'. O CRM usa isso para avisar o atendente (som/notificação) e pôr
-- os quentes no topo. Mesmas travas de antes: só service_role; o banco decide o atendente.
-- Substitui wa_agent_assign(uuid, text) pela versão com p_hot (padrão false: chamadas antigas
-- continuam funcionando).

drop function public.wa_agent_assign(uuid, text);

create function public.wa_agent_assign(p_conversation uuid, p_summary text, p_hot boolean default false)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid; v_lead uuid; v_contato text; v_settings jsonb; v_lista text[]; v_n int;
  v_lead_data jsonb; v_owner text; v_ultimo text; v_pos int; v_tarefa uuid; v_tarefa_owner text; v_nome text;
  v_resumo text := left(trim(coalesce(p_summary, '')), 2000);
  v_hoje text := ((now() at time zone 'America/Sao_Paulo')::date)::text;
  v_quente boolean := coalesce(p_hot, false);
begin
  select c.company_id, k.crm_lead_id, k.name into v_company, v_lead, v_contato
  from public.wa_conversations c join public.wa_contacts k on k.id = c.contact_id and k.company_id = c.company_id
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
    'hot', case when v_quente then true end,
    'leadId', v_lead, 'notes', nullif(v_resumo, ''), 'source', 'agent_handoff', 'conversationId', p_conversation, 'created', clock_timestamp())));
  insert into public.crm_records (company_id, kind, data)
  values (v_company, 'activity', jsonb_build_object('text', case when v_quente then '🔥 Lead quente: ' else '' end || 'Agente passou ' || v_nome || ' para ' || v_owner, 'created', now()));
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (v_company, null, 'agent', 'agent.assign', case when v_lead is null then 'conversation' else 'lead' end, coalesce(v_lead, p_conversation));
  return v_owner;
end $$;

revoke all on function public.wa_agent_assign(uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.wa_agent_assign(uuid, text, boolean) to service_role;

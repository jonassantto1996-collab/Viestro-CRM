-- Agente automático move o lead no funil conforme a conversa.
-- Travas (o banco decide, não a IA): só o servidor chama (service_role); só leads já ligados
-- à conversa; etapa precisa existir no funil da empresa; só avança (nunca volta); nunca
-- move para Ganho/Perdido nem tira um lead de Ganho/Perdido (isso é decisão da equipe).

create function public.wa_agent_move_stage(p_conversation uuid, p_stage text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid; v_lead uuid; v_data jsonb; v_stages jsonb; v_from bigint; v_to bigint;
begin
  select c.company_id, k.crm_lead_id into v_company, v_lead
  from public.wa_conversations c join public.wa_contacts k on k.id = c.contact_id and k.company_id = c.company_id
  where c.id = p_conversation;
  if v_lead is null then return false; end if;

  select settings->'stages' into v_stages from public.crm_companies where id = v_company;
  if p_stage is null or p_stage in ('Ganho', 'Perdido') or v_stages is null or not (v_stages ? p_stage) then return false; end if;

  select data into v_data from public.crm_records
  where id = v_lead and company_id = v_company and kind = 'leads' for update;
  if v_data is null or v_data->>'stage' in ('Ganho', 'Perdido') or v_data->>'stage' = p_stage then return false; end if;

  select e.i into v_from from jsonb_array_elements_text(v_stages) with ordinality e(s, i) where e.s = v_data->>'stage';
  select e.i into v_to from jsonb_array_elements_text(v_stages) with ordinality e(s, i) where e.s = p_stage;
  if v_from is not null and v_to <= v_from then return false; end if;

  update public.crm_records
  set data = data || jsonb_build_object('stage', p_stage, 'updated', now(), 'stage_by', 'agent', 'stage_at', now()),
      updated_at = now()
  where id = v_lead;
  insert into public.crm_records (company_id, kind, data)
  values (v_company, 'activity', jsonb_build_object('text', 'Agente moveu ' || left(coalesce(v_data->>'name', 'lead'), 80) || ' para ' || p_stage, 'created', now()));
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (v_company, null, 'agent', 'agent.move_stage', 'lead', v_lead);
  return true;
end $$;

revoke all on function public.wa_agent_move_stage(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.wa_agent_move_stage(uuid, text) to service_role;

-- Qualificação automática pelo agente: a cada resposta do modo automático, o agente diz quais
-- critérios da empresa (settings.criteria, 4 linhas) a conversa já comprova e a temperatura do lead
-- (frio, morno, quente). Travas (o banco decide, não a IA):
--  * só o servidor chama (service_role); só lead já ligado à conversa;
--  * nunca mexe em lead Ganho/Perdido (decisão da equipe);
--  * critérios só são MARCADOS (nunca desmarca o que a equipe ou o agente já marcou);
--  * pontuação = critérios marcados x 25 (a mesma conta da tela);
--  * temperatura segue a conversa, mas "quente" não volta a esfriar sozinho;
--  * só grava, registra atividade e auditoria quando algo muda.

create function public.wa_agent_qualify(p_conversation uuid, p_criteria text[], p_temperature text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid; v_lead uuid; v_data jsonb; v_criterios jsonb; v_checks jsonb; v_score int; v_old_score int;
  v_temp text; v_old_temp text; v_nome text;
begin
  select c.company_id, k.crm_lead_id into v_company, v_lead
  from public.wa_conversations c join public.wa_contacts k on k.id = c.contact_id and k.company_id = c.company_id
  where c.id = p_conversation;
  if v_lead is null then return false; end if;

  select case when jsonb_typeof(settings->'criteria') = 'array' then settings->'criteria' else '[]'::jsonb end
    into v_criterios from public.crm_companies where id = v_company;

  select data into v_data from public.crm_records
  where id = v_lead and company_id = v_company and kind = 'leads' for update;
  if v_data is null or v_data->>'stage' in ('Ganho', 'Perdido') then return false; end if;

  -- 4 critérios: fica marcado o que já estava OU o que o agente comprovou agora (pelo nome exato).
  select jsonb_agg(coalesce(v_data->'checks'->i = 'true'::jsonb, false)
                   or coalesce(v_criterios->>i = any(coalesce(p_criteria, '{}')), false) order by i)
    into v_checks from generate_series(0, 3) i;
  select count(*) * 25 into v_score from jsonb_array_elements(v_checks) x where x = 'true'::jsonb;
  v_old_score := coalesce((v_data->>'score')::int, 0);

  v_old_temp := v_data->>'temperature';
  v_temp := case when p_temperature in ('frio', 'morno', 'quente') and coalesce(v_old_temp, '') <> 'quente'
                 then p_temperature else v_old_temp end;

  if v_checks = coalesce(v_data->'checks', '[]'::jsonb) and v_score = v_old_score and v_temp is not distinct from v_old_temp then
    return false;
  end if;

  update public.crm_records
  set data = data || jsonb_build_object('checks', v_checks, 'score', v_score, 'updated', now(), 'qualified_by', 'agent', 'qualified_at', now())
             || case when v_temp is distinct from v_old_temp then jsonb_build_object('temperature', v_temp, 'temperature_at', now()) else '{}'::jsonb end,
      updated_at = now()
  where id = v_lead;

  v_nome := left(coalesce(nullif(trim(v_data->>'name'), ''), 'lead'), 80);
  if v_score > v_old_score then
    insert into public.crm_records (company_id, kind, data)
    values (v_company, 'activity', jsonb_build_object('text', 'Agente qualificou ' || v_nome || ': ' || (v_score / 25) || ' de 4 critérios (' || v_score || ' pts)', 'created', now()));
  end if;
  if v_temp is distinct from v_old_temp and v_temp is not null then
    insert into public.crm_records (company_id, kind, data)
    values (v_company, 'activity', jsonb_build_object('text', case when v_temp = 'quente' then '🔥 ' else '' end || 'Agente marcou ' || v_nome || ' como lead ' || v_temp, 'created', now()));
  end if;
  insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (v_company, null, 'agent', 'agent.qualify', 'lead', v_lead);
  return true;
end $$;

revoke all on function public.wa_agent_qualify(uuid, text[], text) from public, anon, authenticated, service_role;
grant execute on function public.wa_agent_qualify(uuid, text[], text) to service_role;

-- Importação de leads em lote (planilhas do CRM Cowboy do Marketing).
-- Só o administrador da empresa importa. Não duplica: pula quem já existe pelo
-- código da importação, pelo telefone ou pelo vínculo do WhatsApp (contact_links).
-- Registra o telefone em contact_links (com e sem o 9) para a conversa do WhatsApp
-- cair no lead importado em vez de criar outro.

create function crm_private.import_leads(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  tid uuid := crm_private.company();
  s jsonb; r jsonb; i int := 0; rid uuid;
  v_ins int := 0; v_skip int := 0;
  v_name text; v_phone text; v_digits text; v_key text; v_key8 text; v_stage text; v_ext text; v_created timestamptz;
begin
  if tid is null then raise exception 'Faça login'; end if;
  if not crm_private.is_admin() then raise exception 'Só o administrador pode importar'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 500
     or octet_length(p_rows::text) > 1500000 then
    raise exception 'Envie de 1 a 500 linhas por vez';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm_import:' || tid::text, 0));
  select settings into s from public.crm_companies where id = tid for share;

  for r in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    if jsonb_typeof(r) is distinct from 'object' then raise exception 'Linha % inválida', i; end if;
    v_name := left(trim(coalesce(r->>'name', '')), 120);
    v_phone := coalesce(r->>'phone', '');
    v_ext := left(coalesce(r->>'importId', ''), 80);
    if length(v_name) = 0 then raise exception 'Linha % sem nome', i; end if;
    if v_phone <> '' and v_phone !~ '^\+55\d{10,11}$' then raise exception 'Linha % com telefone inválido', i; end if;

    v_digits := substr(v_phone, 2);
    v_key := 'phone:' || v_digits;
    -- Celular com 13 dígitos: o WhatsApp costuma identificar sem o 9.
    v_key8 := case when length(v_digits) = 13 then 'phone:' || left(v_digits, 4) || substr(v_digits, 6) end;

    if (v_ext <> '' and exists (select 1 from public.crm_records where company_id = tid and kind = 'leads' and data->>'importId' = v_ext))
       or (v_phone <> '' and (
            exists (select 1 from crm_private.contact_links where company_id = tid and contact_key in (v_key, coalesce(v_key8, v_key)))
         or exists (select 1 from public.crm_records where company_id = tid and kind = 'leads' and data->>'phone' = v_phone))) then
      v_skip := v_skip + 1;
      continue;
    end if;

    v_stage := r->>'stage';
    if v_stage is null or not (s->'stages' ? v_stage) then v_stage := s->'stages'->>0; end if;
    v_created := case when coalesce(r->>'created', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
                      then (r->>'created')::timestamptz else now() end;
    if v_created > now() then v_created := now(); end if;

    rid := gen_random_uuid();
    insert into public.crm_records (id, company_id, kind, data) values (rid, tid, 'leads', jsonb_build_object(
      'id', rid, 'name', v_name, 'source', 'Cowboy', 'phone', v_phone, 'email', '', 'business', '',
      'notes', left(coalesce(r->>'notes', ''), 2000), 'utm_campaign', '', 'stage', v_stage,
      'owner', coalesce(nullif(left(trim(coalesce(r->>'owner', '')), 60), ''), 'Equipe'),
      'value', 0, 'score', 0, 'checks', '[false,false,false,false]'::jsonb,
      'importId', v_ext, 'created', v_created, 'imported', now()));
    if v_phone <> '' then
      insert into crm_private.contact_links (company_id, contact_key, lead_id) values (tid, v_key, rid) on conflict do nothing;
      if v_key8 is not null then
        insert into crm_private.contact_links (company_id, contact_key, lead_id) values (tid, v_key8, rid) on conflict do nothing;
      end if;
    end if;
    v_ins := v_ins + 1;
  end loop;

  if v_ins > 0 then
    insert into public.crm_records (company_id, kind, data)
    values (tid, 'activity', jsonb_build_object('text', 'Importação de planilha: ' || v_ins || ' leads', 'created', now()));
  end if;
  return jsonb_build_object('inserted', v_ins, 'skipped', v_skip);
end $$;

create function public.crm_import_leads(p_rows jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select crm_private.import_leads(p_rows) $$;

-- O Supabase concede EXECUTE a PUBLIC por padrão.
revoke all on function crm_private.import_leads(jsonb), public.crm_import_leads(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function crm_private.import_leads(jsonb), public.crm_import_leads(jsonb) to authenticated;

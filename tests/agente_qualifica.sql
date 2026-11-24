-- Testes: qualificação automática pelo agente (wa_agent_qualify): critérios, pontuação e temperatura.
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('cccccccc-0000-4000-8000-00000000e001','fn-admin-a@example.invalid',now()),
 ('dddddddd-0000-4000-8000-00000000e002','fn-admin-b@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000e001","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja Qualifica Teste','Motos');
select set_config('request.jwt.claims','{"sub":"dddddddd-0000-4000-8000-00000000e002","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Loja B Qualifica','Motos');
reset role;

update public.crm_companies set settings = settings || '{"wa_auto_lead":true,"criteria":["Necessidade identificada","Orçamento disponível","Poder de decisão","Prazo definido"],"stages":["Novo Lead","Em contato","Em Negociação","Visita Agendada","CPF Negativado","Follow UP","Ganho","Perdido"]}'
  where id = (select company_id from public.crm_members where user_id='cccccccc-0000-4000-8000-00000000e001');

-- Lead importado do Cowboy com o 9 (+55 94 9 7777-6666)
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000e001","role":"authenticated"}',true);
select public.crm_import_leads('[{"name":"Cliente Importado","phone":"+5594977776666","stage":"Em contato","importId":"cowboy:q1"}]');
reset role;

create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='cccccccc-0000-4000-8000-00000000e001'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','995000111','WA Qualifica',true from ca returning id, company_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status)
             select ch.company_id, ch.id, '995000111','995000222','+5594900005555','connected' from ch returning id, company_id)
select acc.id account_id, acc.company_id from acc;

-- O WhatsApp identifica o cliente SEM o 9 (559477776666)
select public.wa_ingest(jsonb_build_array(jsonb_build_object('type','message','key','995000111:msg:wamid.QL1','phone_number_id','995000111',
  'payload', jsonb_build_object('wa_id','559477776666','name','Cliente WhatsApp','wamid','wamid.QL1',
    'ts', to_char((now() - interval '30 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body','Quanto fica a entrada?'))));
select crm_private.wa_run_events(50);

do $$ declare v_conv uuid; v_lead uuid; d jsonb; n int; begin
  select c.id, k.crm_lead_id into v_conv, v_lead from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id join fx on fx.company_id=c.company_id;
  if v_lead is null then raise exception 'fixture: conversa sem lead'; end if;

  -- 1. Marca critérios pelo nome, calcula a pontuação e grava a temperatura
  if not public.wa_agent_qualify(v_conv, array['Necessidade identificada','Prazo definido','Inventado'], 'morno') then raise exception 'Falha 1a'; end if;
  select data into d from public.crm_records where id=v_lead;
  if d->'checks' <> '[true,false,false,true]'::jsonb or (d->>'score')::int <> 50 or d->>'temperature' <> 'morno' then raise exception 'Falha 1b: %', d; end if;
  if not exists (select 1 from public.crm_records r join fx on fx.company_id=r.company_id where r.kind='activity' and r.data->>'text' like 'Agente qualificou Cliente Importado: 2 de 4 critérios (50 pts)') then raise exception 'Falha 1c: atividade'; end if;
  if not exists (select 1 from public.wa_audit_logs a join fx on fx.company_id=a.company_id where a.action='agent.qualify' and a.target_id=v_lead) then raise exception 'Falha 1d: auditoria'; end if;

  -- 2. Nunca desmarca: nova resposta só com outro critério soma
  perform public.wa_agent_qualify(v_conv, array['Orçamento disponível'], 'quente');
  select data into d from public.crm_records where id=v_lead;
  if d->'checks' <> '[true,true,false,true]'::jsonb or (d->>'score')::int <> 75 or d->>'temperature' <> 'quente' then raise exception 'Falha 2: %', d; end if;

  -- 3. Quente não esfria sozinho; nada mudou = não grava de novo
  select count(*) into n from public.crm_records r join fx on fx.company_id=r.company_id where r.kind='activity';
  if public.wa_agent_qualify(v_conv, array['Orçamento disponível'], 'frio') then raise exception 'Falha 3a: gravou sem mudança'; end if;
  if (select data->>'temperature' from public.crm_records where id=v_lead) <> 'quente' then raise exception 'Falha 3b: esfriou'; end if;
  if (select count(*) from public.crm_records r join fx on fx.company_id=r.company_id where r.kind='activity') <> n then raise exception 'Falha 3c: atividade repetida'; end if;

  -- 4. Lead Ganho ou Perdido: decisão da equipe, o agente não mexe
  update public.crm_records set data = data || '{"stage":"Ganho","checks":[false,false,false,false],"score":0}' where id=v_lead;
  if public.wa_agent_qualify(v_conv, array['Poder de decisão'], 'quente') then raise exception 'Falha 4a'; end if;
  if (select (data->>'score')::int from public.crm_records where id=v_lead) <> 0 then raise exception 'Falha 4b'; end if;

  -- 5. Conversa inexistente
  if public.wa_agent_qualify(gen_random_uuid(), array['Prazo definido'], 'morno') then raise exception 'Falha 5'; end if;
end $$;

-- 6. Só o servidor chama
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000e001","role":"authenticated"}',true);
do $$ begin
  begin perform public.wa_agent_qualify(gen_random_uuid(), array['x'], 'morno'); raise exception 'Falha 6: usuário chamou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

create temp table resultado_teste as select 'agente_qualifica: todos os testes passaram'::text as resultado;
select * from resultado_teste;
rollback;

-- Testes: lead importado é reconhecido no WhatsApp (sem o 9) e o agente só avança no funil.
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('cccccccc-0000-4000-8000-00000000f001','fn-admin-a@example.invalid',now()),
 ('dddddddd-0000-4000-8000-00000000f002','fn-admin-b@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000f001","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja Funil Teste','Motos');
select set_config('request.jwt.claims','{"sub":"dddddddd-0000-4000-8000-00000000f002","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Loja B Funil','Motos');
reset role;

update public.crm_companies set settings = settings || '{"wa_auto_lead":true,"stages":["Novo Lead","Em contato","Em Negociação","Visita Agendada","CPF Negativado","Follow UP","Ganho","Perdido"]}'
  where id = (select company_id from public.crm_members where user_id='cccccccc-0000-4000-8000-00000000f001');

-- Lead importado do Cowboy com o 9 (+55 94 9 7777-6666)
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000f001","role":"authenticated"}',true);
select public.crm_import_leads('[{"name":"Cliente Importado","phone":"+5594977776666","stage":"Em contato","importId":"cowboy:t1"}]');
reset role;

create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='cccccccc-0000-4000-8000-00000000f001'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','998000111','WA Funil',true from ca returning id, company_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status)
             select ch.company_id, ch.id, '998000111','998000222','+5594900008888','connected' from ch returning id, company_id)
select acc.id account_id, acc.company_id from acc;

-- O WhatsApp identifica o cliente SEM o 9 (559477776666)
select public.wa_ingest(jsonb_build_array(jsonb_build_object('type','message','key','998000111:msg:wamid.FN1','phone_number_id','998000111',
  'payload', jsonb_build_object('wa_id','559477776666','name','Cliente WhatsApp','wamid','wamid.FN1',
    'ts', to_char((now() - interval '30 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body','Quanto fica a entrada?'))));
select crm_private.wa_run_events(50);

do $$ declare v_conv uuid; v_lead uuid; v_lead_conv uuid; n int; st text; begin
  select c.id, k.crm_lead_id into v_conv, v_lead_conv from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id join fx on fx.company_id=c.company_id;
  select r.id into v_lead from public.crm_records r join fx on fx.company_id=r.company_id where r.kind='leads' and r.data->>'importId'='cowboy:t1';
  if v_conv is null then raise exception 'fixture: conversa não criada'; end if;

  -- 1. Conversa cai no lead importado (não cria outro)
  if v_lead_conv is distinct from v_lead then raise exception 'Falha 1a: conversa não ligou ao lead importado'; end if;
  select count(*) into n from public.crm_records r join fx on fx.company_id=r.company_id where r.kind='leads';
  if n <> 1 then raise exception 'Falha 1b: criou lead duplicado (% leads)', n; end if;

  -- 2. Avança: Em contato -> Em Negociação
  if not public.wa_agent_move_stage(v_conv, 'Em Negociação') then raise exception 'Falha 2a: não avançou'; end if;
  select data->>'stage' into st from public.crm_records where id=v_lead;
  if st <> 'Em Negociação' then raise exception 'Falha 2b: etapa %', st; end if;
  if (select data->>'stage_by' from public.crm_records where id=v_lead) <> 'agent' then raise exception 'Falha 2c: sem marca do agente'; end if;
  if not exists (select 1 from public.crm_records r join fx on fx.company_id=r.company_id where r.kind='activity' and r.data->>'text'='Agente moveu Cliente Importado para Em Negociação') then raise exception 'Falha 2d: atividade'; end if;
  if not exists (select 1 from public.wa_audit_logs a join fx on fx.company_id=a.company_id where a.action='agent.move_stage' and a.target_id=v_lead) then raise exception 'Falha 2e: auditoria'; end if;

  -- 3. Não volta, não repete, não inventa etapa, não decide Ganho/Perdido
  if public.wa_agent_move_stage(v_conv, 'Em contato') then raise exception 'Falha 3a: voltou etapa'; end if;
  if public.wa_agent_move_stage(v_conv, 'Em Negociação') then raise exception 'Falha 3b: moveu para a mesma etapa'; end if;
  if public.wa_agent_move_stage(v_conv, 'Etapa inventada') then raise exception 'Falha 3c: etapa inexistente'; end if;
  if public.wa_agent_move_stage(v_conv, 'Ganho') then raise exception 'Falha 3d: agente marcou Ganho'; end if;
  if public.wa_agent_move_stage(v_conv, 'Perdido') then raise exception 'Falha 3e: agente marcou Perdido'; end if;
  if public.wa_agent_move_stage(v_conv, null) then raise exception 'Falha 3f: etapa nula'; end if;
  if (select data->>'stage' from public.crm_records where id=v_lead) <> 'Em Negociação' then raise exception 'Falha 3g: etapa mudou'; end if;

  -- 4. Avança mais uma vez e, depois que a equipe marca Ganho, o agente não mexe mais
  if not public.wa_agent_move_stage(v_conv, 'Visita Agendada') then raise exception 'Falha 4a'; end if;
  update public.crm_records set data = data || '{"stage":"Ganho"}' where id=v_lead;
  if public.wa_agent_move_stage(v_conv, 'Follow UP') then raise exception 'Falha 4b: mexeu em lead Ganho'; end if;

  -- 5. Conversa inexistente
  if public.wa_agent_move_stage(gen_random_uuid(), 'Em contato') then raise exception 'Falha 5'; end if;
end $$;

-- 6. Só o servidor chama
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000f001","role":"authenticated"}',true);
do $$ begin
  begin perform public.wa_agent_move_stage(gen_random_uuid(), 'Em contato'); raise exception 'Falha 6a: usuário chamou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.wa_agent_move_stage(gen_random_uuid(), 'Em contato'); raise exception 'Falha 6b: anônimo chamou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

create temp table resultado_teste as select 'agente_funil: todos os testes passaram'::text as resultado;
select * from resultado_teste;
rollback;

-- Testes: lead quente (wa_agent_assign com p_hot): tarefa com 🔥, lead marcado, sobe e nunca desce.
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('cccccccc-0000-4000-8000-00000000b001','at-admin-a@example.invalid',now()),
 ('dddddddd-0000-4000-8000-00000000b002','at-admin-b@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000b001","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja Quente Teste','Motos');
select set_config('request.jwt.claims','{"sub":"dddddddd-0000-4000-8000-00000000b002","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Loja B Quente','Motos');
reset role;

update public.crm_companies set settings = settings || '{"wa_auto_lead":true,"agent":{"enabled":false,"name":"Assistente","tone":"acolhedor","knowledge":"","handoff":"","attendants":["Agna"]}}'
  where id = (select company_id from public.crm_members where user_id='cccccccc-0000-4000-8000-00000000b001');

create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='cccccccc-0000-4000-8000-00000000b001'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','996000111','WA Quente',true from ca returning id, company_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status)
             select ch.company_id, ch.id, '996000111','996000222','+5594900006666','connected' from ch returning id, company_id)
select acc.id account_id, acc.company_id from acc;

-- Três clientes fictícios escrevem
select public.wa_ingest((select jsonb_agg(jsonb_build_object('type','message','key','996000111:msg:wamid.LQ'||n,'phone_number_id','996000111',
  'payload', jsonb_build_object('wa_id','55949000020'||n,'name','Cliente '||n,'wamid','wamid.LQ'||n,
    'ts', to_char((now() - interval '30 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body','Quero falar com o vendedor'))) from generate_series(1,3) n));
select crm_private.wa_run_events(50);

do $$ declare
  v_co uuid; c1 uuid; c2 uuid; c3 uuid; l1 uuid; l2 uuid; t jsonb;
begin
  select company_id into v_co from fx;
  select c.id, k.crm_lead_id into c1, l1 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where c.company_id=v_co and k.name='Cliente 1';
  select c.id, k.crm_lead_id into c2, l2 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where c.company_id=v_co and k.name='Cliente 2';
  select c.id into c3 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where c.company_id=v_co and k.name='Cliente 3';
  if c1 is null or c2 is null or c3 is null or l1 is null or l2 is null then raise exception 'fixture: conversas/leads não criados'; end if;

  -- 1. Passagem quente: tarefa com 🔥 e hot, lead quente, atividade marcada
  if public.wa_agent_assign(c1, 'Perguntou parcela', true) <> 'Agna' then raise exception 'Falha 1a'; end if;
  select data into t from public.crm_records where company_id=v_co and kind='tasks' and data->>'conversationId'=c1::text;
  if t->>'title' not like '🔥 Atender Cliente 1%' or (t->>'hot')::boolean is not true then raise exception 'Falha 1b: %', t; end if;
  if (select data->>'temperature' from public.crm_records where id=l1) <> 'quente' then raise exception 'Falha 1c: lead não ficou quente'; end if;
  if not exists (select 1 from public.crm_records where company_id=v_co and kind='activity' and data->>'text' like '🔥 Lead quente: Agente passou Cliente 1%') then raise exception 'Falha 1d: atividade'; end if;

  -- 2. Passagem comum (chamada antiga, sem p_hot): sem 🔥, sem hot, lead sem temperatura
  perform public.wa_agent_assign(c2, 'Reclamação');
  select data into t from public.crm_records where company_id=v_co and kind='tasks' and data->>'conversationId'=c2::text;
  if t->>'title' like '🔥%' or t ? 'hot' then raise exception 'Falha 2a: %', t; end if;
  if (select data ? 'temperature' from public.crm_records where id=l2) then raise exception 'Falha 2b'; end if;

  -- 3. A mesma conversa fica quente depois: a tarefa aberta sobe para quente (sem duplicar o 🔥)
  perform public.wa_agent_assign(c2, 'Agora perguntou preço', true);
  perform public.wa_agent_assign(c2, 'De novo', true);
  select data into t from public.crm_records where company_id=v_co and kind='tasks' and data->>'conversationId'=c2::text;
  if t->>'title' not like '🔥 Atender Cliente 2%' or t->>'title' like '🔥 🔥%' or (t->>'hot')::boolean is not true then raise exception 'Falha 3a: %', t; end if;
  if (select data->>'temperature' from public.crm_records where id=l2) <> 'quente' then raise exception 'Falha 3b'; end if;

  -- 4. Quente nunca desce: nova passagem comum na tarefa aberta mantém 🔥
  perform public.wa_agent_assign(c1, 'Só uma dúvida', false);
  select data into t from public.crm_records where company_id=v_co and kind='tasks' and data->>'conversationId'=c1::text;
  if (t->>'hot')::boolean is not true or t->>'notes' <> 'Só uma dúvida' then raise exception 'Falha 4: %', t; end if;

  -- 5. Quente sem lead ligado e sem atendentes: vai para Equipe com 🔥
  update public.wa_contacts set crm_lead_id = null where id = (select contact_id from public.wa_conversations where id=c3);
  update public.crm_companies set settings = jsonb_set(settings, '{agent,attendants}', '[]') where id=v_co;
  if public.wa_agent_assign(c3, 'Quer reservar', true) <> 'Equipe' then raise exception 'Falha 5a'; end if;
  if (select data->>'title' from public.crm_records where company_id=v_co and kind='tasks' and data->>'conversationId'=c3::text) not like '🔥%' then raise exception 'Falha 5b'; end if;
end $$;

-- 6. Só o servidor chama a nova versão; a versão antiga (2 parâmetros) não existe mais à parte
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000b001","role":"authenticated"}',true);
do $$ begin
  begin perform public.wa_agent_assign(gen_random_uuid(), 'x', true); raise exception 'Falha 6a: usuário chamou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  if (select count(*) from pg_proc where proname='wa_agent_assign' and pronamespace='public'::regnamespace) <> 1 then raise exception 'Falha 6b: sobrou versão antiga'; end if;
end $$;

create temp table resultado_teste as select 'lead_quente: todos os testes passaram'::text as resultado;
select * from resultado_teste;
rollback;

-- Testes: divisão do lead quente entre atendentes (wa_agent_assign) com tarefa e resumo.
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('cccccccc-0000-4000-8000-00000000a001','at-admin-a@example.invalid',now()),
 ('dddddddd-0000-4000-8000-00000000a002','at-admin-b@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000a001","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja Atendentes Teste','Motos');
select set_config('request.jwt.claims','{"sub":"dddddddd-0000-4000-8000-00000000a002","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Loja B Atendentes','Motos');
reset role;

update public.crm_companies set settings = settings || '{"wa_auto_lead":true,"agent":{"enabled":false,"name":"Assistente","tone":"acolhedor","knowledge":"","handoff":"","attendants":["Agna"]}}'
  where id = (select company_id from public.crm_members where user_id='cccccccc-0000-4000-8000-00000000a001');

create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='cccccccc-0000-4000-8000-00000000a001'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','997000111','WA Atendentes',true from ca returning id, company_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status)
             select ch.company_id, ch.id, '997000111','997000222','+5594900007777','connected' from ch returning id, company_id)
select acc.id account_id, acc.company_id from acc;

-- Três clientes fictícios escrevem
select public.wa_ingest((select jsonb_agg(jsonb_build_object('type','message','key','997000111:msg:wamid.AT'||n,'phone_number_id','997000111',
  'payload', jsonb_build_object('wa_id','55949000010'||n,'name','Cliente '||n,'wamid','wamid.AT'||n,
    'ts', to_char((now() - interval '30 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body','Quero falar com o vendedor'))) from generate_series(1,3) n));
select crm_private.wa_run_events(50);

do $$ declare
  v_co uuid; c1 uuid; c2 uuid; c3 uuid; l1 uuid; l2 uuid; quem text; n int; t jsonb;
begin
  select company_id into v_co from fx;
  select c.id, k.crm_lead_id into c1, l1 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where c.company_id=v_co and k.name='Cliente 1';
  select c.id, k.crm_lead_id into c2, l2 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where c.company_id=v_co and k.name='Cliente 2';
  select c.id into c3 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where c.company_id=v_co and k.name='Cliente 3';
  if c1 is null or c2 is null or c3 is null or l1 is null or l2 is null then raise exception 'fixture: conversas/leads não criados'; end if;
  update public.wa_contacts set crm_lead_id = null where id = (select contact_id from public.wa_conversations where id=c3); -- conversa sem lead

  -- 1. Um atendente só (Agna): recebe o lead, a tarefa e o resumo
  quem := public.wa_agent_assign(c1, 'Interesse: moto 160cc'||chr(10)||'Próximo passo: ligar');
  if quem is distinct from 'Agna' then raise exception 'Falha 1a: foi para %', quem; end if;
  if (select data->>'owner' from public.crm_records where id=l1) <> 'Agna' then raise exception 'Falha 1b: lead sem a Agna'; end if;
  select data into t from public.crm_records where company_id=v_co and kind='tasks' and data->>'source'='agent_handoff' and data->>'conversationId'=c1::text;
  if t is null then raise exception 'Falha 1c: tarefa não criada'; end if;
  if t->>'owner' <> 'Agna' or (t->>'done')::boolean or t->>'leadId' <> l1::text or t->>'notes' not like 'Interesse: moto 160cc%'
     or t->>'due' <> ((now() at time zone 'America/Sao_Paulo')::date)::text or t->>'title' not like 'Atender Cliente 1%' then
    raise exception 'Falha 1d: tarefa errada %', t; end if;
  if not exists (select 1 from public.crm_records where company_id=v_co and kind='activity' and data->>'text'='Agente passou Cliente 1 para Agna') then raise exception 'Falha 1e: atividade'; end if;
  if not exists (select 1 from public.wa_audit_logs where company_id=v_co and action='agent.assign' and target_id=l1) then raise exception 'Falha 1f: auditoria'; end if;

  -- 2. Mesma conversa passada de novo com a tarefa aberta: não duplica, só atualiza o resumo
  quem := public.wa_agent_assign(c1, 'Resumo novo');
  select count(*) into n from public.crm_records where company_id=v_co and kind='tasks' and data->>'source'='agent_handoff' and data->>'conversationId'=c1::text;
  if quem <> 'Agna' or n <> 1 then raise exception 'Falha 2a: duplicou (% tarefas, %)', n, quem; end if;
  if (select data->>'notes' from public.crm_records where company_id=v_co and kind='tasks' and data->>'conversationId'=c1::text) <> 'Resumo novo' then raise exception 'Falha 2b: resumo não atualizado'; end if;

  -- 3. Cadastram o segundo atendente: passa a alternar (último foi Agna -> Bruno -> Agna)
  update public.crm_companies set settings = jsonb_set(settings, '{agent,attendants}', '["Agna","Bruno"]') where id=v_co;
  if public.wa_agent_assign(c2, 'x') <> 'Bruno' then raise exception 'Falha 3a: não alternou para Bruno'; end if;
  if (select data->>'owner' from public.crm_records where id=l2) <> 'Bruno' then raise exception 'Falha 3b: lead sem o Bruno'; end if;
  if public.wa_agent_assign(c3, 'y') <> 'Agna' then raise exception 'Falha 3c: não voltou para Agna'; end if;
  select data into t from public.crm_records where company_id=v_co and kind='tasks' and data->>'conversationId'=c3::text;
  if t ? 'leadId' or t->>'title' not like 'Atender Cliente 3%' then raise exception 'Falha 3d: conversa sem lead %', t; end if;

  -- 4. Cliente que volta fica com quem já atendia (a vez seria do Bruno)
  update public.crm_records set data = data || '{"done":true}' where company_id=v_co and kind='tasks' and data->>'conversationId'=c1::text;
  if public.wa_agent_assign(c1, 'voltou') <> 'Agna' then raise exception 'Falha 4a: trocou o atendente do cliente que voltou'; end if;
  select count(*) into n from public.crm_records where company_id=v_co and kind='tasks' and data->>'conversationId'=c1::text;
  if n <> 2 then raise exception 'Falha 4b: esperava nova tarefa (%)', n; end if;

  -- 5. Lista vazia ou inválida: vai para "Equipe" e não apaga o responsável do lead
  update public.crm_records set data = data || '{"done":true}' where company_id=v_co and kind='tasks' and data->>'conversationId'=c2::text;
  update public.crm_companies set settings = jsonb_set(settings, '{agent,attendants}', '[]') where id=v_co;
  if public.wa_agent_assign(c2, 'z') <> 'Equipe' then raise exception 'Falha 5a: lista vazia'; end if;
  if (select data->>'owner' from public.crm_records where id=l2) <> 'Bruno' then raise exception 'Falha 5b: apagou o responsável'; end if;
  update public.crm_records set data = data || '{"done":true}' where company_id=v_co and kind='tasks' and data->>'conversationId'=c2::text;
  update public.crm_companies set settings = jsonb_set(settings, '{agent,attendants}', '"Agna"') where id=v_co;
  if public.wa_agent_assign(c2, 'z') <> 'Equipe' then raise exception 'Falha 5c: lista inválida'; end if;

  -- 6. Conversa inexistente
  if public.wa_agent_assign(gen_random_uuid(), 'x') is not null then raise exception 'Falha 6'; end if;

  -- 7. Nada vazou para a outra empresa
  if exists (select 1 from public.crm_records r join public.crm_members m on m.company_id=r.company_id
             where m.user_id='dddddddd-0000-4000-8000-00000000a002' and r.kind='tasks') then raise exception 'Falha 7: tarefa na outra empresa'; end if;
end $$;

-- 8. A equipe conclui a tarefa pela tela: o resumo e a origem continuam na tarefa
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-00000000a001","role":"authenticated"}',true);
select public.crm_save('tasks', (select data || jsonb_build_object('id', id, 'done', true) from public.crm_records
  where kind='tasks' and data->>'title' like 'Atender Cliente 3%'));
do $$ begin
  if not exists (select 1 from public.crm_records where kind='tasks' and data->>'title' like 'Atender Cliente 3%'
                 and (data->>'done')::boolean and data->>'notes'='y' and data->>'source'='agent_handoff') then
    raise exception 'Falha 8: salvar pela tela perdeu o resumo'; end if;
end $$;

-- 9. Só o servidor chama
do $$ begin
  begin perform public.wa_agent_assign(gen_random_uuid(), 'x'); raise exception 'Falha 9a: usuário chamou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.wa_agent_assign(gen_random_uuid(), 'x'); raise exception 'Falha 9b: anônimo chamou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

create temp table resultado_teste as select 'agente_atendentes: todos os testes passaram'::text as resultado;
select * from resultado_teste;
rollback;

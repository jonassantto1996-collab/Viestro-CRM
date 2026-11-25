-- Testes: WasapFlow Bridge por número (ingestão separada por fornecedor, aviso do número, troca do número),
-- dono do número na passagem, fila do alerta do atendente, relatório diário e relógio do worker.
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('aaaaaaaa-0000-4000-8000-0000000a7f01','wf-admin-a@example.invalid',now()),
 ('bbbbbbbb-0000-4000-8000-0000000b7f02','wf-admin-b@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a7f01","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja Moto Teste','Motos');
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-0000000b7f02","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Assessoria Teste','Marketing');
reset role;

-- Empresa A: dois números da loja no WasapFlow (WABAs diferentes). Empresa B: um número no EasyCoexistence.
create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='aaaaaaaa-0000-4000-8000-0000000a7f01'),
     cb as (select company_id id from public.crm_members where user_id='bbbbbbbb-0000-4000-8000-0000000b7f02'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','771000001','Loja 1',true from ca union all
            select id,'whatsapp','771000002','Loja 2',true from ca union all
            select id,'whatsapp','771000003','Viestro',true from cb returning id, company_id, external_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,provider,phone_number_id,waba_id,phone_e164,connection_status)
             select company_id, id, case when external_id = '771000003' then 'easycoexistence' else 'wasapflow' end, external_id,
                    case external_id when '771000001' then '881000001' when '771000002' then '881000002' else '881000003' end,
                    case external_id when '771000001' then '+5594900006088' when '771000002' then '+5594900001715' else '+5594900009999' end,
                    'connected' from ch returning id, company_id, phone_number_id)
select (select id from ca) empresa_a, (select id from cb) empresa_b,
       (select id from acc where phone_number_id='771000001') conta_1, (select id from acc where phone_number_id='771000002') conta_2,
       (select id from acc where phone_number_id='771000003') conta_v;
grant select on fx to authenticated, service_role;

create function pg_temp.msg(p_pnid text, p_wamid text, p_wa text, p_body text) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('type','message','key',p_pnid||':msg:'||p_wamid,'phone_number_id',p_pnid,
    'payload', jsonb_build_object('wa_id',p_wa,'name','Cliente Teste','wamid',p_wamid,'ts',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body',p_body)))
$$;

do $$ declare r jsonb; n int; v text; begin
  -- 1. O fornecedor novo é aceito e o número da Viestro continua no EasyCoexistence
  if (select provider from public.wa_accounts where id=(select conta_v from fx)) <> 'easycoexistence' then raise exception 'Falha 1a: Viestro mudou'; end if;
  begin
    update public.wa_accounts set provider = 'outro' where id = (select conta_1 from fx);
    raise exception 'Falha 1b: fornecedor inválido aceito';
  exception when check_violation then null; end;

  -- 2. Webhook antigo (wa_ingest) não grava evento de número do WasapFlow; o novo não grava de número do EasyCoexistence
  r := public.wa_ingest(pg_temp.msg('771000001','wamid.T2a','5594977770001','oi'));
  if (r->>'ignored')::int <> 1 then raise exception 'Falha 2a: caminho antigo aceitou número do WasapFlow: %', r; end if;
  r := public.wa_ingest_wasapflow('881000003', '771000003', pg_temp.msg('771000003','wamid.T2b','5594977770001','oi'));
  if (r->>'ignored')::int <> 1 then raise exception 'Falha 2b: WasapFlow aceitou número do EasyCoexistence: %', r; end if;
  r := public.wa_ingest(pg_temp.msg('771000003','wamid.T2c','5594977770001','oi'));
  if (r->>'inserted')::int <> 1 then raise exception 'Falha 2c: caminho antigo parou de funcionar: %', r; end if;

  -- 3. Achado pelo waba_id do envelope; sem phone_number_id também; duplicado não entra de novo
  r := public.wa_ingest_wasapflow('881000001', '771000001', pg_temp.msg('771000001','wamid.T3','5594977770001','Quanto custa a X16?'));
  if (r->>'inserted')::int <> 1 then raise exception 'Falha 3a: %', r; end if;
  r := public.wa_ingest_wasapflow('881000001', '771000001', pg_temp.msg('771000001','wamid.T3','5594977770001','Quanto custa a X16?'));
  if (r->>'duplicates')::int <> 1 then raise exception 'Falha 3b: duplicou: %', r; end if;
  r := public.wa_ingest_wasapflow('881000002', null, pg_temp.msg('wf881000002','wamid.T3c','5594977770002','oi'));
  if (r->>'inserted')::int <> 1 then raise exception 'Falha 3c: sem phone_number_id: %', r; end if;
  if (select account_id from public.wa_webhook_events where external_event_id='wf881000002:msg:wamid.T3c') <> (select conta_2 from fx) then raise exception 'Falha 3d: conta errada'; end if;
  r := public.wa_ingest_wasapflow('881000001', '771000002', pg_temp.msg('771000002','wamid.T3e','5594977770001','oi'));
  if (r->>'ignored')::int <> 1 then raise exception 'Falha 3e: waba e número não batem: %', r; end if;
  r := public.wa_ingest_wasapflow('999999999', null, pg_temp.msg('x','wamid.T3f','5594977770001','oi'));
  if (r->>'ignored')::int <> 1 then raise exception 'Falha 3f: waba desconhecido: %', r; end if;

  -- 4. Processamento igual ao de hoje: mensagem, eco do celular, histórico e status
  r := public.wa_ingest_wasapflow('881000001', '771000001', jsonb_build_array(
    jsonb_build_object('type','echo','key','771000001:echo:wamid.T4e','phone_number_id','771000001','payload',
      jsonb_build_object('wa_id','5594977770001','wamid','wamid.T4e','type','text','body','Bom dia! Já te passo o valor.')),
    jsonb_build_object('type','history','key','771000001:hist:wamid.T4h','phone_number_id','771000001','payload',
      jsonb_build_object('wa_id','5594977770001','wamid','wamid.T4h','ts','2026-01-01T12:00:00Z','direction','inbound','type','text','body','mensagem antiga'))));
  perform crm_private.wa_run_events(50);
  if (select source||'|'||direction from public.wa_messages where external_message_id='wamid.T3') <> 'api_inbound|inbound' then raise exception 'Falha 4a'; end if;
  if (select source||'|'||direction from public.wa_messages where external_message_id='wamid.T4e') <> 'app_echo|outbound' then raise exception 'Falha 4b: eco'; end if;
  if (select source from public.wa_messages where external_message_id='wamid.T4h') <> 'history_sync' then raise exception 'Falha 4c: histórico'; end if;
  perform public.wa_ingest_wasapflow('881000001', '771000001', jsonb_build_array(
    jsonb_build_object('type','status','key','771000001:st:wamid.T4e:read','phone_number_id','771000001','payload',jsonb_build_object('wamid','wamid.T4e','status','read'))));
  perform crm_private.wa_run_events(50);
  if (select message_status from public.wa_messages where external_message_id='wamid.T4e') <> 'read' then raise exception 'Falha 4d: status'; end if;
end $$;

do $$ declare n int; begin
  -- 5. Aviso do número: liga, não repete, desliga só os códigos pedidos
  if not public.wa_account_alert((select conta_1 from fx), 'wf_pagamento') then raise exception 'Falha 5a'; end if;
  if public.wa_account_alert((select conta_1 from fx), 'wf_pagamento') then raise exception 'Falha 5b: repetiu'; end if;
  if public.wa_account_alert((select conta_1 from fx), null, array['wf_agente_meta']) then raise exception 'Falha 5c: apagou outro aviso'; end if;
  if (select provider_alert_code from public.wa_accounts where id=(select conta_1 from fx)) <> 'wf_pagamento' then raise exception 'Falha 5d'; end if;
  if not public.wa_account_alert((select conta_1 from fx), null, array['wf_pagamento']) then raise exception 'Falha 5e'; end if;
  if (select provider_alert_code from public.wa_accounts where id=(select conta_1 from fx)) is not null then raise exception 'Falha 5f'; end if;
  select count(*) into n from public.wa_audit_logs where target_id=(select conta_1 from fx) and action like 'account.alert%';
  if n <> 2 then raise exception 'Falha 5g: auditoria (%)', n; end if;
  begin perform public.wa_account_alert((select conta_1 from fx), 'Código Ruim'); raise exception 'Falha 5h'; exception when raise_exception then null; end;
  perform public.wa_account_alert((select conta_2 from fx), 'wf_agente_meta');
end $$;

-- 6. Usuário da empresa vê o aviso do próprio número (não o de outra empresa) e não chama as funções do servidor
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a7f01","role":"authenticated"}',true);
do $$ begin
  if (select provider_alert_code from public.wa_accounts where phone_number_id='771000002') <> 'wf_agente_meta' then raise exception 'Falha 6a: não vê o aviso'; end if;
  if exists (select 1 from public.wa_accounts where phone_number_id='771000003') then raise exception 'Falha 6b: viu número de outra empresa'; end if;
  begin perform public.wa_ingest_wasapflow('881000001', null, '[]'); raise exception 'Falha 6c'; exception when insufficient_privilege then null; end;
  begin perform public.wa_account_alert(gen_random_uuid(), null); raise exception 'Falha 6d'; exception when insufficient_privilege then null; end;
  begin perform public.wa_account_use_wasapflow(gen_random_uuid(), '+5594900000000', '1', '1', null); raise exception 'Falha 6e'; exception when insufficient_privilege then null; end;
  begin perform public.wa_alert_claim(10); raise exception 'Falha 6f'; exception when insufficient_privilege then null; end;
  begin perform public.wa_daily_report_claim(gen_random_uuid(), current_date); raise exception 'Falha 6g'; exception when insufficient_privilege then null; end;
  begin perform count(*) from public.wa_team_alerts; raise exception 'Falha 6h: leu a fila de alertas'; exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ declare v uuid; v_canal uuid; begin
  -- 7. Troca para o WasapFlow: número da empresa achado pelo telefone; canal acompanha o phone_number_id
  update public.wa_accounts set provider='easycoexistence' where id=(select conta_2 from fx);
  v := public.wa_account_use_wasapflow((select empresa_a from fx), '+5594900001715', '881000222', '771000222', 'Loja 2');
  if v <> (select conta_2 from fx) then raise exception 'Falha 7a: criou outra conta'; end if;
  if (select provider||'|'||waba_id||'|'||phone_number_id from public.wa_accounts where id=v) <> 'wasapflow|881000222|771000222' then raise exception 'Falha 7b'; end if;
  select crm_channel_id into v_canal from public.wa_accounts where id=v;
  if (select external_id from public.crm_channels where id=v_canal) <> '771000222' then raise exception 'Falha 7c: canal'; end if;
  if (select provider_alert_code from public.wa_accounts where id=v) is not null then raise exception 'Falha 7d: aviso velho ficou'; end if;
  -- Número novo vira conta nova; número de outra empresa é recusado
  v := public.wa_account_use_wasapflow((select empresa_a from fx), '+5594900005555', '881000555', '771000555', null);
  if (select company_id from public.wa_accounts where id=v) <> (select empresa_a from fx) then raise exception 'Falha 7e'; end if;
  begin perform public.wa_account_use_wasapflow((select empresa_a from fx), '+5594900009999', '881000003', '771000003', null); raise exception 'Falha 7f';
  exception when raise_exception then if sqlerrm not like '%outra empresa%' then raise; end if; end;
  if (select provider from public.wa_accounts where id=(select conta_v from fx)) <> 'easycoexistence' then raise exception 'Falha 7g: mexeu na Viestro'; end if;
  -- Volta o número 2 para os testes seguintes
  perform public.wa_account_use_wasapflow((select empresa_a from fx), '+5594900001715', '881000002', '771000002', 'Loja 2');
end $$;

-- 8. Dono do número: conversa do 6088 vai para a Agna, do 1715 para o Cleudo, sem revezar
update public.crm_companies set settings = settings || jsonb_build_object('agent', jsonb_build_object('enabled', true, 'mode', 'automatico',
  'name', 'Assistente', 'tone', 'acolhedor', 'knowledge', repeat('x', 40), 'handoff', '', 'attendants', jsonb_build_array('Agna','Cleudo'),
  'number_owners', jsonb_build_object('5594900006088','Agna','5594900001715','Cleudo')))
where id = (select empresa_a from fx);

do $$ declare c1 uuid; c2 uuid; c3 uuid; begin
  perform public.wa_ingest_wasapflow('881000001','771000001', pg_temp.msg('771000001','wamid.T8a','5594977770011','oi'));
  perform public.wa_ingest_wasapflow('881000001','771000001', pg_temp.msg('771000001','wamid.T8b','5594977770012','oi'));
  perform public.wa_ingest_wasapflow('881000002','771000002', pg_temp.msg('771000002','wamid.T8c','5594977770013','oi'));
  perform crm_private.wa_run_events(50);
  select c.id into c1 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where k.wa_id='5594977770011';
  select c.id into c2 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where k.wa_id='5594977770012';
  select c.id into c3 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where k.wa_id='5594977770013';
  if public.wa_agent_assign(c1, 'resumo 1', true) <> 'Agna' then raise exception 'Falha 8a'; end if;
  if public.wa_agent_assign(c2, 'resumo 2', false) <> 'Agna' then raise exception 'Falha 8b: revezou em vez do dono'; end if;
  if public.wa_agent_assign(c3, 'resumo 3', false) <> 'Cleudo' then raise exception 'Falha 8c'; end if;
  if (select data->>'hot_at' from public.crm_records where kind='tasks' and data->>'conversationId'=c1::text) is null then raise exception 'Falha 8d: hot_at'; end if;
  -- Dono fora da lista de atendentes: volta o revezamento de antes
  update public.crm_companies set settings = jsonb_set(settings, '{agent,number_owners}', '{"5594900006088":"Fulano"}') where id=(select empresa_a from fx);
  update public.crm_records set data = data || '{"done":true}' where kind='tasks' and data->>'conversationId' = c2::text;
  if public.wa_agent_assign(c2, 'resumo 2b', false) <> 'Agna' then raise exception 'Falha 8e: revezamento (último foi Cleudo)'; end if;
end $$;

do $$ declare c1 uuid; a uuid; r record; n int; begin
  select c.id into c1 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where k.wa_id='5594977770011';
  -- 9. Fila do alerta: loja fechada agenda para a abertura e não sai antes
  a := public.wa_alert_enqueue(c1, '5594991111111', '{"template":{"name":"alerta_atendimento"}}', now() + interval '10 hours');
  if a is null then raise exception 'Falha 9a'; end if;
  select count(*) into n from public.wa_alert_claim(10);
  if n <> 0 then raise exception 'Falha 9b: saiu antes da abertura'; end if;
  -- Nova passagem na mesma conversa: atualiza o mesmo alerta (sem duplicar) e fica com o horário mais cedo
  if public.wa_alert_enqueue(c1, '5594991111111', '{"template":{"name":"alerta_atendimento","quente":true}}', now()) <> a then raise exception 'Falha 9c: duplicou'; end if;
  if (select count(*) from public.wa_team_alerts where conversation_id=c1) <> 1 then raise exception 'Falha 9d'; end if;
  -- Loja aberta: sai na hora; 3 tentativas com falha → failed com auditoria
  select * into r from public.wa_alert_claim(10);
  if r.id <> a or r.payload->'template'->>'quente' <> 'true' or r.account_id is null then raise exception 'Falha 9e'; end if;
  perform public.wa_alert_result(r.id, r.lease_token, false, 'wf_PAYMENT_REQUIRED');
  if (select status from public.wa_team_alerts where id=a) <> 'pending' then raise exception 'Falha 9f'; end if;
  update public.wa_team_alerts set next_run = now() where id = a;
  select * into r from public.wa_alert_claim(10);
  perform public.wa_alert_result(r.id, gen_random_uuid(), true, null); -- lease errado: ignorado
  if (select status from public.wa_team_alerts where id=a) <> 'running' then raise exception 'Falha 9g: lease errado mudou'; end if;
  perform public.wa_alert_result(r.id, r.lease_token, false, 'erro');
  update public.wa_team_alerts set next_run = now() where id = a;
  select * into r from public.wa_alert_claim(10);
  perform public.wa_alert_result(r.id, r.lease_token, false, 'erro');
  if (select status||'|'||attempts from public.wa_team_alerts where id=a) <> 'failed|3' then raise exception 'Falha 9h'; end if;
  if not exists (select 1 from public.wa_audit_logs where action='agent.alert_failed' and target_id=c1) then raise exception 'Falha 9i'; end if;
  -- Depois de falhar, uma passagem nova abre outro alerta; enviado com sucesso fica "sent"
  a := public.wa_alert_enqueue(c1, '5594991111111', '{"template":{}}', now());
  select * into r from public.wa_alert_claim(10);
  perform public.wa_alert_result(r.id, r.lease_token, true, null);
  if (select status from public.wa_team_alerts where id=a) <> 'sent' then raise exception 'Falha 9j'; end if;
  begin perform public.wa_alert_enqueue(c1, '123', '{}', now()); raise exception 'Falha 9k'; exception when raise_exception then if sqlerrm <> 'Alerta inválido' then raise; end if; end;
end $$;

do $$ declare d jsonb; v_dia date := (now() at time zone 'America/Sao_Paulo')::date; begin
  -- 10. Relatório diário: números do dia, um envio por dia, falha pode tentar de novo (até 3)
  d := public.wa_daily_report_claim((select empresa_a from fx), v_dia);
  if d is null then raise exception 'Falha 10a'; end if;
  if (d->>'novas')::int < 4 or (d->>'quentes')::int <> 1 or (d->'passagens'->>'Agna')::int <> 3 or (d->'passagens'->>'Cleudo')::int <> 1 then
    raise exception 'Falha 10b: números errados %', d; end if;
  if (d->>'abertas')::int <> 3 then raise exception 'Falha 10c: abertas %', d; end if;
  if public.wa_daily_report_claim((select empresa_a from fx), v_dia) is not null then raise exception 'Falha 10d: dois ao mesmo tempo'; end if;
  perform public.wa_daily_report_result((select empresa_a from fx), v_dia, false, 'modelo_nao_aprovado');
  if public.wa_daily_report_claim((select empresa_a from fx), v_dia) is null then raise exception 'Falha 10e: não tentou de novo'; end if;
  perform public.wa_daily_report_result((select empresa_a from fx), v_dia, true, null);
  if public.wa_daily_report_claim((select empresa_a from fx), v_dia) is not null then raise exception 'Falha 10f: mandou duas vezes'; end if;
  -- Empresa sem nada no dia: zeros
  d := public.wa_daily_report_claim((select empresa_b from fx), v_dia);
  if (d->>'quentes')::int <> 0 or d->'passagens' <> '{}'::jsonb then raise exception 'Falha 10g %', d; end if;
end $$;

do $$ declare c3 uuid; o record; v_out uuid; begin
  -- 12. Fila de envio: número do WasapFlow (sem token da Meta) é enviado; número antigo sem token continua bloqueado
  select c.id into c3 from public.wa_conversations c join public.wa_contacts k on k.id=c.contact_id where k.wa_id='5594977770013';
  insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key)
  values ((select empresa_a from fx), c3, 'text', '{"text":"Oi!"}', 'teste-wf-0001') returning id into v_out;
  select * into o from public.wa_claim_outbox(10) x where x.id = v_out;
  if o.id is null or o.phone_number_id <> '771000002' or o.to_wa_id <> '5594977770013' then raise exception 'Falha 12a: WasapFlow bloqueado por falta de token'; end if;
  insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key)
  select (select empresa_b from fx), c.id, 'text', '{"text":"Oi!"}', 'teste-ec-0001' from public.wa_conversations c where c.account_id = (select conta_v from fx) limit 1
  returning id into v_out;
  perform public.wa_claim_outbox(10);
  if (select status||'|'||last_error from public.wa_outbox where id = v_out) <> 'blocked|Número sem token configurado' then raise exception 'Falha 12b: regra antiga mudou'; end if;
end $$;

do $$ begin
  -- 11. Relógio: agendado a cada minuto; sem pg_net/segredos não faz nada (nem erro)
  if not exists (select 1 from cron.job where jobname='viestro-wa-relogio' and schedule='* * * * *') then raise exception 'Falha 11a'; end if;
  perform crm_private.wa_tick();
end $$;

create temp table resultado_teste as select 'wasapflow_bridge: todos os testes passaram'::text as resultado;
select * from resultado_teste;
rollback;

-- Testes do WhatsApp no CRM (Migrations B e C). Tudo roda numa transação e é desfeito no final.
-- Nunca usa números ou tokens reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('aaaaaaaa-0000-4000-8000-0000000000a1','wa-admin-a@example.invalid',now()),
 ('aaaaaaaa-0000-4000-8000-0000000000a2','wa-member-a@example.invalid',now()),
 ('bbbbbbbb-0000-4000-8000-0000000000b1','wa-admin-b@example.invalid',now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Pet Shop Teste','Pet');
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-0000000000b1","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Empresa B','Serviços');
reset role;
insert into public.crm_members
  select 'aaaaaaaa-0000-4000-8000-0000000000a2', company_id, 'Atendente A', 'wa-member-a@example.invalid', 'member'
  from public.crm_members where user_id = 'aaaaaaaa-0000-4000-8000-0000000000a1';

-- Número de teste da empresa A, com token fictício no cofre
create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='aaaaaaaa-0000-4000-8000-0000000000a1'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','111000111','WA Teste',true from ca returning id, company_id),
     sec as (select vault.create_secret('token-ficticio-de-teste','wa_token_teste_111000111') id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status,access_token_secret_id)
             select ch.company_id, ch.id, '111000111','222000222','+5594900001111','connected', sec.id from ch, sec returning id, company_id)
select acc.id account_id, acc.company_id from acc;
grant select on fx to authenticated, service_role;

-- ===== 1. Ingestão =====
do $$ declare r jsonb; begin
  r := public.wa_ingest('[
    {"type":"message","key":"111000111:msg:wamid.A1","phone_number_id":"111000111","payload":{"wa_id":"5594988887777","name":"Maria Cliente","wamid":"wamid.A1","ts":"2026-10-23T12:00:00Z","type":"text","body":"Oi, quero banho e tosa"}},
    {"type":"message","key":"111000111:msg:wamid.A1","phone_number_id":"111000111","payload":{"wa_id":"5594988887777","wamid":"wamid.A1","ts":"2026-10-23T12:00:00Z","type":"text","body":"duplicada"}},
    {"type":"message","key":"999:msg:wamid.X","phone_number_id":"999999999","payload":{"wa_id":"5594900000000","wamid":"wamid.X","type":"text","body":"número desconhecido"}},
    {"type":"invalido","key":"k","phone_number_id":"111000111","payload":{}}
  ]');
  if (r->>'inserted')::int <> 1 or (r->>'duplicates')::int <> 1 or (r->>'ignored')::int <> 2 then
    raise exception 'I1 FALHOU: ingestão %', r;
  end if;
end $$;

-- ===== 2. Processamento da mensagem recebida =====
do $$ declare r jsonb; c public.wa_conversations%rowtype; begin
  r := crm_private.wa_run_events(100);
  if (r->>'processed')::int <> 1 then raise exception 'P1 FALHOU: %', r; end if;
  select * into c from public.wa_conversations;
  if c.unread_count <> 1 or c.status <> 'open' or c.last_message_preview <> 'Oi, quero banho e tosa'
     or c.service_window_expires_at <> '2026-10-23T12:00:00Z'::timestamptz + interval '24 hours' then
    raise exception 'P2 FALHOU: conversa %', row_to_json(c);
  end if;
  if (select name from public.wa_contacts) <> 'Maria Cliente' then raise exception 'P3 FALHOU: nome'; end if;
  if (select count(*) from public.crm_records where kind='leads') <> 0 then raise exception 'P4 FALHOU: lead automático sem configuração'; end if;
end $$;

-- ===== 3. Eco do app (resposta humana pelo celular) + mensagem fora de ordem =====
do $$ declare c public.wa_conversations%rowtype; begin
  perform public.wa_ingest('[
    {"type":"echo","key":"111000111:echo:wamid.E1","phone_number_id":"111000111","payload":{"wa_id":"5594988887777","wamid":"wamid.E1","ts":"2026-10-23T12:05:00Z","type":"text","body":"Olá Maria! Temos horário amanhã."}},
    {"type":"message","key":"111000111:msg:wamid.A0","phone_number_id":"111000111","payload":{"wa_id":"5594988887777","wamid":"wamid.A0","ts":"2026-10-23T11:59:00Z","type":"text","body":"mensagem mais antiga"}}
  ]');
  perform crm_private.wa_run_events(100);
  select * into c from public.wa_conversations;
  if c.first_response_at <> '2026-10-23T12:05:00Z'::timestamptz then raise exception 'E1 FALHOU: tempo de 1ª resposta'; end if;
  if c.first_inbound_at <> '2026-10-23T11:59:00Z'::timestamptz then raise exception 'E2 FALHOU: 1ª entrada fora de ordem'; end if;
  if c.last_message_preview <> 'Olá Maria! Temos horário amanhã.' then raise exception 'E3 FALHOU: prévia sobrescrita por msg antiga'; end if;
  if (select count(*) from public.wa_messages where source='app_echo' and direction='outbound') <> 1 then raise exception 'E4 FALHOU: eco'; end if;
  -- Reentrega do mesmo wamid com outra chave (ex.: histórico) não duplica
  perform public.wa_ingest('[{"type":"history","key":"111000111:hist:wamid.E1","phone_number_id":"111000111","payload":{"wa_id":"5594988887777","wamid":"wamid.E1","direction":"outbound","type":"text","body":"x"}}]');
  perform crm_private.wa_run_events(100);
  if (select count(*) from public.wa_messages where external_message_id='wamid.E1') <> 1 then raise exception 'E5 FALHOU: duplicou via histórico'; end if;
end $$;

-- ===== 4. Histórico (6 meses) não marca como não lida =====
do $$ declare u int; begin
  select unread_count into u from public.wa_conversations;
  perform public.wa_ingest('[
    {"type":"history","key":"111000111:hist:wamid.H1","phone_number_id":"111000111","payload":{"wa_id":"5594977776666","wamid":"wamid.H1","ts":"2026-06-01T10:00:00Z","direction":"inbound","type":"text","body":"pedido antigo"}},
    {"type":"history","key":"111000111:hist:wamid.H2","phone_number_id":"111000111","payload":{"wa_id":"5594977776666","wamid":"wamid.H2","ts":"2026-06-01T10:02:00Z","direction":"outbound","status":"read","type":"text","body":"resposta antiga"}}
  ]');
  perform crm_private.wa_run_events(100);
  if (select sum(unread_count) from public.wa_conversations) <> u then raise exception 'H1 FALHOU: histórico gerou não lidas'; end if;
  if (select message_status from public.wa_messages where external_message_id='wamid.H2') <> 'read' then raise exception 'H2 FALHOU: status do histórico'; end if;
  if (select count(*) from public.wa_conversations) <> 2 then raise exception 'H3 FALHOU: conversa do histórico'; end if;
end $$;

-- ===== 5. Agenda do app: atualiza só quem já conversa =====
do $$ declare r jsonb; begin
  perform public.wa_ingest('[
    {"type":"contacts_sync","key":"111000111:cs:5594977776666:1","phone_number_id":"111000111","payload":{"wa_id":"5594977776666","name":"João do Rex","action":"add"}},
    {"type":"contacts_sync","key":"111000111:cs:5594955554444:1","phone_number_id":"111000111","payload":{"wa_id":"5594955554444","name":"Sem conversa","action":"add"}}
  ]');
  r := crm_private.wa_run_events(100);
  if (select name from public.wa_contacts where wa_id='5594977776666') <> 'João do Rex' then raise exception 'C1 FALHOU: nome da agenda'; end if;
  if exists (select 1 from public.wa_contacts where wa_id='5594955554444') then raise exception 'C2 FALHOU: importou agenda inteira'; end if;
  if (r->>'retry')::int <> 1 then raise exception 'C3 FALHOU: contato sem conversa deveria aguardar: %', r; end if;
end $$;

-- ===== 6. Operador: envio de texto, idempotência e isolamento =====
create temp table convs as select c.id, ct.wa_id from public.wa_conversations c join public.wa_contacts ct on ct.id = c.contact_id;
grant select on convs to authenticated;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000000a2","role":"authenticated"}',true);
do $$ declare v_conv uuid; m1 uuid; m2 uuid; begin
  select id into v_conv from public.wa_conversations where contact_id = (select id from public.wa_contacts where wa_id='5594988887777');
  m1 := public.crm_wa_send_text(v_conv, 'Pode trazer o Rex às 9h!', 'idem-envio-0001');
  m2 := public.crm_wa_send_text(v_conv, 'Pode trazer o Rex às 9h!', 'idem-envio-0001');
  if m1 <> m2 then raise exception 'S1 FALHOU: idempotência'; end if;
  if (select count(*) from public.wa_messages where source='crm') <> 1 then raise exception 'S2 FALHOU: duplicou'; end if;
  if (select unread_count from public.wa_conversations where id=v_conv) <> 0 then raise exception 'S3 FALHOU: não lidas'; end if;
  begin perform public.wa_ingest('[]'); raise exception 'S4 FALHOU: operador chamou ingestão';
  exception when insufficient_privilege then null; end;
  begin perform public.wa_claim_outbox(1); raise exception 'S5 FALHOU: operador acessou fila';
  exception when insufficient_privilege then null; end;
  begin perform public.wa_account_token((select account_id from fx)); raise exception 'S6 FALHOU: operador leu token';
  exception when insufficient_privilege then null; end;
  begin perform crm_private.wa_run_events(1); raise exception 'S7 FALHOU: operador rodou executor';
  exception when insufficient_privilege then null; end;
end $$;

-- Janela de 24h fechada bloqueia texto livre
do $$ declare v_conv uuid; begin
  select id into v_conv from public.wa_conversations where contact_id = (select id from public.wa_contacts where wa_id='5594977776666');
  begin perform public.crm_wa_send_text(v_conv, 'oi', 'idem-envio-0002'); raise exception 'S8 FALHOU: enviou fora da janela';
  exception when raise_exception then if sqlerrm like 'S8%' then raise; end if; end;
end $$;

-- Empresa B não envia nem altera conversa da empresa A
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-0000000000b1","role":"authenticated"}',true);
do $$ declare v_conv uuid; begin
  select id into v_conv from convs where wa_id = '5594988887777';
  if exists (select 1 from public.wa_conversations where id = v_conv) then raise exception 'S8b FALHOU: B enxerga conversa de A'; end if;
  begin perform public.crm_wa_send_text(v_conv, 'invasão', 'idem-envio-0003'); raise exception 'S9 FALHOU: outra empresa enviou';
  exception when raise_exception then if sqlerrm like 'S9%' then raise; end if; end;
  begin perform public.crm_wa_update_conversation(v_conv, '{"status":"resolved"}'); raise exception 'S10 FALHOU: outra empresa alterou';
  exception when raise_exception then if sqlerrm like 'S10%' then raise; end if; end;
  begin perform public.crm_wa_create_lead(v_conv); raise exception 'S11 FALHOU: outra empresa criou lead';
  exception when raise_exception then if sqlerrm like 'S11%' then raise; end if; end;
end $$;

-- Atendente não atribui conversa a outra pessoa; administrador sim
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000000a2","role":"authenticated"}',true);
do $$ declare v_conv uuid; begin
  select id into v_conv from public.wa_conversations where contact_id = (select id from public.wa_contacts where wa_id='5594988887777');
  begin perform public.crm_wa_update_conversation(v_conv, '{"assigned_user_id":"aaaaaaaa-0000-4000-8000-0000000000a1"}');
        raise exception 'A1 FALHOU: atendente atribuiu a outro';
  exception when raise_exception then if sqlerrm like 'A1%' then raise; end if; end;
  perform public.crm_wa_update_conversation(v_conv, '{"assigned_user_id":"aaaaaaaa-0000-4000-8000-0000000000a2","category":"Banho e tosa","status":"pending"}');
  if (select assigned_user_id from public.wa_conversations where id=v_conv) <> 'aaaaaaaa-0000-4000-8000-0000000000a2' then raise exception 'A2 FALHOU'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
do $$ declare v_conv uuid; begin
  select id into v_conv from public.wa_conversations where contact_id = (select id from public.wa_contacts where wa_id='5594988887777');
  perform public.crm_wa_update_conversation(v_conv, '{"assigned_user_id":"aaaaaaaa-0000-4000-8000-0000000000a1"}');
  if (select category from public.wa_conversations where id=v_conv) <> 'Banho e tosa' then raise exception 'A3 FALHOU: categoria'; end if;
  if (select count(*) from public.wa_audit_logs where action='conversation.update') <> 2 then raise exception 'A4 FALHOU: auditoria'; end if;
end $$;

-- Criar lead a partir da conversa (reaproveita lead existente pelo telefone)
do $$ declare v_conv uuid; l1 uuid; l2 uuid; begin
  select id into v_conv from public.wa_conversations where contact_id = (select id from public.wa_contacts where wa_id='5594988887777');
  l1 := public.crm_wa_create_lead(v_conv);
  l2 := public.crm_wa_create_lead(v_conv);
  if l1 is null or l1 <> l2 then raise exception 'L1 FALHOU: lead duplicado'; end if;
  if (select data->>'source' from public.crm_records where id=l1) <> 'WhatsApp' then raise exception 'L2 FALHOU: origem'; end if;
  if (select count(*) from public.crm_records where kind='tasks') <> 1 then raise exception 'L3 FALHOU: tarefa de 1º contato'; end if;
end $$;
reset role;

-- ===== 7. Fila de envio: sucesso, status fora de ordem, falha e lease expirado =====
do $$ declare o record; v_msg uuid; v_conv uuid; r jsonb; begin
  select * into o from public.wa_claim_outbox(10);
  if o.id is null or o.to_wa_id <> '5594988887777' or o.payload->>'text' <> 'Pode trazer o Rex às 9h!' then raise exception 'O1 FALHOU: claim'; end if;
  if exists (select 1 from public.wa_claim_outbox(10)) then raise exception 'O2 FALHOU: claim duplo'; end if;
  if public.wa_account_token(o.account_id) <> 'token-ficticio-de-teste' then raise exception 'O3 FALHOU: token do cofre'; end if;

  -- Status "delivered" chega ANTES do registro do wamid: deve aguardar
  perform public.wa_ingest('[{"type":"status","key":"111000111:st:wamid.S1:delivered","phone_number_id":"111000111","payload":{"wamid":"wamid.S1","status":"delivered","ts":"2026-10-23T12:10:05Z"}}]');
  r := crm_private.wa_run_events(100);
  if (r->>'retry')::int < 1 then raise exception 'O4 FALHOU: status antecipado não aguardou: %', r; end if;

  perform public.wa_outbox_result(o.id, o.lease_token, true, 'wamid.S1', null, false);
  select message_id into v_msg from public.wa_outbox where id = o.id;
  if (select message_status from public.wa_messages where id=v_msg) <> 'sent' then raise exception 'O5 FALHOU: sent'; end if;

  -- reprocessa (forçando o próximo ciclo) e recebe "read" e depois "delivered" atrasado
  update public.wa_webhook_events set next_run = now() where processing_status='pending';
  perform public.wa_ingest('[{"type":"status","key":"111000111:st:wamid.S1:read","phone_number_id":"111000111","payload":{"wamid":"wamid.S1","status":"read","ts":"2026-10-23T12:11:00Z"}}]');
  perform crm_private.wa_run_events(100);
  if (select message_status from public.wa_messages where id=v_msg) <> 'read' then raise exception 'O6 FALHOU: status regrediu'; end if;
  perform public.wa_ingest('[{"type":"status","key":"111000111:st:wamid.S1:failed","phone_number_id":"111000111","payload":{"wamid":"wamid.S1","status":"failed","error_code":"131026"}}]');
  perform crm_private.wa_run_events(100);
  if (select message_status from public.wa_messages where id=v_msg) <> 'read' then raise exception 'O7 FALHOU: failed após read'; end if;

  -- Falha temporária → volta para a fila; falha definitiva → mensagem falha
  select id into v_conv from public.wa_conversations where contact_id = (select id from public.wa_contacts where wa_id='5594988887777');
  insert into public.wa_messages(company_id,conversation_id,direction,source,body,sent_by_user_id,message_status)
    values ((select company_id from fx), v_conv, 'outbound','crm','segunda','aaaaaaaa-0000-4000-8000-0000000000a1','queued') returning id into v_msg;
  insert into public.wa_outbox(company_id,conversation_id,kind,payload,idempotency_key,message_id)
    values ((select company_id from fx), v_conv, 'text','{"text":"segunda"}','idem-envio-0010', v_msg);
  select * into o from public.wa_claim_outbox(10);
  perform public.wa_outbox_result(o.id, o.lease_token, false, null, '130429', true);
  if (select status from public.wa_outbox where id=o.id) <> 'pending' then raise exception 'O8 FALHOU: retentativa'; end if;
  update public.wa_outbox set next_run = now() where id = o.id;
  select * into o from public.wa_claim_outbox(10);
  perform public.wa_outbox_result(o.id, o.lease_token, false, null, '131047', false);
  if (select message_status from public.wa_messages where id=v_msg) <> 'failed'
     or (select error_code from public.wa_messages where id=v_msg) <> '131047' then raise exception 'O9 FALHOU: falha definitiva'; end if;

  -- Execução interrompida (lease expirou): não reenvia
  insert into public.wa_messages(company_id,conversation_id,direction,source,body,sent_by_user_id,message_status)
    values ((select company_id from fx), v_conv, 'outbound','crm','terceira','aaaaaaaa-0000-4000-8000-0000000000a1','queued') returning id into v_msg;
  insert into public.wa_outbox(company_id,conversation_id,kind,payload,idempotency_key,message_id)
    values ((select company_id from fx), v_conv, 'text','{"text":"terceira"}','idem-envio-0011', v_msg);
  select * into o from public.wa_claim_outbox(10);
  update public.wa_outbox set lease_until = now() - interval '1 second' where id = o.id;
  if exists (select 1 from public.wa_claim_outbox(10)) then raise exception 'O10 FALHOU: reenviou após lease'; end if;
  if (select error_code from public.wa_messages where id=v_msg) <> 'unknown_result' then raise exception 'O11 FALHOU: resultado desconhecido'; end if;

  -- Número sem token: bloqueia sem chamar a Meta
  update public.wa_accounts set access_token_secret_id = null where id = (select account_id from fx);
  insert into public.wa_messages(company_id,conversation_id,direction,source,body,sent_by_user_id,message_status)
    values ((select company_id from fx), v_conv, 'outbound','crm','quarta','aaaaaaaa-0000-4000-8000-0000000000a1','queued') returning id into v_msg;
  insert into public.wa_outbox(company_id,conversation_id,kind,payload,idempotency_key,message_id)
    values ((select company_id from fx), v_conv, 'text','{"text":"quarta"}','idem-envio-0012', v_msg);
  if exists (select 1 from public.wa_claim_outbox(10)) then raise exception 'O12 FALHOU: enviou sem token'; end if;
  if (select error_code from public.wa_messages where id=v_msg) <> 'token_missing' then raise exception 'O13 FALHOU'; end if;
end $$;

-- ===== 8. Templates: consentimento, descadastro e limite =====
do $$ declare v_tpl uuid; v_util uuid; begin
  insert into public.wa_templates(company_id,account_id,name,language,category,status,components)
    values ((select company_id from fx),(select account_id from fx),'promo_banho','pt_BR','MARKETING','APPROVED',
            '[{"type":"BODY","text":"Olá {{1}}, banho com 20% off esta semana!"}]') returning id into v_tpl;
  insert into public.wa_templates(company_id,account_id,name,language,category,status,components)
    values ((select company_id from fx),(select account_id from fx),'lembrete_horario','pt_BR','UTILITY','APPROVED',
            '[{"type":"BODY","text":"Olá {{1}}, lembrete do seu horário às {{2}}."}]') returning id into v_util;
  create temp table tpl as select v_tpl mkt, v_util util;
  grant select on tpl to authenticated;
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
do $$ declare v_conv uuid; v_contact uuid; m uuid; begin
  select id, contact_id into v_conv, v_contact from public.wa_conversations where contact_id = (select id from public.wa_contacts where wa_id='5594977776666');
  begin perform public.crm_wa_send_template(v_conv, (select mkt from tpl), '["João"]', 'idem-tpl-0001'); raise exception 'T1 FALHOU: marketing sem consentimento';
  exception when raise_exception then if sqlerrm like 'T1%' then raise; end if; end;
  begin perform public.crm_wa_set_consent(v_contact, 'marketing', 'granted', null); raise exception 'T2 FALHOU: consentimento sem evidência';
  exception when raise_exception then if sqlerrm like 'T2%' then raise; end if; end;
  perform public.crm_wa_set_consent(v_contact, 'marketing', 'granted', 'Cliente pediu promoções no balcão em 23/10');
  m := public.crm_wa_send_template(v_conv, (select mkt from tpl), '["João"]', 'idem-tpl-0002');
  if (select body from public.wa_messages where id=m) <> 'Olá João, banho com 20% off esta semana!' then raise exception 'T3 FALHOU: corpo do template'; end if;
  begin perform public.crm_wa_send_template(v_conv, (select mkt from tpl), '["João"]', 'idem-tpl-0003'); raise exception 'T4 FALHOU: limite diário';
  exception when raise_exception then if sqlerrm like 'T4%' then raise; end if; end;
  m := public.crm_wa_send_template(v_conv, (select util from tpl), '["João","9h"]', 'idem-tpl-0004');
  begin perform 1 from public.wa_outbox where message_id=m; raise exception 'T5 FALHOU: operador leu a fila';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  if (select payload #>> '{template,components,0,parameters,1,text}' from public.wa_outbox where idempotency_key='idem-tpl-0004') <> '9h' then
    raise exception 'T6 FALHOU: variáveis do template';
  end if;
end $$;

-- Descadastro por palavra-chave bloqueia marketing
do $$ begin
  perform public.wa_ingest('[{"type":"message","key":"111000111:msg:wamid.OUT","phone_number_id":"111000111","payload":{"wa_id":"5594977776666","wamid":"wamid.OUT","ts":"2026-10-23T13:00:00Z","type":"text","body":" sair "}}]');
  perform crm_private.wa_run_events(100);
  if (select marketing_opt_out_at from public.wa_contacts where wa_id='5594977776666') is null then raise exception 'T7 FALHOU: descadastro'; end if;
end $$;

-- ===== 9. Evento que sempre falha vira "dead" após 8 tentativas =====
do $$ declare r jsonb; begin
  insert into public.wa_webhook_events(company_id,account_id,event_type,external_event_id,payload_restricted,attempts)
    values ((select company_id from fx),(select account_id from fx),'contacts_sync','111000111:cs:teste-dead','{"wa_id":"5594911112222","name":"X","action":"add"}',7);
  r := crm_private.wa_run_events(100);
  if (select processing_status from public.wa_webhook_events where external_event_id='111000111:cs:teste-dead') <> 'dead' then
    raise exception 'D1 FALHOU: %', r;
  end if;
end $$;

-- ===== 10. Lead automático quando a empresa ativa =====
do $$ begin
  update public.crm_companies set settings = settings || '{"wa_auto_lead":true}' where id = (select company_id from fx);
  perform public.wa_ingest('[{"type":"message","key":"111000111:msg:wamid.N1","phone_number_id":"111000111","payload":{"wa_id":"5594933332222","name":"Novo Cliente","wamid":"wamid.N1","ts":"2026-10-23T14:00:00Z","type":"text","body":"Vocês têm ração?"}}]');
  perform crm_private.wa_run_events(100);
  if (select crm_lead_id from public.wa_contacts where wa_id='5594933332222') is null then raise exception 'L4 FALHOU: lead automático'; end if;
end $$;

-- ===== 11. Anônimo não acessa nada =====
set local role anon;
do $$ begin
  begin perform public.wa_ingest('[]'); raise exception 'N1 FALHOU'; exception when insufficient_privilege then null; end;
  begin perform public.crm_wa_send_text(gen_random_uuid(), 'x', 'idem-anon-0001'); raise exception 'N2 FALHOU'; exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
select 'WhatsApp: todos os testes de banco passaram; fixtures desfeitas' as resultado;

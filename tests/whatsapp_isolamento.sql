-- Testes de isolamento e integridade do Messaging Hub.
-- Roda numa transação e desfaz tudo no final (rollback). Nunca usa dados reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('aaaaaaaa-0000-4000-8000-000000000001','hub-admin-a@example.invalid',now()),
 ('bbbbbbbb-0000-4000-8000-000000000002','hub-admin-b@example.invalid',now()),
 ('aaaaaaaa-0000-4000-8000-000000000003','hub-member-a@example.invalid',now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Pet Shop A','Pet');
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Empresa B','Serviços');
reset role;

insert into public.crm_members
  select 'aaaaaaaa-0000-4000-8000-000000000003', company_id, 'Atendente A', 'hub-member-a@example.invalid', 'member'
  from public.crm_members where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

create temp table t_ids as
select (select company_id from public.crm_members where user_id='aaaaaaaa-0000-4000-8000-000000000001') ca,
       (select company_id from public.crm_members where user_id='bbbbbbbb-0000-4000-8000-000000000002') cb;
grant select on t_ids to authenticated, anon, service_role;

do $$
declare ca uuid; cb uuid; cha uuid; chb uuid; acc_a uuid; acc_b uuid; ct_a uuid; ct_b uuid; cv_a uuid; lead_b uuid;
begin
  select t.ca, t.cb into ca, cb from t_ids t;
  insert into public.crm_channels(company_id,provider,external_id,label,enabled) values (ca,'whatsapp','1000001','WA A',true) returning id into cha;
  insert into public.crm_channels(company_id,provider,external_id,label,enabled) values (cb,'whatsapp','2000002','WA B',true) returning id into chb;

  insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164)
    values (ca,cha,'1000001','9000001','+5594900000001') returning id into acc_a;
  insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164)
    values (cb,chb,'2000002','9000002','+5594900000002') returning id into acc_b;

  -- T1: conta da empresa B usando canal da empresa A
  begin
    insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164)
      values (cb,cha,'1000001','9000003','+5594900000003');
    raise exception 'T1 FALHOU: conta ligada a canal de outra empresa';
  exception when raise_exception then if sqlerrm like 'T1%' then raise; end if;
            when unique_violation then null;
  end;

  insert into public.wa_contacts(company_id,wa_id,name) values (ca,'5594911110000','Cliente A') returning id into ct_a;
  insert into public.wa_contacts(company_id,wa_id,name) values (cb,'5594922220000','Cliente B') returning id into ct_b;
  if (select phone_e164 from public.wa_contacts where id = ct_a) <> '+5594911110000' then raise exception 'T2 FALHOU: E.164'; end if;

  -- T3: conversa da empresa A com contato da empresa B
  begin
    insert into public.wa_conversations(company_id,account_id,contact_id) values (ca,acc_a,ct_b);
    raise exception 'T3 FALHOU: referência cruzada aceita';
  exception when foreign_key_violation then null; end;

  -- T4: conversa da empresa A com conta da empresa B
  begin
    insert into public.wa_conversations(company_id,account_id,contact_id) values (ca,acc_b,ct_a);
    raise exception 'T4 FALHOU: referência cruzada aceita';
  exception when foreign_key_violation then null; end;

  insert into public.wa_conversations(company_id,account_id,contact_id,last_inbound_at,service_window_expires_at)
    values (ca,acc_a,ct_a,now(),now()+interval '24 hours') returning id into cv_a;
  insert into public.wa_conversations(company_id,account_id,contact_id) values (cb,acc_b,ct_b);

  -- T5: atribuir conversa da empresa A a usuário da empresa B
  begin
    update public.wa_conversations set assigned_user_id='bbbbbbbb-0000-4000-8000-000000000002' where id=cv_a;
    raise exception 'T5 FALHOU: responsável de outra empresa aceito';
  exception when raise_exception then if sqlerrm like 'T5%' then raise; end if; end;
  update public.wa_conversations set assigned_user_id='aaaaaaaa-0000-4000-8000-000000000003' where id=cv_a;

  -- T6: vincular contato da empresa A a lead da empresa B
  insert into public.crm_records(company_id,kind,data) values (cb,'leads','{"name":"Lead B"}') returning id into lead_b;
  begin
    update public.wa_contacts set crm_lead_id=lead_b where id=ct_a;
    raise exception 'T6 FALHOU: lead de outra empresa aceito';
  exception when raise_exception then if sqlerrm like 'T6%' then raise; end if; end;

  -- T7: deduplicação por wamid
  insert into public.wa_messages(company_id,conversation_id,external_message_id,direction,source,body,message_status)
    values (ca,cv_a,'wamid.TESTE1','inbound','api_inbound','Oi, quero banho e tosa','received');
  begin
    insert into public.wa_messages(company_id,conversation_id,external_message_id,direction,source,body,message_status)
      values (ca,cv_a,'wamid.TESTE1','inbound','api_inbound','duplicada','received');
    raise exception 'T7 FALHOU: mensagem duplicada aceita';
  exception when unique_violation then null; end;

  -- T8: direção x origem incoerentes
  begin
    insert into public.wa_messages(company_id,conversation_id,direction,source,body,message_status)
      values (ca,cv_a,'inbound','crm','x','received');
    raise exception 'T8 FALHOU: origem incoerente aceita';
  exception when check_violation then null; end;

  -- T9: lista importada não autoriza marketing sem evidência
  begin
    insert into public.wa_consents(company_id,contact_id,purpose,status,source,granted_at)
      values (ca,ct_a,'marketing','granted','import',now());
    raise exception 'T9 FALHOU: consentimento de marketing por importação aceito';
  exception when check_violation then null; end;
  insert into public.wa_consents(company_id,contact_id,purpose,status,source,granted_at)
    values (ca,ct_a,'service','granted','whatsapp_inbound',now());

  insert into public.wa_webhook_events(company_id,account_id,event_type,external_event_id,payload_restricted)
    values (ca,acc_a,'message','msg:wamid.TESTE1','{"k":"v"}');
  begin
    insert into public.wa_webhook_events(event_type,external_event_id,payload_restricted)
      values ('message','msg:wamid.TESTE1','{"k":"v"}');
    raise exception 'T10 FALHOU: evento duplicado aceito';
  exception when unique_violation then null; end;

  insert into public.wa_outbox(company_id,conversation_id,kind,payload,idempotency_key)
    values (ca,cv_a,'text','{"text":"teste"}','idem-0001');
  begin
    insert into public.wa_outbox(company_id,conversation_id,kind,payload,idempotency_key)
      values (ca,cv_a,'text','{"text":"teste"}','idem-0001');
    raise exception 'T11 FALHOU: envio duplicado aceito';
  exception when unique_violation then null; end;

  insert into public.wa_audit_logs(company_id,actor_user_id,actor_kind,action,target_type,target_id)
    values (ca,'aaaaaaaa-0000-4000-8000-000000000001','user','conversation.assign','conversation',cv_a);
end $$;

-- ===== Visão do ADMIN da empresa A =====
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $$ begin
  if (select count(*) from public.wa_accounts) <> 1 then raise exception 'R1 FALHOU: vazamento de contas'; end if;
  if (select count(*) from public.wa_contacts) <> 1 then raise exception 'R2 FALHOU: vazamento de contatos'; end if;
  if (select count(*) from public.wa_conversations) <> 1 then raise exception 'R3 FALHOU: vazamento de conversas'; end if;
  if (select count(*) from public.wa_messages) <> 1 then raise exception 'R4 FALHOU: vazamento de mensagens'; end if;
  if (select count(*) from public.wa_audit_logs) <> 1 then raise exception 'R5 FALHOU: admin sem auditoria'; end if;
  perform id, phone_number_id, connection_status from public.wa_accounts;
  begin perform access_token_secret_id from public.wa_accounts; raise exception 'R6 FALHOU: coluna do cofre visível';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.wa_webhook_events; raise exception 'R7 FALHOU: eventos brutos visíveis';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.wa_outbox; raise exception 'R8 FALHOU: fila de envio visível';
  exception when insufficient_privilege then null; end;
  begin insert into public.wa_messages(company_id,conversation_id,direction,source,body,message_status)
          select company_id, id, 'outbound','crm','forjada','sent' from public.wa_conversations;
        raise exception 'R9 FALHOU: escrita direta permitida';
  exception when insufficient_privilege then null; end;
  begin update public.wa_conversations set status='resolved'; raise exception 'R10 FALHOU: update direto permitido';
  exception when insufficient_privilege then null; end;
end $$;

-- ===== Visão do ATENDENTE (member) da empresa A =====
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000003","role":"authenticated"}',true);
do $$ begin
  if (select count(*) from public.wa_conversations) <> 1 then raise exception 'M1 FALHOU: atendente sem conversas'; end if;
  if (select count(*) from public.wa_audit_logs) <> 0 then raise exception 'M2 FALHOU: atendente lê auditoria'; end if;
end $$;

-- ===== Visão do ADMIN da empresa B =====
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $$ begin
  if (select count(*) from public.wa_messages) <> 0 then raise exception 'B1 FALHOU: B vê mensagens de A'; end if;
  if exists (select 1 from public.wa_contacts where wa_id = '5594911110000') then raise exception 'B2 FALHOU: B vê telefone de A'; end if;
  if (select count(*) from public.wa_conversations) <> 1 then raise exception 'B3 FALHOU: B sem a própria conversa'; end if;
end $$;
reset role;

-- ===== Anônimo =====
set local role anon;
do $$ begin
  begin perform 1 from public.wa_messages; raise exception 'N1 FALHOU: anon lê mensagens';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.wa_contacts; raise exception 'N2 FALHOU: anon lê contatos';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ===== Chave de serviço: auditoria é somente inclusão =====
set local role service_role;
do $$ begin
  begin update public.wa_audit_logs set action='adulterado'; raise exception 'S1 FALHOU: auditoria alterável';
  exception when insufficient_privilege then null; end;
  begin delete from public.wa_audit_logs; raise exception 'S2 FALHOU: auditoria apagável';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Dono do banco também não altera auditoria (trigger)
do $$ begin
  begin update public.wa_audit_logs set action='adulterado'; raise exception 'S3 FALHOU: trigger de auditoria';
  exception when raise_exception then if sqlerrm like 'S3%' then raise; end if; end;
end $$;

-- Exclusão de usuário anonimiza a auditoria sem quebrar
delete from public.crm_members where user_id = 'aaaaaaaa-0000-4000-8000-000000000003';
update public.wa_conversations set assigned_user_id = null where assigned_user_id is not null;
delete from public.crm_members where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
delete from auth.users where id = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$ begin
  if exists (select 1 from public.wa_audit_logs where actor_user_id is not null) then raise exception 'S4 FALHOU: auditoria não anonimizada'; end if;
end $$;

select 'Messaging Hub: todos os testes de isolamento e integridade passaram (rollback aplicado)' as resultado;
rollback;

-- Testes do agente automático do WhatsApp. Tudo roda numa transação e é desfeito no final.
-- Requer a migration 20261116000000_agente_automatico.sql. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('aaaaaaaa-0000-4000-8000-0000000a9e01','ag-admin-a@example.invalid',now()),
 ('bbbbbbbb-0000-4000-8000-0000000b9e02','ag-admin-b@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a9e01","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Clinica Agente Teste','Odontologia');
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-0000000b9e02","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Empresa B Agente','Servicos');
reset role;

create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='aaaaaaaa-0000-4000-8000-0000000a9e01'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','999000111','WA Agente',true from ca returning id, company_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status)
             select ch.company_id, ch.id, '999000111','999000222','+5594900009999','connected' from ch returning id, company_id)
select acc.id account_id, acc.company_id from acc;
grant select on fx to authenticated, service_role;

-- Cliente manda mensagem há 30 s
select public.wa_ingest(jsonb_build_array(jsonb_build_object('type','message','key','999000111:msg:wamid.AG1','phone_number_id','999000111',
  'payload', jsonb_build_object('wa_id','5594977776666','name','Paciente Teste','wamid','wamid.AG1',
    'ts', to_char((now() - interval '30 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body','Quanto custa a limpeza?'))));
select crm_private.wa_run_events(50);
create temp table fxc as select c.id conv from public.wa_conversations c join fx on fx.company_id = c.company_id;
grant select on fxc to authenticated, service_role;

do $$ declare v_conv uuid; v_in timestamptz; v_msg uuid; n int; begin
  select c.id, c.last_inbound_at into v_conv, v_in from public.wa_conversations c join fx on fx.company_id=c.company_id;
  if v_conv is null then raise exception 'fixture: conversa não criada'; end if;

  -- 1. Agente desligado: nenhuma candidata
  if exists (select 1 from public.wa_agent_candidates(10, 50) where conversation_id = v_conv) then raise exception 'agente desligado respondeu'; end if;
  if public.wa_agent_send(v_conv, v_in, 'Oi', false, null, 10) is not null then raise exception 'envio com agente desligado'; end if;

  -- 2. Modo sugestão também não responde sozinho
  update public.crm_companies set settings = settings || '{"agent":{"enabled":true,"name":"Vi","tone":"acolhedor","mode":"sugestao","knowledge":"Limpeza R$ 150. Horario 8h-18h. Rua A, 10.","handoff":""}}'::jsonb
   where id = (select company_id from fx);
  if exists (select 1 from public.wa_agent_candidates(10, 50) where conversation_id = v_conv) then raise exception 'modo sugestão respondeu'; end if;

  -- 3. Modo automático: responde uma vez
  update public.crm_companies set settings = jsonb_set(settings, '{agent,mode}', '"automatico"') where id = (select company_id from fx);
  if not exists (select 1 from public.wa_agent_candidates(10, 50) where conversation_id = v_conv) then raise exception 'candidata não encontrada'; end if;
  if exists (select 1 from public.wa_agent_candidates(60, 50) where conversation_id = v_conv) then raise exception 'não esperou o cliente terminar de digitar'; end if;
  v_msg := public.wa_agent_send(v_conv, v_in, 'A limpeza custa R$ 150,00.', false, null, 10);
  if v_msg is null then raise exception 'agente não enviou'; end if;
  if (select source from public.wa_messages where id = v_msg) <> 'agent' then raise exception 'origem errada'; end if;
  if not exists (select 1 from public.wa_outbox where message_id = v_msg and kind = 'text' and idempotency_key like 'agent:%') then raise exception 'sem fila de envio'; end if;
  if (select replies_today from public.wa_agent_state where conversation_id = v_conv) <> 1 then raise exception 'contador errado'; end if;

  -- 4. Não responde duas vezes a mesma mensagem
  if public.wa_agent_send(v_conv, v_in, 'De novo', false, null, 10) is not null then raise exception 'respondeu duas vezes'; end if;
  if exists (select 1 from public.wa_agent_candidates(0, 50) where conversation_id = v_conv) then raise exception 'continua candidata depois de responder'; end if;

  -- 5. Resposta antiga não sai se o cliente mandou outra mensagem
  update public.wa_conversations set last_outbound_at = now() - interval '25 seconds', last_inbound_at = now() - interval '20 seconds' where id = v_conv; -- now() é fixo dentro da transação
  if public.wa_agent_send(v_conv, v_in, 'Velha', false, null, 10) is not null then raise exception 'enviou resposta desatualizada'; end if;

  -- 6. Limite diário por conversa
  if public.wa_agent_send(v_conv, (select last_inbound_at from public.wa_conversations where id = v_conv), 'Segunda', false, null, 2) is null then raise exception 'segunda resposta bloqueada'; end if;
  update public.wa_conversations set last_outbound_at = now() - interval '25 seconds', last_inbound_at = now() - interval '15 seconds' where id = v_conv; -- now() é fixo dentro da transação
  if public.wa_agent_send(v_conv, (select last_inbound_at from public.wa_conversations where id = v_conv), 'Terceira', false, null, 2) is not null then raise exception 'passou do limite diário'; end if;

  -- 7. Passagem para a equipe: pausa e marca pendente
  update public.wa_agent_state set replies_today = 0 where conversation_id = v_conv;
  if public.wa_agent_send(v_conv, (select last_inbound_at from public.wa_conversations where id = v_conv), 'Vou chamar a equipe.', true, 'Pediu desconto', 10) is null then raise exception 'handoff não enviou'; end if;
  if (select status from public.wa_conversations where id = v_conv) <> 'pending' then raise exception 'handoff não marcou pendente'; end if;
  if (select paused_until from public.wa_agent_state where conversation_id = v_conv) <= now() then raise exception 'handoff não pausou'; end if;
  update public.wa_conversations set last_outbound_at = now() - interval '25 seconds', last_inbound_at = now() - interval '12 seconds' where id = v_conv; -- now() é fixo dentro da transação
  if exists (select 1 from public.wa_agent_candidates(10, 50) where conversation_id = v_conv) then raise exception 'pausada continua candidata'; end if;
  if public.wa_agent_send(v_conv, (select last_inbound_at from public.wa_conversations where id = v_conv), 'X', false, null, 10) is not null then raise exception 'pausada enviou'; end if;

  -- 8. Pessoa da equipe respondeu pelo celular: agente fica quieto 12 h
  update public.wa_agent_state set paused_until = null where conversation_id = v_conv;
  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, message_status, provider_timestamp)
  values ((select company_id from fx), v_conv, 'outbound', 'app_echo', 'text', 'Oi, aqui é a recepção', 'sent', now() - interval '5 minutes');
  if exists (select 1 from public.wa_agent_candidates(10, 50) where conversation_id = v_conv) then raise exception 'respondeu com humano ativo'; end if;
  if public.wa_agent_send(v_conv, (select last_inbound_at from public.wa_conversations where id = v_conv), 'X', false, null, 10) is not null then raise exception 'enviou com humano ativo'; end if;
end $$;

-- 9. Permissões: app não envia pelo agente; só lê o estado da própria empresa; pausa/reativa só na própria empresa
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a9e01","role":"authenticated"}',true);
do $$ declare v_conv uuid; begin
  select id into v_conv from public.wa_conversations limit 1;
  begin perform public.wa_agent_send(v_conv, now(), 'x', false, null, 10); raise exception 'app enviou pelo agente';
  exception when insufficient_privilege then null; end;
  begin perform * from public.wa_agent_candidates(10, 10); raise exception 'app listou candidatas';
  exception when insufficient_privilege then null; end;
  if (select count(*) from public.wa_agent_state) <> 1 then raise exception 'não vê o estado da própria conversa'; end if;
  perform public.crm_wa_agent_toggle(v_conv, true);
  if (select paused_until from public.wa_agent_state where conversation_id = v_conv) <> 'infinity' then raise exception 'pausa manual falhou'; end if;
  perform public.crm_wa_agent_toggle(v_conv, false);
  if (select paused_until from public.wa_agent_state where conversation_id = v_conv) is not null then raise exception 'reativar falhou'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-0000000b9e02","role":"authenticated"}',true);
do $$ declare v_conv uuid; begin
  if (select count(*) from public.wa_agent_state) <> 0 then raise exception 'vazamento de estado entre empresas'; end if;
  select conv into v_conv from fxc;
  begin perform public.crm_wa_agent_toggle(v_conv, true); raise exception 'pausou conversa de outra empresa';
  exception when raise_exception then if sqlerrm = 'pausou conversa de outra empresa' then raise; end if; end;
end $$;
reset role;

select 'agente automático: ok' as resultado;
rollback;

-- Testes: uma chamada à IA por mensagem do cliente (wa_agent_claim / wa_agent_release / wa_agent_candidates).
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values ('aaaaaaaa-0000-4000-8000-0000000a6f01','uc-admin@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a6f01","role":"authenticated"}',true);
select public.crm_bootstrap('Admin','Loja Chamada Teste','Motos');
reset role;

create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='aaaaaaaa-0000-4000-8000-0000000a6f01'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','993000111','WA Chamada',true from ca returning id, company_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status)
             select ch.company_id, ch.id, '993000111','993000222','+5594900003333','connected' from ch returning id, company_id)
select acc.id account_id, acc.company_id from acc;

update public.crm_companies set settings = settings || jsonb_build_object('agent', jsonb_build_object('enabled', true, 'mode', 'automatico',
  'name', 'Assistente', 'tone', 'acolhedor', 'knowledge', repeat('x', 40), 'handoff', ''))
where id = (select company_id from fx);

select public.wa_ingest(jsonb_build_array(jsonb_build_object('type','message','key','993000111:msg:wamid.UC1','phone_number_id','993000111',
  'payload', jsonb_build_object('wa_id','5594977773333','name','Cliente Teste','wamid','wamid.UC1',
    'ts', to_char((now() - interval '30 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body','Oi, tem moto elétrica?'))));
select crm_private.wa_run_events(50);

do $$ declare v_conv uuid; v_in timestamptz; n int; begin
  select c.id, c.last_inbound_at into v_conv, v_in from public.wa_conversations c join fx on fx.company_id = c.company_id;
  if v_conv is null then raise exception 'fixture: conversa não criada'; end if;

  -- 1. Antes da reserva, a conversa é candidata
  select count(*) into n from public.wa_agent_candidates(2, 10) x where x.conversation_id = v_conv;
  if n <> 1 then raise exception 'Falha 1: não era candidata'; end if;

  -- 2. Primeira rodada reserva; as outras (mesma mensagem) não conseguem
  if not public.wa_agent_claim(v_conv, v_in) then raise exception 'Falha 2a: primeira reserva recusada'; end if;
  if public.wa_agent_claim(v_conv, v_in) then raise exception 'Falha 2b: segunda rodada reservou a mesma mensagem'; end if;
  if public.wa_agent_claim(v_conv, v_in) then raise exception 'Falha 2c: terceira rodada reservou'; end if;

  -- 3. Reservada: deixa de aparecer como candidata (outras rodadas nem tentam)
  select count(*) into n from public.wa_agent_candidates(2, 10) x where x.conversation_id = v_conv;
  if n <> 0 then raise exception 'Falha 3: reservada continuou candidata'; end if;

  -- 4. A IA falhou: soltar a reserva libera para a próxima rodada
  perform public.wa_agent_release(v_conv, v_in);
  select count(*) into n from public.wa_agent_candidates(2, 10) x where x.conversation_id = v_conv;
  if n <> 1 then raise exception 'Falha 4a: solta e não voltou a ser candidata'; end if;
  if not public.wa_agent_claim(v_conv, v_in) then raise exception 'Falha 4b: não reservou depois de soltar'; end if;

  -- 5. Mensagem mais nova do cliente pode ser reservada na hora (a antiga não vale mais)
  if not public.wa_agent_claim(v_conv, v_in + interval '5 seconds') then raise exception 'Falha 5a: mensagem nova bloqueada'; end if;
  if public.wa_agent_claim(v_conv, v_in) then raise exception 'Falha 5b: mensagem antiga tomou a reserva da nova'; end if;
  -- Soltar com a mensagem antiga não solta a reserva da nova
  perform public.wa_agent_release(v_conv, v_in);
  if public.wa_agent_claim(v_conv, v_in + interval '5 seconds') then raise exception 'Falha 5c: soltou a reserva errada'; end if;

  -- 6. Reserva vencida (90 s) pode ser tomada de novo
  update public.wa_agent_state set thinking_until = now() - interval '1 second' where conversation_id = v_conv;
  if not public.wa_agent_claim(v_conv, v_in + interval '5 seconds') then raise exception 'Falha 6: reserva vencida não liberou'; end if;

  -- 7. A resposta continua passando pelo wa_agent_send normalmente (reserva não atrapalha o envio)
  update public.wa_agent_state set thinking_inbound_at = v_in, thinking_until = now() + interval '90 seconds' where conversation_id = v_conv;
  if public.wa_agent_send(v_conv, v_in, 'Temos sim! Pra quem seria a moto?', false, null, 10) is null then raise exception 'Falha 7a: envio recusado'; end if;
  if (select replies_today from public.wa_agent_state where conversation_id = v_conv) <> 1 then raise exception 'Falha 7b: contador'; end if;

  -- 8. Conversa inexistente ou sem mensagem: não reserva
  if public.wa_agent_claim(gen_random_uuid(), now()) then raise exception 'Falha 8a'; end if;
  if public.wa_agent_claim(v_conv, null) then raise exception 'Falha 8b'; end if;
end $$;

-- 9. Só o servidor chama
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a6f01","role":"authenticated"}',true);
do $$ begin
  begin perform public.wa_agent_claim(gen_random_uuid(), now()); raise exception 'Falha 9a'; exception when insufficient_privilege then null; end;
  begin perform public.wa_agent_release(gen_random_uuid(), now()); raise exception 'Falha 9b'; exception when insufficient_privilege then null; end;
  begin perform public.wa_agent_candidates(2, 10); raise exception 'Falha 9c'; exception when insufficient_privilege then null; end;
end $$;
reset role;

create temp table resultado_teste as select 'agente_uma_chamada: todos os testes passaram'::text as resultado;
select * from resultado_teste;
rollback;

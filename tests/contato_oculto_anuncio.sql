-- Testes: cliente com telefone oculto (BSUID), anúncio Clique para WhatsApp, contato com/sem o 9 e
-- remarketing com número parado por pagamento (migration 20261127120000_contato_oculto_anuncio.sql).
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values ('aaaaaaaa-0000-4000-8000-0000000a8f01','co-admin@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a8f01","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja Oculto Teste','Motos');
reset role;

create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='aaaaaaaa-0000-4000-8000-0000000a8f01'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','772000001','Loja',true from ca returning id, company_id, external_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,provider,phone_number_id,waba_id,phone_e164,connection_status)
             select company_id, id, 'wasapflow', external_id, '882000001', '+5594900006088', 'connected' from ch returning id)
select (select id from ca) empresa, (select id from acc) conta;

create function pg_temp.msg(p_wamid text, p_payload jsonb) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('type','message','key','772000001:msg:'||p_wamid,'phone_number_id','772000001',
    'payload', jsonb_build_object('wamid',p_wamid,'ts',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'type','text','body','Oi')
               || p_payload))
$$;
create function pg_temp.entra(p_wamid text, p_payload jsonb) returns void language plpgsql as $$
declare r jsonb; begin
  r := public.wa_ingest_wasapflow('882000001', '772000001', pg_temp.msg(p_wamid, p_payload));
  if (r->>'inserted')::int <> 1 then raise exception 'evento % não entrou: %', p_wamid, r; end if;
  perform crm_private.wa_run_events(50);
  if exists (select 1 from public.wa_webhook_events where external_event_id = '772000001:msg:' || p_wamid and processing_status <> 'done') then
    raise exception 'evento % não processado: %', p_wamid, (select last_error from public.wa_webhook_events where external_event_id = '772000001:msg:' || p_wamid);
  end if;
end $$;

do $$ declare e uuid := (select empresa from fx); c public.wa_contacts%rowtype; v_conv uuid; v_conv2 uuid; n int; d jsonb; r record; begin
  -- 1. Telefone oculto: só BSUID → contato com o BSUID, sem telefone, com conversa e mensagem
  perform pg_temp.entra('wamid.O1', '{"bsuid":"BR.13491208655302741918","name":"Cliente Oculto"}');
  select * into c from public.wa_contacts where company_id = e and bsuid = 'BR.13491208655302741918';
  if c.id is null or c.wa_id <> 'BR.13491208655302741918' or c.phone_e164 is not null or c.name <> 'Cliente Oculto' then
    raise exception 'Falha 1a: contato oculto %', row_to_json(c); end if;
  select id into v_conv from public.wa_conversations where contact_id = c.id;
  if v_conv is null or not exists (select 1 from public.wa_messages where conversation_id = v_conv and external_message_id = 'wamid.O1' and direction = 'inbound') then
    raise exception 'Falha 1b: conversa/mensagem do contato oculto'; end if;

end $$;

-- 2. Resposta sai para o BSUID (a fila entrega o wa_id do contato ao worker)
do $$ declare e uuid := (select empresa from fx); v_conv uuid; v_msg uuid; r record; begin
  select cv.id into v_conv from public.wa_conversations cv join public.wa_contacts k on k.id = cv.contact_id where k.bsuid = 'BR.13491208655302741918';
  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, message_status)
  values (e, v_conv, 'outbound', 'agent', 'text', 'Oi!', 'queued') returning id into v_msg;
  insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key, message_id)
  values (e, v_conv, 'text', '{"text":"Oi!"}', 'teste-oculto-1', v_msg);
  select * into r from public.wa_claim_outbox(5) x where x.payload->>'text' = 'Oi!';
  if r.to_wa_id is distinct from 'BR.13491208655302741918' then raise exception 'Falha 2: destino da resposta %', r.to_wa_id; end if;
end $$;

do $$ declare e uuid := (select empresa from fx); c public.wa_contacts%rowtype; v_id uuid; v_conv uuid; n int; d jsonb; begin
  -- 3. Depois o mesmo cliente aparece com telefone + BSUID: mesmo contato, ganha o telefone
  select id into v_id from public.wa_contacts where bsuid = 'BR.13491208655302741918';
  perform pg_temp.entra('wamid.O2', '{"wa_id":"5594977771111","bsuid":"BR.13491208655302741918"}');
  select * into c from public.wa_contacts where id = v_id;
  if c.wa_id <> '5594977771111' or c.phone_e164 <> '+5594977771111' then raise exception 'Falha 3a: telefone não entrou %', row_to_json(c); end if;
  if (select count(*) from public.wa_contacts where company_id = e and (bsuid = 'BR.13491208655302741918' or wa_id in ('5594977771111','BR.13491208655302741918'))) <> 1 then
    raise exception 'Falha 3b: duplicou contato'; end if;
  if (select count(*) from public.wa_conversations where contact_id = v_id) <> 1 then raise exception 'Falha 3c: duplicou conversa'; end if;
  -- e sem telefone de novo (só BSUID): continua o mesmo
  perform pg_temp.entra('wamid.O3', '{"bsuid":"BR.13491208655302741918"}');
  if (select count(*) from public.wa_contacts where company_id = e) <> 1 then raise exception 'Falha 3d: BSUID criou outro contato'; end if;

  -- 4. Com e sem o 9: o remarketing criou o contato com o 9; a resposta vem sem o 9 → mesmo contato e conversa
  v_id := crm_private.wa_contact(e, '5594981020001', 'Ademar Teste');
  v_conv := crm_private.wa_conversation(e, (select conta from fx), v_id);
  perform pg_temp.entra('wamid.N1', '{"wa_id":"559481020001","name":"Ademar"}');
  if (select count(*) from public.wa_contacts where company_id = e and wa_id in ('5594981020001','559481020001')) <> 1 then
    raise exception 'Falha 4a: criou contato duplicado sem o 9'; end if;
  if not exists (select 1 from public.wa_messages where external_message_id = 'wamid.N1' and conversation_id = v_conv) then
    raise exception 'Falha 4b: resposta caiu em outra conversa'; end if;
  -- e o contrário (existe sem o 9, chega com o 9)
  v_id := crm_private.wa_contact(e, '559481020002', 'Sem Nove');
  if crm_private.wa_contact(e, '5594981020002', null) <> v_id then raise exception 'Falha 4c: com o 9 não achou o sem o 9'; end if;

  -- 5. Anúncio: contato novo, lead automático desligado → lead criado como "Anúncio Meta" com o nome do anúncio
  perform pg_temp.entra('wamid.A1', '{"wa_id":"5594977772222","name":"Cliente Anúncio","referral":{"source_type":"ad","source_id":"120210001","source_url":"https://fb.me/abc","headline":"Moto elétrica em 12x","body":"Sem gasolina","ctwa_clid":"ARAk1"}}');
  select k.id, k.crm_lead_id into v_id from public.wa_contacts k where k.wa_id = '5594977772222';
  select data into d from public.crm_records r join public.wa_contacts k on k.crm_lead_id = r.id where k.wa_id = '5594977772222';
  if d is null or d->>'source' <> 'Anúncio Meta' or d->>'ad_name' <> 'Moto elétrica em 12x' or d->>'ad_id' <> '120210001'
     or d->>'utm_campaign' <> 'Moto elétrica em 12x' or d->>'phone' <> '+5594977772222' then
    raise exception 'Falha 5a: lead do anúncio %', d; end if;
  if (select ad_referral->>'headline' from public.wa_conversations where contact_id = v_id) <> 'Moto elétrica em 12x'
     or (select ad_referral->>'ctwa_clid' from public.wa_conversations where contact_id = v_id) <> 'ARAk1' then
    raise exception 'Falha 5b: anúncio não ficou na conversa'; end if;
  if (select count(*) from public.crm_records where kind = 'activity' and company_id = e and data->>'text' like 'Chegou pelo anúncio da Meta: Moto elétrica em 12x%') <> 1 then
    raise exception 'Falha 5c: atividade do anúncio'; end if;
  -- mesmo anúncio de novo: não repete atividade
  perform pg_temp.entra('wamid.A2', '{"wa_id":"5594977772222","referral":{"source_id":"120210001","headline":"Moto elétrica em 12x"}}');
  if (select count(*) from public.crm_records where kind = 'activity' and company_id = e and data->>'text' like 'Chegou pelo anúncio da Meta%') <> 1 then
    raise exception 'Falha 5d: repetiu atividade do mesmo anúncio'; end if;
  -- mensagem sem anúncio e lead automático desligado: não cria lead
  perform pg_temp.entra('wamid.A3', '{"wa_id":"5594977773333"}');
  if (select crm_lead_id from public.wa_contacts where wa_id = '5594977773333') is not null then raise exception 'Falha 5e: criou lead sem anúncio'; end if;

  -- 6. Lead que já existia de outra origem (Cowboy) mantém a origem e ganha o anúncio
  insert into public.crm_records (company_id, kind, data) values (e, 'leads',
    '{"name":"Lead Cowboy","phone":"+5594977774444","source":"Cowboy","stage":"Em contato","utm_campaign":"campanha antiga"}') returning id into v_id;
  insert into crm_private.contact_links (company_id, contact_key, lead_id) values (e, 'phone:5594977774444', v_id);
  perform pg_temp.entra('wamid.A4', '{"wa_id":"5594977774444","referral":{"source_id":"777","headline":"ZUB Paris"}}');
  select data into d from public.crm_records where id = v_id;
  if d->>'source' <> 'Cowboy' or d->>'ad_name' <> 'ZUB Paris' or d->>'utm_campaign' <> 'campanha antiga' then raise exception 'Falha 6: %', d; end if;
  if (select crm_lead_id from public.wa_contacts where wa_id = '5594977774444') <> v_id then raise exception 'Falha 6b: ligou a outro lead'; end if;

  -- 7. Anúncio com telefone oculto: lead sem telefone, ligado pelo BSUID
  perform pg_temp.entra('wamid.A5', '{"bsuid":"BR.555000111","referral":{"headline":"Promo"}}');
  select r.data into d from public.crm_records r join public.wa_contacts k on k.crm_lead_id = r.id where k.wa_id = 'BR.555000111';
  if d is null or d->>'phone' <> '' or d->>'source' <> 'Anúncio Meta' then raise exception 'Falha 7a: lead do oculto %', d; end if;
  if not exists (select 1 from crm_private.contact_links where company_id = e and contact_key = 'bsuid:BR.555000111') then raise exception 'Falha 7b: chave do BSUID'; end if;

  -- 8. Lixo continua fora: sem telefone e sem BSUID não processa; wa_id inválido é recusado
  perform pg_temp.entra('wamid.X1', '{"bsuid":"nao-e-bsuid"}');
  if exists (select 1 from public.wa_messages where external_message_id = 'wamid.X1') then raise exception 'Falha 8a: aceitou mensagem sem cliente'; end if;
  begin
    insert into public.wa_contacts (company_id, wa_id) values (e, 'br.minusculo');
    raise exception 'Falha 8b: wa_id inválido aceito';
  exception when check_violation then null; end;
end $$;

-- 9. Remarketing: número parado por pagamento e tentativa que não conta
do $$ declare e uuid := (select empresa from fx); a uuid := (select conta from fx); v_lead uuid; v_k uuid; v_conv uuid; v_m uuid; r record; begin
  if crm_private.wa_conta_parada(a) then raise exception 'Falha 9a: número parado sem motivo'; end if;
  insert into public.crm_records (company_id, kind, data) values (e, 'leads',
    jsonb_build_object('name','Lead RM','phone','+5594977775555','stage','Em contato','created', now() - interval '40 days')) returning id into v_lead;
  v_k := crm_private.wa_contact(e, '5594977775555', 'Lead RM');
  update public.wa_contacts set crm_lead_id = v_lead where id = v_k;
  v_conv := crm_private.wa_conversation(e, a, v_k);
  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, template_name, message_status, error_code, created_at)
  values (e, v_conv, 'outbound', 'agent', 'template', 'Oi', 'remarketing_parcela', 'failed', '131042', now() - interval '1 hour') returning id into v_m;
  insert into public.wa_remarketing_sends (company_id, lead_id, contact_id, conversation_id, account_id, message_id, attempt, template_name, day, created_at)
  values (e, v_lead, v_k, v_conv, a, v_m, 1, 'remarketing_parcela', current_date, now() - interval '1 hour');
  if not crm_private.wa_conta_parada(a) then raise exception 'Falha 9b: número com 131042 não parou'; end if;
  select * into r from crm_private.wa_remarketing_elegiveis(e, now() + interval '30 days') x where x.lead_id = v_lead;
  if r.attempt is distinct from 1 then raise exception 'Falha 9c: falha por pagamento gastou tentativa (%)', r.attempt; end if;
  -- Falha do cliente (ex.: 131047) conta como tentativa normalmente
  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, template_name, message_status, error_code, created_at)
  values (e, v_conv, 'outbound', 'agent', 'template', 'Oi', 'remarketing_parcela', 'failed', '131047', now() - interval '30 minutes') returning id into v_m;
  insert into public.wa_remarketing_sends (company_id, lead_id, contact_id, conversation_id, account_id, message_id, attempt, template_name, day, created_at)
  values (e, v_lead, v_k, v_conv, a, v_m, 1, 'remarketing_parcela', current_date - 1, now() - interval '30 minutes');
  select * into r from crm_private.wa_remarketing_elegiveis(e, now() + interval '30 days') x where x.lead_id = v_lead;
  if r.attempt is distinct from 2 then raise exception 'Falha 9d: falha comum deveria contar (%)', r.attempt; end if;
  -- O número volta sozinho quando um modelo é entregue de novo
  insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, template_name, message_status, created_at)
  values (e, v_conv, 'outbound', 'crm', 'template', 'Oi', 'alerta_atendimento', 'delivered', now());
  if crm_private.wa_conta_parada(a) then raise exception 'Falha 9e: número não voltou após entrega'; end if;
end $$;

-- 10. Funções internas não ficam expostas
do $$ begin
  if has_function_privilege('authenticated', 'crm_private.wa_contact(uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'crm_private.wa_lead_do_anuncio(uuid,uuid,uuid,jsonb,timestamptz)', 'execute') then
    raise exception 'Falha 10: função interna exposta'; end if;
end $$;

select 'contato_oculto_anuncio: ok' as resultado;
rollback;

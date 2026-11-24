-- Testes: agente manda a foto do catálogo (wa_agent_send_image) e a fila trata imagem como texto.
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('aaaaaaaa-0000-4000-8000-0000000a9f01','ag-admin-a@example.invalid',now()),
 ('bbbbbbbb-0000-4000-8000-0000000b9f02','ag-admin-b@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a9f01","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja Foto Teste','Odontologia');
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-0000000b9f02","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Empresa B Foto','Servicos');
reset role;

create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='aaaaaaaa-0000-4000-8000-0000000a9f01'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','994000111','WA Foto',true from ca returning id, company_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status)
             select ch.company_id, ch.id, '994000111','994000222','+5594900004444','connected' from ch returning id, company_id)
select acc.id account_id, acc.company_id from acc;
grant select on fx to authenticated, service_role;

-- Cliente manda mensagem há 30 s
select public.wa_ingest(jsonb_build_array(jsonb_build_object('type','message','key','994000111:msg:wamid.FT1','phone_number_id','994000111',
  'payload', jsonb_build_object('wa_id','5594977774444','name','Paciente Teste','wamid','wamid.FT1',
    'ts', to_char((now() - interval '30 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body','Quanto custa a limpeza?'))));
select crm_private.wa_run_events(50);
create temp table fxc as select c.id conv from public.wa_conversations c join fx on fx.company_id = c.company_id;
grant select on fxc to authenticated, service_role;

update public.crm_companies set settings = settings || jsonb_build_object('agent', jsonb_build_object('enabled', true, 'mode', 'automatico',
  'name', 'Assistente', 'tone', 'acolhedor', 'knowledge', repeat('x', 40), 'handoff', '',
  'photos', jsonb_build_object('ZUB L70', 'https://exemplo.invalid/a.png', 'Bot Flash', 'https://exemplo.invalid/b.png', 'Yala TTX', 'https://exemplo.invalid/c.png')))
where id = (select company_id from fx);

do $$ declare v_conv uuid; v_in timestamptz; m uuid; n int; o record; begin
  select c.id, c.last_inbound_at into v_conv, v_in from public.wa_conversations c join fx on fx.company_id=c.company_id;
  if v_conv is null then raise exception 'fixture: conversa não criada'; end if;

  -- 1. Antes de o agente responder esta mensagem, não manda foto
  if public.wa_agent_send_image(v_conv, v_in, 'https://exemplo.invalid/a.png', '📷 ZUB L70') is not null then raise exception 'Falha 1: foto antes do texto'; end if;
  if public.wa_agent_send(v_conv, v_in, 'Olha a ZUB L70 aqui 👇', false, null, 10) is null then raise exception 'fixture: texto não enviado'; end if;

  -- 2. Foto do catálogo: vira mensagem de imagem com legenda e entra na fila como "image"
  m := public.wa_agent_send_image(v_conv, v_in, 'https://exemplo.invalid/a.png', '📷 ZUB L70');
  if m is null then raise exception 'Falha 2a: foto do catálogo recusada'; end if;
  if (select message_type||'|'||body||'|'||source from public.wa_messages where id=m) <> 'image|📷 ZUB L70|agent' then raise exception 'Falha 2b: mensagem errada'; end if;
  select * into o from public.wa_outbox where message_id=m;
  if o.kind <> 'image' or o.payload->'image'->>'link' <> 'https://exemplo.invalid/a.png' or o.payload->'image'->>'caption' <> '📷 ZUB L70' then raise exception 'Falha 2c: fila errada'; end if;
  if not exists (select 1 from public.wa_audit_logs where action='agent.send_image' and target_id=v_conv) then raise exception 'Falha 2d: auditoria'; end if;

  -- 3. Link fora do catálogo, foto repetida e legenda vazia: recusados
  if public.wa_agent_send_image(v_conv, v_in, 'https://malicioso.invalid/x.png', '📷 X') is not null then raise exception 'Falha 3a: link fora do catálogo'; end if;
  if public.wa_agent_send_image(v_conv, v_in, 'https://exemplo.invalid/a.png', '📷 ZUB L70') is not null then raise exception 'Falha 3b: repetiu'; end if;
  if public.wa_agent_send_image(v_conv, v_in, 'https://exemplo.invalid/b.png', '   ') is not null then raise exception 'Falha 3c: sem legenda'; end if;

  -- 4. No máximo 2 fotos por resposta
  if public.wa_agent_send_image(v_conv, v_in, 'https://exemplo.invalid/b.png', '📷 Bot Flash') is null then raise exception 'Falha 4a'; end if;
  if public.wa_agent_send_image(v_conv, v_in, 'https://exemplo.invalid/c.png', '📷 Yala TTX') is not null then raise exception 'Falha 4b: terceira foto'; end if;

  -- 5. Agente fora do automático: não manda
  update public.crm_companies set settings = jsonb_set(settings, '{agent,mode}', '"sugestao"') where id = (select company_id from fx);
  update public.wa_outbox set idempotency_key = idempotency_key || '-x' where conversation_id = v_conv and kind = 'image'; -- libera o limite só para este teste
  if public.wa_agent_send_image(v_conv, v_in, 'https://exemplo.invalid/c.png', '📷 Yala TTX') is not null then raise exception 'Falha 5: modo sugestão'; end if;
  update public.crm_companies set settings = jsonb_set(settings, '{agent,mode}', '"automatico"') where id = (select company_id from fx);

  -- 6. Cliente mandou outra mensagem depois: a resposta antiga não manda mais foto
  update public.wa_conversations set last_inbound_at = now() where id = v_conv;
  if public.wa_agent_send_image(v_conv, v_in, 'https://exemplo.invalid/c.png', '📷 Yala TTX') is not null then raise exception 'Falha 6: mensagem velha'; end if;

  -- 7. Fila: imagem com a janela de 24 h fechada é bloqueada, como texto
  update public.wa_conversations set service_window_expires_at = now() - interval '1 minute' where id = v_conv;
  perform public.wa_claim_outbox(10);
  select count(*) into n from public.wa_outbox where conversation_id = v_conv and kind = 'image' and status <> 'blocked';
  if n <> 0 then raise exception 'Falha 7: imagem fora da janela não foi bloqueada (%)', n; end if;
end $$;

-- 8. Só o servidor chama
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a9f01","role":"authenticated"}',true);
do $$ begin
  begin perform public.wa_agent_send_image(gen_random_uuid(), now(), 'https://exemplo.invalid/a.png', 'x'); raise exception 'Falha 8: usuário chamou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

create temp table resultado_teste as select 'agente_foto: todos os testes passaram'::text as resultado;
select * from resultado_teste;
rollback;

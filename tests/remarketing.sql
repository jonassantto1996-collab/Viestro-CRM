-- Testes: remarketing automático (wa_remarketing_run, gatilho de resposta/opt-out, painel e relatório).
-- Tudo roda numa transação e é desfeito no final. Nunca usa números reais.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('aaaaaaaa-0000-4000-8000-0000000a5f01','rm-admin-a@example.invalid',now()),
 ('bbbbbbbb-0000-4000-8000-0000000b5f02','rm-admin-b@example.invalid',now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a5f01","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja Remarketing Teste','Motos');
select set_config('request.jwt.claims','{"sub":"bbbbbbbb-0000-4000-8000-0000000b5f02","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Loja B Remarketing','Motos');
reset role;

-- Quarta-feira às 17:59 (Brasília) desta semana: dentro do horário (seg-sab 09-18), cota cheia.
create temp table fx as
with ca as (select company_id id from public.crm_members where user_id='aaaaaaaa-0000-4000-8000-0000000a5f01'),
     cb as (select company_id id from public.crm_members where user_id='bbbbbbbb-0000-4000-8000-0000000b5f02'),
     ch as (insert into public.crm_channels(company_id,provider,external_id,label,enabled)
            select id,'whatsapp','775000001','Loja 6088',true from ca union all
            select id,'whatsapp','775000002','Loja 1715',true from ca union all
            select id,'whatsapp','775000003','Loja B',true from cb returning id, company_id, external_id),
     acc as (insert into public.wa_accounts(company_id,crm_channel_id,phone_number_id,waba_id,phone_e164,connection_status)
             select company_id, id, external_id, '88' || external_id,
                    case external_id when '775000001' then '+5594900006088' when '775000002' then '+5594900001715' else '+5594900007777' end,
                    'connected' from ch returning id, phone_number_id)
select (select id from ca) a, (select id from cb) b,
       (select id from acc where phone_number_id='775000001') c6088, (select id from acc where phone_number_id='775000002') c1715,
       (select id from acc where phone_number_id='775000003') cb1,
       ((date_trunc('week', now() at time zone 'America/Sao_Paulo') + interval '2 days 17 hours 59 minutes') at time zone 'America/Sao_Paulo') base;
grant select on fx to authenticated, service_role;

-- Modelos aprovados (empresa A: os três nos dois números; empresa B: só o primeiro)
insert into public.wa_templates (company_id, account_id, name, language, category, status, components)
select (select a from fx), acc, nome, 'pt_BR', 'MARKETING', 'APPROVED', jsonb_build_array(jsonb_build_object('type','BODY','text','Oi, {{1}}! ' || nome))
from (select unnest(array[(select c6088 from fx), (select c1715 from fx)]) acc) x,
     unnest(array['remarketing_parcela','remarketing_economia','remarketing_ultima']) nome;
insert into public.wa_templates (company_id, account_id, name, language, category, status, components)
select b, cb1, 'remarketing_parcela', 'pt_BR', 'MARKETING', 'APPROVED', '[{"type":"BODY","text":"Oi, {{1}}! parcela"}]' from fx;

update public.crm_companies set settings = settings || jsonb_build_object(
  'agent', jsonb_build_object('enabled', true, 'mode', 'automatico', 'name', 'Assistente', 'tone', 'acolhedor', 'knowledge', repeat('x', 40), 'handoff', '',
    'attendants', jsonb_build_array('Agna','Cleudo'), 'number_owners', jsonb_build_object('5594900006088','Agna','5594900001715','Cleudo'),
    'attendant_phones', jsonb_build_object('Agna','5594991110000')),
  'remarketing', jsonb_build_object('enabled', true))
where id = (select a from fx);
update public.crm_companies set settings = settings || jsonb_build_object('remarketing', jsonb_build_object('enabled', true, 'daily_limit', 1))
where id = (select b from fx);

-- Leads da empresa A
create function pg_temp.lead(p_company uuid, p_nome text, p_fone text, p_stage text, p_owner text, p_criado timestamptz) returns uuid language sql as $$
  insert into public.crm_records (company_id, kind, data) values (p_company, 'leads', jsonb_build_object('name', p_nome, 'phone', p_fone,
    'stage', p_stage, 'owner', p_owner, 'created', to_char(p_criado at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) returning id
$$;
create temp table ld as select
  pg_temp.lead((select a from fx), 'Maria Souza', '+55 94 99000-0001', 'Novo Lead', 'Equipe', (select base from fx) - interval '11 days') l1,
  pg_temp.lead((select a from fx), 'Joana Lima',  '5594990000002', 'Em contato', 'Agna', (select base from fx) - interval '11 days') l2,
  pg_temp.lead((select a from fx), '😀🛵',         '5594990000003', 'Novo Lead', 'Cleudo', (select base from fx) - interval '11 days') l3,
  pg_temp.lead((select a from fx), 'Pedro Alves', '5594990000004', 'Em Negociação', 'Agna', (select base from fx) - interval '40 days') l4,
  pg_temp.lead((select a from fx), 'Ganhou Já',   '5594990000005', 'Ganho', 'Equipe', (select base from fx) - interval '40 days') l5,
  pg_temp.lead((select a from fx), 'Recente',     '5594990000006', 'Novo Lead', 'Equipe', (select base from fx) - interval '5 days') l6,
  pg_temp.lead((select a from fx), 'Saiu Antes',  '5594990000007', 'Novo Lead', 'Equipe', (select base from fx) - interval '40 days') l7,
  pg_temp.lead((select a from fx), 'Atendente',   '5594991110000', 'Novo Lead', 'Equipe', (select base from fx) - interval '40 days') l8,
  pg_temp.lead((select a from fx), 'Sem Fone',    '',              'Novo Lead', 'Equipe', (select base from fx) - interval '40 days') l9;
grant select on ld to authenticated, service_role;

create function pg_temp.msg(p_pnid text, p_wamid text, p_wa text, p_body text, p_ts timestamptz) returns jsonb language sql as $$
  select public.wa_ingest(jsonb_build_array(jsonb_build_object('type','message','key',p_pnid||':msg:'||p_wamid,'phone_number_id',p_pnid,
    'payload', jsonb_build_object('wa_id',p_wa,'name','Cliente','wamid',p_wamid,'ts',to_char(p_ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'type','text','body',p_body))))
$$;
-- L4 conversou pelo 1715 há 11 dias; L7 pediu SAIR há tempos (contato com opt-out). O 9º dígito é tratado (WhatsApp sem o 9).
select pg_temp.msg('775000002', 'wamid.R4', '559490000004', 'Quanto custa a X16?', (select base from fx) - interval '11 days');
select pg_temp.msg('775000001', 'wamid.R7', '5594990000007', 'SAIR', (select base from fx) - interval '30 days');
select crm_private.wa_run_events(100);

do $$ declare r jsonb; n int; v_acc uuid; begin
  -- 0. Auxiliares
  if crm_private.primeiro_nome('maria souza') <> 'Maria' or crm_private.primeiro_nome('😀🛵') <> 'tudo bem' or crm_private.primeiro_nome('123') <> 'tudo bem'
     or crm_private.primeiro_nome('') <> 'tudo bem' or crm_private.primeiro_nome('  JOÃO  pedro') <> 'João' or crm_private.primeiro_nome(null) <> 'tudo bem' then
    raise exception 'Falha 0a: primeiro nome'; end if;
  if not (crm_private.pediu_para_sair('SAIR') and crm_private.pediu_para_sair(' parar ') and crm_private.pediu_para_sair('Stop!')
          and crm_private.pediu_para_sair('não quero mais') and crm_private.pediu_para_sair('Nao quero mais receber.')) then raise exception 'Falha 0b'; end if;
  if crm_private.pediu_para_sair('não quero mais a X16, quero a Yala') or crm_private.pediu_para_sair('sair de casa cedo') then raise exception 'Falha 0c: falso positivo'; end if;
  if crm_private.br_variantes('5594990000004') <> array['5594990000004','559490000004'] then raise exception 'Falha 0d'; end if;

  -- 1. Fora do horário, domingo e desligado: nada
  if (public.wa_remarketing_run((select a from fx), (select base from fx) - interval '10 hours', 20))->>'skipped' <> 'fora_do_horario' then raise exception 'Falha 1a: 07:59'; end if;
  if (public.wa_remarketing_run((select a from fx), (select base from fx) + interval '1 minute', 20))->>'skipped' <> 'fora_do_horario' then raise exception 'Falha 1b: 18:00'; end if;
  if (public.wa_remarketing_run((select a from fx), (select base from fx) + interval '4 days', 20))->>'skipped' <> 'fora_do_horario' then raise exception 'Falha 1c: domingo'; end if;

  -- 2. Primeira rodada: L1, L2, L3, L4 (Ganho, recente, opt-out, atendente e sem telefone ficam de fora)
  r := public.wa_remarketing_run((select a from fx), (select base from fx), 20);
  if (r->>'queued')::int <> 4 then raise exception 'Falha 2a: esperava 4, veio %', r; end if;
  if exists (select 1 from public.wa_remarketing_sends s, ld where s.lead_id in (ld.l5, ld.l6, ld.l7, ld.l8, ld.l9)) then raise exception 'Falha 2b: lead proibido recebeu'; end if;
  if exists (select 1 from public.wa_remarketing_sends where company_id = (select a from fx) and (attempt <> 1 or template_name <> 'remarketing_parcela')) then raise exception 'Falha 2c: 1ª tentativa errada'; end if;

  -- 3. Escolha do número: L4 pela conversa (1715, mesmo sendo da Agna); L2 dono Agna → 6088; L3 dono Cleudo → 1715; L1 reveza
  if (select account_id from public.wa_remarketing_sends s, ld where s.lead_id = ld.l4) <> (select c1715 from fx) then raise exception 'Falha 3a: conversa'; end if;
  if (select account_id from public.wa_remarketing_sends s, ld where s.lead_id = ld.l2) <> (select c6088 from fx) then raise exception 'Falha 3b: dono Agna'; end if;
  if (select account_id from public.wa_remarketing_sends s, ld where s.lead_id = ld.l3) <> (select c1715 from fx) then raise exception 'Falha 3c: dono Cleudo'; end if;
  if (select account_id from public.wa_remarketing_sends s, ld where s.lead_id = ld.l1) is null then raise exception 'Falha 3d: revezamento'; end if;

  -- 4. Mensagem e fila: modelo com o primeiro nome (ou "tudo bem"), saída do agente, registro com o lead
  if (select m.body from public.wa_remarketing_sends s join public.wa_messages m on m.id = s.message_id, ld where s.lead_id = ld.l1) <> 'Oi, Maria! remarketing_parcela' then raise exception 'Falha 4a: nome'; end if;
  if (select m.body from public.wa_remarketing_sends s join public.wa_messages m on m.id = s.message_id, ld where s.lead_id = ld.l3) <> 'Oi, tudo bem! remarketing_parcela' then raise exception 'Falha 4b: tudo bem'; end if;
  if (select o.payload->'template'->'components'->0->'parameters'->0->>'text' from public.wa_remarketing_sends s join public.wa_outbox o on o.message_id = s.message_id, ld where s.lead_id = ld.l2) <> 'Joana' then raise exception 'Falha 4c: parâmetro'; end if;
  if exists (select 1 from public.wa_remarketing_sends s join public.wa_messages m on m.id = s.message_id where s.company_id = (select a from fx) and (m.source <> 'agent' or m.message_type <> 'template' or m.message_status <> 'queued')) then raise exception 'Falha 4d'; end if;
  if (select count(*) from public.crm_records r2, ld where r2.kind = 'activity' and r2.data->>'leadId' = ld.l1::text and r2.data->>'text' like 'Remarketing enviado (tentativa 1%') <> 1 then raise exception 'Falha 4e: atividade'; end if;
  if (select crm_lead_id from public.wa_contacts k join public.wa_remarketing_sends s on s.contact_id = k.id, ld where s.lead_id = ld.l1) <> (select l1 from ld) then raise exception 'Falha 4f: contato ligado ao lead'; end if;

  -- 5. Rodar de novo (worker duas vezes) não duplica
  r := public.wa_remarketing_run((select a from fx), (select base from fx), 20);
  if (r->>'queued')::int <> 0 then raise exception 'Falha 5: duplicou %', r; end if;
  if (select count(*) from public.wa_outbox where company_id = (select a from fx) and kind = 'template') <> 4 then raise exception 'Falha 5b: fila'; end if;
end $$;

-- 6. L1 responde (1 h depois): sai do ciclo, atividade "Respondeu ao remarketing (tentativa 1)"
select pg_temp.msg((select a.phone_number_id from public.wa_accounts a join public.wa_remarketing_sends s on s.account_id = a.id, ld where s.lead_id = ld.l1),
  'wamid.R1resp', (select k.wa_id from public.wa_contacts k join public.wa_remarketing_sends s on s.contact_id = k.id, ld where s.lead_id = ld.l1),
  'SIM, me manda', (select base from fx) + interval '1 hour');
-- 7. L2 pede para sair: "Não quero mais"
select pg_temp.msg('775000001', 'wamid.R2sair', (select k.wa_id from public.wa_contacts k join public.wa_remarketing_sends s on s.contact_id = k.id, ld where s.lead_id = ld.l2),
  'Não quero mais', (select base from fx) + interval '2 hours');
select crm_private.wa_run_events(100);

do $$ declare r jsonb; v_conv uuid; begin
  if (select outcome from public.wa_remarketing_sends s, ld where s.lead_id = ld.l1) <> 'responded' then raise exception 'Falha 6a'; end if;
  if not exists (select 1 from public.crm_records r2, ld where r2.kind = 'activity' and r2.data->>'leadId' = ld.l1::text and r2.data->>'text' = 'Respondeu ao remarketing (tentativa 1)') then raise exception 'Falha 6b'; end if;

  -- Opt-out: contato e lead marcados, envio marcado, confirmação na fila, histórico do lead, agente não responde por cima
  if (select outcome from public.wa_remarketing_sends s, ld where s.lead_id = ld.l2) <> 'opt_out' then raise exception 'Falha 7a'; end if;
  if (select k.marketing_opt_out_at from public.wa_contacts k join public.wa_remarketing_sends s on s.contact_id = k.id, ld where s.lead_id = ld.l2) is null then raise exception 'Falha 7b: contato'; end if;
  if (select data->>'marketing_opt_out' from public.crm_records, ld where id = ld.l2) <> 'true' then raise exception 'Falha 7c: lead'; end if;
  if not exists (select 1 from public.crm_records r2, ld where r2.kind = 'activity' and r2.data->>'leadId' = ld.l2::text and r2.data->>'text' like 'Pediu para não receber mais%') then raise exception 'Falha 7d: histórico'; end if;
  select conversation_id into v_conv from public.wa_remarketing_sends s, ld where s.lead_id = ld.l2;
  if not exists (select 1 from public.wa_outbox where conversation_id = v_conv and kind = 'text' and payload->>'text' like 'Pronto! Você não vai mais receber%') then raise exception 'Falha 7e: confirmação'; end if;
  if (select last_outbound_at <= last_inbound_at from public.wa_conversations where id = v_conv) then raise exception 'Falha 7f: agente responderia por cima'; end if;
  if not exists (select 1 from public.wa_consents c join public.wa_remarketing_sends s on s.contact_id = c.contact_id, ld where s.lead_id = ld.l2 and c.status = 'revoked' and c.purpose = 'marketing') then raise exception 'Falha 7g: consentimento'; end if;

  -- 8. +10 dias (sábado): 2ª tentativa só para L3 e L4 (L1 respondeu, L2 saiu); L6 ("Recente") completou 10 dias e entra na 1ª
  r := public.wa_remarketing_run((select a from fx), (select base from fx) + interval '10 days', 20);
  if (r->>'queued')::int <> 3 then raise exception 'Falha 8a: %', r; end if;
  if (select attempt from public.wa_remarketing_sends s, ld where s.lead_id = ld.l6) <> 1 then raise exception 'Falha 8d: recente'; end if;
  if (select string_agg(template_name, ',' order by template_name) from public.wa_remarketing_sends s, ld where s.lead_id in (ld.l3, ld.l4) and s.attempt = 2) <> 'remarketing_economia,remarketing_economia' then raise exception 'Falha 8b'; end if;

  -- 9. +12 dias (segunda): L1 volta ao ciclo na 1ª tentativa (a contagem zerou com a resposta), 10+ dias depois da resposta
  r := public.wa_remarketing_run((select a from fx), (select base from fx) + interval '12 days', 20);
  if (r->>'queued')::int <> 1 or (select attempt from public.wa_remarketing_sends s, ld where s.lead_id = ld.l1 order by created_at desc limit 1) <> 1 then raise exception 'Falha 9: %', r; end if;

  -- Menos de 10 dias desde o último envio: nada
  if (public.wa_remarketing_run((select a from fx), (select base from fx) + interval '19 days', 20))->>'queued' <> '0' then raise exception 'Falha 9b: antes de 10 dias'; end if;
  -- 10. +20 dias: 3ª e última para L3/L4; +30 e +40 dias: nunca uma 4ª
  r := public.wa_remarketing_run((select a from fx), (select base from fx) + interval '20 days', 20);
  if (select count(*) from public.wa_remarketing_sends s, ld where s.lead_id in (ld.l3, ld.l4) and s.attempt = 3 and s.template_name = 'remarketing_ultima') <> 2 then raise exception 'Falha 10a: %', r; end if;
  perform public.wa_remarketing_run((select a from fx), (select base from fx) + interval '30 days', 20);
  perform public.wa_remarketing_run((select a from fx), (select base from fx) + interval '40 days', 20);
  if exists (select 1 from public.wa_remarketing_sends s, ld where s.lead_id in (ld.l3, ld.l4) group by s.lead_id having count(*) > 3) then raise exception 'Falha 10b: passou de 3'; end if;
  if exists (select 1 from public.wa_remarketing_sends s, ld where s.lead_id = ld.l2 and s.created_at > (select base from fx)) then raise exception 'Falha 10c: mandou para quem saiu'; end if;
end $$;

-- 11. Limite diário (empresa B: 1 por número por dia), distribuição ao longo do dia e modelo não aprovado
create temp table ldb as select
  pg_temp.lead((select b from fx), 'Ana', '5594980000001', 'Novo Lead', 'Equipe', (select base from fx) - interval '40 days') b1,
  pg_temp.lead((select b from fx), 'Bia', '5594980000002', 'Novo Lead', 'Equipe', (select base from fx) - interval '40 days') b2,
  pg_temp.lead((select b from fx), 'Caio', '5594980000003', 'Novo Lead', 'Equipe', (select base from fx) - interval '40 days') b3;
do $$ declare r jsonb; begin
  r := public.wa_remarketing_run((select b from fx), (select base from fx), 20);
  if (r->>'queued')::int <> 1 then raise exception 'Falha 11a: limite diário %', r; end if;
  if (public.wa_remarketing_run((select b from fx), (select base from fx) + interval '1 hour' - interval '1 hour', 20))->>'queued' <> '0' then raise exception 'Falha 11b'; end if;
  -- Dia seguinte às 09:00: cota começa pequena (distribui ao longo do horário) — limite 9 → 1 na primeira hora
  update public.crm_companies set settings = jsonb_set(settings, '{remarketing,daily_limit}', '9') where id = (select b from fx);
  r := public.wa_remarketing_run((select b from fx), (select base from fx) + interval '1 day' - interval '8 hours 59 minutes', 20);
  if (r->>'queued')::int <> 1 or (r->>'quota')::int <> 1 then raise exception 'Falha 11c: distribuição %', r; end if;
  -- Sem o modelo da tentativa 2 aprovado: o lead espera (nada sai)
  r := public.wa_remarketing_run((select b from fx), (select base from fx) + interval '10 days', 20);
  if exists (select 1 from public.wa_remarketing_sends where company_id = (select b from fx) and attempt = 2) then raise exception 'Falha 11d: modelo não aprovado'; end if;
end $$;

-- 12. Relatório diário traz o remarketing do dia (só de quem usa)
do $$ declare d jsonb; begin
  d := public.wa_daily_report_claim((select a from fx), ((select base from fx) at time zone 'America/Sao_Paulo')::date);
  if (d->'remarketing'->>'enviados')::int <> 4 or (d->'remarketing'->>'responderam')::int <> 1 then raise exception 'Falha 12a: %', d; end if;
  update public.crm_companies set settings = settings - 'remarketing' where id = (select b from fx);
  d := public.wa_daily_report_claim((select b from fx), ((select base from fx) at time zone 'America/Sao_Paulo')::date);
  if d ? 'remarketing' then raise exception 'Falha 12b: empresa sem remarketing'; end if;
  if (public.wa_remarketing_run((select b from fx), (select base from fx) + interval '20 days', 20))->>'skipped' <> 'desligado' then raise exception 'Falha 12c'; end if;
end $$;

-- 13. Painel: usuário vê só a própria empresa; não chama a rodada
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-0000000a5f01","role":"authenticated"}',true);
do $$ declare s jsonb; begin
  s := public.crm_remarketing_summary();
  if (s->>'optouts')::int < 1 or s->>'fila' is null then raise exception 'Falha 13a: %', s; end if;
  if exists (select 1 from public.wa_remarketing_sends where company_id <> (select a from fx)) then raise exception 'Falha 13b: viu outra empresa'; end if;
  if (select count(*) from public.wa_remarketing_sends) = 0 then raise exception 'Falha 13c: não vê os próprios'; end if;
  begin perform public.wa_remarketing_run((select a from fx), now(), 1); raise exception 'Falha 13d'; exception when insufficient_privilege then null; end;
  begin insert into public.wa_remarketing_sends (company_id, lead_id, attempt, template_name, day) values ((select a from fx), (select l1 from ld), 1, 'x', current_date);
        raise exception 'Falha 13e'; exception when insufficient_privilege then null; end;
end $$;
reset role;

create temp table resultado_teste as select 'remarketing: todos os testes passaram'::text as resultado;
select * from resultado_teste;
rollback;

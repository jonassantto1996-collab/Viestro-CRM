-- =====================================================================
-- Viestro CRM · Remarketing automático por modelos de marketing do WhatsApp
-- ---------------------------------------------------------------------
-- Decisão do dono (Regtech): vai para todos os leads que ficaram N dias (10) sem responder, de qualquer
-- temperatura, menos Ganho e quem pediu para sair. Substitui, só para este envio, a exigência de
-- consentimento de marketing; SAIR/PARAR continua obrigatório (opt-out nunca recebe).
--
-- 1. settings.remarketing (desligado por padrão): enabled, days (10), max_attempts (3), daily_limit (50 por
--    número), send_days (seg-sab), start (09:00), end (18:00), templates (um por tentativa).
-- 2. wa_remarketing_sends: um registro por envio (lead, número, modelo, tentativa, resultado). No máximo um
--    por lead por dia (índice único) e o worker roda com trava por empresa: rodar duas vezes não duplica.
-- 3. wa_remarketing_run (service_role): escolhe quem recebe, por qual número (conversa → dono do responsável →
--    revezamento), respeita horário, limite diário distribuído ao longo do dia e modelo APPROVED; põe na fila.
-- 4. Gatilho nas mensagens recebidas: SAIR/PARAR/STOP/"não quero mais" marca opt-out no contato e no lead,
--    registra no histórico e responde uma confirmação (empresas com remarketing ligado); qualquer outra
--    resposta registra "Respondeu ao remarketing (tentativa N)" e o agente segue atendendo normalmente.
-- 5. crm_remarketing_summary (usuário logado, da própria empresa): números do painel e tamanho da fila.
-- 6. Relatório diário ganha os números do remarketing do dia.
-- Nenhum dado existente é apagado ou alterado por esta migration.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Auxiliares
-- ---------------------------------------------------------------------
-- Número brasileiro com e sem o 9 (o WhatsApp às vezes registra sem; a planilha importada tem com).
create function crm_private.br_variantes(p text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p ~ '^55[0-9]{2}9[0-9]{8}$' then array[p, substr(p, 1, 4) || substr(p, 6)]
    when p ~ '^55[0-9]{2}[0-9]{8}$' then array[p, substr(p, 1, 4) || '9' || substr(p, 5)]
    else array[p] end
$$;

-- Data em texto vinda do JSON do lead; texto inválido vira null (nunca derruba a consulta).
create function crm_private.ts_ou_nulo(p text) returns timestamptz
language plpgsql immutable set search_path = '' as $$
begin
  return p::timestamptz;
exception when others then
  return null;
end $$;

-- Primeiro nome para o modelo ("Oi, {{1}}!"): só letras, 2 a 20; emoji, número ou vazio viram "tudo bem" ("Oi, tudo bem!").
create function crm_private.primeiro_nome(p text) returns text
language sql immutable set search_path = '' as $$
  select case when w ~ '^[A-Za-zÀ-ÖØ-öø-ÿ]{2,20}$' then upper(left(w, 1)) || lower(substr(w, 2)) else 'tudo bem' end
  from (select split_part(regexp_replace(trim(coalesce(p, '')), '[[:space:]]+', ' ', 'g'), ' ', 1) w) x
$$;

-- Mensagem de descadastro: SAIR, PARAR, STOP, CANCELAR, DESCADASTRAR, "não quero mais (receber)".
create function crm_private.pediu_para_sair(p text) returns boolean
language sql immutable set search_path = '' as $$
  select trim(regexp_replace(translate(upper(coalesce(p, '')), 'ÃÁÀÂÄÉÊÈËÍÎÌÏÓÔÕÒÖÚÛÙÜÇ', 'AAAAAEEEEIIIIOOOOOUUUUC'), '[^A-Z ]', ' ', 'g'))
         ~ '^(SAIR|PARAR|PARE|STOP|CANCELAR|DESCADASTRAR|NAO QUERO MAIS|NAO QUERO MAIS RECEBER|NAO QUERO RECEBER|NAO QUERO MAIS MENSAGENS?)$'
$$;

-- Configuração normalizada (padrões do pedido; valores fora da faixa voltam ao padrão).
create function crm_private.wa_remarketing_cfg(s jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'enabled', coalesce(r->>'enabled', 'false') = 'true',
    'days', case when jsonb_typeof(r->'days') = 'number' and (r->>'days')::numeric between 1 and 90 then (r->>'days')::int else 10 end,
    'max_attempts', case when jsonb_typeof(r->'max_attempts') = 'number' and (r->>'max_attempts')::numeric between 1 and 3 then (r->>'max_attempts')::int else 3 end,
    'daily_limit', case when jsonb_typeof(r->'daily_limit') = 'number' and (r->>'daily_limit')::numeric between 1 and 1000 then (r->>'daily_limit')::int else 50 end,
    'send_days', case when r->>'send_days' in ('seg-sex', 'seg-sab') then r->>'send_days' else 'seg-sab' end,
    'start', case when coalesce(r->>'start', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then r->>'start' else '09:00' end,
    'end', case when coalesce(r->>'end', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then r->>'end' else '18:00' end,
    'templates', case when jsonb_typeof(r->'templates') = 'array' and jsonb_array_length(r->'templates') between 1 and 3
                      then r->'templates' else '["remarketing_parcela","remarketing_economia","remarketing_ultima"]'::jsonb end)
  from (select coalesce(s->'remarketing', '{}'::jsonb) r) x
$$;

-- ---------------------------------------------------------------------
-- Registro dos envios
-- ---------------------------------------------------------------------
create table public.wa_remarketing_sends (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.crm_companies(id) on delete cascade,
  lead_id         uuid not null references public.crm_records(id) on delete cascade,
  contact_id      uuid references public.wa_contacts(id) on delete set null,
  conversation_id uuid references public.wa_conversations(id) on delete set null,
  account_id      uuid references public.wa_accounts(id) on delete set null,
  message_id      uuid references public.wa_messages(id) on delete set null,
  attempt         integer not null check (attempt between 1 and 3),
  template_name   text not null check (template_name ~ '^[a-z0-9_]+$' and length(template_name) <= 512),
  day             date not null,
  outcome         text check (outcome in ('responded', 'opt_out')),
  responded_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (lead_id, day)
);
create index wa_remarketing_sends_company_idx on public.wa_remarketing_sends (company_id, created_at desc);
create index wa_remarketing_sends_lead_idx on public.wa_remarketing_sends (lead_id, created_at desc);
create index wa_remarketing_sends_contact_idx on public.wa_remarketing_sends (contact_id, created_at desc) where outcome is null;
create index wa_remarketing_sends_account_day_idx on public.wa_remarketing_sends (account_id, day);
alter table public.wa_remarketing_sends enable row level security;
revoke all on public.wa_remarketing_sends from anon, authenticated;
grant select, insert, update, delete on public.wa_remarketing_sends to service_role;
grant select on public.wa_remarketing_sends to authenticated;
create policy wa_remarketing_sends_read on public.wa_remarketing_sends for select to authenticated
  using (company_id = (select crm_private.company()));

-- ---------------------------------------------------------------------
-- Quem pode receber agora (sem olhar horário nem limite): leads com telefone, fora de Ganho, sem opt-out,
-- N dias sem mensagem do cliente (ou desde a criação, se nunca conversou), N dias desde o último envio
-- e menos de max_attempts envios desde a última resposta. Número de atendente nunca recebe.
-- ---------------------------------------------------------------------
create function crm_private.wa_remarketing_elegiveis(p_company uuid, p_now timestamptz)
returns table (lead_id uuid, lead_name text, owner text, wa_id text, contact_id uuid, conversation_id uuid,
               conv_account_id uuid, attempt int, last_contact_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with co as (select settings s, crm_private.wa_remarketing_cfg(settings) c from public.crm_companies where id = p_company),
  atend as (
    select coalesce(array_agg(regexp_replace(x.v, '\D', '', 'g')), '{}'::text[]) tels
    from co, jsonb_each_text(case when jsonb_typeof(co.s->'agent'->'attendant_phones') = 'object' then co.s->'agent'->'attendant_phones' else '{}'::jsonb end) x(k, v)
  ),
  l as (
    select r.id, r.data, r.created_at, regexp_replace(coalesce(r.data->>'phone', ''), '\D', '', 'g') fone
    from public.crm_records r
    where r.company_id = p_company and r.kind = 'leads'
      and coalesce(r.data->>'stage', '') <> 'Ganho'
      and coalesce(r.data->>'marketing_opt_out', 'false') <> 'true'
  )
  select l.id, l.data->>'name', l.data->>'owner', coalesce(k.wa, l.fone), k.principal, cv.id, cv.account_id,
         (coalesce(env.desde, 0) + 1)::int,
         coalesce(li.t, crm_private.ts_ou_nulo(l.data->>'created'), l.created_at)
  from l
  cross join co cross join atend
  left join lateral (
    select array_agg(k.id) ids, bool_or(k.marketing_opt_out_at is not null) saiu,
           (array_agg(k.id order by (k.crm_lead_id = l.id) desc, k.created_at))[1] principal,
           (array_agg(k.wa_id order by (k.crm_lead_id = l.id) desc, k.created_at))[1] wa
    from public.wa_contacts k
    where k.company_id = p_company and (k.crm_lead_id = l.id or (l.fone <> '' and k.wa_id = any(crm_private.br_variantes(l.fone))))
  ) k on true
  left join lateral (
    select max(coalesce(m.provider_timestamp, m.created_at)) t
    from public.wa_messages m join public.wa_conversations c on c.id = m.conversation_id
    where m.company_id = p_company and m.direction = 'inbound' and c.contact_id = any(coalesce(k.ids, '{}'::uuid[]))
  ) li on true
  left join lateral (
    select c.id, c.account_id from public.wa_conversations c
    where c.company_id = p_company and c.contact_id = any(coalesce(k.ids, '{}'::uuid[]))
    order by c.last_message_at desc nulls last limit 1
  ) cv on true
  left join lateral (
    select count(*) filter (where s.created_at > coalesce(li.t, '-infinity'::timestamptz)) desde, max(s.created_at) ultimo
    from public.wa_remarketing_sends s where s.lead_id = l.id
  ) env on true
  where coalesce(k.wa, l.fone) ~ '^[1-9][0-9]{9,14}$'
    and not coalesce(k.saiu, false)
    and not (coalesce(k.wa, l.fone) = any(atend.tels)) and not (l.fone <> '' and l.fone = any(atend.tels))
    and coalesce(li.t, crm_private.ts_ou_nulo(l.data->>'created'), l.created_at) <= p_now - make_interval(days => (co.c->>'days')::int)
    and (env.ultimo is null or env.ultimo <= p_now - make_interval(days => (co.c->>'days')::int))
    and coalesce(env.desde, 0) < least((co.c->>'max_attempts')::int, jsonb_array_length(co.c->'templates'))
$$;

-- ---------------------------------------------------------------------
-- Rodada do remarketing de uma empresa (worker, a cada minuto). Devolve o que foi para a fila.
-- p_max: no máximo isto por rodada (espalha os envios ao longo do dia junto com a cota por hora).
-- ---------------------------------------------------------------------
create function public.wa_remarketing_run(p_company uuid, p_now timestamptz default now(), p_max int default 4)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_settings jsonb; v_cfg jsonb; v_local timestamp; v_dia date; v_ini time; v_fim time; v_total numeric; v_passou numeric;
  v_cota int; v_limite int; v_contas uuid[]; e record; v_acc uuid; v_fixo boolean; v_tpl text; t public.wa_templates%rowtype;
  v_contact uuid; v_conv uuid; v_nome text; v_body text; v_payload jsonb; v_send uuid; v_msg uuid; v_feitos int := 0;
  v_itens jsonb := '[]'::jsonb; v_dono_tel text; n int;
begin
  select settings into v_settings from public.crm_companies where id = p_company;
  if v_settings is null then return jsonb_build_object('queued', 0, 'skipped', 'empresa'); end if;
  v_cfg := crm_private.wa_remarketing_cfg(v_settings);
  if not (v_cfg->>'enabled')::boolean then return jsonb_build_object('queued', 0, 'skipped', 'desligado'); end if;

  -- Horário de envio (Brasília)
  v_local := p_now at time zone 'America/Sao_Paulo';
  v_dia := v_local::date;
  v_ini := (v_cfg->>'start')::time; v_fim := (v_cfg->>'end')::time;
  if extract(isodow from v_local) > (case when v_cfg->>'send_days' = 'seg-sex' then 5 else 6 end)
     or v_local::time < v_ini or v_local::time >= v_fim or v_fim <= v_ini then
    return jsonb_build_object('queued', 0, 'skipped', 'fora_do_horario');
  end if;

  -- Uma rodada por empresa de cada vez (worker rodando duas vezes não duplica)
  perform pg_advisory_xact_lock(hashtextextended('remarketing:' || p_company::text, 0));

  -- Cota até agora: o limite diário vai liberando ao longo do horário (não sai tudo às 9h)
  v_limite := (v_cfg->>'daily_limit')::int;
  v_total := extract(epoch from (v_fim - v_ini)) / 60;
  v_passou := extract(epoch from (v_local::time - v_ini)) / 60 + 1;
  v_cota := least(v_limite, greatest(1, ceil(v_limite * v_passou / v_total)::int));

  select coalesce(array_agg(a.id order by a.phone_e164), '{}') into v_contas
  from public.wa_accounts a join public.crm_channels c on c.id = a.crm_channel_id
  where a.company_id = p_company and a.connection_status = 'connected' and c.enabled;
  if cardinality(v_contas) = 0 then return jsonb_build_object('queued', 0, 'skipped', 'sem_numero'); end if;

  for e in select * from crm_private.wa_remarketing_elegiveis(p_company, p_now) x order by x.last_contact_at desc, x.lead_id loop
    exit when v_feitos >= greatest(1, least(coalesce(p_max, 4), 20));
    v_tpl := v_cfg->'templates'->>(e.attempt - 1);
    v_acc := null; v_fixo := false;

    -- 1º: número da última conversa do lead
    if e.conv_account_id is not null and e.conv_account_id = any(v_contas) then
      v_acc := e.conv_account_id; v_fixo := true;
    else
      -- 2º: número de quem é o responsável pelo lead (ex.: Agna → 6088, Cleudo → 1715)
      select x.key into v_dono_tel from jsonb_each_text(case when jsonb_typeof(v_settings->'agent'->'number_owners') = 'object'
                                                            then v_settings->'agent'->'number_owners' else '{}'::jsonb end) x
       where x.value = e.owner limit 1;
      if v_dono_tel is not null then
        select a.id into v_acc from public.wa_accounts a where a.id = any(v_contas) and ltrim(a.phone_e164, '+') = v_dono_tel;
        v_fixo := v_acc is not null;
      end if;
    end if;

    if v_fixo then
      -- Número definido: precisa do modelo aprovado e de cota hoje; senão o lead espera.
      select * into t from public.wa_templates where account_id = v_acc and name = v_tpl and status = 'APPROVED' order by (language = 'pt_BR') desc limit 1;
      if not found then continue; end if;
      select count(*) into n from public.wa_remarketing_sends where account_id = v_acc and day = v_dia;
      if n >= v_cota then continue; end if;
    else
      -- 3º: sem conversa e sem dono: reveza entre os números (o que enviou menos hoje), com modelo aprovado e cota.
      select a.id into v_acc
      from unnest(v_contas) with ordinality a(id, ord)
      where exists (select 1 from public.wa_templates tt where tt.account_id = a.id and tt.name = v_tpl and tt.status = 'APPROVED')
        and (select count(*) from public.wa_remarketing_sends s where s.account_id = a.id and s.day = v_dia) < v_cota
      order by (select count(*) from public.wa_remarketing_sends s where s.account_id = a.id and s.day = v_dia), a.ord
      limit 1;
      if v_acc is null then continue; end if;
      select * into t from public.wa_templates where account_id = v_acc and name = v_tpl and status = 'APPROVED' order by (language = 'pt_BR') desc limit 1;
    end if;

    -- Contato e conversa no número escolhido (cria se o lead nunca conversou por ele)
    v_contact := e.contact_id;
    if v_contact is null then
      v_contact := crm_private.wa_contact(p_company, e.wa_id, e.lead_name);
    end if;
    update public.wa_contacts set crm_lead_id = e.lead_id where id = v_contact and crm_lead_id is null;
    if exists (select 1 from public.wa_contacts where id = v_contact and marketing_opt_out_at is not null) then continue; end if;
    v_conv := crm_private.wa_conversation(p_company, v_acc, v_contact);

    -- Registro primeiro: um envio por lead por dia (índice único)
    insert into public.wa_remarketing_sends (company_id, lead_id, contact_id, conversation_id, account_id, attempt, template_name, day, created_at)
    values (p_company, e.lead_id, v_contact, v_conv, v_acc, e.attempt, t.name, v_dia, p_now)
    on conflict (lead_id, day) do nothing
    returning id into v_send;
    if v_send is null then continue; end if;

    v_nome := crm_private.primeiro_nome(coalesce(nullif(trim(e.lead_name), ''), (select name from public.wa_contacts where id = v_contact)));
    select x->>'text' into v_body from jsonb_array_elements(t.components) x where upper(x->>'type') = 'BODY' limit 1;
    v_body := replace(coalesce(v_body, '[Modelo ' || t.name || ']'), '{{1}}', v_nome);
    v_payload := jsonb_build_object('template', jsonb_build_object('name', t.name, 'language', jsonb_build_object('code', t.language),
      'components', jsonb_build_array(jsonb_build_object('type', 'body', 'parameters', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_nome))))));

    insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, template_name, message_status)
    values (p_company, v_conv, 'outbound', 'agent', 'template', left(v_body, 6000), t.name, 'queued')
    returning id into v_msg;
    insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key, requested_by, message_id)
    values (p_company, v_conv, 'template', v_payload, 'remarketing:' || v_send, null, v_msg);
    update public.wa_remarketing_sends set message_id = v_msg where id = v_send;
    update public.wa_conversations set last_outbound_at = now(), last_message_at = now(), last_message_preview = left(v_body, 160)
     where id = v_conv;
    insert into public.crm_records (company_id, kind, data)
    values (p_company, 'activity', jsonb_build_object('text', 'Remarketing enviado (tentativa ' || e.attempt || ', modelo ' || t.name || ')',
      'leadId', e.lead_id, 'created', now()));
    insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (p_company, null, 'system', 'remarketing.send', 'lead', e.lead_id, jsonb_build_object('attempt', e.attempt, 'template', t.name));

    v_feitos := v_feitos + 1;
    v_itens := v_itens || jsonb_build_object('lead', e.lead_id, 'account', v_acc, 'attempt', e.attempt, 'template', t.name);
  end loop;
  return jsonb_build_object('queued', v_feitos, 'items', v_itens, 'quota', v_cota);
end $$;

-- ---------------------------------------------------------------------
-- Mensagem recebida: descadastro ou resposta ao remarketing
-- ---------------------------------------------------------------------
create function crm_private.wa_remarketing_inbound() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_contact uuid; v_lead uuid; v_wa text; s public.wa_remarketing_sends%rowtype; v_ts timestamptz; v_settings jsonb;
  v_msg uuid; v_texto text := 'Pronto! Você não vai mais receber nossas mensagens de ofertas. Se precisar de algo, é só chamar aqui. 🙂';
begin
  if new.direction <> 'inbound' or new.source <> 'api_inbound' then return new; end if;
  begin
    v_ts := coalesce(new.provider_timestamp, new.created_at);
    select c.contact_id, k.crm_lead_id, k.wa_id into v_contact, v_lead, v_wa
      from public.wa_conversations c join public.wa_contacts k on k.id = c.contact_id where c.id = new.conversation_id;
    select * into s from public.wa_remarketing_sends x
     where x.company_id = new.company_id and x.outcome is null and x.created_at <= v_ts and x.created_at > v_ts - interval '30 days'
       and (x.contact_id = v_contact or (v_lead is not null and x.lead_id = v_lead))
     order by x.created_at desc limit 1;

    if crm_private.pediu_para_sair(new.body) then
      -- Opt-out vale para sempre: contato, lead(s) do mesmo telefone e histórico.
      update public.wa_contacts set marketing_opt_out_at = coalesce(marketing_opt_out_at, v_ts) where id = v_contact;
      -- As palavras antigas (SAIR, PARAR, STOP, CANCELAR, DESCADASTRAR) já gravam o consentimento revogado no processamento.
      if upper(trim(coalesce(new.body, ''))) not in ('SAIR','PARAR','STOP','CANCELAR','DESCADASTRAR') then
        insert into public.wa_consents (company_id, contact_id, purpose, status, source, evidence, revoked_at)
        values (new.company_id, v_contact, 'marketing', 'revoked', 'whatsapp_inbound', 'Pediu para não receber mais mensagens', v_ts);
      end if;
      update public.crm_records set data = data || jsonb_build_object('marketing_opt_out', true, 'marketing_opt_out_at', v_ts, 'updated', now()),
             updated_at = now()
       where company_id = new.company_id and kind = 'leads' and coalesce(data->>'marketing_opt_out', 'false') <> 'true'
         and (id = v_lead or id = s.lead_id or regexp_replace(coalesce(data->>'phone', ''), '\D', '', 'g') = any(crm_private.br_variantes(v_wa)));
      insert into public.crm_records (company_id, kind, data)
      select new.company_id, 'activity', jsonb_build_object('text', 'Pediu para não receber mais mensagens (opt-out de marketing)',
             'leadId', coalesce(v_lead, s.lead_id), 'created', now())
       where coalesce(v_lead, s.lead_id) is not null;
      if s.id is not null then
        update public.wa_remarketing_sends set outcome = 'opt_out', responded_at = v_ts where id = s.id;
      end if;
      -- Confirmação curta (empresas com remarketing ligado). O agente não responde por cima: a saída fica depois da entrada.
      select settings into v_settings from public.crm_companies where id = new.company_id;
      if (crm_private.wa_remarketing_cfg(v_settings)->>'enabled')::boolean then
        insert into public.wa_messages (company_id, conversation_id, direction, source, message_type, body, message_status)
        values (new.company_id, new.conversation_id, 'outbound', 'agent', 'text', v_texto, 'queued')
        returning id into v_msg;
        insert into public.wa_outbox (company_id, conversation_id, kind, payload, idempotency_key, requested_by, message_id)
        values (new.company_id, new.conversation_id, 'text', jsonb_build_object('text', v_texto), 'optout:' || new.id, null, v_msg)
        on conflict (company_id, idempotency_key) do nothing;
        update public.wa_conversations set last_outbound_at = greatest(now(), v_ts + interval '1 second'), last_message_at = now(),
               last_message_preview = left(v_texto, 160)
         where id = new.conversation_id;
      end if;
      insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id)
      values (new.company_id, null, 'system', 'remarketing.opt_out', 'conversation', new.conversation_id);
    elsif s.id is not null then
      -- Respondeu: sai do ciclo (a contagem dos N dias recomeça desta mensagem) e o agente atende normalmente.
      update public.wa_remarketing_sends set outcome = 'responded', responded_at = v_ts where id = s.id;
      insert into public.crm_records (company_id, kind, data)
      values (new.company_id, 'activity', jsonb_build_object('text', 'Respondeu ao remarketing (tentativa ' || s.attempt || ')',
              'leadId', s.lead_id, 'created', now()));
    end if;
  exception when others then
    -- Nunca derruba o recebimento da mensagem.
    raise warning 'remarketing: mensagem recebida não processada (%)', sqlstate;
  end;
  return new;
end $$;

create trigger wa_messages_remarketing after insert on public.wa_messages
  for each row when (new.direction = 'inbound' and new.source = 'api_inbound')
  execute function crm_private.wa_remarketing_inbound();

-- ---------------------------------------------------------------------
-- Painel (usuário logado, só a própria empresa)
-- ---------------------------------------------------------------------
create function crm_private.remarketing_resumo() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid := crm_private.company(); v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; r jsonb;
begin
  if v_company is null then raise exception 'Faça login'; end if;
  select jsonb_build_object(
    'hoje', count(*) filter (where day = v_hoje),
    'semana', count(*) filter (where day > v_hoje - 7),
    'mes', count(*) filter (where day > v_hoje - 30),
    'respostas', count(*) filter (where outcome = 'responded' and day > v_hoje - 30),
    'optouts', count(*) filter (where outcome = 'opt_out' and day > v_hoje - 30))
  into r from public.wa_remarketing_sends where company_id = v_company and day > v_hoje - 30;
  return r || jsonb_build_object(
    'fila', (select count(*) from crm_private.wa_remarketing_elegiveis(v_company, now())),
    'optouts_total', (select count(*) from public.wa_contacts where company_id = v_company and marketing_opt_out_at is not null));
end $$;
create function public.crm_remarketing_summary() returns jsonb
language sql security invoker set search_path = '' as $$ select crm_private.remarketing_resumo() $$;

-- ---------------------------------------------------------------------
-- Relatório diário: + remarketing do dia (só quando a empresa usa)
-- ---------------------------------------------------------------------
create or replace function public.wa_daily_report_claim(p_company uuid, p_day date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ok boolean; v_novas int; v_quentes int; v_abertas int; v_passagens jsonb; v_rmk jsonb;
begin
  insert into public.wa_daily_reports as r (company_id, day, status) values (p_company, p_day, 'running')
  on conflict (company_id, day) do update set status = 'running', attempts = r.attempts + 1
   where (r.status = 'failed' and r.attempts < 3) or (r.status = 'running' and r.updated_at < now() - interval '10 minutes')
  returning true into v_ok;
  if v_ok is null then return null; end if;

  select count(*) into v_novas from public.wa_conversations
   where company_id = p_company and (first_inbound_at at time zone 'America/Sao_Paulo')::date = p_day;
  select count(*) filter (where data->>'hot' = 'true'
           and (coalesce((data->>'hot_at')::timestamptz, created_at) at time zone 'America/Sao_Paulo')::date = p_day),
         count(*) filter (where coalesce(data->>'done', 'false') <> 'true')
    into v_quentes, v_abertas
    from public.crm_records where company_id = p_company and kind = 'tasks' and data->>'source' = 'agent_handoff';
  select coalesce(jsonb_object_agg(dono, n), '{}'::jsonb) into v_passagens from (
    select left(coalesce(data->>'owner', 'Equipe'), 40) dono, count(*) n from public.crm_records
     where company_id = p_company and kind = 'tasks' and data->>'source' = 'agent_handoff'
       and (created_at at time zone 'America/Sao_Paulo')::date = p_day
     group by 1) x;
  if (select (crm_private.wa_remarketing_cfg(settings)->>'enabled')::boolean from public.crm_companies where id = p_company) then
    select jsonb_build_object('enviados', (select count(*) from public.wa_remarketing_sends where company_id = p_company and day = p_day),
                              'responderam', (select count(*) from public.wa_remarketing_sends where company_id = p_company and outcome = 'responded'
                                                and (responded_at at time zone 'America/Sao_Paulo')::date = p_day))
      into v_rmk;
  end if;
  return jsonb_build_object('novas', v_novas, 'quentes', v_quentes, 'abertas', v_abertas, 'passagens', v_passagens)
         || case when v_rmk is not null then jsonb_build_object('remarketing', v_rmk) else '{}'::jsonb end;
end $$;

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------
revoke all on function crm_private.br_variantes(text), crm_private.ts_ou_nulo(text), crm_private.primeiro_nome(text),
  crm_private.pediu_para_sair(text), crm_private.wa_remarketing_cfg(jsonb), crm_private.wa_remarketing_elegiveis(uuid, timestamptz),
  crm_private.wa_remarketing_inbound(), crm_private.remarketing_resumo(),
  public.wa_remarketing_run(uuid, timestamptz, int), public.crm_remarketing_summary(), public.wa_daily_report_claim(uuid, date)
  from public, anon, authenticated;
grant execute on function public.wa_remarketing_run(uuid, timestamptz, int), public.wa_daily_report_claim(uuid, date) to service_role;
grant execute on function crm_private.remarketing_resumo(), public.crm_remarketing_summary() to authenticated;

-- =====================================================================
-- Viestro CRM — Cliente com telefone oculto, anúncio Clique para WhatsApp, contato com/sem o 9 e
-- remarketing que não gasta tentativa quando o número da loja está com problema de pagamento.
--
-- 1. Telefone oculto (usernames da Meta): quando o cliente esconde o número, a Meta manda só o BSUID
--    (ex.: "BR.13491208655302741918"). O contato passa a ser gravado com o BSUID em wa_id (phone_e164 fica
--    vazio) e as respostas saem para o BSUID. Se depois vier o telefone, o mesmo contato ganha o telefone.
-- 2. Anúncio (referral): a 1ª mensagem depois do clique traz o anúncio. A conversa guarda o anúncio
--    (ad_referral) e o lead vira "Anúncio Meta" com o nome e o id do anúncio. Lead que já existia de
--    outra origem (Cowboy, importado...) mantém a origem e ganha o anúncio e uma atividade.
--    O lead é criado mesmo com o lead automático desligado: clique em anúncio é lead.
-- 3. Contato com e sem o 9: o remarketing manda para o número com o 9 e o cliente responde de um número
--    sem o 9 (ou o contrário); antes virava outro contato e outra conversa. Agora a resposta cai no mesmo
--    contato (e na mesma conversa).
-- 4. Remarketing: número com erro de pagamento/conta na Meta (131042, 131031) para de receber envios até
--    voltar a entregar, e essas falhas não contam como tentativa do lead.
--
-- Aplicar ANTES do deploy (o agente lê wa_conversations.ad_referral).
-- Testes: tests/contato_oculto_anuncio.sql (transação com rollback).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Contatos: wa_id aceita telefone OU BSUID; phone_e164 só para telefone.
-- ---------------------------------------------------------------------
create function crm_private.wa_bsuid_valido(p text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p ~ '^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]+$' and length(p) <= 140, false)
$$;

alter table public.wa_contacts drop constraint wa_contacts_wa_id_check;
alter table public.wa_contacts add constraint wa_contacts_wa_id_check
  check (wa_id ~ '^[0-9]{8,15}$' or (wa_id ~ '^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]+$' and length(wa_id) <= 140));

-- Coluna gerada: recriada (Postgres 16 não troca a expressão; o 17 troca, mas o resultado é o mesmo).
alter table public.wa_contacts drop column phone_e164;
alter table public.wa_contacts add column phone_e164 text
  generated always as (case when wa_id ~ '^[0-9]{8,15}$' then '+' || wa_id end) stored;

-- BSUID guardado também em contato que tem telefone (o mesmo cliente pode aparecer só com o BSUID depois).
alter table public.wa_contacts add column bsuid text
  check (bsuid is null or (bsuid ~ '^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]+$' and length(bsuid) <= 140));
create unique index wa_contacts_bsuid_key on public.wa_contacts (company_id, bsuid) where bsuid is not null;

-- Anúncio de onde veio a conversa (só os campos úteis; o webhook já limita o tamanho).
alter table public.wa_conversations add column ad_referral jsonb
  check (ad_referral is null or (jsonb_typeof(ad_referral) = 'object' and pg_column_size(ad_referral) <= 4000));

-- ---------------------------------------------------------------------
-- 2. Achar ou criar o contato: telefone (com ou sem o 9) e/ou BSUID.
-- ---------------------------------------------------------------------
create or replace function crm_private.wa_contact(p_company uuid, p_wa_id text, p_name text, p_bsuid text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_wa text; v_book text; v_cur text;
  v_fone text := case when p_wa_id ~ '^[0-9]{8,15}$' then p_wa_id end;
  v_bsuid text := case when crm_private.wa_bsuid_valido(p_bsuid) then p_bsuid
                       when crm_private.wa_bsuid_valido(p_wa_id) then p_wa_id end;
  v_name text := nullif(left(trim(coalesce(p_name,'')),120),'');
begin
  if v_fone is null and v_bsuid is null then raise exception 'Contato sem telefone e sem ID'; end if;
  -- Uma busca por vez por cliente (duas mensagens juntas não criam dois contatos)
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || 'wa_contact:' || coalesce(v_bsuid, v_fone), 0));
  if v_fone is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_company::text || 'wa_contact:' || right(v_fone, 8), 0));
  end if;

  -- 1º telefone exato; 2º o mesmo telefone com/sem o 9; 3º o BSUID.
  if v_fone is not null then
    select id, wa_id into v_id, v_wa from public.wa_contacts where company_id = p_company and wa_id = v_fone;
    if v_id is null then
      select id, wa_id into v_id, v_wa from public.wa_contacts
       where company_id = p_company and wa_id = any(crm_private.br_variantes(v_fone)) and wa_id <> v_fone
       order by created_at limit 1;
    end if;
  end if;
  if v_id is null and v_bsuid is not null then
    select id, wa_id into v_id, v_wa from public.wa_contacts
     where company_id = p_company and (bsuid = v_bsuid or wa_id = v_bsuid) order by (wa_id ~ '^[0-9]') desc limit 1;
    -- Era só BSUID e agora veio o telefone: o contato ganha o telefone (as respostas passam a ir para ele).
    if v_id is not null and v_fone is not null and v_wa !~ '^[0-9]{8,15}$' then
      update public.wa_contacts set wa_id = v_fone where id = v_id;
      v_wa := v_fone;
    end if;
  end if;

  select name into v_book from public.wa_address_book where company_id = p_company and wa_id = coalesce(v_wa, v_fone, '');
  v_name := coalesce(v_book, v_name);

  if v_id is null then
    insert into public.wa_contacts (company_id, wa_id, name, bsuid)
    values (p_company, coalesce(v_fone, v_bsuid), v_name, v_bsuid)
    on conflict (company_id, wa_id) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.wa_contacts where company_id = p_company and wa_id = coalesce(v_fone, v_bsuid);
    end if;
    return v_id;
  end if;

  if v_name is not null then
    update public.wa_contacts set name = v_name where id = v_id and name is null;
  end if;
  if v_bsuid is not null then
    select bsuid into v_cur from public.wa_contacts where id = v_id;
    if v_cur is null and not exists (select 1 from public.wa_contacts where company_id = p_company and bsuid = v_bsuid) then
      update public.wa_contacts set bsuid = v_bsuid where id = v_id;
    end if;
  end if;
  return v_id;
end $$;

-- Assinatura antiga (remarketing, telas): mesma regra, sem BSUID separado.
create or replace function crm_private.wa_contact(p_company uuid, p_wa_id text, p_name text)
returns uuid
language sql security definer set search_path = '' as $$
  select crm_private.wa_contact(p_company, p_wa_id, p_name, null)
$$;

revoke all on function crm_private.wa_contact(uuid, text, text, text), crm_private.wa_bsuid_valido(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Lead do contato: chave do BSUID quando não há telefone (lead sem telefone).
-- ---------------------------------------------------------------------
create or replace function crm_private.wa_link_lead(p_company uuid, p_contact uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.wa_contacts%rowtype; s jsonb; v_lead uuid; v_key text; v_short text; v_name text;
begin
  select * into c from public.wa_contacts where id = p_contact and company_id = p_company for update;
  if not found then raise exception 'Contato não encontrado'; end if;
  if c.crm_lead_id is not null then return c.crm_lead_id; end if;

  if c.phone_e164 is not null then
    v_key := 'phone:' || c.wa_id;
    v_short := case when c.wa_id like '55%' then 'phone:' || substr(c.wa_id, 3) end;
  else
    v_key := 'bsuid:' || c.wa_id; -- telefone oculto: o lead fica ligado ao ID do WhatsApp
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || v_key, 0));
  select lead_id into v_lead from crm_private.contact_links
   where company_id = p_company and contact_key in (v_key, coalesce(v_short, v_key))
   order by (contact_key = v_key) desc limit 1;

  if v_lead is null then
    select settings into s from public.crm_companies where id = p_company;
    v_lead := gen_random_uuid();
    v_name := coalesce(c.name, 'Contato do WhatsApp');
    insert into public.crm_records (id, company_id, kind, data) values (v_lead, p_company, 'leads',
      jsonb_build_object('id', v_lead, 'name', v_name, 'source', 'WhatsApp', 'phone', coalesce(c.phone_e164, ''),
        'email', '', 'business', '', 'notes', case when c.phone_e164 is null then 'Cliente escondeu o telefone no WhatsApp (responda pela conversa).' else '' end,
        'utm_campaign', '', 'stage', s->'stages'->>0,
        'owner', 'Equipe', 'value', 0, 'score', 0, 'checks', '[false,false,false,false]'::jsonb, 'created', now()));
    insert into crm_private.contact_links (company_id, contact_key, lead_id) values (p_company, v_key, v_lead)
    on conflict do nothing;
    if coalesce((s->>'followup')::boolean, false) then
      insert into public.crm_records (company_id, kind, data) values (p_company, 'tasks',
        jsonb_build_object('title', 'Primeiro contato · ' || v_name, 'leadId', v_lead,
          'due', (current_date + 1)::text, 'done', false, 'owner', 'Equipe', 'created', now()));
    end if;
    insert into public.crm_records (company_id, kind, data) values (p_company, 'activity',
      jsonb_build_object('text', 'Lead criado a partir do WhatsApp: ' || v_name, 'leadId', v_lead, 'created', now()));
  end if;

  update public.wa_contacts set crm_lead_id = v_lead where id = p_contact;
  return v_lead;
end $$;

-- ---------------------------------------------------------------------
-- 4. Anúncio: guarda na conversa e marca o lead.
-- ---------------------------------------------------------------------
create function crm_private.wa_lead_do_anuncio(p_company uuid, p_contact uuid, p_conv uuid, p_ref jsonb, p_ts timestamptz)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_lead uuid; d jsonb; v_nome text; v_id text; v_url text; v_novo boolean;
begin
  if jsonb_typeof(p_ref) <> 'object' then return; end if;
  v_nome := nullif(left(trim(coalesce(p_ref->>'headline', p_ref->>'body', '')), 200), '');
  v_id := nullif(left(regexp_replace(coalesce(p_ref->>'source_id', ''), '[^0-9A-Za-z_.-]', '', 'g'), 60), '');
  v_url := case when coalesce(p_ref->>'source_url', '') ~ '^https://' then left(p_ref->>'source_url', 500) end;

  update public.wa_conversations set ad_referral = jsonb_strip_nulls(jsonb_build_object(
      'source_type', left(p_ref->>'source_type', 20), 'source_id', v_id, 'source_url', v_url, 'headline', v_nome,
      'body', left(p_ref->>'body', 300), 'media_type', left(p_ref->>'media_type', 20), 'ctwa_clid', left(p_ref->>'ctwa_clid', 200),
      'at', p_ts))
   where id = p_conv and company_id = p_company;

  v_lead := crm_private.wa_link_lead(p_company, p_contact);
  select data into d from public.crm_records where id = v_lead and company_id = p_company and kind = 'leads' for update;
  if d is null then return; end if;
  -- Mesmo anúncio de novo (cliente clicou outra vez): não repete atividade.
  v_novo := coalesce(d->>'ad_id', '') is distinct from coalesce(v_id, '') or coalesce(d->>'ad_name', '') is distinct from coalesce(v_nome, '');
  update public.crm_records set data = data
      || jsonb_build_object('ad_name', coalesce(v_nome, 'Anúncio da Meta'), 'ad_id', coalesce(v_id, ''), 'ad_url', coalesce(v_url, ''), 'ad_at', p_ts)
      -- Origem: lead novo do WhatsApp (ou sem origem) vira "Anúncio Meta"; de outra origem mantém (histórico do funil).
      || case when coalesce(d->>'source', '') in ('', 'WhatsApp') then jsonb_build_object('source', 'Anúncio Meta') else '{}'::jsonb end
      || case when coalesce(d->>'utm_campaign', '') = '' and v_nome is not null then jsonb_build_object('utm_campaign', v_nome) else '{}'::jsonb end
   where id = v_lead;
  if v_novo then
    insert into public.crm_records (company_id, kind, data) values (p_company, 'activity',
      jsonb_build_object('text', 'Chegou pelo anúncio da Meta: ' || coalesce(v_nome, 'sem título') || coalesce(' (id ' || v_id || ')', ''),
        'leadId', v_lead, 'created', now()));
    insert into public.wa_audit_logs (company_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (p_company, null, 'system', 'lead.ad_referral', 'lead', v_lead, jsonb_strip_nulls(jsonb_build_object('ad_id', v_id)));
  end if;
end $$;
revoke all on function crm_private.wa_lead_do_anuncio(uuid, uuid, uuid, jsonb, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Processamento do evento: telefone e/ou BSUID, anúncio.
--    (igual à versão de 20261025200000_agenda_e_financeiro.sql, mudando só a identificação do cliente
--     e o anúncio)
-- ---------------------------------------------------------------------
create or replace function crm_private.wa_process_event(ev public.wa_webhook_events) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := ev.payload_restricted;
  v_ts timestamptz; v_contact uuid; v_conv uuid; v_body text; v_dir text; v_status text; n int;
  v_settings jsonb; v_name text; v_fone text; v_bsuid text;
begin
  v_ts := coalesce((p->>'ts')::timestamptz, ev.received_at);
  v_body := nullif(left(coalesce(p->>'body',''), 6000), '');

  if ev.event_type in ('message','echo','history') then
    v_fone := case when coalesce(p->>'wa_id','') ~ '^[0-9]{8,15}$' then p->>'wa_id' end;
    v_bsuid := case when crm_private.wa_bsuid_valido(p->>'bsuid') then p->>'bsuid' end;
    if (v_fone is null and v_bsuid is null) or coalesce(p->>'wamid','') = '' then
      return;  -- sem dados mínimos: descarta (não faz sentido tentar de novo)
    end if;
    v_contact := crm_private.wa_contact(ev.company_id, coalesce(v_fone, v_bsuid),
      case when ev.event_type = 'message' then p->>'name' end, v_bsuid);
    v_conv := crm_private.wa_conversation(ev.company_id, ev.account_id, v_contact);
    v_dir := case ev.event_type when 'message' then 'inbound' when 'echo' then 'outbound'
                  else case when p->>'direction' = 'outbound' then 'outbound' else 'inbound' end end;
    v_status := case when v_dir = 'inbound' then 'received'
                     when p->>'status' in ('delivered','read') then p->>'status' else 'sent' end;

    insert into public.wa_messages (company_id, conversation_id, external_message_id, direction, source,
      message_type, body, media_id, message_status, provider_timestamp, sent_at, delivered_at, read_at)
    values (ev.company_id, v_conv, p->>'wamid', v_dir,
      case ev.event_type when 'message' then 'api_inbound' when 'echo' then 'app_echo' else 'history_sync' end,
      left(coalesce(p->>'type','text'),40), v_body, nullif(left(coalesce(p->>'media_id',''),200),''),
      v_status, v_ts,
      case when v_dir = 'outbound' then v_ts end,
      case when v_status in ('delivered','read') then v_ts end,
      case when v_status = 'read' then v_ts end)
    on conflict (company_id, external_message_id) where external_message_id is not null do nothing;
    get diagnostics n = row_count;
    if n = 0 then
      -- Já registrada. Se veio primeiro pelo histórico, passa a valer a origem ao vivo.
      if ev.event_type in ('message','echo') then
        update public.wa_messages
           set source = case ev.event_type when 'message' then 'api_inbound' else 'app_echo' end
         where company_id = ev.company_id and external_message_id = p->>'wamid' and source = 'history_sync';
      end if;
      return;
    end if;

    if v_dir = 'inbound' then
      update public.wa_conversations set
        unread_count = unread_count + case when ev.event_type = 'message' then 1 else 0 end,
        first_inbound_at = least(coalesce(first_inbound_at, v_ts), v_ts),
        last_inbound_at = greatest(coalesce(last_inbound_at, v_ts), v_ts),
        last_message_preview = case when v_ts >= coalesce(last_message_at, v_ts)
                                    then left(coalesce(v_body, '[' || coalesce(p->>'type','mensagem') || ']'), 160)
                                    else last_message_preview end,
        last_message_at = greatest(coalesce(last_message_at, v_ts), v_ts),
        service_window_expires_at = greatest(coalesce(service_window_expires_at, '-infinity'::timestamptz), v_ts + interval '24 hours'),
        status = case when ev.event_type = 'message' and status = 'resolved' then 'open' else status end
      where id = v_conv;

      if ev.event_type = 'message' then
        -- Descadastro por palavra-chave (vale para marketing; atendimento continua permitido)
        if upper(trim(coalesce(v_body,''))) in ('SAIR','PARAR','STOP','CANCELAR','DESCADASTRAR') then
          update public.wa_contacts set marketing_opt_out_at = coalesce(marketing_opt_out_at, v_ts) where id = v_contact;
          insert into public.wa_consents (company_id, contact_id, purpose, status, source, evidence, revoked_at)
          values (ev.company_id, v_contact, 'marketing', 'revoked', 'whatsapp_inbound', 'Palavra-chave de descadastro', v_ts);
        end if;
        if jsonb_typeof(p->'referral') = 'object' then
          -- Veio do anúncio: lead sempre (mesmo com lead automático desligado), com origem e nome do anúncio.
          perform crm_private.wa_lead_do_anuncio(ev.company_id, v_contact, v_conv, p->'referral', v_ts);
        else
          -- Lead automático só se a empresa ativar (padrão: manual, para não poluir o funil)
          select settings into v_settings from public.crm_companies where id = ev.company_id;
          if coalesce((v_settings->>'wa_auto_lead')::boolean, false) then
            perform crm_private.wa_link_lead(ev.company_id, v_contact);
          end if;
        end if;
      end if;
    else
      update public.wa_conversations set
        last_outbound_at = greatest(coalesce(last_outbound_at, v_ts), v_ts),
        first_response_at = case when ev.event_type = 'echo' and first_response_at is null
                                      and first_inbound_at is not null and v_ts >= first_inbound_at
                                 then v_ts else first_response_at end,
        unread_count = case when ev.event_type = 'echo' and v_ts >= coalesce(last_inbound_at, v_ts) then 0 else unread_count end,
        last_message_preview = case when v_ts >= coalesce(last_message_at, v_ts)
                                    then left(coalesce(v_body, '[' || coalesce(p->>'type','mensagem') || ']'), 160)
                                    else last_message_preview end,
        last_message_at = greatest(coalesce(last_message_at, v_ts), v_ts)
      where id = v_conv;
    end if;

  elsif ev.event_type = 'status' then
    v_status := p->>'status';
    if v_status not in ('sent','delivered','read','failed') or coalesce(p->>'wamid','') = '' then return; end if;
    update public.wa_messages m set
      message_status = case
        when v_status = 'failed' then case when crm_private.wa_status_rank(m.message_status) >= 2 then m.message_status else 'failed' end
        when m.message_status = 'failed' then v_status
        when crm_private.wa_status_rank(v_status) > crm_private.wa_status_rank(m.message_status) then v_status
        else m.message_status end,
      sent_at = case when v_status in ('sent','delivered','read') then coalesce(m.sent_at, v_ts) else m.sent_at end,
      delivered_at = case when v_status in ('delivered','read') then coalesce(m.delivered_at, v_ts) else m.delivered_at end,
      read_at = case when v_status = 'read' then coalesce(m.read_at, v_ts) else m.read_at end,
      failed_at = case when v_status = 'failed' then coalesce(m.failed_at, v_ts) else m.failed_at end,
      error_code = case when v_status = 'failed' then nullif(left(coalesce(p->>'error_code',''),40),'') else m.error_code end
    where m.company_id = ev.company_id and m.external_message_id = p->>'wamid' and m.direction = 'outbound';
    get diagnostics n = row_count;
    if n = 0 and ev.received_at > now() - interval '15 minutes' then
      raise exception 'Mensagem ainda não registrada';  -- chegou antes do registro do envio: tenta de novo
    end if;

  elsif ev.event_type = 'contacts_sync' then
    -- Agenda do celular: guarda nome + número e atualiza a conversa, se já existir.
    if coalesce(p->>'wa_id','') !~ '^[0-9]{8,15}$' then return; end if;
    v_name := nullif(left(trim(coalesce(p->>'name','')),120),'');
    if p->>'action' = 'remove' then
      delete from public.wa_address_book where company_id = ev.company_id and wa_id = p->>'wa_id';
    elsif v_name is not null then
      insert into public.wa_address_book (company_id, wa_id, name) values (ev.company_id, p->>'wa_id', v_name)
      on conflict (company_id, wa_id) do update set name = excluded.name, updated_at = now();
      update public.wa_contacts set name = v_name where company_id = ev.company_id and wa_id = p->>'wa_id';
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Remarketing: número com problema de pagamento/conta na Meta.
-- ---------------------------------------------------------------------
-- Erros da Meta que são da conta da loja (não do cliente): 131042 pagamento, 131031 conta bloqueada.
create function crm_private.wa_erro_da_conta(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_code in ('131042', '131031'), false)
$$;

-- Número parado para marketing: o último modelo enviado nas últimas 24 h falhou por erro da conta.
-- Volta sozinho assim que um modelo for entregue (ex.: a loja enviou um modelo pelo CRM).
create function crm_private.wa_conta_parada(p_account uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select crm_private.wa_erro_da_conta(m.error_code) and m.message_status = 'failed'
      from public.wa_messages m join public.wa_conversations c on c.id = m.conversation_id
     where c.account_id = p_account and m.direction = 'outbound' and m.message_type = 'template'
       and m.created_at > now() - interval '24 hours' and m.message_status in ('sent', 'delivered', 'read', 'failed')
     order by m.created_at desc limit 1), false)
$$;
revoke all on function crm_private.wa_conta_parada(uuid), crm_private.wa_erro_da_conta(text) from public, anon, authenticated;

-- Igual à versão de 20261126120000_remarketing.sql, mas envio que falhou por erro da conta não conta como tentativa.
create or replace function crm_private.wa_remarketing_elegiveis(p_company uuid, p_now timestamptz)
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
    from public.wa_remarketing_sends s
    left join public.wa_messages m on m.id = s.message_id
    where s.lead_id = l.id
      -- Falha por erro da conta da loja (pagamento, bloqueio): o cliente não recebeu, não gasta tentativa.
      and not coalesce(m.message_status = 'failed' and crm_private.wa_erro_da_conta(m.error_code), false)
  ) env on true
  where coalesce(k.wa, l.fone) ~ '^[1-9][0-9]{9,14}$'
    and not coalesce(k.saiu, false)
    and not (coalesce(k.wa, l.fone) = any(atend.tels)) and not (l.fone <> '' and l.fone = any(atend.tels))
    and coalesce(li.t, crm_private.ts_ou_nulo(l.data->>'created'), l.created_at) <= p_now - make_interval(days => (co.c->>'days')::int)
    and (env.ultimo is null or env.ultimo <= p_now - make_interval(days => (co.c->>'days')::int))
    and coalesce(env.desde, 0) < least((co.c->>'max_attempts')::int, jsonb_array_length(co.c->'templates'))
$$;

-- Igual à versão de 20261126120000_remarketing.sql, mas sem número parado por erro da conta.
create or replace function public.wa_remarketing_run(p_company uuid, p_now timestamptz default now(), p_max int default 4)
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

  -- Número com problema de pagamento/conta na Meta fica de fora até voltar a entregar.
  select coalesce(array_agg(a.id order by a.phone_e164), '{}') into v_contas
  from public.wa_accounts a join public.crm_channels c on c.id = a.crm_channel_id
  where a.company_id = p_company and a.connection_status = 'connected' and c.enabled
    and not crm_private.wa_conta_parada(a.id);
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

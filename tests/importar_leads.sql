-- Testes da importação de leads (crm_import_leads). Tudo roda numa transação e é desfeito no final.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('eeeeeeee-0000-4000-8000-0000000000e1','imp-admin-a@example.invalid',now()),
 ('eeeeeeee-0000-4000-8000-0000000000e2','imp-member-a@example.invalid',now()),
 ('ffffffff-0000-4000-8000-0000000000f1','imp-admin-b@example.invalid',now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"eeeeeeee-0000-4000-8000-0000000000e1","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Loja A','Motos');
select set_config('request.jwt.claims','{"sub":"ffffffff-0000-4000-8000-0000000000f1","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Loja B','Motos');
reset role;
insert into public.crm_members
  select 'eeeeeeee-0000-4000-8000-0000000000e2', company_id, 'Atendente A', 'imp-member-a@example.invalid', 'member'
  from public.crm_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000e1';
update public.crm_companies set settings = settings || '{"stages":["Novo Lead","Em contato","Em Negociação","Visita Agendada","CPF Negativado","Follow UP","Ganho","Perdido"]}'
  where id = (select company_id from public.crm_members where user_id = 'eeeeeeee-0000-4000-8000-0000000000e1');

-- ===== 1. Administrador importa; telefone ganha vínculo com e sem o 9 =====
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"eeeeeeee-0000-4000-8000-0000000000e1","role":"authenticated"}',true);
do $$ declare r jsonb; n int; begin
  r := public.crm_import_leads('[
    {"name":"Ana","phone":"+5594991234567","stage":"Ganho","owner":"David","notes":"Prioridade: Alta · Importado do Cowboy","created":"2026-10-25T13:00:00.000Z","importId":"cowboy:f1"},
    {"name":"Loja Fixa","phone":"+559433214567","stage":"Em contato","importId":"cowboy:f2"},
    {"name":"Sem Telefone","phone":"","stage":"Etapa que não existe","importId":"cowboy:f3"},
    {"name":"Futuro","phone":"+5594997777777","created":"2099-01-01T00:00:00.000Z","importId":"cowboy:f4"}]');
  if r <> '{"inserted":4,"skipped":0}'::jsonb then raise exception 'Falha 1a: %', r; end if;
  select count(*) into n from public.crm_records where kind='leads' and data->>'source'='Cowboy';
  if n <> 4 then raise exception 'Falha 1b: admin vê % leads', n; end if;
  if (select data->>'stage' from public.crm_records where kind='leads' and data->>'name'='Ana') <> 'Ganho' then raise exception 'Falha 1c: etapa'; end if;
  if (select data->>'stage' from public.crm_records where kind='leads' and data->>'name'='Sem Telefone') <> 'Novo Lead' then raise exception 'Falha 1d: etapa desconhecida devia virar a primeira'; end if;
  if (select data->>'owner' from public.crm_records where kind='leads' and data->>'name'='Sem Telefone') <> 'Equipe' then raise exception 'Falha 1e: responsável padrão'; end if;
  if (select (data->>'created')::timestamptz from public.crm_records where kind='leads' and data->>'name'='Ana') <> '2026-10-25T13:00:00Z'::timestamptz then raise exception 'Falha 1f: data original'; end if;
  if (select (data->>'created')::timestamptz from public.crm_records where kind='leads' and data->>'name'='Futuro') > now() then raise exception 'Falha 1g: data no futuro'; end if;
  if not exists (select 1 from public.crm_records where kind='activity' and data->>'text'='Importação de planilha: 4 leads') then raise exception 'Falha 1h: atividade'; end if;
  if exists (select 1 from public.crm_records where kind='tasks') then raise exception 'Falha 1i: importação não deve criar tarefas'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from crm_private.contact_links where contact_key in ('phone:5594991234567','phone:559491234567')) <> 2 then raise exception 'Falha 1j: vínculos do celular'; end if;
  if (select count(*) from crm_private.contact_links where contact_key = 'phone:559433214567') <> 1 then raise exception 'Falha 1k: vínculo do fixo'; end if;
  if (select count(*) from crm_private.contact_links l join public.crm_records r on r.id=l.lead_id where r.data->>'name'='Sem Telefone') <> 0 then raise exception 'Falha 1l: sem telefone não tem vínculo'; end if;
end $$;

-- ===== 2. Importar de novo não duplica (código, telefone com ou sem o 9) =====
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"eeeeeeee-0000-4000-8000-0000000000e1","role":"authenticated"}',true);
do $$ declare r jsonb; begin
  r := public.crm_import_leads('[
    {"name":"Ana","phone":"+5594991234567","importId":"cowboy:f1"},
    {"name":"Ana outra planilha","phone":"+5594991234567","importId":"cowboy:x1"},
    {"name":"Loja Fixa 2","phone":"+559433214567","importId":"cowboy:x2"},
    {"name":"Novo","phone":"+5594995555555","importId":"cowboy:x3"},
    {"name":"Novo repetido no lote","phone":"+5594995555555","importId":"cowboy:x4"}]');
  if r <> '{"inserted":1,"skipped":4}'::jsonb then raise exception 'Falha 2a: %', r; end if;
end $$;

-- ===== 3. Validações =====
do $$ begin
  begin perform public.crm_import_leads('[{"name":"X","phone":"94991234567"}]'); raise exception 'Falha 3a: aceitou telefone sem +55';
  exception when others then if sqlerrm not like 'Linha 1 com telefone inválido' then raise; end if; end;
  begin perform public.crm_import_leads('[{"name":"  ","phone":""}]'); raise exception 'Falha 3b: aceitou sem nome';
  exception when others then if sqlerrm not like 'Linha 1 sem nome' then raise; end if; end;
  begin perform public.crm_import_leads('[]'); raise exception 'Falha 3c: aceitou lista vazia';
  exception when others then if sqlerrm not like 'Envie de 1 a 500%' then raise; end if; end;
  begin perform public.crm_import_leads((select jsonb_agg(jsonb_build_object('name','N'||g)) from generate_series(1,501) g)); raise exception 'Falha 3d: aceitou 501';
  exception when others then if sqlerrm not like 'Envie de 1 a 500%' then raise; end if; end;
  begin perform public.crm_import_leads('{"name":"X"}'); raise exception 'Falha 3e: aceitou objeto';
  exception when others then if sqlerrm not like 'Envie de 1 a 500%' then raise; end if; end;
  begin perform public.crm_import_leads('[{"name":"X","created":"2026-10-25 13:00"}]');
  exception when others then raise exception 'Falha 3f: data em outro formato devia virar agora: %', sqlerrm; end;
end $$;

-- ===== 4. Atendente (member) não importa =====
select set_config('request.jwt.claims','{"sub":"eeeeeeee-0000-4000-8000-0000000000e2","role":"authenticated"}',true);
do $$ begin
  begin perform public.crm_import_leads('[{"name":"X"}]'); raise exception 'Falha 4: atendente importou';
  exception when others then if sqlerrm not like 'Só o administrador pode importar' then raise; end if; end;
end $$;

-- ===== 5. Isolamento: outra empresa importa o mesmo telefone e não vê os leads da A =====
select set_config('request.jwt.claims','{"sub":"ffffffff-0000-4000-8000-0000000000f1","role":"authenticated"}',true);
do $$ declare r jsonb; begin
  if exists (select 1 from public.crm_records where kind='leads') then raise exception 'Falha 5a: B vê leads da A'; end if;
  r := public.crm_import_leads('[{"name":"Ana na B","phone":"+5594991234567","importId":"cowboy:f1"}]');
  if r <> '{"inserted":1,"skipped":0}'::jsonb then raise exception 'Falha 5b: %', r; end if;
end $$;

-- ===== 6. Sem login / anônimo não importa =====
select set_config('request.jwt.claims','{}',true);
do $$ begin
  begin perform public.crm_import_leads('[{"name":"X"}]'); raise exception 'Falha 6a: importou sem login';
  exception when others then if sqlerrm not like 'Faça login' then raise; end if; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.crm_import_leads('[{"name":"X"}]'); raise exception 'Falha 6b: anônimo executou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'importar_leads: todos os testes passaram' as resultado;
rollback;

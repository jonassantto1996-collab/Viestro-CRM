-- Testes do Financeiro do CRM. Tudo roda numa transação e é desfeito no final.
begin;

insert into auth.users(id,email,email_confirmed_at) values
 ('cccccccc-0000-4000-8000-0000000000c1','fin-admin-a@example.invalid',now()),
 ('cccccccc-0000-4000-8000-0000000000c2','fin-member-a@example.invalid',now()),
 ('dddddddd-0000-4000-8000-0000000000d1','fin-admin-b@example.invalid',now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-0000000000c1","role":"authenticated"}',true);
select public.crm_bootstrap('Admin A','Agência A','Serviços');
select set_config('request.jwt.claims','{"sub":"dddddddd-0000-4000-8000-0000000000d1","role":"authenticated"}',true);
select public.crm_bootstrap('Admin B','Agência B','Serviços');
reset role;
insert into public.crm_members
  select 'cccccccc-0000-4000-8000-0000000000c2', company_id, 'Atendente A', 'fin-member-a@example.invalid', 'member'
  from public.crm_members where user_id = 'cccccccc-0000-4000-8000-0000000000c1';

create temp table fin_ids (k text primary key, id uuid);
grant all on fin_ids to authenticated;

-- ===== 1. Administrador lança entradas e despesas =====
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-0000000000c1","role":"authenticated"}',true);
do $$ declare lead uuid; e1 uuid; e2 uuid; begin
  lead := public.crm_save('leads', '{"name":"Clínica Teste","value":2500,"stage":"Novo lead"}');
  insert into fin_ids values ('leadA', lead);
  e1 := public.crm_finance_save(jsonb_build_object('kind','income','occurred_on','2026-10-10','description','Gestão de tráfego outubro',
        'category','Gestão de tráfego','client_name','Clínica Teste','lead_id',lead,'amount_cents',250000,'method','pix','status','paid'));
  e2 := public.crm_finance_save('{"kind":"expense","occurred_on":"2026-10-12","description":"Assinatura de ferramenta","category":"Ferramentas","amount_cents":9990,"status":"pending"}');
  insert into fin_ids values ('e1', e1), ('e2', e2);
  if (select paid_on from public.crm_finance_entries where id = e1) <> '2026-10-10' then raise exception 'F1 FALHOU: data de pagamento padrão'; end if;
  if (select paid_on from public.crm_finance_entries where id = e2) is not null then raise exception 'F2 FALHOU: pendente com pagamento'; end if;
  if (select count(*) from public.crm_finance_entries) <> 2 then raise exception 'F3 FALHOU: leitura do administrador'; end if;
  -- edição: marca a despesa como paga
  perform public.crm_finance_save(jsonb_build_object('id',e2,'kind','expense','occurred_on','2026-10-12','description','Assinatura de ferramenta',
          'category','Ferramentas','amount_cents',9990,'status','paid','paid_on','2026-10-15','method','cartao_credito'));
  if (select status||paid_on::text from public.crm_finance_entries where id = e2) <> 'paid2026-10-15' then raise exception 'F4 FALHOU: edição'; end if;
end $$;

-- ===== 2. Validações =====
do $$ begin
  begin perform public.crm_finance_save('{"kind":"income","occurred_on":"2026-10-10","description":"x","category":"y","amount_cents":0,"status":"paid"}');
    raise exception 'V1 FALHOU: aceitou valor zero'; exception when raise_exception then if sqlerrm like 'V1%' then raise; end if; end;
  begin perform public.crm_finance_save('{"kind":"income","occurred_on":"2026-10-10","description":"x","category":"y","amount_cents":-5,"status":"paid"}');
    raise exception 'V2 FALHOU: aceitou valor negativo'; exception when raise_exception then if sqlerrm like 'V2%' then raise; end if; end;
  begin perform public.crm_finance_save('{"kind":"outro","occurred_on":"2026-10-10","description":"x","category":"y","amount_cents":100,"status":"paid"}');
    raise exception 'V3 FALHOU: tipo inválido'; exception when raise_exception then if sqlerrm like 'V3%' then raise; end if; end;
  begin perform public.crm_finance_save('{"kind":"income","occurred_on":"10/10/2026","description":"x","category":"y","amount_cents":100,"status":"paid"}');
    raise exception 'V4 FALHOU: data inválida'; exception when raise_exception then if sqlerrm like 'V4%' then raise; end if; end;
  begin perform public.crm_finance_save('{"kind":"income","occurred_on":"2026-10-10","description":"  ","category":"y","amount_cents":100,"status":"paid"}');
    raise exception 'V5 FALHOU: descrição vazia'; exception when raise_exception then if sqlerrm like 'V5%' then raise; end if; end;
  begin perform public.crm_finance_save('{"kind":"income","occurred_on":"2026-10-10","description":"x","category":"y","amount_cents":100,"status":"paid","method":"cheque-voador"}');
    raise exception 'V6 FALHOU: forma de pagamento inválida'; exception when raise_exception then if sqlerrm like 'V6%' then raise; end if; end;
end $$;

-- ===== 3. Atendente (não administrador) não vê nem lança =====
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-0000000000c2","role":"authenticated"}',true);
do $$ begin
  if (select count(*) from public.crm_finance_entries) <> 0 then raise exception 'P1 FALHOU: atendente viu o financeiro'; end if;
  begin perform public.crm_finance_save('{"kind":"income","occurred_on":"2026-10-10","description":"x","category":"y","amount_cents":100,"status":"paid"}');
    raise exception 'P2 FALHOU: atendente lançou'; exception when raise_exception then if sqlerrm like 'P2%' then raise; end if; end;
  begin perform public.crm_finance_delete((select id from fin_ids where k='e1'));
    raise exception 'P3 FALHOU: atendente apagou'; exception when raise_exception then if sqlerrm like 'P3%' then raise; end if; end;
  begin insert into public.crm_finance_entries(company_id,kind,occurred_on,description,category,amount_cents,status)
    values ((select company_id from public.crm_members where user_id = auth.uid()),'income','2026-10-10','x','y',100,'pending');
    raise exception 'P4 FALHOU: escrita direta na tabela'; exception when insufficient_privilege then null; end;
end $$;

-- ===== 4. Outra empresa não vê, não edita e não vincula lead alheio =====
select set_config('request.jwt.claims','{"sub":"dddddddd-0000-4000-8000-0000000000d1","role":"authenticated"}',true);
do $$ begin
  if (select count(*) from public.crm_finance_entries) <> 0 then raise exception 'I1 FALHOU: outra empresa viu lançamentos'; end if;
  begin perform public.crm_finance_save(jsonb_build_object('id',(select id from fin_ids where k='e1'),'kind','income','occurred_on','2026-10-10',
      'description','invadido','category','y','amount_cents',1,'status','paid'));
    raise exception 'I2 FALHOU: editou lançamento de outra empresa'; exception when raise_exception then if sqlerrm like 'I2%' then raise; end if; end;
  begin perform public.crm_finance_save(jsonb_build_object('kind','income','occurred_on','2026-10-10','description','x','category','y',
      'amount_cents',100,'status','paid','lead_id',(select id from fin_ids where k='leadA')));
    raise exception 'I3 FALHOU: vinculou lead de outra empresa'; exception when raise_exception then if sqlerrm like 'I3%' then raise; end if; end;
  begin perform public.crm_finance_delete((select id from fin_ids where k='e1'));
    raise exception 'I4 FALHOU: apagou lançamento de outra empresa'; exception when raise_exception then if sqlerrm like 'I4%' then raise; end if; end;
end $$;

-- ===== 5. Exclusão pelo administrador =====
select set_config('request.jwt.claims','{"sub":"cccccccc-0000-4000-8000-0000000000c1","role":"authenticated"}',true);
do $$ begin
  perform public.crm_finance_delete((select id from fin_ids where k='e2'));
  if (select count(*) from public.crm_finance_entries) <> 1 then raise exception 'D1 FALHOU: exclusão'; end if;
  if (select description from public.crm_finance_entries) <> 'Gestão de tráfego outubro' then raise exception 'D2 FALHOU: lançamento alterado por outra empresa'; end if;
end $$;
reset role;

-- ===== 6. Visitante sem login não acessa =====
set local role anon;
do $$ begin
  begin perform count(*) from public.crm_finance_entries; raise exception 'A1 FALHOU: visitante leu';
  exception when insufficient_privilege then null; end;
  begin perform public.crm_finance_save('{}'); raise exception 'A2 FALHOU: visitante chamou função';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
select 'Financeiro: todos os testes de banco passaram; fixtures desfeitas' as resultado;

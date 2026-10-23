-- =====================================================================
-- Vértice Messaging Hub · Migration A · Endurecimento do banco existente
-- Projeto: vertice-motor-automacao (jucsyhcamxwgkshzkazv)
-- STATUS: APLICADA em 21/10/2026 (versão remota 20261021140454).
--
-- O que muda:
--   1. Ativa RLS nas 4 tabelas de crm_private (sem políticas = negação
--      total para anon/authenticated). Não quebra o CRM porque:
--        - todas as funções que usam essas tabelas são SECURITY DEFINER
--          ou rodam via pg_cron, com dono "postgres" (dono ignora RLS);
--        - service_role tem BYPASSRLS;
--        - nenhuma tabela usa FORCE ROW LEVEL SECURITY.
--   2. Fixa search_path de public.set_updated_at() (alerta do Advisor).
--   3. Remove privilégios sem uso (TRUNCATE, REFERENCES, TRIGGER) de
--      anon/authenticated nas tabelas legadas. TRUNCATE não é coberto
--      por RLS; a API REST não o expõe, mas o privilégio não deveria
--      existir.
--   4. Remove todos os privilégios de anon/authenticated em
--      public.fila_vertice (RLS sem políticas já bloqueava tudo; o motor
--      usa a chave de serviço).
--
-- O que NÃO muda: dados, políticas de leitura pública do catálogo,
-- INSERT público de pedidos/leads dos sites (ver relatório de riscos).
-- =====================================================================
begin;

alter table crm_private.capture_tokens  enable row level security;
alter table crm_private.invites         enable row level security;
alter table crm_private.contact_links   enable row level security;
alter table crm_private.capture_windows enable row level security;

alter function public.set_updated_at() set search_path = '';

revoke truncate, references, trigger on
  public.categories, public.products, public.orders, public.order_items,
  public.clientes, public.cliente_conteudo, public.cliente_leads
from anon, authenticated;

revoke all on public.fila_vertice from anon, authenticated;

commit;

-- ---------------------------------------------------------------------
-- ROLLBACK (executar somente se necessário)
-- begin;
-- alter table crm_private.capture_tokens  disable row level security;
-- alter table crm_private.invites         disable row level security;
-- alter table crm_private.contact_links   disable row level security;
-- alter table crm_private.capture_windows disable row level security;
-- alter function public.set_updated_at() reset search_path;
-- grant truncate, references, trigger on public.categories, public.products,
--   public.orders, public.order_items, public.clientes, public.cliente_conteudo,
--   public.cliente_leads to anon, authenticated;
-- grant all on public.fila_vertice to anon, authenticated;
-- commit;
-- ---------------------------------------------------------------------

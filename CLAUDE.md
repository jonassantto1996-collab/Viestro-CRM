# Viestro CRM — memória do projeto

CRM próprio da Viestro Assessoria, reaproveitável para qualquer nicho (clínica, pet shop, lojas). Leads, funil, tarefas, WhatsApp oficial, financeiro e indicadores. Detalhes completos no `README.md`; aqui fica só o essencial para trabalhar rápido.

## Como trabalhar aqui
- Ler este arquivo primeiro; abrir só os arquivos da área da tarefa (mapa abaixo).
- Respostas curtas; testar antes de dizer pronto (`npm run typecheck`, `npm test`, `npm run build`).
- Ao tomar decisão importante ou resolver um erro, acrescentar 1 linha nas seções no fim.

## Stack e deploy
- Next.js 16 (App Router, React 19) + Supabase (Auth/Postgres/RLS/pg_cron/Vault) + Vercel. Node >= 22.13.
- Supabase compartilhado `jucsyhcamxwgkshzkazv` (sa-east-1) — também tem tabelas de outros produtos. **Nunca** `supabase db push` nem reaplicar migrations antigas; nova migration = arquivo novo em `supabase/migrations/`, aplicado só a ela.
- Deploy automático na Vercel ao subir na `main` (time Viestro projects). Mudou variável de ambiente → republicar.
- Repositório GitHub: `Viestro-CRM` (antigo `vertice-crm`).

## Mapa
- `app/page.tsx` — app inteiro do CRM num arquivo (linhas longas). Telas por `page==='…'`: Visão geral/Tráfego pago/Atividades (~l.63), Leads (~68), Funil (~69), Financeiro (~71), Automações (~72), Método Viestro (~73), Configurações (~74, `SettingsView` l.79). Tabela de leads: `leadTable` (l.58); exportar: `exportLeads` (l.56).
- `components/whatsapp-inbox.tsx` — caixa de entrada do WhatsApp. `components/whatsapp-metrics.tsx` — indicadores. `components/finance.tsx` — Financeiro.
- `app/api/crm` — bootstrap/salvar/configurações/token (RPCs `crm_bootstrap`, `crm_save`, `crm_settings`, `crm_token`).
- `app/api/finance` — `crm_finance_save` / `crm_finance_delete`.
- `app/api/whatsapp` — enviar texto/template, consentimento, criar lead, marcar lida (`crm_wa_*`).
- `app/api/webhooks/whatsapp/[key]` — entrada da Meta via EasyCoexistence (`wa_ingest`). `app/api/webhooks/meta` — webhook Instagram/WhatsApp antigo (HMAC).
- `app/api/capture` — entrada externa de leads por token. `app/api/worker`, `app/api/whatsapp/worker` — filas (`lib/worker.ts`, `lib/whatsapp-worker.ts`).
- `lib/supabase/server.ts` — cliente Supabase (URL/chave padrão da instalação Viestro). `lib/export.ts` — exportar planilha (CSV `;`). `lib/whatsapp.mjs`, `lib/whatsapp-metrics.mjs`, `lib/meta.mjs` — regras testadas.
- `lib/demo*.ts`, `lib/*-demo.ts` — dados fictícios do modo demonstração (`/?demo=petshop`).
- `app/globals.css` — todo o visual (azul-marinho/azul Viestro). `components/ui/` — shadcn (não editar sem necessidade).
- `supabase/migrations/` — banco; `tests/*.sql` — testes em transação com rollback (nunca rodar em produção com exclusão).

## Regras
- Toda listagem principal exporta para planilha (`lib/export.ts`).
- Escrita no banco só por funções RPC validadas; leitura por RLS por `company_id`. Segredos só no servidor (nunca `NEXT_PUBLIC_`).
- WhatsApp só pela API oficial (coexistência EasyCoexistence). Sem WhatsApp Web, sem envio em massa. Texto livre só na janela de 24h; marketing exige consentimento e respeita SAIR/PARAR.
- Marca: "Viestro Assessoria" e "desenvolvido por Viestro".

## Decisões
- 2026-09-24 — CRM com fila própria, separada do motor de automação (não misturar IA/sites com contatos reais).
- 2026-10 — Rebrand Vértice → Viestro em nome e créditos.
- 2026-10 — WhatsApp oficial via EasyCoexistence; lead automático desligado por padrão (`settings.wa_auto_lead`), operador cria lead pela conversa.
- 2026-10 — Aba Financeiro controla entradas **e** despesas por mês (modelo CredFaz); mover oportunidade para Ganho sugere lançamento.
- 2026-10 — Demonstração de pet shop em `/?demo=petshop` para vendas.
- 2026-10 — Primeira implantação planejada: clínica (reativação de pacientes antigos); manter o CRM genérico para outros nichos.

## Erros já resolvidos
- 2026-10 — "supabaseUrl is required" no deploy → URL/chave publicável padrão no `lib/supabase/server.ts`.
- 2026-10 — Variável nova na Vercel não fazia efeito → precisa republicar o deploy.
- 2026-10 — Falha silenciosa no webhook do WhatsApp → agora registra o motivo técnico (sem dados pessoais).
- 2026-10-25 — Vercel publicou CSS antigo (cache do Turbopack) → `turbopackFileSystemCacheForBuild:false` no `next.config.ts`.

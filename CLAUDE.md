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
- `app/api/mcp/[chave]` — conector do Claude (MCP, só leitura): `lib/mcp-protocolo.mjs` (JSON-RPC), `lib/mcp-chave.mjs` (endereço secreto por empresa = HMAC da `SUPABASE_SECRET_KEY`; `CRM_MCP_ROTACAO` troca todos, `CRM_MCP_DESLIGADO=1` desliga), `lib/mcp-ferramentas.ts` (7 consultas, sempre filtradas por `company_id`). Endereço para o admin: `app/api/conector-claude` + `components/claude-connector.tsx` (Configurações).
- Agente de atendimento (modo sugestão): `lib/agente.mjs` (regras e prompt, testado), `lib/agente-ia.ts` (chamada ao Claude; `ANTHROPIC_API_KEY`, `CRM_AGENTE_MODELO` padrão Haiku 5.5), ação `suggest` em `app/api/whatsapp`, botão Sugerir + sugestão automática ao abrir conversa esperando resposta em `components/whatsapp-inbox.tsx`, configuração em `components/agent-settings.tsx` (salva em `settings.agent`, validada por `agenteValido`; campo opcional `sales` = "Como vender", até 4.000, entra no prompt em `<como_vender>` só para conduzir a conversa, nunca como fonte de fatos). Demo: `waDemoSugestoes` em `lib/whatsapp-demo.ts`.
- Agente automático: `lib/agente-runner.ts` (`runAgent`, chamado por `drainAllWithAgent` após webhook com mensagem de cliente, espera 2,5 s (candidata só com 2 s de silêncio), e pelo worker); banco decide se envia: `wa_agent_candidates`, `wa_agent_send`, `wa_agent_pause` (só service_role), `crm_wa_agent_toggle` (operador pausa/reativa); estado em `wa_agent_state`; mensagens do agente têm `source='agent'`. Regras de horário em `respondeSozinho`/`dentroDoExpediente` (`lib/agente.mjs`). Testes do banco: `tests/agente_automatico.sql`.
- Agente move no funil (só automático): campo opcional `settings.agent.funnel` ("Quando mover no funil", até 2.000; vazio = não mexe) em `components/agent-settings.tsx`; `etapasDoAgente`/`ferramentaPara`/`lerSugestao` em `lib/agente.mjs` (etapa atual vai na mensagem do usuário, não nas instruções, para manter o cache); runner chama `wa_agent_move_stage` (só service_role; só avança, nunca Ganho/Perdido, só lead ligado à conversa; registra atividade e auditoria). Testes: `tests/agente-funil.test.mjs`, `tests/agente_funil.sql`.
- Lead quente para atendente (só automático): quando o agente passa para a equipe (pediu humano ou limite diário), `passarParaAtendente` em `lib/agente-runner.ts` escreve o resumo (`resumirConversa` em `lib/agente-ia.ts`; regras `pedidoResumo`/`lerResumo`/`resumoReserva` em `lib/agente.mjs`; se a IA falhar usa o resumo reserva) e chama `wa_agent_assign` (só service_role): escolhe o atendente de `settings.agent.attendants` (até 5, um nome por linha em `components/agent-settings.tsx`), alternado pela ordem; cliente que volta fica com quem já atendia; lista vazia = "Equipe"; cria tarefa `source='agent_handoff'` com `notes` (resumo) e `conversationId`, sem duplicar enquanto aberta; marca o responsável no lead. Resumo aparece em Atividades (`.task-notes`). Testes: `tests/agente-atendentes.test.mjs`, `tests/agente_atendentes.sql`.
- Lead quente e alerta do atendente: o agente devolve `lead_quente` (intenção de compra: preço/parcela/pagamento, ir à loja/ver o produto, comprar/reservar; regra no prompt de `lib/agente.mjs`); runner passa `p_hot` para `wa_agent_assign` (tarefa com 🔥 e `hot`, lead com `temperature='quente'`; sobe para quente, nunca desce). `GET /api/whatsapp?view=summary` devolve `alerts` (passagens abertas, por RLS); `components/lead-alerts.tsx` (`useAlertasDeLead`: som + notificação do computador + aviso "Ver"; vistos no localStorage; primeira vez no computador não toca; `AtivarAvisos` em Atividades). Quentes no topo das Atividades (`.task-item.is-hot`). Testes: `tests/lead_quente.sql`.
- Transcrição de áudio: `lib/transcricao.ts` (`transcreverPendentes`: baixa a mídia na Meta com o token do número e transcreve na OpenAI `gpt-4o-mini-transcribe`, `OPENAI_API_KEY`, `CRM_TRANSCRICAO_MODELO`); roda em `drainAllWithAgent` em paralelo à espera do agente e no worker; colunas `wa_messages.transcript`/`transcript_status` (reserva com `running`). Só áudios recebidos nos últimos 15 min, até 8 MB.
- Importar planilhas do Cowboy (Contatos + Funil): `components/import-planilha.tsx` (Configurações, só admin; lê .xlsx no navegador com `read-excel-file`), regras puras em `lib/importar-cowboy.mjs` (telefone ganha o 9, etapa por nome, Vendido→Ganho, junta por nome), `app/api/crm/importar` (lotes de 200) → RPC `crm_import_leads` (admin, até 500/lote, não duplica por importId/telefone/contact_links, grava vínculo com e sem o 9). Testes: `tests/importar-cowboy.test.mjs`, `tests/importar_leads.sql`.
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
- 2026-11-14 — Conector do Claude (MCP) só de consulta; ações (enviar mensagem, mover lead) só depois, com confirmação. Próximo: agente do WhatsApp em modo sugestão.
- 2026-11-15 — Agente do WhatsApp começa em modo sugestão (a equipe revisa e envia); configuração em `settings.agent` sem migration. Próximo: modo automático para dúvidas simples, com passagem para humano.
- 2026-11-16 — Modo automático: responde só a última mensagem do cliente, espera ~9 s, cala 12 h quando a equipe responde, máx. 10 respostas/conversa/dia, passa para a equipe marcando Pendente e pausando 24 h. Migration `20261116000000_agente_automatico.sql` precisa ser aplicada ANTES do deploy (a caixa de entrada lê `wa_agent_state`).
- 2026-11-16 — Ajustes após teste real: espera reduzida (resposta em ~10 s em vez de ~19 s) e o agente só cumprimenta na primeira resposta (código avisa quando a empresa falou nas últimas 6 h).
- 2026-11-16 — Áudios dos clientes são transcritos (OpenAI, mesma escolha do Vért Rural) e o agente responde ao conteúdo; transcrição aparece no CRM. Migration `20261116020000_transcricao_audio.sql` ANTES do deploy (consultas leem `transcript`).
- 2026-11-16 — Espera do automático reduzida para 2,5 s (2 s de silêncio): resposta em ~6–7 s; mensagens com mais de ~2,5 s de intervalo podem gerar duas respostas.
- 2026-11-16 — Campo "Como vender" separado da base de conhecimento; regras fixas de venda honesta no prompt (sem urgência falsa, sem desconto ou promessa fora da base). Roteiro da Viestro tirado das conversas reais do Jonas + venda consultiva (métodos públicos).
- 2026-11-19 — Regtech Motos sai do Cowboy para este CRM: importador de planilhas; funil com as 8 etapas da Regtech (Vendido vira Ganho) só na empresa deles. Migration `20261119190000_importar_leads.sql` ANTES do deploy.
- 2026-11-20 — Funil mostra sempre as oportunidades abertas; o filtro de período vale só para Ganho/Perdido (leads importados antigos sumiam). Agente avança o lead no funil pelas regras da empresa; Ganho/Perdido continuam da equipe. Migration `20261120000000_agente_move_funil.sql` ANTES do deploy.
- 2026-11-20 — Lead quente (agente passou para a equipe) vai para um atendente com tarefa e resumo da conversa; divisão alternada, cliente que volta fica com o mesmo. Regtech começa só com a Agna (sem login, um computador); o 2º atendente entra na lista depois, sem código. Migration `20261120120000_agente_distribui_lead.sql` ANTES do deploy.
- 2026-11-20 — Base de conhecimento da Regtech tirada do Supabase do site (`regtech-motos`, só leitura: 23 modelos ativos) e do código do site (`lib/seo/business.ts`: endereço/horário). Sem preços até a loja conferir o cadastro (X16 e Yala TTX com cartão menor que à vista; M8-B sem à vista): qualquer pergunta de valor, CPF negativado, troca etc. vai para a Agna. À vista/desconto sempre com o atendente. Próximo: tabela de parcelamento calculada pelo código (5x, 10x...) quando a loja mandar a base.
- 2026-11-20 — Alerta para o atendente em toda passagem do agente, com 🔥 nos leads quentes (quentes primeiro; depois o agente trabalha frios/mornos). Parte 1 (no CRM: som, notificação, topo da lista) feita; parte 2 (WhatsApp pessoal da Agna via modelo UTILITY aprovado pela Meta) espera número dela e o WhatsApp da loja conectado. Migration `20261120180000_lead_quente.sql` ANTES do deploy (troca a assinatura de `wa_agent_assign`).
- 2026-10 — Primeira implantação planejada: clínica (reativação de pacientes antigos); manter o CRM genérico para outros nichos.

## Erros já resolvidos
- 2026-11-16 — Cache do agente quase nunca funcionava (cache=0 nos logs): a hora ("Agora") estava nas instruções e mudava a cada minuto → hora foi para a mensagem do usuário; instruções ficam idênticas.
- 2026-11-14 — resumo_crm do conector falhava em meses de 30 dias (data 2026-11-31 inválida no Postgres) → `fimDoMes()`.
- 2026-11-20 — Testes SQL rodam num Postgres 16 local (esqueleto de auth/vault/cron + todas as migrations, pulando `messaging_hub_a_seguranca_existente`, que só mexe em tabelas de outros produtos); nunca na produção. Ordem de registros criados na mesma transação: usar `clock_timestamp()`, não `now()`.
- 2026-11 — `npm ci` falha (lock fora de sincronia: ajv); para testar local use `npm install --package-lock=false`.
- 2026-10 — "supabaseUrl is required" no deploy → URL/chave publicável padrão no `lib/supabase/server.ts`.
- 2026-10 — Variável nova na Vercel não fazia efeito → precisa republicar o deploy.
- 2026-10 — Falha silenciosa no webhook do WhatsApp → agora registra o motivo técnico (sem dados pessoais).
- 2026-10-25 — Vercel publicou CSS antigo (cache do Turbopack) → `turbopackFileSystemCacheForBuild:false` no `next.config.ts`.

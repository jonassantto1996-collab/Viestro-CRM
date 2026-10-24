# Viestro CRM · MVP 2

CRM para aquisição, qualificação, tarefas, campanhas e conversão. Identidade azul-marinho/azul e logo da Viestro. Método: Diagnóstico → Arquitetura → Implementação → Evolução.

## Estado da entrega

- Código portado para Next.js 16 e Supabase Auth/Postgres.
- Quatro migrations CRM já aplicadas no projeto `jucsyhcamxwgkshzkazv` em 24/09/2026. Não execute novamente nesse banco. Em uma instalação nova, aplique na ordem dos arquivos.
- Dados existentes do motor/e-commerce não foram alterados nem importados para empresas do CRM. O ambiente anterior Sites não possuía empresas cadastradas na consulta feita nesta entrega.
- Repositório: `jonassantto1996-collab/vertice-CRM`. Deploy de produção: https://vertice-crm-nu.vercel.app. A demonstração anterior no Sites permanece separada.
- Instagram/WhatsApp têm receptor de webhook implementado, mas nenhuma conta Meta está vinculada. Sem envio automático de mensagens ou sincronização de gastos de anúncios.
- Testes de banco com fixtures transacionais e rollback passaram. Build Next, TypeScript e testes de assinatura/normalização passaram.

## Rodar

Node >=22.13, npm. `npm ci`, copie `.env.example` para `.env.local`, `npm run dev`.

O login e as operações do CRM usam apenas URL/chave publicável + sessão do usuário. Na instalação Viestro, a URL e a chave publicável do projeto autorizado têm valores padrão no código; o login pode inicializar mesmo sem copiar o arquivo de ambiente. Variáveis configuradas substituem esses valores. Para outro projeto, configure URL e chave correspondentes; uma URL diferente nunca reutiliza a chave padrão. A chave publicável é identificador público; RLS e funções validam autorização. `SUPABASE_SECRET_KEY` é somente servidor, necessária para captura externa e worker. Nunca use prefixo `NEXT_PUBLIC_` para segredos.

`npm run build`, `npm run typecheck`, `npm test`.

## Publicar na Vercel

1. Usar o repositório `jonassantto1996-collab/vertice-CRM`, que contém estes arquivos. Segredos, `.env.local`, `.next` e `node_modules` não são versionados.
2. Importar como Next.js na Vercel. Não substituir `vertice-motor-automacao`.
3. Configurar variáveis de `.env.example`. Usar chave secreta do Supabase, `CRON_SECRET` aleatório forte, `META_APP_SECRET` e `META_VERIFY_TOKEN` somente nos campos seguros de ambiente. Nunca compartilhar em chat/repositório.
4. Definir `NEXT_PUBLIC_SITE_URL` com a URL final exata. No Supabase Auth, ajustar Site URL e permitir a URL final `/auth/confirm` e a variante `?next=recover` em Redirect URLs. Configurar SMTP para e-mails de produção e conferir quotas de Auth.
5. Os links padrão PKCE funcionam no mesmo navegador que solicitou cadastro/recuperação. Para links acessíveis em outro dispositivo, configurar templates Supabase com `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` (confirmação) e URL final `/auth/confirm?token_hash={{ .TokenHash }}&type=recovery` (recuperação); não concatenar segundo `?` se RedirectTo já tiver query. A rota valida tipos e sempre redireciona para caminho local.
6. Testar cadastro com e-mail controlado, confirmação, login, recuperação, empresa vazia, convites e captura antes de liberar para clientes.
7. Preservar Deployment Protection. Para webhooks externos, usar domínio de produção permitido pela política atual da equipe, ou uma exceção específica aprovada; não desabilitar a proteção global.

## Empresas e equipe

Um usuário pertence a uma empresa neste MVP. O primeiro cadastro confirmado cria a empresa e o administrador. O administrador gera convite para um e-mail específico, válido por sete dias. O link é entregue manualmente; o CRM não envia convites automaticamente. Quem já pertence a outra empresa precisa usar outro e-mail neste MVP. A senha do convidado é escolhida pelo próprio convidado.

Leituras são isoladas por RLS. Escritas passam por funções com validação da identidade, papel e empresa. Criar lead, atribuir nota, criar tarefa e registrar atividade ocorre numa única transação. Metadados de Auth servem apenas para nomes e preferências iniciais, nunca para promover papéis ou escolher company_id.

## Entrada de leads

Administrador → Automações → Gerar token. A rotação invalida o token anterior. O banco armazena só o hash. `/api/capture` exige:

```http
POST /api/capture
Authorization: Bearer TOKEN
Idempotency-Key: identificador-estavel-do-evento
Content-Type: application/json

{"name":"Nome real do contato","phone":"DDINUMERO","message":"Pedido recebido","utm_campaign":"campanha"}
```

Resposta 202 significa persistido na fila, não processamento concluído. Repetir com a mesma chave não cria nova tarefa. Há limite de 120 novas entradas/minuto por empresa; 429 retorna `Retry-After: 60`. O emissor deve aguardar e repetir com a mesma chave. Tokens inválidos não escrevem na fila. UTM/canal não substitui integração oficial de atribuição de anúncios.

## Instagram e WhatsApp

Webhook único: `/api/webhooks/meta`. GET valida challenge/verify token; POST valida HMAC-SHA256 sobre os bytes originais. Instagram: mensagens recebidas, ignorando echoes e exclusões. WhatsApp: mensagens recebidas, ignorando status de entrega. Mídia vira indicação textual; não há download de anexos.

Para ativar cada empresa: autorizar conta profissional/app Meta e permissões necessárias, configurar assinatura de eventos, validar propriedade da conta e cadastrar via administrador de plataforma uma linha de `crm_channels` com `company_id`, `provider`, `external_id` (Instagram recipient ID ou WhatsApp phone_number_id), `label`, `enabled=true`. IDs devem vir da conta autorizada, nunca do preenchimento livre pelo usuário do CRM. O MVP ainda não tem onboarding OAuth/Embedded Signup self-service nem cofre de tokens de envio. O mapeamento conta→empresa é exclusivo e configurado no servidor.

Não há autorização nem implementação para disparos a seguidores ou envio de mensagens. Respostas, templates, janela de atendimento e conversões da Meta precisam ser implementados/validados antes de habilitar envio. Gastos de anúncios continuam manuais.

## WhatsApp oficial (coexistência)

Número continua no aplicativo WhatsApp Business e passa a funcionar também no CRM, pela API oficial da Meta (Cloud API) com coexistência via EasyCoexistence. Sem WhatsApp Web, bibliotecas não oficiais ou envio em massa.

**Fluxo**

1. Meta → `POST /api/webhooks/whatsapp/<WHATSAPP_WEBHOOK_KEY>` → `wa_ingest()` grava o evento deduplicado e responde 200. Falha no banco → 503 e a Meta reenvia.
2. `crm_private.wa_run_events()` processa no banco (pg_cron `viestro-wa-process-events` a cada minuto e logo após cada webhook): contatos, conversas, mensagens, ecos do app (`smb_message_echoes`), status, histórico de até 6 meses (`history`) e nomes da agenda (`smb_app_state_sync`, só para quem já conversa).
3. Operador responde pelo CRM → `crm_wa_send_text`/`crm_wa_send_template` validam empresa, janela de 24h, consentimento e enfileiram em `wa_outbox` → backend envia para a Cloud API com o token do número guardado no Supabase Vault.

**Segurança**

- A Meta assina as entregas com o segredo do app do provedor, que não é compartilhado; a autenticação é a chave longa no caminho da URL (recomendação oficial do provedor) + mapeamento `phone_number_id → empresa` feito no servidor. Chave errada → 404.
- Leitura pelo app: RLS por `company_id`. Escrita: só pelas funções do banco. `wa_webhook_events`, `wa_outbox` e a coluna do cofre não são visíveis para usuários.
- Token só segue para `https://graph.facebook.com/vNN.N`. Logs não registram conteúdo nem token.
- Execução interrompida sem resposta da Meta não é reenviada (evita mensagem duplicada ao cliente); fica como "Resultado desconhecido".
- Texto livre só dentro da janela de 24h; template de marketing exige consentimento com evidência, respeita descadastro (SAIR/PARAR/STOP/CANCELAR) e limite de 1 por contato a cada 24h.
- Lead automático desligado por padrão (`settings.wa_auto_lead`); o operador cria o lead pela conversa.

**Caixa de entrada (menu WhatsApp):** lista com filtros (não lidas, aguardando resposta, minhas, sem responsável, resolvidas) e busca; conversa com origem de cada mensagem (cliente, CRM, celular, histórico) e status de entrega; resposta livre só com a janela de 24h aberta, senão envio de template; status, tipo de atendimento, responsável, criação de lead com um clique e registro de autorização para promoções. Atualiza a cada 10 s (conversa aberta a cada 5 s). Sem login, mostra uma demonstração de pet shop com dados fictícios.

**Variáveis (Vercel, somente servidor):** `WHATSAPP_WEBHOOK_KEY` (32+ caracteres aleatórios), `WHATSAPP_VERIFY_TOKEN` (32+), `WHATSAPP_GRAPH_BASE` (opcional, padrão v26.0), além de `SUPABASE_SECRET_KEY` e `CRON_SECRET` já existentes.

**Ativar um número (somente com autorização):** conectar pelo EasyCoexistence com QR code (nunca código SMS); salvar o token no Vault do Supabase com nome `wa_token_<phone_number_id>`; cadastrar `crm_channels` (provider `whatsapp`, `external_id` = phone_number_id) e `wa_accounts` com o id do segredo; apontar o destino do webhook no provedor em até 24h para receber o histórico.

**Testes:** `npm test` (normalização, chave, classificação de erros); `tests/whatsapp_database.sql` e `tests/whatsapp_isolamento.sql` (em transação com rollback; nunca em produção com comandos de exclusão).

## Fila e execução

- Eventos são persistidos antes do ACK. Chave única por empresa/evento deduplica reentregas.
- `after()` inicia lote curto após webhook/captura; falhas permanecem na fila.
- Worker `/api/worker` exige `Authorization: Bearer CRON_SECRET`. Nunca coloque segredo na query string.
- Reserva atômica com `FOR UPDATE SKIP LOCKED`, lease de dois minutos e token por tentativa. Execução de lead/atividade e conclusão transacionais evitam efeito parcial.
- Até oito tentativas; intervalo exponencial com jitter, teto aproximado de uma hora. Expiração da última tentativa vira `failed`.
- Executor Supabase Cron **ativado**: job `vertice-crm-process-events`, a cada minuto, chama `crm_private.run_queue()` para processar até vinte eventos por passagem. Não chama APIs externas nem gera custos de IA. A reserva é compatível com os lotes imediatos da aplicação; não há cron Vercel obrigatório. A fila pode acumular atraso se o volume superar a capacidade; monitorar status e duração. O cron para se o projeto Supabase for pausado.
- Lotes imediatos de até dez eventos; banco indexado, sem polling no navegador. Limites de provedores e planos continuam existindo.
- Registros pessoais e jobs não têm política automática de retenção no MVP; configurar retenção, backups e monitoramento conforme a operação antes de escalar.

O motor existente foi encontrado em `jonassantto1996-collab/vertice-motor-automacao` / projeto Vercel homônimo. O código agenda `/api/cron-processar-fila` às 11h UTC e processa um item/dia de prospecção/criação de projetos. Sete respostas HTTP 200 foram observadas nos sete dias consultados; isso confirma chamadas, não valida qualidade de resultados gerados. A fila CRM é independente para não misturar criação de sites/IA com contatos reais. Não foi ativado consumo da fila antiga nem geração paga de IA.

## Limites do MVP

Dashboard carrega os 1.000 registros mais recentes e avisa quando o recorte é atingido; indicadores refletem esse recorte. Antes de bases maiores, adicionar paginação por entidade e agregações SQL de métricas. Não há importação automática da base antiga, caixa de conversas completa, respostas Meta, pagamentos, upload de anexos ou app mobile nativo. Recuperação/cadastro dependem da configuração de e-mail/redirect no projeto Supabase.

## Verificação

- `tests/meta.test.mjs`: assinatura válida/inválida; alterações de payload; filtro de echoes/exclusões; status do WhatsApp; mapeamento de remetente por conta.
- `tests/database.sql`: cria fixtures em transação e faz rollback; verifica RLS, qualificação 75, tarefa automática, bloqueio de promoção de papel/worker, deduplicação de contato, reserva de fila, retry e expiração. Executar somente por papel administrativo em ambiente controlado.
- Advisors de segurança do Supabase: nenhuma ocorrência nova para objetos CRM. Avisos preexistentes: `public.set_updated_at` sem search_path fixo e `fila_vertice` com RLS sem policy. Não foram alterados porque pertencem ao motor atual. Referências: https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable e https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy.

HTTP smoke: página 200, sessão anônima sem dados, CSRF 403, worker/captura sem credencial 401 e Meta não configurada 503. O executor SQL foi chamado sem eventos e o agendamento está ativo; a primeira execução automática às 04:28 UTC de 24/09/2026 terminou com status succeeded. A verificação visual desta versão não foi concluída porque o navegador não alcançou o servidor local; build e rotas foram verificados.

O projeto Supabase já possui migrations de outros produtos. Este repositório contém somente as quatro migrations do CRM, com versões reconciliadas com o histórico remoto. Não use `supabase db push` no projeto compartilhado antes de reconciliar o histórico completo com o repositório proprietário do banco.

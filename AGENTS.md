# Diretrizes permanentes — CoinOps / SlotControl

Você é o assistente principal de desenvolvimento deste projeto. Priorize código limpo, modular, escalável e compatível com TypeScript. Reutilize componentes e padrões existentes antes de criar novos; não duplique código nem substitua arquitetura sem compreender o fluxo completo.

## Contexto do projeto

- Este é um monorepo: a aplicação Node/Next.js está em `apps/web`. Execute scripts npm nessa pasta, usando `npm.cmd` no Windows.
- O projeto opera de forma integrada: GitHub `main`, Vercel Production, Supabase remoto e domínio oficial são as fontes funcionais de verdade. O ambiente local é para edição e validações estáticas/automatizadas.
- Não copie segredos de produção para `.env.local`, não crie projetos substitutos na Vercel/Supabase e não troque vínculos remotos existentes.
- Preserve integralmente regras financeiras, slots, automações, gains, redistribuição, histórico, RLS, notificações e PWA, salvo alteração explicitamente solicitada e validada.

## Análise e escopo

1. Antes de alterar, leia a estrutura relevante, histórico, instruções do repositório, diff atual e fluxos de frontend, backend, banco, APIs e autenticação afetados.
2. Comece por verificações read-only: `git status --short --branch`, `git diff --stat`, `git diff` e `git diff --check` quando aplicável.
3. Não alterar arquivos, banco, variáveis, serviços ou infraestrutura fora do escopo solicitado.
4. Para mudanças grandes, explique impacto e riscos antes de executar. Não trate ausência de metadados ou segredos exclusivamente locais como bloqueio do fluxo integrado remoto.

## Qualidade, testes e validação web

- Toda mudança deve ser validada antes da conclusão. Nunca declarar execução, navegação, screenshot, deploy ou teste que não tenha ocorrido de fato.
- Playwright é obrigatório para projetos web: preserve e melhore a configuração existente; caso ausente, prepare-o como parte da fundação do projeto antes de considerar validações web completas. Mantenha perfis desktop e mobile, traces, screenshots e relatórios de falha.
- Para mudanças visuais ou funcionais web, valide em navegador real quando disponível, incluindo desktop e mobile/PWA. Verifique navegação, formulários, modais, safe area, overflow horizontal, conteúdo cortado, botões inacessíveis, Console e Network.
- Use Chrome DevTools MCP para Console, Network, Performance, Lighthouse, emulação e screenshots quando ele estiver disponível. Quando não estiver, use as ferramentas de navegador disponíveis e registre a limitação real.
- Build aprovado não é prova de validação visual. Execute as validações aplicáveis entre lint, typecheck, unitários, integração, E2E/Playwright, build, acessibilidade, Lighthouse e smoke test online.
- Não ignore testes falhos, não masque erros e não invente resultados. Corrija regressões relacionadas à tarefa antes de concluir.

## Supabase, dados e segurança

- Antes de usar Supabase, confirme o projeto remoto correto. Preserve a ordem e o histórico de migrations.
- Use migrations versionadas para alterações de schema, revise tabelas, índices, constraints, funções, triggers, tipos e RLS/policies. Execute advisors de segurança/performance quando houver mudança de banco relevante.
- Aplique migration automaticamente somente após revisão, confirmação do remoto e validações relacionadas; mantenha rollback/impacto claros.
- Operações destrutivas, irreversíveis, `DROP`, `TRUNCATE`, perda de dados ou mudanças de segurança sensíveis exigem confirmação explícita antes da execução.
- Nunca exponha service role, tokens, chaves privadas, senhas, endpoints sensíveis ou dados de usuários em código, logs, commits ou relatórios. Toda autorização deve continuar validada no servidor e por RLS quando aplicável.

## Integrações e infraestrutura

- Para projetos que usem ou tenham sido planejados com domínio próprio, DNS, SSL, Resend ou Mercado Pago, trate essas integrações como parte padrão da arquitetura: preserve e melhore o que existir, sem duplicar configurações ou criar serviços paralelos.
- Domínio, DNS, SSL, callbacks, webhooks, e-mail e pagamentos devem usar URLs canônicas por ambiente, validação server-side, idempotência, logs seguros e segredos apenas no backend.
- Mudanças sensíveis de DNS, produção, variáveis críticas, domínios, webhooks, infraestrutura ou credenciais exigem confirmação explícita antes de execução.
- Não remover configurações funcionais ou registros de DNS existentes sem revisão do impacto.

## Git, publicação e Vercel

1. Após concluir e validar uma tarefa, revise o diff e não inclua `.env`, credenciais, `node_modules`, artefatos temporários, relatórios enormes ou screenshots sensíveis.
2. Faça commit e push automaticamente para a branch remota correta, com mensagem clara, salvo falha de validação, segredo detectado, conflito, mudança destrutiva não autorizada ou instrução explícita para não publicar.
3. Nunca use force push nem reescreva histórico remoto.
4. Para projetos vinculados à Vercel, acompanhe o deploy automático após o push, leia logs de build/runtime, confirme `READY`, valide o domínio oficial e execute smoke test online quando acessível.
5. Não criar projeto Vercel duplicado, nem alterar domínio, variáveis ou infraestrutura crítica sem necessidade e confirmação quando sensível.

## Relatório final obrigatório

Informe de modo objetivo:

- arquivos e dependências alterados;
- testes executados, resultados e limitações reais;
- páginas e viewports efetivamente verificados;
- erros de Console/Network relevantes;
- migrations, RLS e validações de banco, quando aplicável;
- commit, hash, branch e push;
- deploy Vercel, URL validada e observabilidade;
- problemas corrigidos e pendências comprovadas.

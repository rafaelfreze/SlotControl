# Administração de clientes e acessos — 16/10/2026

A área Usuários e acessos, dentro de Configurações, apresenta quatro indicadores derivados dos acessos do operador autenticado, seis cadastros recentes, lista de dez por página e busca. O diálogo Gerenciar concentra as ações existentes e permite consultar somente contas que o backend já retornou para este operador. Cadastro conserva os cinco campos e a idempotência existentes.

Não foi criado acesso Master entre operadores. O produto mantém operator_id, exchange_account_id e engines próprios; um cliente VIEWER continua limitado à sua conta e somente leitura. A seleção de consulta usa o contrato existente da aplicação. Não há editor de landing neste produto.

Escopo: viewer-users-panel.tsx e seu CSS. Dashboard operacional, cards financeiros, estratégia, engine, executor, APIs, Auth, RLS, billing e migrations não foram alterados. Backend Platform otdfpmsegjxpqrzisfmi, schema coinops, preservado. Nenhuma ordem, ativação, reconciliação, e-mail, credencial ou operação em conta real foi feita para testar esta alteração. Não exige restart ou deploy de VPS.

Validação: 21 testes de políticas/cadastro de viewers, lint dirigido, typecheck e build aprovados. Fingerprint do workload financeiro preservado (42bddbc53c9c21b19c33e594dd85275234aacfb78a2e04016ec8586e8bf49c4e). QA com componentes reais, PremiumDrawer e dados sintéticos em Chrome 390x900 e 1366x900 verificou paginação 6/10/2, diálogos sem overflow, Escape sem fechar Configurações, campos de cadastro e nenhuma requisição de escrita. QA sintética não prova operação financeira nem sessão autenticada de produção.

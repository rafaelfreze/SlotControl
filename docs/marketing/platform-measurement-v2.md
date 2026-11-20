# CoinOps: mensuração institucional v2

Escopo exclusivo: site público https://cripto-flax.vercel.app, tenant técnico `platform`. Backend OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`. Não consulta nem exporta dados financeiros, clientes autenticados ou trading.

- SDK 1.4.18: eventos operacionais sem atribuição opcional quando consentimento recusado; uma sessão lógica deduplica contato entre páginas.
- Writer `/api/marketing/platform` usa callback v2, filtro QA e páginas públicas.
- Export `POST /api/marketing-hub/export-v2` usa HMAC institucional existente, nonce consumido por `claim_website_read_nonce_v1`, caminho exato assinado e DTO v2. Outros tenants são rejeitados.
- Dashboard nativo usa a mesma fonte v2; padrão mês atual. Fonte indisponível não vira zero e histórico v1 não entra na nova base.
- Migration 20261120130556: quatro tabelas RLS, leitura/escrita RPC somente service_role, epoch imutável, projeção comercial vazia. Nenhuma baseline ou evento falso é criado pela migration.

Ativação operacional deve acontecer somente após deployment READY do código v2. A RPC `activate_marketing_measurement_epoch_v2('platform', <UUID novo>, null)` fixa o instante real e aceita somente ator de sistema. Não retroagir o corte, não recriar uma ativação existente. Rollback do código preserva as tabelas e o histórico; não apagar a epoch para simular continuidade.

Validação: testes isolados de adapter/QA, execução PostgreSQL local com pgcrypto e readback remoto de ledger/RLS. Nenhum clique, contato, pedido, pagamento ou ordem real é usado como smoke.

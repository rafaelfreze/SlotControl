# CoinOps — assinatura comercial central

## Escopo

A assinatura comercial usa o UUID do usuário Auth como identidade estável. Um operador com várias contas de negociação não ganha cobranças por conta. O vínculo é explícito no Master OnPlay Fiscal, com um contrato mensal CoinOps real, ativo e ainda disponível no FinOps. Não existe catálogo/preço inventado nem cobrança no cadastro genérico.

Backend oficial: Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`. Produção: Vercel `cripto`, root `apps/web`, domínio `https://cripto-flax.vercel.app`. A camada recusa configurações de backend/schema diferentes. O ambiente local legado permanece preservado e não é fonte para migrations remotas.

Esta camada não altera execução, ordens, capital, engines, workers, autenticação operacional, Binance ou políticas de acesso aos motores. Status financeiro é exibido no portal comercial. Nenhum worker é reiniciado por sincronização de assinatura.

## Onboarding e operação

1. No FinOps, confira o contrato mensal real, cliente, empresa recebedora, valor, início, vencimento e consentimento de contato.
2. Em Master → Assinaturas SaaS → Vincular acesso CoinOps, descubra os usuários ativos pelo backend CoinOps.
3. Selecione o usuário e o contrato disponível. O servidor revalida membership, produto, status, contrato, preço e contato; o browser não fornece preço nem cria cliente/contrato paralelo.
4. O usuário acessa `/assinatura` com seu login existente. Ele vê mensalidade, vencimento, pagamento confirmado e cobrança disponível. A primeira visita não cria assinatura.
5. Atualizar assinatura consulta a Central assinada e persiste somente a projeção sanitizada. Pagar abre o checkout temporário da cobrança existente na Central, sem armazenar sua URL.

Usuários VIEWER ativos usam o mesmo portal, somente para sua identidade. Membership, viewer ou Auth revogados impedem leitura própria; pagamentos/cancelamentos ainda podem atualizar o histórico de uma assinatura previamente vinculada.

## Contrato e segurança

- `POST /api/integrations/onplay-billing/tenants`: descoberta de identidades comerciais ativas, paginada, sem e-mail, exchange, capital ou executor.
- `POST /api/integrations/onplay-billing/events`: projeção assinada com nonce/evento idempotentes, produto, identidade, assinatura imutável e versão crescente.
- `POST /api/integrations/onplay-billing/reconcile`: nonce e lease de 90 segundos confirmados antes do ACK 202. O lote de até 20 assinaturas continua por `waitUntil`; checkpoint somente depois de toda a página aplicada. Aceito e worker ocupado não alegam sincronização concluída.
- `POST /api/assinatura`: sessão real, identidade ativa, Origin e intenção obrigatórios; somente sync/checkout. Não recebe tenant ou preço do usuário.

HMAC v1 cobre método, rota, produto, timestamp, nonce e corpo. Janela de cinco minutos, corpo limitado e nonces duráveis. `saas_billing_projections` tem RLS por usuário; eventos, nonces e sync são exclusivos server-side. A projeção não armazena checkout, token ou contato. As funções de escrita são service-only e usam search_path vazio.

Secrets Production exclusivos do produto: `ONPLAY_BILLING_SECRET`; rotação opcional `ONPLAY_BILLING_PREVIOUS_SECRET` + `ONPLAY_BILLING_PREVIOUS_VALID_UNTIL`. `ONPLAY_BILLING_ORIGIN` opcional aceita somente a origem oficial OnPlay Fiscal. Nunca usar NEXT_PUBLIC para secrets.

## Histórico e troubleshooting

Sem vínculo: exibe Nenhuma assinatura vinculada. Sem backend/configuração: Indisponível. Falha de sync mantém projeção/checkpoint anteriores; retry pode reaplicar uma página sem duplicar assinatura ou cobrança. Mudança de subscription ID de um usuário já vinculado é rejeitada. Suspensão operacional continua sob os fluxos próprios CoinOps.

Offboarding comercial cancela/revoga na Central e preserva histórico. Revogação de acesso CoinOps usa os fluxos administrativos existentes; ela não é substituída por uma alteração de contrato.

Migration efetiva: `20261011223915_coinops_commercial_billing.sql`, aplicada e conferida em 11/10/2026 no projeto `otdfpmsegjxpqrzisfmi`, schema `coinops`. Não reaplicar nem editar o SQL aplicado. Testes SQL usam banco efêmero; nunca criam financeiro ou ordens em produção.

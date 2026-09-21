# Execution Engine Binance — Shadow (Fase 1)

## Estado e limites

O motor introduz a fronteira `Strategy Engine → Order Intent → Execution Engine → Exchange Adapter → Binance Spot` sem alterar as regras existentes de slots, gains, ATH, histerese, prioridades, pools, ciclos, aportes, redistribuição ou notificações.

O único modo persistível nesta fase é `SHADOW`. O banco recusa `LIVE`; o adaptador não contém transporte autenticado nem implementação HTTP para criar ou cancelar ordens; `createOrder` e `cancelOrder` lançam `COINOPS_LIVE_EXECUTION_BLOCKED_PHASE_1`. Não existe armazenamento de chave Binance, secret, senha, 2FA, seed ou capacidade de saque.

## Persistência e segurança

- `coinops.exchange_connections`: metadados de conexão, sem credenciais.
- `coinops.execution_engine_settings`: controles globais fail-closed. O kill switch começa ativo.
- `coinops.execution_asset_settings`: controles separados para BTC e SOL; cada automação começa desabilitada e com kill switch ativo.
- `coinops.exchange_order_intents`: intenção auditável, em `SHADOW_RECORDED`, com preço observado, quantidade calculada, motivo, regime, slot e chave SHA-256 determinística.

A restrição única por `product_id, tenant_id, user_id, idempotency_key` impede repetição por retry, refresh ou reinício. As tabelas usam RLS, `FORCE ROW LEVEL SECURITY` e leitura autenticada somente no escopo CoinOps; apenas `service_role` pode inserir a intenção técnica.

O bridge do cron observa somente slots `hold` cujo preço de mercado alcançou o gatilho já calculado pela estratégia. Ele só registra se houver configuração Shadow explícita, kill switches liberados e limites de notional/idade do preço atendidos. O estado padrão não grava nada. Em nenhum caso o bridge chama o adaptador de exchange.

## Capital, filtros e reconciliação

O tamanho inicial de slot é `capital da estratégia / 25`; não há valor fixo de USDT no motor. BTC e SOL são configurados e limitados separadamente.

O motor valida idade de cotação, notional por ordem/dia, saldo simulado insuficiente, duplicidade e estado do slot. O adaptador expõe leitura futura de `getAccount`, `getBalances`, `getSymbolInfo`, `getMarketPrice`, `getOpenOrders`, `getOrder` e `getTrades`; `getSymbolInfo` prepara `minQty`, `minNotional` e `stepSize`. Fills parciais são classificados em `PENDING`, `PARTIALLY_FILLED` ou `FILLED` somente para reconciliação simulada.

Na Fase 2, antes de qualquer modo LIVE, a Binance deve ser a fonte de verdade de saldo, ordens abertas, ordens executadas, fills parciais e trades. O CoinOps continuará sendo a fonte de verdade para estratégia. Todo restart deverá executar reconciliação antes de qualquer executor; qualquer erro, preço obsoleto, timeout ou limite tende a não operar.

## Próximo passo permitido

Conectar somente leitura com credenciais criptografadas e referência a secret manager, implementar reconciliador de saldos/ordens/fills e validar Shadow com dados reais de leitura. `LIVE` exige decisão explícita posterior, revisão de segurança, reconciliação íntegra e uma migration própria; não faz parte desta fase.

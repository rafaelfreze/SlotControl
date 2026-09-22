# Execution Engine Binance — Shadow e Reconciliação Read-only (Fases 1 e 2)

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

## Fase 2 — Binance somente leitura

`BinanceSpotAdapter` agora assina apenas requisições `GET` para os endpoints Spot de conta, permissões, saldos, `exchangeInfo`, preços, ordens abertas, consulta de ordem e `myTrades`. O relógio é sincronizado pelo endpoint público de tempo antes da primeira consulta assinada; `recvWindow` é 5 segundos e falhas transitórias de rede, 429 e 5xx têm somente um retry seguro. Nenhum método HTTP `POST`, `PUT` ou `DELETE` é usado pelo adaptador.

As únicas variáveis de ambiente aceitas são `BINANCE_API_KEY`, `BINANCE_API_SECRET` e `COINOPS_BINANCE_CONNECTION_ID`. A chave e o secret nunca entram no banco, browser, localStorage, URL, logs ou payload de rota. A tabela de conexão conserva somente um sufixo mascarado da chave e a referência textual `SERVER_ENV:BINANCE_READ_ONLY`.

O cron protegido `/api/cron/exchange-reconciliation` executa no máximo uma reconciliação por conexão a cada janela de cinco minutos. A execução lê dados da exchange, registra um snapshot e itens em `exchange_reconciliation_runs` e `exchange_reconciliation_items`, e não modifica slots, gains, saldos internos nem status de estratégia. Se a conexão, credenciais ou variáveis não estiverem configuradas, ele falha fechado sem chamar a Binance.

Binance é a fonte de verdade para saldos, ordens e fills. CoinOps é a fonte de verdade para regras e intenções Shadow. Um trade ou ordem histórica só é associado quando houver o `clientOrderId` determinístico de uma intenção; sem isso, permanece `EXCHANGE_ONLY`. O sistema nunca adivinha que um trade antigo pertence a um slot.

## Recuperação e limites

Após restart, a reconciliação idempotente ocorre antes de qualquer futura capacidade de execução. Estados `MATCH`, `EXPECTED_ONLY`, `EXCHANGE_ONLY`, `QUANTITY_MISMATCH`, `PRICE_MISMATCH` e `STATUS_MISMATCH` são auditáveis e não geram correção financeira automática. A tela `/automacao` mostra apenas o status, saldos BTC/SOL/USDT, última reconciliação e intenções Shadow do escopo autenticado.

## Próximo passo permitido

Para habilitar a leitura da conta do Rafael, crie uma chave Binance com leitura e restrição IP adequadas, configure as três variáveis exclusivamente no ambiente server-side e crie o registro de conexão no escopo CoinOps correto. Isso é a única dependência humana: o CoinOps não cria, revela nem persiste credenciais. `LIVE` exige decisão explícita posterior, revisão de segurança, reconciliação íntegra e uma migration própria; não faz parte desta fase.

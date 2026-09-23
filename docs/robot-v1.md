# CoinOps Robot V1

The manual operation remains **BTCUSDT** and **SOLUSDT** and is never selected, created, modified, or cancelled by Robot V1. Robot V1 owns only **BTCUSDC** and **SOLUSDC**.

Each asset has an independently configured USDC capital allocation. The fixed 25-slot notional is `configured capital / 25`. `V1_RULES` preserves the future official BTC (2% spacing / 1.2% gain) and SOL (3% / 5.5%) defaults; the separate `V1_TEST_PROFILE` is 0.5% gain / 1% spacing / 25 slots / 250 USDC per asset. The test preset never authorizes LIVE and does not retroactively alter an open cycle. Prices and quantities are normalized to the current Binance symbol filters.

Modes are fail-closed: `SHADOW` records deterministic market-observed fills; `TESTNET` uses a separately credentialed Binance Spot Testnet adapter for BTCUSDC and SOLUSDC; `LIVE` is not a persisted or runnable V1 mode. Production Binance has a GET-only adapter. Testnet credentials are `BINANCE_TESTNET_API_KEY` and `BINANCE_TESTNET_API_SECRET`, never Production credentials.

Every V1 order uses a deterministic `COV1-...` client order id plus an idempotency hash. Recovery reconciles first and executes second. Partial fills only permit a take-profit quantity no larger than the confirmed executed amount. A cycle can reset only when every position and TP is closed; only V1-owned pending BUYs are eligible for cancellation in Testnet, never manual orders or a global cancel-all.

Fees from fills are retained separately from gross PnL so the strategy percentage is never represented as a guaranteed net return.

## Controle Shadow

`/automacao` permite ao proprietário autenticado configurar capital virtual, gain e spacing do próximo ciclo por ativo, aplicar o preset rápido, iniciar o teste Shadow, pausar somente novas entradas, retomar e acionar o kill switch. O snapshot do ciclo ativo e seus TPs não mudam. Na virada, uma RPC restrita ao service role ajusta as 25 contas físicas pelo delta de capital, preservando lucro, gains e histórico de operações; uma configuração incompatível com filtros ou saldo é rejeitada antes da virada.

## Testnet BTC e SOL

Cada ativo possui ciclo, lease, ordens, idempotência, filtros, capital lógico e reconciliação independentes. O primeiro ciclo novo usa o `V1_TEST_PROFILE`; ciclos SOL preexistentes conservam o próprio snapshot, compounding e clientOrderId originais. Uma próxima configuração é salva em colunas `next_*` do run e só é aplicada por RPC transacional depois do TP terminal, com validação de filtros, saldo lógico e capital fictício. A UI expõe configuração atual e próxima por ativo. O cron processa ambos mesmo quando um falha. O transporte de escrita aponta somente para `testnet.binance.vision`; o usuário não dispõe de botão LIVE.

O cron protegido executa a cada cinco minutos em `gru1`. Para não perder níveis entre execuções, o worker recupera candles públicos de um minuto da Binance por GET e os persiste. Uma baixa que cruza uma entrada cria fill Shadow no preço planejado; uma alta que alcança TP fecha apenas posições que já estavam ativas no começo da vela. BUY e TP no mesmo candle ficam auditados como `INTRABAR_AMBIGUOUS`, sem gain fabricado.

Os ciclos e eventos operacionais mantêm o marco de 30 dias, checkpoints de candle e trilha de auditoria por tenant/usuário. Nada desse fluxo cria uma ordem, cancelamento, transferência ou saque na Binance Production.

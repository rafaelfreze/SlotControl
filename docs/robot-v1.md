# CoinOps Robot V1

The manual operation remains **BTCUSDT** and **SOLUSDT** and is never selected, created, modified, or cancelled by Robot V1. Robot V1 owns only **BTCUSDC** and **SOLUSDC**.

Each asset has an independently configured USDC capital allocation. The fixed 25-slot notional is `configured capital / 25`. BTC entries are compounded at 2% below the previous level and take profit at 1.2% above the confirmed average fill; SOL uses 3% and 5.5%. Prices and quantities are normalized to the current Binance symbol filters.

Modes are fail-closed: `SHADOW` records deterministic market-observed fills; `TESTNET` is reserved for a separately credentialed Binance Spot Testnet adapter; `LIVE` is not a persisted or runnable V1 mode. Production Binance has a GET-only adapter. Testnet credentials, if later provisioned, are `BINANCE_TESTNET_API_KEY` and `BINANCE_TESTNET_API_SECRET`, never Production credentials.

Every V1 order uses a deterministic `COV1-...` client order id plus an idempotency hash. Recovery reconciles first and executes second. Partial fills only permit a take-profit quantity no larger than the confirmed executed amount. A cycle can reset only when every position and TP is closed; only V1-owned pending BUYs are eligible for cancellation in Testnet, never manual orders or a global cancel-all.

Fees from fills are retained separately from gross PnL so the strategy percentage is never represented as a guaranteed net return.

## Controle Shadow

`/automacao` permite ao proprietário autenticado configurar capital virtual por ativo, iniciar o teste Shadow, pausar somente novas entradas, retomar e acionar o kill switch. O capital de um ciclo ativo é salvo como capital do próximo ciclo; níveis ou posições existentes nunca são recalculados. Os parâmetros V1 (25 slots, spacing e gain) permanecem somente leitura.

O cron protegido executa a cada cinco minutos em `gru1`. Para não perder níveis entre execuções, o worker recupera candles públicos de um minuto da Binance por GET e os persiste. Uma baixa que cruza uma entrada cria fill Shadow no preço planejado; uma alta que alcança TP fecha apenas posições que já estavam ativas no começo da vela. BUY e TP no mesmo candle ficam auditados como `INTRABAR_AMBIGUOUS`, sem gain fabricado.

Os ciclos e eventos operacionais mantêm o marco de 30 dias, checkpoints de candle e trilha de auditoria por tenant/usuário. Nada desse fluxo cria uma ordem, cancelamento, transferência ou saque na Binance Production.

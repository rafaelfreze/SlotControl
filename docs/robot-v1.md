# CoinOps Robot V1

The manual operation remains **BTCUSDT** and **SOLUSDT** and is never selected, created, modified, or cancelled by Robot V1. Robot V1 owns only **BTCUSDC** and **SOLUSDC**.

Each asset has an independently configured USDC capital allocation. The fixed 25-slot notional is `configured capital / 25`. BTC entries are compounded at 2% below the previous level and take profit at 1.2% above the confirmed average fill; SOL uses 3% and 5.5%. Prices and quantities are normalized to the current Binance symbol filters.

Modes are fail-closed: `SHADOW` records deterministic market-observed fills; `TESTNET` is reserved for a separately credentialed Binance Spot Testnet adapter; `LIVE` is not a persisted or runnable V1 mode. Production Binance has a GET-only adapter. Testnet credentials, if later provisioned, are `BINANCE_TESTNET_API_KEY` and `BINANCE_TESTNET_API_SECRET`, never Production credentials.

Every V1 order uses a deterministic `COV1-...` client order id plus an idempotency hash. Recovery reconciles first and executes second. Partial fills only permit a take-profit quantity no larger than the confirmed executed amount. A cycle can reset only when every position and TP is closed; only V1-owned pending BUYs are eligible for cancellation in Testnet, never manual orders or a global cancel-all.

Fees from fills are retained separately from gross PnL so the strategy percentage is never represented as a guaranteed net return.

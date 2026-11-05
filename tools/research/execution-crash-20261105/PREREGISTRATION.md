# Execution crash candidate — 05/11/2026

Recorded before executing the new historical comparison. OFFLINE; no LIVE switch.
Code anchor e9491ceb; old research data anchor 808247906fec3a8c2eb7d6a9314404926e86529b.

Price signal: closed native5m observations,5/15/60min losses. BTC floors2/3.5/6%;
SOL3/5/9%. Each threshold is the greater of that floor,4 prior-candle realized
standard deviations scaled by square root of window, and the previous calendar
year99.9th percentile of positive losses. Minimum8640 prior-year samples.
Training2021; walk-forward2022–2025. No strategy setting enters the detector.
These floors are research severity hypotheses, not statistically certified limits.

Risk pauses new entry decisions; resident zero-fill NEW requires owned ONLY_NEW
cancel claim before dispatch, exact terminal observation and reconciliation.
Partial/unknown financial state never becomes a second BUY. TPs remain supervised.
Confirmation30–180min adapts to shock severity/volatility; continuous calm,
no new low15min, half trigger thresholds and30min range limit required. Missing
data resets continuity. Recovery references fresh stable price, one new prospective
LIMIT at configured spacing; no MARKET and no accumulated missed-level queue.
All financial controls remain independent gates. Prospective reanchoring requires
canonical runtime support; this pure model does not grant permission to edit levels.

Historical price-only benchmark pairs identical initial capital1000 nativequote,
25slots, gainBTC1.2%/SOL5.5%, spacingBTC2%/SOL1%, fees0.10% each side,
slippage2bp on MARKET, same OHLC order semantics and starting conditions.
This is a deliberately limited execution benchmark, NOT the canonic cumulative
goal/ATH/reset engine. It has no order book, historical filters, partial queue,
BNB valuation, historical fee tiers or calibrated cancel latency. It cannot approve
LIVE or estimate accounts' actual P&L. No cross-quote synthesis.

At each bar the previously resident LIMIT may fill BEFORE closed-bar risk detection.
Cancellation takes effect only after that observation. TPs of positions existing
before the bar may fill; BUY→TP within a bar is deferred because path unknown.
At most one new BUY decision per bar. Baseline may consume a crossed next logical
level by MARKET on the next decision; candidate pauses and, after proof assumed by
benchmark, resumes from fresh reference. This models the harmful cascade opportunity,
not proof of exact production timing. Fixed grid until all positions close; then
cash cycle resets. Reinvestment stays within original slot capital plus net realized
gain; no externally added capital. Equal fee/cost/economic settings within pairs.
TP semantics corrected symmetrically after code review: gross average-fill×(1+gain),
CEIL current tick BTCBRL1/BTCUSDT0.01/SOLBRL0.1/SOLUSDT0.01, matching runtime.
Both fees reduce realized net; gain is not a fee-inclusive net target. Historical
tick/filter changes are not reconstructed. Detector thresholds/screens unchanged.
OHLC correction: account for a previously resident BUY fill before any candle-close
reset/cancel, even when an old TP also fits in the same candle. Otherwise TP-first
processing could incorrectly cancel a BUY retroactively. New BUY cannot TP same bar.

Synthetic probes:1/3/5/10% in5min,20% in3h,30% in24h,successive20%/day,
50/70% in1h,fastV,gradual10%/day,lateral multipleTPs and persistent uptrend.
Slot25/50/100 and spacing1/1.5/2/3/5/8% are model probes, not capacity certification.

Predeclared economic screen: no duplicate financial intent or TP mutation; ≥95%
realized-gain count retained, totalreturn delta≥−2pp andDD worsening≤2pp in all
four native markets; marketpause<1% of valid observed time; preserved committed
capital in crash contexts (report all negatives). Failure or unidentifiable data
prevents economic approval. Even PASS cannot certify LIVE without real worker
fixtures, persistence/RLS, crash/fencing, all entry paths, operational cadence,
Binance filter/liq/cancel proofs and report/Watchdog integration.

# Exposure and executor routing reads — 2026-10-14

## Production evidence and historical limits

- Executor 01 / Caixeta SOLBRL: `COINOPS_LIVE_EXPOSURE_UNAVAILABLE`,
  stage/root `ARM_ENTRY` / same code, first seen 21:38:35Z. Watchdog detected
  and held only this engine, but the legacy code was not automatically eligible.
- Executor 01 / Thyely BTCUSDT: `COINOPS_LIVE_RECONCILE_ORDERS_FAILED`,
  root `EXECUTOR_ENGINE_SHARD_DENIED`, first seen 21:41:04Z. Watchdog detected
  at 21:41:46Z, resumed after full proof at 21:42:19Z and closed at 21:42:46Z.
- Both wrappers discarded the original provider response. Historical 503,
  timeout, rate limit or real permission denial is **not proved**. Source and
  offline reproduction prove that failed routing GETs were mislabeled as shard
  denial and exposure GET errors lacked the canonical bounded read policy.
- Caixeta recovered through explicitly authorized official operator RESUME at
  22:00:42Z; Watchdog independently closed at 22:00:46Z. Before recovery, account
  BRL exposure was 189.03645870 against cap 775; all 25 slots/run, fills, scope,
  configuration, intents, dispatches and fresh Binance ownership were proved.
  Its seven TP orders and BUY #8 / Binance ID 433300306 were already resident.
  Recovery did not replace, duplicate or cancel them. Evidence is retained in
  the ledger's LIVE_RESUMED event and the two Watchdog incidents.

## Permanent correction

1. Exposure reads now use the existing strict classifier and two complete
   GET-only attempts, each under a shared 5s abort deadline, separated by 250ms.
   Exhaustion preserves path, attempts, HTTP and sanitized provider code and
   enters the existing normal reconciler checkpoint. No financial step retries.
2. Account exposure includes every ACTIVE/PAUSED run in the same account and
   native quote, across engines and shards. Exact counts, stable complete pages,
   unique IDs, ownership, run/engine/order/slot mapping and physical slots 1..25
   are required. An empty/partial result never means zero exposure. Counts do
   not make cross-engine GETs atomic: changing page counts fail closed.
   `liveEngineExposure` remains the sole, unchanged financial formula.
3. Engine routing GETs use the same bounded read policy. A transient observation
   is `COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE`; non-transient provider failure
   is `COINOPS_EXECUTOR_BINDING_READ_FAILED`. Real absent/foreign/disabled binding
   remains `EXECUTOR_ENGINE_SHARD_DENIED`. Hard errors dominate parallel transient
   reads; only a fully valid binding enters the exact engine-scoped cache.
4. Legacy exposure eligibility is restricted to exact ARM_ENTRY/root evidence.
   New typed exposure/routing outages require allowlisted GET paths. Successful
   reconciliation is necessary, never sufficient: guarded resume still proves
   scope, executor, TP, fills, monthly facts, caps and unchanged incident under
   lease. Pending strategy edits, ambiguous orders, ownership/cap/permission
   failures remain fail-closed. A deliberate PAUSED engine never auto-resumes.
5. Captured stage/root/read-path join code/timestamps and exact engine/account/run
   in the final alert compare-and-set. Changed incidents cannot inherit approval.

## Runbook

First inspect latest alert and Watchdog. Do not interrupt healthy recovery.
For known read outages, let the normal reconciler complete bounded observation
and full proof; Watchdog remains the fallback. Persistent provider failures,
missing/malformed facts, financial ambiguity or actual shard denial require
scoped investigation, never a generic allowlist or manual SQL gate clearing.
Explicit operator RESUME requires current financial proof and the sole immutable
critical; uncertain responses require remote state lookup before any retry.

No new cron/polling frequency, infrastructure, migration/RLS, strategy, spacing,
gain, cap, rank or executor runtime change. Do not use a LIVE order or RESUME as
a smoke. Validate the final web release through normal server-side ticks and
read-only Binance/ledger agreement; preserve intentionally paused accounts.

## Regression evidence

Focused offline tests cover transient GET then success, exhaustion/timeout,
parallel permission precedence, cache eviction, same-symbol cross-shard routing,
complete account/native-quote exposure, first ACTIVE empty-position run, physical
slots and pagination, unknown/malformed/hard-cap fail-closed, exact recovery
fingerprint/CAS, TP preservation, lease fencing and deliberate pause.
See the corresponding `live-exposure-read`, `executor-engine-binding-read`,
`live-read-recovery`, and server reconciliation test files.

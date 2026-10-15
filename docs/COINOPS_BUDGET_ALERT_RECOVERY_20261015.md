# Account-budget alert housekeeping — 2026-10-15

## Incident and evidence

CoinOps Production, project `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Jenny Mae Maria / SOLBRL / Executor 02, engine
`755cf77f-a517-4c84-ac4b-6ee041ed1123`, run
`3f09a415-8fc8-4d7e-908a-7cdca58b4929`.

At 08:11:21Z, `COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_FAILED` was
recorded with stage ARM_ENTRY and the same root code. Watchdog detected it
at 08:11:46Z, blocked only this engine and did not attempt unknown recovery.
The original provider HTTP/code was discarded; a historical 503, timeout or
permission failure is not proved.

Source and an offline reproduction identify the defect: every successful
worker tick attempted an UPDATE of the ACCOUNT_ORDER_BUDGET alert even when
the target did not exist. A failure of that metadata write became a financial
critical and closed the engine/preparation BUY gates. The operational stage
still incorrectly looked like ARM_ENTRY. Production contained no target
ACCOUNT_ORDER_BUDGET alert for this run, so this was an empty housekeeping
UPDATE, not proof of exhausted account order capacity or a Binance rejection.

Before authorized official operator RESUME: 25 physical slots, seven OPENs,
seven resident TP orders and one NEXT BUY #8 matched Binance by exact IDs,
client IDs, side, quantity and price. Zero pending fills, unsettled financial
decisions, unacknowledged dispatches or pending/blocked strategy edits.
Position cost 75.22174031 BRL plus BUY reserve 10.945 BRL = 86.16674031 BRL,
below the unchanged engine/account cap of 275 BRL. Spot BRL and BNB were
available. The seven TPs and BUY 433876331 were already resident.

Official RESUME reopened only this engine after full fresh proof and immutable
incident CAS. Watchdog independently closed the incident HEALTHY at 10:06:46Z.
No order, position, slot, strategy, capital or sibling was manually changed.

## Permanent behavior

- First read the exact owned account-budget alert with the canonical bounded
  GET policy. Absent/already-resolved target means no UPDATE. Healthy empty
  housekeeping cannot cause the original write failure anymore.
- Do not declare current Binance budget PASS or clear a warning merely because
  a cycle returned. KILL_SWITCH, executor unavailable, capital/BNB/quote HOLD,
  partial BUY or inconclusive transition defers cleanup.
- An existing warning requires its exact owned client/order/run/slot/operation,
  completed strategy decision, matching exchange ACK and acknowledged same-shard
  reservation. NEW with zero execution needs no nonexistent fill credit;
  terminal/fill paths still require reconciliation. A different NEXT BUY or
  another engine's order cannot substitute for this proof.
- Renew the actual run lease before metadata CAS. Pin full scope, alert ID/key,
  code, first/last timestamps and run/side/client details. Change only resolved_at.
  One constant timestamp and at most two metadata CAS attempts are permitted.
  Lost responses require exact readback before retry; PostgREST UTC offsets are
  compared as instants. Never retry the financial step, reserve, order or gain.
- Unknown/permission/schema write failures are typed
  `COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED`, not automatically recoverable.
  Exhausted proven transient metadata writes are
  `COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_RETRY`; retain sanitized path,
  attempts, HTTP and provider code. Their stage is RESOLVE_ACCOUNT_BUDGET_ALERT.
  Alert, decision and reservation GET outages retain their distinct GET paths.
- Automatic recovery accepts only exact audited legacy stage/root or new typed
  metadata origin. It first proves fresh health, Binance/ledger agreement, all
  25 slots, TP/fills/monthly facts/caps and settled financial decisions/dispatches.
  It resolves the exact metadata checkpoint under the same lease, rejects
  DEFERRED, rechecks the sole unchanged critical and settled dispatches, then
  opens only this engine's gates by the existing official flow. Metadata path
  joins the incident CAS, including captured absence.

## Validation and limits

Offline regressions cover absent-target zero writes; holds retained; lost
response already applied; transient-before-apply; bounded exhaustion; hard
errors; same-symbol/cross-shard isolation; foreign/changed alert or proof;
NEW zero-fill versus terminal reconciliation; pending decisions/dispatches and
late changes; full protected legacy recovery; critical CAS races.

Production smoke is non-mutating and follows normal server-side ticks. Never
create a test order or issue another RESUME just to demonstrate the fix.
Preserve intentional PAUSED accounts. No migration/RLS, cron/frequency,
infrastructure, shared executor runtime, strategy, spacing, gain, rank, cap or
report format change; existing report version 24 retains diagnostic metadata.

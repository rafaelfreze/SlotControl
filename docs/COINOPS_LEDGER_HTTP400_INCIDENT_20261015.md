# CoinOps — Samya SOLUSDT: HTTP 400 on monthly gains observation

## Scope and observed incident

- Production: `otdfpmsegjxpqrzisfmi`, schema `coinops`.
- Operator: `d508bb3e-5a1d-4579-bd7a-de171c118d25`.
- Account: `95c95966-b92e-4e22-ac03-32a3f1d0bc1b` (Samya).
- Engine: `b4d30a96-71a3-4e44-a633-13bc419be7e1`, SOLUSDT,
  Executor 03, verified egress `167.71.37.166`.
- Run: `89bc316b-8b6d-4e2a-a8c0-e14ecd3889c8`, strategy `4.3.1`.
- Alert: `20a6af71-de02-4f5a-89a7-1c5639e82dec`.
- Watchdog incident: `a45a5200-2a2d-4975-86e8-a0180fb16bad`.

The failed normal tick at 2026-10-15 10:47 UTC (06:47 America/Campo_Grande)
persisted `COINOPS_LIVE_LEDGER_READ_FAILED`, stage `RECYCLE_SLOTS`, source
`ENGINE`, read path `ledger/monthly_gains`, HTTP **400**, attempt **1**.
There was no provider code in the retained evidence. The actual observation
is a GET of `robot_v1_slot_gain_totals`, not a gain-credit mutation or a GET of
`robot_v1_monthly_slot_gains`. No fill/gain immediately causing this failure
has been established.

Vercel request `xplhs-1792061224210-cd7daa12a252` reported one failed engine
and preserved the other engines. Subsequent normal ticks returned OK from
10:48 UTC onward. This did **not** resolve the critical alert or reopen BUY:
an OK reconciliation is not permission to forget an unclassified read error.

Watchdog detected the incident at 10:47:46.438039 UTC and kept only this engine
blocked. It made no recovery attempt; `READ_FAILED` is deliberately excluded
from automatic transient-read recovery. No global kill switch or sibling
pause occurred.

## What is and is not proved

The original failure boundary is proved: the monthly-gains GET returned HTTP
400 without a usable provider code. The upstream reason is **not established**.
Do not describe this as a proven timeout, 503, permission denial, schema defect,
Binance rejection, insufficient balance, or a transient provider incident.

The installed PostgREST SDK can expose non-JSON 400 responses, JSON with only
`message`, and scalar JSON without a `code`. These possibilities are offline
fixtures, not recovered historical response bodies. Network rejection normally
produces status 0 in this SDK; it must not be conflated with the observed 400.
The current query has fixed columns, scoped UUID filters and no large `in()`.

Keep the incident knowledge signature in INVESTIGATE, not FIXED. Do not invent a
permanent-fix version or broaden the automatic-recovery allowlist merely because
current reads succeed. Raw upstream content was not retained, and must not be
reconstructed from a later response. Gateway-log filtering did not recover a
matching 4xx record for the actual endpoint in the incident window.

## Authorized recovery and financial proof

Fresh read-only `/v1/health` and `/v1/state` on the assigned executor at
14:03:45–46 UTC confirmed runtime
`8dc5eb49de9ceb63ff63ffd643c8354645623808`, verified IP, Spot-restricted
permission, Binance connectivity, trading enabled and no executor kill switch.
The six resident TPs were NEW with zero execution, quantities
0.081/0.084/0.087/0.089/0.097/0.100 SOL, total 0.538 SOL. The resident NEXT BUY
was order `17989358638`, client
`C2-b99b6473e5-7-B-5e0e33b62ac118`, 0.098 SOL at 99.70 USDT, also NEW/zero fill.
Spot USDT free was 366.06960227; BNB free 0.00214683. This was not a balance HOLD.

Only the official `OPERATOR_CONTROL` RESUME endpoint was used. The first attempt
returned `COINOPS_LIVE_RESUME_LEASE_BUSY` without mutation. After a fresh normal
reconciliation and release of the worker lease, the second returned RESUMED for
the exact account/engine/run. The official path verifies full ownership, health,
25 physical slots, exchange/ledger/TP agreement, monthly facts, exposure/caps,
no pending strategy edit, settled financial decisions and acknowledged dispatches
twice, then compares and sets the unchanged sole critical incident under lease.
It does not create, cancel, replace or reconcile-with-write an exchange order.

The alert resolved at 14:08:33.975 UTC. Watchdog independently confirmed
RECOVERED / HEALTHY at 14:08:46.486 UTC, with no Watchdog recovery action.
Database observation afterward confirmed ACTIVE, last_error null, engine gate
open, no pending strategy update, 25 distinct physical slots, six OPENs, six
resident TPs, one BUY and zero unreconciled terminal orders. Other engines and
the intentionally PAUSED Renato account remained untouched.

A second assigned-executor read at 14:15:55–56 UTC verified all seven SOLUSDT
exchange order IDs, client IDs, sides, quantities, prices, NEW status and zero
execution unchanged from the pre-recovery snapshot. Normal trading in the
account's other engine continued independently; account balances are therefore
not expected to be a frozen snapshot across the observation interval.

## Runbook for a future equivalent notification

1. Read the exact current alert, stage/root/path/HTTP/code and Watchdog state.
   Never infer the cause from the notification or a later successful tick.
2. Do not race a healthy recovery or an occupied lease. Preserve resident TPs.
3. HTTP 400 without a provider code remains fail-closed: no generic retry,
   automatic resume, gain rewrite, monthly zero fallback, or exchange write.
4. Retrieve scoped provider evidence where available. Permission, schema,
   identity or financially ambiguous facts continue blocked in the affected engine.
5. Explicit authorized operator recovery may use the existing official RESUME
   only after fresh truth and all existing financial/lease/CAS gates pass.
   An uncertain response requires readback; do not blindly repeat it.
6. Confirm independent Watchdog closure, fresh reconciliation and unchanged
   owned exchange orders. Preserve history and intentional pauses.
7. Add a narrower permanent fix only after an upstream signature is proved;
   never mark an unknown 400 automatically recoverable.

Regression fixtures pin the observed HTTP/status/resource shape, one attempt,
sanitized evidence, rejection by automatic read recovery and unchanged financial
boundaries. No runtime policy, schema, RLS, strategy, capital, cron frequency,
VPS configuration or financial state is changed by these regression tests.

## Validation

- 51 related ledger/recovery/server-harness tests passed, including the two new
  regressions and safe explicit recovery, isolated lease/CAS, TP and unsettled
  decision/dispatch rejection.
- Targeted ESLint and TypeScript typecheck passed; `git diff --check` passed.
- No local application build was repeated: only tests and this runbook changed,
  with no application/runtime graph or dependency change. No VPS restart,
  migration, RLS change or artificial Production trading test was performed.
- Provider cause remains unverified; no automatic HTTP 400 recovery or claim
  of a permanent upstream fix is part of this delivery.

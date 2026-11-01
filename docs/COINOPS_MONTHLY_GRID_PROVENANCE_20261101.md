# Monthly grid provenance and partial BUY protection

## Cause and invariant

The monthly ATH/rank transition can legitimately contain two kinds of future
levels: GRID targets recalculated at the new anchor and retained local reentries
whose original allocated level came from the previous GRID. The old adapter
preserved the latter price and its GRID origin, but validated it against only
the new global anchor. The price invariant correctly stopped dispatch.

`entry_grid_contexts`, inside the existing strategy snapshot, records immutable
GRID geometry by price: exact run, engine, price, anchor, spacing and canonical
slot count. The monthly permutation moves prices between physical slots while
this map remains independent of rank/slot ownership. A newly calculated level
receives the new geometry; a retained level must still pass its prior geometry.
Every order freezes its own snapshot. No historic order snapshot is rewritten.
Missing context keeps the legacy strict global-anchor validation; malformed or
foreign context fails closed. This does not relax tick/reference/GRID checks.

Monthly counts remain calendar-month counters in America/Campo_Grande. Day 1
restores eligibility, keeps lifetime history and reinvested capital, and uses
monthly DESC, lifetime DESC, physical ASC within the existing regime constraints.
The change does not alter ranking, targets, capital, gain, spacing or ATH policy.

For legacy snapshots, a still-uncommitted future level can receive its missing
context before becoming NEXT BUY. This requires the exact persisted monthly
transition and a scoped, unchanged-strategy pre-transition order snapshot that
already contains that same GRID source. A GRID_CONTEXT_PROVEN immutable event
precedes the metadata save. It never changes the current resident BUY, slot
price, financial state, strategy or history. No arbitrary anchor is inferred.

## Exact historical repair

The reconciler, under the existing engine lease and closed BUY gate, may repair
only a NORMAL monthly RECONCILE_ORDERS price-invariant incident in the first ten
minutes of a calendar month. It requires:

- A matching persisted monthly ATH transition and one exact never-submitted
  PREPARED BUY: no submission guard, exchange id, fill or cumulative quote.
- An immutable, reconciled zero-fill CANCELED predecessor of the same slot and
  price, with unchanged strategy/configuration, proving the retained geometry.
- Every other current GRID target valid under its own geometry; complete slot,
  exchange/ledger and position/TP agreement; no pending strategy edit, unknown
  order or unacknowledged account dispatch.
- Fresh authenticated GET absence for the exact new client id and fresh GET
  confirmation of the canceled predecessor. Absence alone never proves unsent.

The STARTED checkpoint precedes retirement; a crash resumes that exact proof.
Only the unsent local intent is retired, its decision completed as
RETIRED_NEVER_SUBMITTED, and its empty slot restored to PLANNED. The new run
snapshot gains the proven context. No Binance cancel/create occurs in repair.
An idempotent MONTHLY_GRID_REPAIRED event precedes COMPLETED. Normal reconciliation
then protects and audits. Automatic resume additionally requires fresh complete
reconciliation, the exact repair event/incident, twice-settled decisions and
dispatches, healthy executor, hard caps and the existing incident CAS. Only the
ordinary Strategy Engine may prepare the next real BUY after that resume.

## Tiny partial fills

Before canceling a PARTIALLY_FILLED BUY, calculate whether its actual reconciled
quantity can fund the canonical TP after quantity rounding and current Binance
minimum quantity/notional. If not, keep that SAME owned resident BUY; close new
entries only on that engine. Other engines and resident TPs remain untouched.
Do not submit an extra BUY, alter TP gain or classify the whole position as dust.
Natural progress of the original order may later permit cancel/reconcile/TP.
Only a subsequent complete protected reconciliation can automatically resume
the exact TP_FILTER_UNPROTECTABLE incident. Unconfirmed fills or protection
continue BLOCKED_SAFE and the normal blocked-only notification policy applies.

An older already-CANCELED partial below Binance minimum cannot be repaired by
this protection-only change. It stays visibly blocked: no fictitious TP, extra
purchase, position merge, capital transfer or manual gate clearing. A separate
financial disposition is required through a proven supported flow.

## Validation and operations

Fixtures cover BTC/SOL, 25/50/100 topology, mixed grids, foreign ownership,
guarded/sent/filled intents, changed strategy/geometry, JSONB key order,
interruption after retirement, exchange order appearing during recovery,
retained immutable snapshots, preserved TPs, tiny partials, exact recovery
eligibility, late unsettled dispatches and lost incident CAS. No REAL test orders.
No SQL migration/RLS change, cron-frequency change or native runtime change.
Production closeout must independently compare exchange orders, slots, TPs,
NEXT BUY, incidents and sibling-engine checkpoints; a green HTTP result is
insufficient. Never mark an unprotectable partial healthy to silence its alert.

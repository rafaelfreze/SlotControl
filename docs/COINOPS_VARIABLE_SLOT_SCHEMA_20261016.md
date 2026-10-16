# Configurable engine slots — database contract

Target: CoinOps, OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Migration: `20261016161550_configurable_live_engine_slots.sql`.

## Canonical identity and compatibility

`trading_engines.slot_count` is immutable after creation, defaults to 25, and
accepts a software-validated range of 2..100 for REAL engines. This maximum is
not a fleet-capacity certificate. Non-REAL database engines retain 25 slots;
this release does not re-enable Testnet. Individual capital/rates/targets,
account/shard ownership and physical slot IDs are unchanged.

Preparations carry the same count and runs have an immutable count snapshot.
Engine JSON is a checked compatibility mirror, not a resizing API. Legacy
engines are backfilled through constant column defaults, without financial
UPDATEs or creating/canceling Binance orders. Migration aborts if an existing
JSON topology is not the expected legacy 25.

Physical rows, ranks, real monthly gains, adjustments and selective allocation
records are bounded by the canonical engine count, not by the number of rows
returned by a query. The existing composite ownership foreign keys remain.
Existing RLS policies are not broadened or replaced. Existing financial RPCs
keep their service-only execution grants and empty search paths.

## Provisioning and financial boundaries

`stage_operator_engine_plan` and `append_operator_engine_plan` accept optional
JSON `slotCount`; absence means 25. Only an integer JSON number 2..100 is valid.
Capital remains whole cents and must fund at least one cent per physical slot;
exchange filters and full-grid funding still require the official preview.
This SQL lower bound is not an order minimum or authorization to trade.

Both stage overloads accept optional `monthlyTarget` while preserving historical
defaults when absent. Append retains its explicit target. Replay comparison
normalizes only the default topology/default target representation; material
changes remain idempotency conflicts. Append retains credential, identity,
isolation, inventory/funding-preview, freshness and serialized account-cap gates.

`seed_robot_v1_live_slot_accounts(p_run_id uuid, p_slot_capitals jsonb)` replaces
per-slot initialization round trips with one transactional operation. The JSON
array is in physical order 1..N, contains positive whole-cent numeric amounts,
and must sum to the approved preparation capital. It only seeds a PREPARING
run with no orders and a complete, untouched ledger, or replays exact balances.
Partial initialization, nonzero fees/gains/dust, a changed amount or active run
fails closed. It is not an adjustment or deposit endpoint.

Activation, order preparation, resets, manual adjustments and selective
contributions use engine/run/preparation counts rather than 25. The existing
manual `gain_units <= 25` guard remains; gain units are not physical slots.
Bulk-engine batch limits and retired manual/Testnet constraints are unchanged.

## Capacity and shared Binance orders

`preview_engine_slot_admission(shard, environment, slot_counts[], exclude_engine)`
reuses the existing admission formula and persisted hysteresis. Legacy 25-slot
engines keep their current one-unit conservative profile. Every other count
requires an exact-count reviewed workload profile in the existing
`executor_admission_attestations.evidence.slot_workload` object. No new table,
certificate, current low-load sample or linear `ceil(N/25)` assumption supplies
that proof automatically. The software count limit is not workload coverage.

Required envelope: `contract = SLOT_WORKLOAD_V1`, `environment`, `target_sha`,
`runtime_sha256`, `policy_version`, and `profiles`. Runtime, target, Node and
policy must agree with both the shard attestation and current fleet release.
The profile for the requested count must occur exactly once and contain:

- Integer `slot_count`, exact request match; a larger maximum is not coverage.
- `status = PASS`, integer `capacity_units` from 1..25, and positive
  `upper_bound_weight_per_minute <= capacity_units * policy.incremental_weight`.
- A 64-character `evidence_sha256` identifying the reviewed evidence artifact.
- `scenarios` with all seven explicit PASS proofs: `STEADY`,
  `ALL_TP_FILL_BURST`, `TRANSIENT_RETRIES`, `SIBLING_LOAD`, `CPU_RAM`,
  `RECONCILIATION_BACKLOG`, and `QUEUE_AND_RATE_LIMIT`.

These fields describe a reviewed workload certificate, not flags an onboarding
caller can assert. Existing capacity preflight certifies runtime/configuration;
it does not invent, infer or generate this additional workload coverage. A
future certificate requires bounded evidence for all scenarios, not only a
successful quiet-state sample. Missing, duplicate, incomplete or differently
bound proof returns `CAPACITY_UNKNOWN / SLOT_WORKLOAD_UNCERTIFIED`, distinct
from measured saturation. A 100-slot burst cannot be assumed to cost exactly
four times a 25-slot engine, nor assumed to fit because current CPU is low.

`reserve_executor_capacity` loads the immutable count and reviewed units itself.
Append and reservation lock the existing attestation/release while checking
and recording the reservation, so its profile cannot change between those
steps. The usual telemetry, headroom, hysteresis, Watchdog, whitelist and
account-budget gates still apply independently. No workload profile was added
to Production as part of SQL metadata inspection. At the 16/10/2026 inspection,
the three current runtime attestations had no `slot_workload` evidence; this
does not establish that Executor 03 is physically full.

Direct activation of a PREPARING non-25 run rechecks the exact workload profile
and ordinary admission preview, excluding its own reservation from duplicate
counting, then requires a live, engine/shard/environment-exact reservation with
sufficient reserved weight. Expired, missing, foreign or undersized reservations
cannot activate it. Existing ACTIVE replay does not reactivate or renew anything;
legacy 25 activation semantics are unchanged. Lock order is account, shard,
attestation/release, then account cap/preparation, consistent with append.

Account-wide order-budget JSON accepts either legacy numeric engine counts
(each represents 25 slots) or an array of proposed physical counts per symbol:
`{"SOLBRL": [25,100]}`. Worst-case resident ownership is calculated as
`external + sum(existing_engine.slot_count + 1) + sum(proposed_count + 1)`.
This is independent of shard. A 100-slot engine reserves 101 possible resident
orders, not 26; two such engines cannot pass a 200-order account/symbol filter.
Fresh signed account intervals and `EXPIRE_TAKER` proof remain mandatory.

## Validation and limitations

Run the isolated SQL regression from the repository root:

```text
node --test supabase/tests/configurable_engine_slots.test.mjs
```

The fixture uses the already-pinned PGlite 0.5.9 runtime from
`tools/testing/account-pause-sql`. It contains synthetic rows and column shapes,
never credentials or Production records. Tests cover 25/50/75/100, default
compatibility, immutable topology, physical bounds, incomplete seed rejection,
idempotent seed/append/reset, exact principal, mixed shared-order budgets,
exact reviewed admission units, missing/foreign/incomplete workload denial,
cross-shard sibling principal isolation, slot-100 TP ownership/idempotency and
anonymous/foreign-user RLS denial. Synthetic reviewed profiles of 50/75/100
prove only the generalized RPC gate; they are not fleet workload certificates.
The migration is a single transaction with a five-second lock timeout and
60-second statement timeout. Any failed statement rolls back its DDL together.

PGlite is not evidence of actual Binance fills, runtime parity, fleet admission,
production deployment, full provider outage behavior or actual simultaneous
PostgreSQL sessions. Those gates remain separate. No linked remote database is
ever used for these tests. SQL read-only metadata inspection is not a migration.

Remote migration timestamps historically differ from some local timestamps;
never run an unreviewed whole-directory push to reconcile that history. Verify
the exact target and apply only this reviewed migration through the official
mechanism, after checking it is absent. Do not replay historical migrations.

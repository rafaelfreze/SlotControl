# CoinOps fixed-IP executor — account/engine contract

The executor accepts only HMAC-authenticated server intents. Trading remains on
the existing cron and Strategy Engine. A migration does not authorize another
account, market, capital limit, or exchange operation.

## Trusted registry

`COINOPS_EXECUTOR_REGISTRY_PATH` is required at startup. It points to an absolute
JSON path outside Git, normally `/etc/coinops/account-registry.json`, installed by
root and readable by the service group (owner `root`, group `coinops-executor`,
mode `0640`; containing directory `0750`). The service must not be able to edit
this file. The example in `deploy/account-registry.example.json` contains fake
IDs and disabled execution; it is not a deployable production account.

Populate UUIDs from the migrated authoritative `coinops` registry. Each engine
binds operator, account, environment, symbol, base/quote, credential reference,
executor profile, ownership namespace, immutable caps and three kill switches.
`credentials` maps a reference to environment **names**, never values. Unknown
accounts, symbols, references and missing credentials fail closed. There is no
default-credential fallback. Multiple accounts cannot share one credential ref.

The Rafael legacy engines alone retain COR1 ownership and the existing exact
client IDs. Only BTCBRL and SOLBRL may be enabled there: engine caps 450/275 BRL,
account BRL cap 725, per-order caps 18/11. A future engine uses the C2 namespace
derived from account+engine, plus physical slot, side and operation hash. An
inactive/new account must keep execution disabled and its kill switch on.

## Intent and response identity

Every signed POST, including reads and `/v1/health`, carries:

`operator_id`, `exchange_account_id`, `trading_engine_id`, `environment`,
`symbol`, `quote_asset`, `decision_id`, `idempotency_key`.

The body key must equal the HMAC request's idempotency header. Requests cannot
select a credential reference or carry Binance keys. Responses echo the routing
identity; the web transport rejects a mismatched response before using its data.
The per-engine health endpoint checks the selected account's permissions and
symbol, so a failing account does not authorize or block another account.
Unauthenticated `/health` remains the legacy infrastructure summary, not account
authorization. The global service flags still apply to every engine.

Monetary intent names ending in `Brl` are retained for wire compatibility with
existing COR1 durable claims; their amount is in the explicitly validated engine
quote currency. New code uses native quote filters, balances and BNB/quote fee
prices. Account caps/exposure must never combine currencies or exchange accounts.

## Safe rollout and rollback

1. Record fresh exchange/ledger consistency without creating/canceling orders.
2. Apply additive schema/backfill, preserving all existing run/slot/order IDs.
3. Generate the trusted registry from those persisted identities. Preserve the
   actual legacy execution/kill configuration; the example is intentionally off.
4. Validate registry locally. Check no ambiguous pending intent is outstanding.
5. Deploy the executor **before** the new web release. For this rolling window,
   explicitly set registry `legacy_account_id` to Rafael's persisted account UUID
   and `COINOPS_EXECUTOR_LEGACY_COMPAT=true`. Also set
   `COINOPS_EXECUTOR_LEGACY_VERSION` to the exact version currently validated by
   the old web deployment. During this bridge, public GET `/health` reports that
   compatibility version plus the true `actual_executor_version`, explicit
   `legacy_contract_version` and `legacy_compatibility_enabled`; scoped POST health
   reports the true new executor version. This preserves the old version gate
   without weakening the new engine gate. Only a fully old payload (no routing
   identity fields at all) can resolve the exact Rafael legacy engine/symbol.
   Partial or conflicting new envelopes never use the bridge. Old reconciliation
   is pinned to the Rafael BTCBRL engine and remains GET-only against Binance.
6. Publish the web release with mandatory scoped intents; verify authenticated
   scoped GETs, owned-order identity, ledger invariants and the new engine health.
   Its `LIVE_EXECUTOR_VALIDATED_VERSION` must equal the new executor version.
7. Disable `COINOPS_EXECUTOR_LEGACY_COMPAT` after old web invocations have drained,
   then restart the executor preserving registry, service flags and durable state.
   Never roll new web onto an old executor: old code lacks scoped health and cannot
   validate the new identity envelope. Rollbacks keep the compatibility executor
   or explicitly re-enable its pinned legacy bridge before restoring old web.

Sanitized request logs include `legacy_client` and engine/account IDs to verify
that old callers have drained. No request body, credential value or signature is
logged. The compatibility version does not hide the actual runtime version.

Do **not** remove, rename, clear or reset `/var/lib/coinops-live-executor`.
COR1 claims retain their prior durable key and original body digest after the
routing envelope is removed. Existing completed and pending files are consulted;
unknown outcomes require exact exchange-ID recovery, never a second POST.
C2 claims use account+engine-scoped keys. Keep this state directory and registry
through rollback. Never recreate a client ID to bypass a failed claim.

Local verification: `npm test` in `apps/live-executor`; all Binance calls in these
tests are fictitious transports. Tests cover A/B credentials, four markets,
scope/ownership tampering, replay/restart, native quote dry-runs and legacy caps.

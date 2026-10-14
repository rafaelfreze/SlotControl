# Registry GET and incident recovery — 2026-10-14

## Confirmed chain, not guessed provider cause

Production 13:52:17Z: registry GET `trading_engines` failed with provider code
UNKNOWN in 34ms; worker returned `COINOPS_OPERATOR_REGISTRY_UNAVAILABLE`.
Subsequent ticks returned `COINOPS_LIVE_RECOVERY_INCIDENT_CHANGED`. At 18:00Z,
the monitor replaced the primary cause with `COINOPS_LIVE_MONITOR_RECONCILIATION_STALE`.
The worker continued reconciling/protecting positions with new BUY gated.
The historical HTTP response and original outer stage were discarded: do not
call this a proven 503, timeout, Binance rejection or permission denial.

## Structural corrections

- Registry reuses the strict GET classifier: two complete attempts at most,
  each under a fresh 5s deadline, separated by 250ms. Only proven transport,
  timeout, 502/503/504 or allowlisted connection failures retry. Unknown,
  permission, schema and malformed/missing facts remain fail-closed. A slower
  permission error prevails over a transient sibling. Keep sanitized provider
  code/HTTP/path/attempt, never messages, URLs or private payloads.
- Legacy registry automatic eligibility recognizes only audited GET stages:
  LOAD_LEDGER, RECONCILE_ORDERS, PROTECT_TP, ASSERT_NEW_POSITION, ARM_ENTRY,
  ATH_TRANSITION, RESTART_CYCLE, CONFIG_UPDATE. Exact root/stage and unchanged
  incident are required. Eligibility never approves a pending strategy edit.
- Resume still proves full fresh scope, 25 physical slots, Binance/ledger
  ownership, TP, fills, monthly facts and caps under the run lease.
- Monitor claims the same real lease, uses the claimed row and re-fences before
  mutation. It never manufactures reconciliation freshness or erases execution
  errors. Staleness preserves the primary incident; real TP/financial failures
  still fail closed. Crash-left-open gates with a primary incident are closed
  without rewriting its fingerprint; already closed gates avoid redundant writes.
- Explicit operator recovery captures/rechecks the sole critical and uses scoped
  CAS. Unknown/PREPARED orders, incomplete decisions/dispatches, new/changed
  critical, pending strategy edit or missing TP deny recovery. Resume performs
  no Binance write; the next normal tick alone decides canonical NEXT BUY.

## Overwritten legacy cause

Generic STALE is not automatically recoverable. Never reconstruct financial
truth from an old registry incident, clear gates/alerts by SQL, or add a generic
stale allowlist. Use only explicitly authorized official operator RESUME after
complete current proof and immutable incident CAS.

`tools/operations/resume-engine-official.mjs` accepts exact account/engine/asset
and expected current run. It calls only canonical Production RESUME, using the
existing control credential through non-echoing stdin, never arguments, files or
output. No redirects, retries, credential rotation or Secret bypass. An unknown
response requires fresh remote-state lookup before retry. Never use as a smoke.

## Regression / validation

Offline: registry transient/non-transient precedence; root/stage immutability;
monitor lease busy/stolen/expired/expiry during lookup; primary fingerprint and
freshness preservation; TP loss fail-closed; fill snapshot race; operator CAS,
settled intent/dispatch proof, sibling isolation; official body/run and no retry.

Production: GET-only before/after authorized RESUME. Compare TP IDs/quantities,
slots, fills, intents and gates. Let the normal worker rearm one NEXT BUY and the
independent Watchdog close only after a fresh healthy snapshot. Preserve deliberate
PAUSED accounts. No global cron trigger, test order or VPS restart for this web-only
change; prove common executor graph unchanged.

Strategy, spacing, rank, gain, ledger economics, capacity and report format/version
are unchanged. No migration or RLS change is required.

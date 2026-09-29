# CoinOps performance - 2026-09-29

## Baseline before changes

Production main: c29a27ba0754f8e0bf422ab930db3efde1da890f.
Vercel: dpl_Emt1MenbydK8eSS7EkLj7N6z3STv, READY.
Official backend: otdfpmsegjxpqrzisfmi, schema coinops.

19:43 UTC: 13 ACTIVE REAL engines, 0 engine/account kills, 0 active alerts,
maximum reconciliation age 28.613 s, 23 resident TP and 13 ENTRY orders.
Both executor heartbeats current, runtime 63273fe3e08e499fa5f753811a8fcc76cead8727.
Watchdog: 13 healthy engines, no blocked/recovering/stale; executor-01 has a
CAPACITY_WARNING (not a trading failure); executor-02 HEALTHY.

### Actual database measurements

pg_stat_statements is cumulative, NOT endpoint latency or p95.

| Query | Calls | Mean ms | Max ms |
| --- | ---: | ---: | ---: |
| Native LIVE events, latest 40 | 19010 | 1879.06 | 7995.21 |
| Testnet events | 451 | 4017.62 | 7989.60 |
| Reconciliation latest, without explicit scope | 3832 | 477.01 | 2715.74 |
| Market candles | 1001 | 1618.52 | 7996.54 |
| Native LIVE slots | 19042 | 83.73 | 686.22 |
| LIVE slot accounts | 13033 | 91.23 | 271.21 |
| LIVE orders | 19042 | 26.07 | 388.58 |

Authenticated/RLS EXPLAIN ANALYZE, current Thyely SOL run, latest 40 events:
4092.838 ms, 6320 events inspected, 72586 shared buffer hits,
bitmap intersection followed by top-N sort. Newer run: 83.861 ms / 181 events.
No statistics reset or LIVE order mutations performed.

### Initial bundle (existing local build, not Production waterfall)

Build BwtybfK40jiOqBg_ye3UV: automacao layout/page/error union, 10 JS files,
945368 uncompressed bytes, 257377 gzip bytes. Page chunk: 377672 bytes,
98549 gzip bytes. Repeat identical calculation after build.

### Measurement limits

Authenticated browser TTFB/FCP/LCP/INP, hydration, actual Home payload/requests,
API p50/p95, mobile and drawer/navigation timings are NOT MEASURED yet.
The real Chrome computer-use integration stopped because it could not safely
verify the URL. The independent browser has no authenticated CoinOps session.
Do not infer browser PASS from database timings or a build.

## Safety

Preserve Auth/RLS/operator-account-engine isolation and canonical ledger data.
No strategy, dispatch, Watchdog or Capacity policy changes. No LIVE order smoke
or executor restart. Unrelated executor diagnostic changes stay unstaged.

## Results before publication

| Measurement | Before | After | Evidence boundary |
| --- | ---: | ---: | --- |
| Latest 40 LIVE events, same active run, authenticated RLS | 4092.838 ms | 17.745 ms | Production EXPLAIN ANALYZE, not API latency |
| Shared buffers for that query | 72586 | 1240 | Production query plan |
| Native REAL engine HTTP reads | 9 per engine | 1 per at most 32 engines | Code contract; legacy path kept |
| Grouped projection, 13 engines | Not measured | 585.628 ms | Production database execution, NOT endpoint p95 |
| Initial JS union, gzip | 257377 bytes | 205417 bytes | Local build manifest, -20.2%, not device transfer |
| Initial JS union, raw | 945368 bytes | 726494 bytes | Same layout/page/error union, 10 JS chunks |
| Home page chunk, gzip | 98549 bytes | 42089 bytes | Local build, -57.3% |
| Drawer structure, Chromium, 320-1440 px | Not measured | 25-56 ms | Local real-component fixtures, click to next paint |
| Account selector, same Chromium fixtures | Not measured | 21-31 ms | Local fixtures |
| Drawer structure, WebKit iPhone viewport 390 px | Not measured | 66-79 ms | Emulation, NOT a physical iPhone/PWA |
| Selector, WebKit 390 px | Not measured | 34 ms | Emulation |
| TTFB / FCP / LCP / hydration / INP | Not measured | Not measured | Authenticated Production browser unavailable |
| Home network requests / payload / waterfall | Not measured | Not measured | Build chunks are not network requests |
| API p50 / p95 / p99 | Not measured | Not measured | No artificial load against Production |
| Costs route transition | Not measured | Not measured | Next Link enabled; authenticated smoke pending |

After build: DfJRWC-wCpHdpl-x-mQrL; Next reports /automacao 42 kB,
First Load JS 204 kB. gzip calculation uses Node gzipSync on the manifest union.

## Ten principal findings and actions

1. PROVEN: event queries scanned/sorted thousands of rows and hit statement
   timeouts. Three scoped indexes replace that work with ordered index reads.
2. PROVEN in code: nine requests per native engine created a serial, bounded
   but long waterfall. A current-cycle SQL projection groups up to 32 identities;
   the original isolated fallback remains for partial failure.
3. PROVEN in code: per-engine signed health and preparation/Binance reads were
   in the first-render path. Health now arrives separately; preparation needs
   an explicit diagnostic request. Missing health remains unknown, never green.
4. PROVEN in code: six public chart reads delayed Home. Charts load after the
   structural render; a failed chart does not fail the operational page.
5. PROVEN in code/build: closed administrative/editing panels were imported or
   mounted eagerly. Dynamic imports and first-open mounting remove that work;
   once opened, financial form state/idempotency keys survive drawer closing.
6. PROVEN in code: server-rendered strategy/adjustment trees for all engines were
   serialized before opening a panel. Only typed, scoped panel data now travels.
7. PROVEN in code: the initial All view queried private balances for all accounts.
   It now offers explicit on-demand balance consultation; a selected account
   fetches only its own balances, verified against the owned registry.
8. PROVEN in code: secondary manual-history/onboarding errors failed Home.
   These modules now show their own unavailable state, with writes still gated.
9. PROVEN in code: returning to a visible window replaced even a healthy Realtime
   channel. Connected channels are retained; reconnect remains for disconnected
   channels. Existing scope filters, freshness and refresh budget remain intact.
10. PROVEN in code/local tests: native links caused full document navigation;
    empty loading UI could not respond to menus. Next Link and an interactive
    public shell provide early feedback. A queued native dialog close can no
    longer dismiss an already reopened drawer.

No rewrite, chart library, global cache of private data, financial-policy change,
new executor deployment or additional paid service was introduced.
The existing selector already caps displayed results and uses >=16 px mobile
inputs. 1,000-account network/load behavior is NOT proven by 13 current engines.

## Cache, authorization and freshness contract

- Private registry/ledger: authenticated RLS reads, no shared response cache.
- New projection: SECURITY INVOKER, explicit operator/account/engine/run joins,
  maximum 32 requested engines, no writes. Cross-operator and foreign-user probes
  returned 0 rows; anon has no EXECUTE permission; owned scope returned 13.
- Signed health: private/no-store, bounded requests, signed collection clock,
  75-second validity and 2-second future-clock tolerance. It never advances the
  ledger snapshot timestamp or turns an unavailable engine into a healthy one.
- Public display LOT_SIZE: symbol-specific 300-second cache, real collection
  timestamp, <=10-minute display validity; never a financial authorization.
- Asset/Binance Health and Capacity/Watchdog still read their existing persisted
  collectors. Public charts remain reference data with original candle dates.
- Service worker inspected: notification-only; no fetch handler/page/data cache.
  Do not clear user sessions/cache or replace this worker without evidence.
- Logs: allowlisted Home stage timings, 2% normal sample and slow-read reports;
  no IDs, payloads, secrets or raw SQL. Because slow reads are oversampled, do not
  derive unweighted production percentiles from these logs. New secondary APIs
  expose Server-Timing. Browser timing diagnostics stay local on window.

## Validation and operational evidence

- TypeScript, lint and optimized build passed for implementation.
- Focused 39 tests passed; added projection equivalence regression confirms
  identical slots/orders/exposure and unknown health before signed observation.
  Presentation tests: 9/9; health plus performance contracts: 13/13.
- Existing Watchdog, Capacity, asset-health, monthly-goal, adjustment and bulk
  regressions were executed without LIVE mutations. One outdated source-text
  assertion rejected a keyed Binance card; corrected and retested 9/9.
- Chromium: six interaction/selector tests passed at 320/360/375/390/430/1440 px;
  earlier health card tests passed at 320/360/375/390/430/1280 px. WebKit 390 px:
  health cards and interaction test both passed. Requests/actions are blocked in
  these synthetic fixtures; they do not claim authenticated Production coverage.
- Broad visual tests with obsolete global navigation/layout expectations were
  interrupted after failures. The full visual suite is NOT claimed as passing.
- 20:35 UTC Production: 13 active engines; 23/23 open positions have resident TP;
  all 13 runs have exactly one resident NEXT BUY; no LIVE engine/account kills,
  unresolved LIVE alerts or open incidents. Reconciliation maximum 33.4 s.
  Runtime remains 63273fe3e08e499fa5f753811a8fcc76cead8727 on both executors.
- Capacity is distinct from trading health: executor-01 CAPACITY_LIMIT and
  executor-02 CAPACITY_WARNING; both current, no backlog/errors, Watchdog shows
  7+6 healthy engines, zero blocked/stale/recovering. Preserve admission gates;
  evaluate SCALE_OUT/headroom separately, with no provisioning in this task.

## Migrations, publication and rollback

Applied only to official coinops, version names matched to remote history:

- 20260929195641_coinops_dashboard_scoped_event_reads.sql (three additive indexes).
- 20260929201344_coinops_dashboard_events_batch.sql (read-only invoker RPC).

Compatibility: old frontend keeps working with both additive migrations. If a
web regression is proven, revert only this frontend commit or promote the
previous validated Vercel deployment. Do not delete ledger data, reset indexes,
modify executor runtime or cancel/recreate orders. Failed batch reads degrade
through the existing bounded per-engine reader, without borrowing another scope.

## Gates at implementation close

PASS means the stated scope only; pending Production proof is never green.

| Gate | Result |
| --- | --- |
| HOME_FAST_PASS | NOT PROVEN: authenticated <1 s timing pending |
| NAVIGATION_INSTANT_PASS | Local menus PASS; Production route transitions pending |
| DRAWER_INSTANT_PASS | Local Chromium/WebKit PASS; Production pending |
| MOBILE_FAST_PASS | Responsive/WebKit interactions PASS; physical iPhone/PWA pending |
| DESKTOP_FAST_PASS | Local interactions PASS; Production initial-load pending |
| API_P95_PASS | NOT PROVEN: no sufficient authenticated sample |
| QUERY_OPTIMIZATION_PASS | PASS for measured scoped event read, not all queries |
| NO_N_PLUS_ONE_PASS | Partial: native REAL grouped; legacy/other-environment fallback remains |
| BUNDLE_OPTIMIZED_PASS | PASS local manifest, -20.2% gzip |
| PARTIAL_FAILURE_ISOLATION_PASS | PASS scoped read regressions; Production chaos prohibited |
| CACHE_TENANT_SAFE_PASS | PASS invoker/RLS probes and private/public cache boundaries |
| REALTIME_OPTIMIZED_PASS | PASS connection reuse code/contracts; no field storm simulation |
| TRADING_UNAFFECTED_PASS | PASS persisted current evidence; recheck after deploy |
| WATCHDOG_UNAFFECTED_PASS | PASS current checks; capacity warnings kept visible |

Production READY, deployed SHA, authenticated Home and runtime-log closing
evidence must be appended after publication. This report does not call the full
emergency performance request complete while authenticated measurements remain unavailable.

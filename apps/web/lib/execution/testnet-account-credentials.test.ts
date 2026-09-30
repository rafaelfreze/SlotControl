import assert from "node:assert/strict";
import test from "node:test";
import { resolveTestnetCredentials } from "./testnet-account-credentials.ts";
import { BinanceSpotTestnetAdapter } from "./binance-spot-testnet-adapter.ts";
import { testnetInitialCapital } from "./robot-v1-testnet-cycle.ts";
import { distributeLiveCapital } from "./live-capital-distribution.ts";
import type { EngineContext } from "./operator-context.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const engine = (n: number): EngineContext => ({ operator_id: id(1), exchange_account_id: id(n),
  trading_engine_id: id(10 + n), account_display_name: `Fixture ${n}`, environment: "TESTNET",
  symbol: "BTCUSDT", base_asset: "BTC", quote_asset: "USDT", is_legacy_default: false,
  legacy_compatible: false, global_kill_switch: false, account_kill_switch: false,
  engine_kill_switch: false, status: "ACTIVE", hard_cap_quote: 250, ath_reference_symbol: "BTCUSDT" });
const entries = [2, 3].map((n) => ({ ...engine(n), engines: [{ trading_engine_id: id(10 + n), symbol: "BTCUSDT" }],
  apiKey: `fake-key-${n}`, apiSecret: `fake-secret-${n}` }));

test("Testnet initial allocation respects each new account cap without inventing remainder", () => {
  assert.deepEqual(testnetInitialCapital(419, false), { capital: 419, slotNotional: 16.76, unallocated: 0 });
  assert.deepEqual(testnetInitialCapital("250.00", true), { capital: 250, slotNotional: 10, unallocated: 0 });
  assert.deepEqual(testnetInitialCapital(419.03, false), { capital: 419.03, slotNotional: 16.76, unallocated: 0.03 });
  const allocations = distributeLiveCapital(419.03);
  assert.deepEqual(allocations.slice(0, 4), [16.77, 16.77, 16.77, 16.76]);
  assert.equal(Math.round(allocations.reduce((sum, value) => sum + value, 0) * 100), 41903);
  assert.equal(419.03 / 25 * 25, 419.03);
  for (const cap of [0, -1, 1.001, Number.NaN]) assert.throws(() => testnetInitialCapital(cap, false), /CAP_INVALID/);
});

test("Testnet credentials resolve exact account + engine; no Production or Rafael fallback", () => {
  const env = { COINOPS_TESTNET_ACCOUNTS_JSON: JSON.stringify(entries), BINANCE_API_KEY: "never-used",
    BINANCE_TESTNET_API_KEY: "legacy-key", BINANCE_TESTNET_API_SECRET: "legacy-secret" };
  assert.equal(resolveTestnetCredentials(engine(2), env).apiKey, "fake-key-2");
  assert.equal(resolveTestnetCredentials(engine(3), env).apiKey, "fake-key-3");
  for (const patch of [{ exchange_account_id: id(3) }, { trading_engine_id: id(13) },
    { operator_id: id(99) }, { symbol: "BTCUSDC" }, { environment: "REAL" as const }])
    assert.throws(() => resolveTestnetCredentials({ ...engine(2), ...patch }, env), /DENIED/);
  assert.throws(() => resolveTestnetCredentials(engine(2), { ...env, COINOPS_TESTNET_ACCOUNTS_JSON: "[]" }), /DENIED/);
  assert.throws(() => resolveTestnetCredentials(engine(2), { ...env, COINOPS_TESTNET_ACCOUNTS_JSON: undefined }), /DENIED/);
  assert.throws(() => resolveTestnetCredentials(engine(2), { COINOPS_TESTNET_ACCOUNTS_JSON: "[null]" }), /INVALID/);
});

test("retired Testnet denies all account factories before network, even with stale enabled env", () => {
  const names = ["COINOPS_TESTNET_ACCOUNTS_JSON", "COINOPS_TESTNET_ENABLED"] as const;
  const previous = names.map((name) => process.env[name]);
  process.env.COINOPS_TESTNET_ENABLED = "true";
  process.env.COINOPS_TESTNET_ACCOUNTS_JSON = JSON.stringify(entries);
  try {
    let calls = 0;
    for (const n of [2, 3]) assert.throws(() => BinanceSpotTestnetAdapter.fromAccount(engine(n), id(20), [], {
      fetcher: async () => { calls++; throw new Error("Network must not be reached"); },
    }), /COINOPS_TESTNET_DISABLED/);
    assert.equal(calls, 0);
  } finally { names.forEach((name, n) => { if (previous[n] === undefined) delete process.env[name]; else process.env[name] = previous[n]; }); }
});

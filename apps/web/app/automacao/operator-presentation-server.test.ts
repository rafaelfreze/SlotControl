import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { resolveEngineContext, type DomainRegistry, type EngineContext } from "../../lib/execution/operator-context.ts";
import { loadLiveExecutorStatus } from "../../lib/execution/live-executor-health.ts";
import { monthlyPeriodKey, rankMonthlySlots } from "../../lib/execution/monthly-slot-policy.ts";
import { buildPremiumEngine } from "./premium-operator.ts";
import type { buildOperatorPresentation as BuildPresentation } from "./operator-presentation-server";
import type { Props } from "./automation-mobile";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ip = "46.101.104.48";
const registry: DomainRegistry = {
  operator: { id: id(1), product_id: id(2), tenant_id: id(3), user_id: id(4), status: "ACTIVE", kill_switch: false },
  accounts: [{ id: id(5), operator_id: id(1), display_name: "Fixture", status: "ACTIVE", is_legacy_default: true, kill_switch: false }],
  engines: (["BTC", "SOL"] as const).map((asset, index) => ({ id: id(6 + index), operator_id: id(1), exchange_account_id: id(5),
    environment: "REAL", symbol: `${asset}BRL`, base_asset: asset, quote_asset: "BRL", status: "ACTIVE",
    kill_switch: false, hard_cap_quote: asset === "BTC" ? 450 : 275, legacy_compatible: true }))
};
const health = { healthy: true, version: "new-scoped-version", actual_executor_version: "new-scoped-version",
  legacy_contract_version: "old-bridge-version", legacy_compatibility_enabled: true, region: "FRA1", environment: "REAL",
  clock: new Date().toISOString(), clock_drift_ms: 10, binance_connectivity: "OK", account_permission: "SPOT_RESTRICTED",
  egress_ipv4: ip, egress_ipv4_verified: true, trading_enabled: true, kill_switch: false, latency_ms: 10 };

function data(): Props {
  const slots = Array.from({ length: 25 }, (_, n) => ({ slot_number: n + 1,
    entry_state: n === 0 ? "OPEN" : n === 1 ? "ARMED" : "PLANNED", target_buy_price: 100,
    position_quantity: n === 0 ? .1 : 0, position_committed_brl: n === 0 ? 10 : 0,
    operation_sequence: 1, operational_rank: n + 1, post_ath_group: null, post_ath_group_rank: null, missed_at: null }));
  const at = new Date().toISOString();
  return { balances: [], configs: [], cycles: [], slots: [], operations: [], slotAccounts: [], events: [], candles: [],
    monthlyGoals: [], livePreparation: {
      executor: { gate: "ATTENTION", ip, health: { ...health, version: "old-bridge-version", environment: "BINANCE_PRODUCTION_PREPARED" } },
      configs: ["BTC", "SOL"].map((asset) => ({ asset, max_total_exposure_brl: asset === "BTC" ? 450 : 275, regime: "NORMAL", live_enabled: true, kill_switch: false })),
      sizing: ["BTC", "SOL"].map((asset) => ({ asset, priceBrl: 100 }))
    }, liveAssetData: Object.fromEntries(["BTC", "SOL"].map((asset) => [asset, {
      run: { id: `${asset}-fixture`, status: "ACTIVE", symbol: `${asset}BRL`, entry_regime: "NORMAL", last_reconciled_at: at, last_error: null, gain_rate: .012, entry_spacing: .01 },
      slots, accounts: slots.map((slot) => ({ slot_number: slot.slot_number, balance_brl: asset === "BTC" ? 18 : 11, market_pnl_brl: 0, fees_brl: 0, gain_count: 0 })),
      monthlyGains: [], events: [], alerts: [], orders: [
        { client_order_id: `${asset}-TP`, exchange_order_id: `${asset}-1`, slot_number: 1, side: "SELL", purpose: "TP", status: "NEW", price: 101.2, requested_quantity: .1, executed_quantity: 0, cumulative_quote: 0 },
        { client_order_id: `${asset}-NEXT`, exchange_order_id: `${asset}-2`, slot_number: 2, side: "BUY", purpose: "ENTRY", status: "NEW", price: 99, requested_quantity: .1, executed_quantity: 0, cumulative_quote: 0 }
      ]
    }])) } as unknown as Props;
}

async function run(patch: (engine: EngineContext) => Record<string, unknown> = () => ({})) {
  const names = ["LIVE_EXECUTOR_BASE_URL", "LIVE_EXECUTOR_EGRESS_IP", "COINOPS_EXECUTOR_HMAC_SECRET"] as const;
  const previous = names.map((name) => process.env[name]);
  process.env.LIVE_EXECUTOR_BASE_URL = `https://${ip}`;
  process.env.LIVE_EXECUTOR_EGRESS_IP = ip;
  process.env.COINOPS_EXECUTOR_HMAC_SECRET = "fixture-only-secret".repeat(3);
  const requests: EngineContext[] = [];
  try {
    const dependencies: Record<string, unknown> = {
      "server-only": {}, "@/lib/execution/operator-context": { resolveEngineContext },
      "@/lib/execution/monthly-slot-policy": { monthlyPeriodKey, rankMonthlySlots },
      "./premium-operator": { buildPremiumEngine },
      "@/lib/execution/live-executor-health": { loadLiveEngineExecutorStatus: async (engine: EngineContext) => {
        requests.push(engine);
        return loadLiveExecutorStatus(`https://${ip}`, ip, (async (url, init) => {
          assert.equal(String(url), `https://${ip}/v1/health`);
          assert.equal(init?.method, "POST");
          const payload = JSON.parse(String(init?.body));
          for (const field of ["operator_id", "exchange_account_id", "trading_engine_id", "symbol", "quote_asset"] as const)
            assert.equal(payload[field], engine[field]);
          return Response.json({ ...payload, ...health, ...patch(engine) });
        }) as typeof fetch, "new-scoped-version", engine);
      } }
    };
    const source = readFileSync(new URL("./operator-presentation-server.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const evaluated: Record<string, unknown> = {};
    new Function("require", "exports", compiled)((name: string) => {
      assert.ok(name in dependencies, `Unexpected UI dependency: ${name}`);
      return dependencies[name];
    }, evaluated);
    const build = evaluated.buildOperatorPresentation as typeof BuildPresentation;
    const client = { from(table: string) {
      assert.equal(table, "account_quote_caps");
      return { select: () => ({ eq: () => ({ error: null, data: [{ exchange_account_id: id(5), quote_asset: "BRL", hard_cap_quote: 725 }] }) }) };
    } } as unknown as Parameters<typeof BuildPresentation>[0];
    const input = data();
    const result = await build(client, input, registry, { accountId: "ALL", symbol: "ALL" });
    return { input, result, requests };
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
}

test("UI uses authenticated per-engine health despite public legacy bridge version", async () => {
  const { input, result, requests } = await run();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((engine) => engine.symbol), ["BTCBRL", "SOLBRL"]);
  assert.ok(result.engines.every((engine) => engine.health.healthy));
  assert.equal(result.engineData[id(6)].livePreparation?.executor.gate, "LIVE_EXECUTOR_ACTIVE");
  assert.equal(result.engineData[id(7)].livePreparation?.executor.health?.version, "new-scoped-version");
  assert.equal(input.livePreparation?.executor.gate, "ATTENTION", "shared public observation is not mutated or forged");
  assert.notEqual(result.engineData[id(6)].livePreparation, result.engineData[id(7)].livePreparation);
});

test("one engine kill switch never makes the other engine unhealthy or falsely active", async () => {
  const { result } = await run((engine) => ({ kill_switch: engine.symbol === "SOLBRL" }));
  assert.equal(result.engineData[id(6)].livePreparation?.executor.gate, "LIVE_EXECUTOR_ACTIVE");
  assert.equal(result.engineData[id(7)].livePreparation?.executor.gate, "LIVE_EXECUTOR_PROTECTED");
  assert.equal(result.engines.find((engine) => engine.symbol === "BTCBRL")?.health.healthy, true);
  assert.equal(result.engines.find((engine) => engine.symbol === "SOLBRL")?.health.healthy, false);
});

test("wrong version or cross-account health stays ATTENTION, not softened for the UI", async () => {
  for (const patch of [{ version: "unvalidated" }, { exchange_account_id: id(90) }]) {
    const { result } = await run((engine) => engine.symbol === "BTCBRL" ? patch : {});
    assert.equal(result.engineData[id(6)].livePreparation?.executor.gate, "ATTENTION");
    assert.equal(result.engines.find((engine) => engine.symbol === "BTCBRL")?.health.healthy, false);
    assert.equal(result.engines.find((engine) => engine.symbol === "SOLBRL")?.health.healthy, true);
  }
});

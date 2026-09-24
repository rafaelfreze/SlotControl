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

async function run(patch: (engine: EngineContext) => Record<string, unknown> = () => ({}),
  options: { timeout?: boolean; requireParallel?: boolean } = {}) {
  const names = ["LIVE_EXECUTOR_BASE_URL", "LIVE_EXECUTOR_EGRESS_IP", "COINOPS_EXECUTOR_HMAC_SECRET", "LIVE_EXECUTOR_VALIDATED_VERSION"] as const;
  const previous = names.map((name) => process.env[name]);
  process.env.LIVE_EXECUTOR_BASE_URL = `https://${ip}`;
  process.env.LIVE_EXECUTOR_EGRESS_IP = ip;
  process.env.COINOPS_EXECUTOR_HMAC_SECRET = "fixture-only-secret".repeat(3);
  process.env.LIVE_EXECUTOR_VALIDATED_VERSION = "new-scoped-version";
  const requests: EngineContext[] = [];
  const deadlines: number[] = [], controllers: AbortController[] = [];
  const pending: Array<() => void> = [];
  let inflight = 0, maximumInflight = 0;
  try {
    const dependencies: Record<string, unknown> = {
      "server-only": {}, "@/lib/execution/operator-context": { resolveEngineContext },
      "@/lib/execution/monthly-slot-policy": { monthlyPeriodKey, rankMonthlySlots },
      "./premium-operator": { buildPremiumEngine },
      "@/lib/execution/live-executor-health": { loadLiveExecutorStatus }
    };
    const fetcher = (async (url, init) => {
        assert.equal(String(url), `https://${ip}/v1/health`);
        assert.equal(init?.method, "POST");
        const payload = JSON.parse(String(init?.body));
        const engine = resolveEngineContext(registry, { environment: "REAL",
          exchange_account_id: payload.exchange_account_id, trading_engine_id: payload.trading_engine_id });
        requests.push(engine);
        for (const field of ["operator_id", "exchange_account_id", "trading_engine_id", "symbol", "quote_asset"] as const)
          assert.equal(payload[field], engine[field]);
        inflight++; maximumInflight = Math.max(maximumInflight, inflight);
        try {
          if (options.timeout) {
            const controller = controllers.at(-1)!;
            await new Promise<void>((_resolve, reject) => {
              init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
              queueMicrotask(() => controller.abort(new DOMException("UI observation timed out", "TimeoutError")));
            });
          }
          if (options.requireParallel) await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("UI health must run concurrently")), 500);
            pending.push(() => { clearTimeout(timer); resolve(); });
            if (pending.length === 2) pending.splice(0).forEach((release) => release());
          });
          return Response.json({ ...payload, ...health, ...patch(engine) });
        } finally { inflight--; }
      }) as typeof fetch;
    const uiAbortSignal = { any: AbortSignal.any.bind(AbortSignal), timeout: (ms: number) => {
      deadlines.push(ms); const controller = new AbortController(); controllers.push(controller); return controller.signal;
    } };
    const source = readFileSync(new URL("./operator-presentation-server.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const evaluated: Record<string, unknown> = {};
    new Function("require", "exports", "fetch", "AbortSignal", compiled)((name: string) => {
      assert.ok(name in dependencies, `Unexpected UI dependency: ${name}`);
      return dependencies[name];
    }, evaluated, fetcher, uiAbortSignal);
    const build = evaluated.buildOperatorPresentation as typeof BuildPresentation;
    const client = { from(table: string) {
      assert.equal(table, "account_quote_caps");
      return { select: () => ({ eq: () => ({ error: null, data: [{ exchange_account_id: id(5), quote_asset: "BRL", hard_cap_quote: 725 }] }) }) };
    } } as unknown as Parameters<typeof BuildPresentation>[0];
    const input = data();
    const result = await build(client, input, registry, { accountId: "ALL", symbol: "ALL" });
    assert.ok(deadlines.every((ms) => ms === 5_000), "UI budget is exactly 5s, not the 35s transport budget");
    return { input, result, requests, deadlines, maximumInflight };
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

test("a database kill switch cannot be presented as healthy when executor health is green", () => {
  const input = data();
  input.livePreparation!.executor.gate = "LIVE_EXECUTOR_ACTIVE";
  const btc = resolveEngineContext(registry, { environment: "REAL", exchange_account_id: id(5), trading_engine_id: id(6) });
  assert.equal(buildPremiumEngine(input, btc).health.healthy, true);
  const protectedEngine = buildPremiumEngine(input, { ...btc, engine_kill_switch: true });
  assert.equal(protectedEngine.killSwitch, true);
  assert.equal(protectedEngine.health.healthy, false);
  assert.equal(protectedEngine.health.label, "PROTEGIDO");
  assert.equal(buildPremiumEngine(input, resolveEngineContext(registry, {
    environment: "REAL", exchange_account_id: id(5), trading_engine_id: id(7)
  })).health.healthy, true, "SOL remains independent");
});

test("wrong version or cross-account health stays ATTENTION, not softened for the UI", async () => {
  for (const patch of [{ version: "unvalidated" }, { exchange_account_id: id(90) }]) {
    const { result } = await run((engine) => engine.symbol === "BTCBRL" ? patch : {});
    assert.equal(result.engineData[id(6)].livePreparation?.executor.gate, "ATTENTION");
    assert.equal(result.engines.find((engine) => engine.symbol === "BTCBRL")?.health.healthy, false);
    assert.equal(result.engines.find((engine) => engine.symbol === "SOLBRL")?.health.healthy, true);
  }
});

test("BTC/SOL UI health runs concurrently with two bounded five-second observations", async () => {
  const { result, requests, deadlines, maximumInflight } = await run(undefined, { requireParallel: true });
  assert.equal(requests.length, 2, "no duplicate or extra health observations");
  assert.deepEqual(deadlines, [5_000, 5_000]);
  assert.equal(maximumInflight, 2);
  assert.ok(result.engines.every((engine) => engine.health.healthy));
});

test("UI timeout is fail-closed for both engines and never inherits public healthy evidence", async () => {
  const { result, requests, deadlines } = await run(undefined, { timeout: true });
  assert.equal(requests.length, 2);
  assert.deepEqual(deadlines, [5_000, 5_000]);
  for (const engine of result.engines) {
    assert.equal(engine.health.healthy, false);
    const executor = result.engineData[engine.engineId].livePreparation!.executor;
    assert.equal(executor.gate, "ATTENTION");
    assert.equal(executor.health, null);
  }
});

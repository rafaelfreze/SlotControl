import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { buildLiveSizing, parseLiveRules } from "./live-preparation.ts";
import { distributeLiveCapital } from "./live-capital-distribution.ts";
import { configuredEngineSlotCount, hasCompletePhysicalSlotSet } from "./engine-slot-topology.ts";
import { STRATEGY_VERSION } from "./strategy-engine.ts";

type Row = Record<string, any>;

/** Execute the real preparation function with an isolated numeric(20,8)
 * database round-trip. No application client, credentials or network exists. */
function fixture(capital: number, count: number) {
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "operator",
    exchange_account_id: "account", trading_engine_id: "engine", quote_asset: "BRL" };
  const engine = { ...scope, slot_count: count, hard_cap_quote: capital };
  const profile = { gain_rate: .03, normal_spacing_rate: .01, post_ath_spacing_rate: .02,
    regime: "NORMAL", config_version: 1, updated_at: new Date().toISOString() };
  const prep = { ...scope, ...profile, asset: "SOL", symbol: "SOLBRL", slot_count: count,
    configured_live_capital_brl: capital, max_order_notional_brl: Math.ceil(capital * 100 / count) / 100,
    max_total_exposure_brl: capital, monthly_target: 3, live_enabled: false, kill_switch: true, engine };
  const rules = parseLiveRules({ symbol: "SOLBRL", status: "TRADING", baseAsset: "SOL", quoteAsset: "BRL",
    baseAssetPrecision: 8, quoteAssetPrecision: 8, quoteOrderQtyMarketAllowed: true, orderTypes: ["LIMIT", "MARKET"],
    filters: [{ filterType: "PRICE_FILTER", minPrice: ".1", maxPrice: "100000", tickSize: ".1" },
      { filterType: "LOT_SIZE", minQty: ".001", maxQty: "100000", stepSize: ".001" },
      { filterType: "MIN_NOTIONAL", minNotional: "1" }] });
  let run: Row | null = null;
  let insertCount = 0, seeds = 0;
  const slots: Row[] = [], accounts: Row[] = [];
  const service = { from(table: string) {
    let values: Row | Row[] | null = null;
    const response = () => {
      if (table === "robot_v1_live_runs") {
        if (values) {
          assert.equal(run, null, "replay must not create a second run");
          const data = values as Row;
          run = { ...data, id: "run", slot_notional_brl: Number(data.slot_notional_brl).toFixed(8) };
          insertCount++;
        }
        return { data: run ? { ...run } : null, error: null };
      }
      if (table === "robot_v1_live_slots") {
        if (values && slots.length === 0) slots.push(...values as Row[]);
        return { data: slots, error: null };
      }
      assert.fail(`Unexpected table ${table}`);
    };
    const query = { select: () => query, eq: () => query, in: () => query,
      insert: (data: Row) => { values = data; return query; },
      upsert: (data: Row[]) => { values = data; return query; },
      single: async () => response(), maybeSingle: async () => response(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve) };
    return query;
  }, async rpc(name: string, input: Row) {
    assert.equal(name, "seed_robot_v1_live_slot_accounts");
    assert.equal(input.p_run_id, "run");
    assert.deepEqual(input.p_slot_capitals, distributeLiveCapital(capital, count));
    if (accounts.length === 0) accounts.push(...input.p_slot_capitals.map((value: number, index: number) => ({
      slot_number: index + 1, balance_brl: value, contribution_brl: value,
    })));
    seeds++;
    return { data: { seeded_count: count }, error: null };
  } };
  const bindings: Row = {
    assertScope: () => {}, createServiceRoleClient: () => service, scopedPreparation: async () => prep,
    configuredEngineSlotCount, loadAthProfile: async () => profile, athScope: () => scope,
    readLiveExecutorState: async () => ({ price: { price: 500, observedAt: new Date().toISOString() },
      balances: [{ asset: "BRL", free: capital }], open_orders: [] }),
    publicRules: async () => rules, quoteCap: async () => capital, buildLiveSizing,
    STRATEGY_VERSION, liveEngineOrderPrefix: () => "owned:", amount: Number,
    monthlyPeriodKey: () => "2026-10", validateRunEngine: async () => engine,
    owned: () => scope, hasCompletePhysicalSlotSet,
    runRows: async () => ({ accounts }), event: async () => {},
  };
  const source = ts.createSourceFile("robot-v1-live-server.ts",
    readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const implementation = source.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "prepareLiveCycle")!;
  const compiled = ts.transpileModule(implementation.getText(source), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Row = {};
  new Function(...Object.keys(bindings), "exports", compiled)(...Object.values(bindings), exports);
  return { prepare: () => exports.prepareLiveCycle("user", "SOL"), accounts,
    run: () => run!, inserts: () => insertCount, seeds: () => seeds };
}

for (const [capital, count] of [[33.01, 3], [825.01, 75], [275.01, 25], [1100, 100]]) {
  test(`${capital}/${count}: rounded run reference replays without changing cent-exact funded slots`, async () => {
    const f = fixture(capital!, count!);
    assert.equal(await f.prepare(), "run");
    assert.equal(await f.prepare(), "run");
    assert.equal(f.inserts(), 1); assert.equal(f.seeds(), 2);
    assert.equal(Number(f.run().slot_notional_brl), Number((capital! / count!).toFixed(8)));
    assert.deepEqual(f.accounts.map(account => account.balance_brl), distributeLiveCapital(capital!, count!));
    assert.equal(f.accounts.reduce((sum, account) => sum + Math.round(account.balance_brl * 100), 0), Math.round(capital! * 100));
  });
}

test("a real persisted reference mismatch remains fail-closed before seeding on replay", async () => {
  const f = fixture(33.01, 3);
  await f.prepare();
  f.run().slot_notional_brl = "11.00333334";
  await assert.rejects(f.prepare(), /COINOPS_LIVE_PREPARATION_RECOVERY_MISMATCH/);
  assert.equal(f.seeds(), 1); assert.equal(f.inserts(), 1);
});

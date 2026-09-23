import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

import { planAthLadder } from "../execution/ath-ladder.ts";
import { monthlyPeriodKey } from "../execution/monthly-slot-policy.ts";
import { renewExecutionLease } from "../execution/execution-lease.ts";

type Row = Record<string, any>;

/** The private runtime function is exercised with an in-memory ledger and a
 * fictitious exchange adapter; no credentials, network or operational DB. */
function harness(partial = false) {
  const run: Row = { id: "run", product_id: "product", tenant_id: "tenant", user_id: "user",
    asset: "BTC", symbol: "BTCUSDC", gain_rate: .005, entry_spacing: .01,
    lease_owner: "lease", lease_until: new Date(Date.now() + 90_000).toISOString(), entry_regime: "NORMAL", ath_transition_key: null, ath_period_key: null };
  const slots: Row[] = Array.from({ length: 25 }, (_, index) => ({ id: `slot-${index + 1}`,
    slot_number: index + 1, operation_sequence: 1, entry_state: index === 0 ? "OPEN" : index === 1 ? "ARMED" : "PLANNED",
    target_buy_price: 105 - index, entry_reference_price: 105 - index,
    balance_usdc: 10, entry_origin: "GRID", missed_at: null }));
  const orders: Row[] = [{ id: "owned-buy", run_id: run.id, slot_id: slots[1]!.id,
    slot_number: 2, side: "BUY", purpose: "ENTRY", client_order_id: "COV1-BTC-owned",
    exchange_order_id: "testnet-order", status: partial ? "PARTIALLY_FILLED" : "NEW",
    executed_quantity: partial ? .001 : 0, cumulative_quote: 0 }];
  const profile: Row = { transition_key: "ATH:confirmed", regime: "POST_ATH", normal_spacing_rate: .01,
    post_ath_spacing_rate: .02, ath_price: 105 };
  const monthly = slots.map((slot) => ({ physicalSlotNumber: slot.slot_number,
    physicalSlotId: `physical-${String(slot.slot_number).padStart(2, "0")}`,
    lifetimeGainCount: slot.slot_number, monthlyGainCount: 0 }));
  const events: Row[] = [];
  let cancels = 0;
  const service = { from(table: string) { return {
    upsert(row: Row) { events.push({ table, ...row }); return Promise.resolve({ error: null }); },
    update(values: Row) {
      const chain: Row = { eq() { return chain; }, gt() { return chain; }, select() { return chain; },
        async maybeSingle() {
          if (table === "robot_v1_testnet_runs") Object.assign(run, values);
          return { data: { id: table === "robot_v1_testnet_runs" ? run.id : "ok" }, error: null };
        },
        then(resolve: (value: Row) => void) { resolve({ error: null }); },
      };
      return chain;
    },
  }; } };
  const adapter = { reads: { async getMarketPrice() { return { price: 105, observedAt: "2026-09-23T12:00:00Z" }; } },
    async cancelOwnedOrder(symbol: string, orderId: string, clientId: string) {
      assert.equal(symbol, "BTCUSDC"); assert.equal(orderId, "testnet-order"); assert.equal(clientId, "COV1-BTC-owned");
      cancels++; return { status: "CANCELED", executedQuantity: 0, cumulativeQuoteQuantity: 0 };
    } };
  const source = readFileSync(new URL("../execution/robot-v1-testnet-server.ts", import.meta.url), "utf8")
    + "\nexport { applyTestnetAthTransition };";
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const runtime: Row = {};
  const nativeRequire = createRequire(import.meta.url);
  new Function("require", "exports", compiled)((name: string) => {
    if (name === "node:crypto") return nativeRequire(name);
    if (name === "./ath-ladder") return { planAthLadder };
    if (name === "./monthly-slot-policy") return { monthlyPeriodKey };
    if (name === "./execution-lease") return { renewExecutionLease };
    if (name === "./monthly-slot-server") return { loadMonthlySlotStatuses: async () => monthly };
    if (name === "./robot-v1-testnet-cycle") return { TESTNET_ACTIVE_ORDER_STATUSES: new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]) };
    return {};
  }, runtime);
  const filters = { priceTick: .01, quantityStep: .000001, minQuantity: .000001,
    maxQuantity: 100000, minNotional: 1 };
  return { run, slots, orders, profile, events, service, adapter, filters,
    transition: runtime.applyTestnetAthTransition as (...args: any[]) => Promise<boolean>,
    cancellations: () => cancels };
}

test("Testnet ATH transition cancels only the exact unfilled owned BUY and replays idempotently", async () => {
  const h = harness();
  const openPrice = h.slots[0]!.target_buy_price;
  assert.equal(await h.transition(h.service, h.run, h.slots, h.orders, h.profile, h.filters, h.adapter), true);
  assert.equal(h.cancellations(), 1);
  assert.equal(h.orders[0]!.status, "CANCELED");
  assert.equal(h.slots[0]!.target_buy_price, openPrice);
  assert.equal(h.run.entry_regime, "POST_ATH");
  assert.equal(h.slots[10]!.post_ath_group, "PRIMARY");
  assert.equal(h.slots[10]!.operational_rank, 1);
  assert.equal(h.events.filter((event) => event.event_type === "ATH_OWNED_BUY_CANCELLED").length, 1);
  assert.equal(await h.transition(h.service, h.run, h.slots, h.orders, h.profile, h.filters, h.adapter), false);
  assert.equal(h.cancellations(), 1);
});

test("partial Testnet BUY blocks ATH replacement before any cancel or reprice", async () => {
  const h = harness(true);
  const before = h.slots.map((slot) => slot.target_buy_price);
  await assert.rejects(h.transition(h.service, h.run, h.slots, h.orders, h.profile, h.filters, h.adapter),
    /COINOPS_ATH_BUY_FILL_RECONCILIATION_REQUIRED/);
  assert.equal(h.cancellations(), 0);
  assert.deepEqual(h.slots.map((slot) => slot.target_buy_price), before);
});

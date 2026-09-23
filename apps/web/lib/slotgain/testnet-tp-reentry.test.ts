import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

import * as cycle from "../execution/robot-v1-testnet-cycle.ts";
import * as robot from "../execution/robot-v1.ts";
import * as strategy from "../execution/strategy-engine.ts";
import * as recovery from "../execution/strategy-testnet-recovery.ts";
import * as fillEvidence from "../coinops-reports/testnet-fill-evidence.ts";

type Row = Record<string, unknown>;
type Runtime = {
  ensureTakeProfits: (service: unknown, run: Row, slots: Row[], orders: Row[], filters: Row, adapter: unknown) => Promise<void>;
  prepareOrder: (service: unknown, run: Row, slot: Row, side: string, purpose: string, revision: number, quantity: number | null, quote: number | null, price: number | null, decisionId?: string) => Promise<Row>;
};

const run = { id: "fixture-cycle", asset: "SOL", symbol: "SOLUSDC", product_id: "11111111-1111-1111-1111-111111111111", tenant_id: "22222222-2222-2222-2222-222222222222", user_id: "33333333-3333-3333-3333-333333333333", gain_rate: 0.005, entry_spacing: 0.01, previous_run_id: null };
const slot = { id: "physical-slot-5", run_id: run.id, tenant_id: run.tenant_id, slot_number: 5, operation_sequence: 2, entry_state: "OPEN", target_buy_price: 114.28, balance_usdc: 10.05046, missed_at: null };
const filters = { symbol: "SOLUSDC", baseAsset: "SOL", quoteAsset: "USDC", quantityStep: 0.001, priceTick: 0.01, minQuantity: 0.001, maxQuantity: 10000, minNotional: 5 };
function order(values: Row): Row {
  const side = values.side === "SELL" ? "SELL" : "BUY";
  const revision = Number(values.revision ?? 1);
  return { id: `fixture-${side}-${revision}`, run_id: run.id, product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id, slot_id: slot.id, slot_number: 5,
    operation_sequence: 1, side, purpose: side === "SELL" ? "TP" : "ENTRY", revision,
    client_order_id: cycle.testnetClientOrderId(run.id, "SOL", 5, side, revision), exchange_order_id: `exchange-${side}-${revision}`,
    status: "FILLED", requested_quantity: 0.087, requested_quote: null, price: side === "SELL" ? 114.86 : 114.28,
    executed_quantity: 0.087, cumulative_quote: side === "SELL" ? 9.99282 : 9.94236,
    fee_base: 0, fee_quote: 0, fee_other: [], trades_reconciled: true, ...values };
}

function harness(seedOrders: Row[], status = "NEW") {
  const storedOrders = structuredClone(seedOrders);
  const slots = [structuredClone(slot)];
  const decisions: Row[] = [];
  const completions: Row[] = [];
  const requests: Row[] = [];
  const tables: Record<string, Row[]> = { robot_v1_testnet_orders: storedOrders, robot_v1_testnet_slots: slots, robot_v1_testnet_events: [] };
  const service = {
    from(table: string) {
      assert.ok(tables[table], `Unexpected database access: ${table}`);
      let mutation: { type: "upsert" | "update"; value: Row | Row[]; conflict?: string } | null = null;
      const predicates: Array<[string, unknown]> = [];
      const result = () => {
        const rows = tables[table];
        const matches = rows.filter((row) => predicates.every(([key, value]) => row[key] === value));
        if (mutation?.type === "update") {
          for (const row of matches) Object.assign(row, mutation.value);
          return { data: structuredClone(matches), error: null };
        }
        if (mutation?.type === "upsert") {
          const inserted: Row[] = [];
          for (const payload of Array.isArray(mutation.value) ? mutation.value : [mutation.value]) {
            const keys = (mutation.conflict ?? "id").split(",");
            if (rows.some((row) => keys.every((key) => row[key] === payload[key]))) continue;
            const row = { id: `insert-${rows.length}`, status: "PREPARED", exchange_order_id: null,
              executed_quantity: 0, cumulative_quote: 0, fee_base: 0, fee_quote: 0, fee_other: [], trades_reconciled: false, ...payload };
            rows.push(row); inserted.push(row);
          }
          return { data: structuredClone(inserted), error: null };
        }
        return { data: structuredClone(matches), error: null };
      };
      const query = {
        upsert(value: Row | Row[], options: { onConflict: string }) { mutation = { type: "upsert", value, conflict: options.onConflict }; return query; },
        update(value: Row) { mutation = { type: "update", value }; return query; },
        select() { return query; },
        eq(key: string, value: unknown) { predicates.push([key, value]); return query; },
        async maybeSingle() { const response = result(); return { ...response, data: response.data[0] ?? null }; },
        async single() { return query.maybeSingle(); },
        then(resolve: (value: ReturnType<typeof result>) => unknown) { return Promise.resolve(result()).then(resolve); },
      };
      return query;
    },
  };
  const adapter = {
    async ensureOwnedOrder(request: Row) {
      requests.push(request);
      const quantity = status === "FILLED" ? Number(request.quantity) : status === "PARTIALLY_FILLED" ? 0.04 : 0;
      return { orderId: "new-tp-exchange", clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side,
        status, executedQuantity: quantity, cumulativeQuoteQuantity: quantity * Number(request.price), price: Number(request.price) };
    },
    async getOwnedTrades() {
      const request = requests.at(-1)!;
      const quantity = status === "FILLED" ? Number(request.quantity) : 0.04;
      return [{ id: "trade", quantity, quoteQuantity: quantity * Number(request.price), commission: 0, commissionAsset: "USDC", isBuyer: false, filledAt: "2026-09-23T16:00:00.000Z" }];
    },
  };
  // Execute the actual private adapter functions, without widening production
  // exports. Every database/exchange dependency is local and explicitly mocked.
  const source = readFileSync(new URL("../execution/robot-v1-testnet-server.ts", import.meta.url), "utf8")
    + "\nexport { ensureTakeProfits, prepareOrder };";
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies: Record<string, unknown> = {
    "./robot-v1-testnet-cycle": cycle, "./robot-v1": robot, "./strategy-engine": strategy,
    "./strategy-testnet-recovery": recovery, "../coinops-reports/testnet-fill-evidence": fillEvidence,
    "./monthly-slot-server": { loadMonthlySlotStatuses: async () => [] },
    "../supabase/env": {}, "../supabase/service-role": {}, "./binance-spot-testnet-adapter": {},
    "./strategy-decision-server": {
      persistStrategyDecision: async (_service: unknown, _scope: unknown, _environment: unknown, decision: Row) => { decisions.push(decision); },
      dispatchStrategyDecision: async () => {},
      completeStrategyDecision: async (_service: unknown, _scope: unknown, _environment: unknown, decisionId: string, observed: Row) => { completions.push({ decisionId, ...observed }); },
      failStrategyDecision: async () => {},
    },
  };
  const require = createRequire(import.meta.url);
  const runtime = {} as Runtime;
  new Function("require", "exports", compiled)((name: string) => {
    if (name === "node:crypto") return require(name);
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected module: ${name}`);
    return dependencies[name];
  }, runtime);
  return { runtime, service, adapter, slots, storedOrders, decisions, completions, requests,
    async ensure(orders: Row[]) { await runtime.ensureTakeProfits(service, run, slots, orders, filters, adapter); } };
}

for (const status of ["NEW", "PARTIALLY_FILLED", "FILLED"]) {
  test(`reentry TP gets a new physical-slot SELL identity and remains idempotent when ${status}`, async () => {
    const orders = [order({ side: "SELL" }), order({ side: "BUY", revision: 2, operation_sequence: 2 })];
    const original = structuredClone(orders[0]);
    const h = harness(orders, status);
    await h.ensure(orders);
    const tp = orders.at(-1)!;
    assert.equal(tp.side, "SELL");
    assert.equal(tp.operation_sequence, 2);
    assert.equal(tp.revision, 2);
    assert.equal(tp.price, 114.86);
    assert.equal(tp.requested_quantity, 0.087);
    assert.equal(tp.client_order_id, cycle.testnetClientOrderId(run.id, "SOL", 5, "SELL", 2));
    assert.notEqual(tp.client_order_id, original.client_order_id);
    assert.equal(tp.status, status);
    assert.equal(h.requests.length, 1);
    assert.equal(h.completions.length, 1);
    assert.equal(h.completions[0].order_status, status);
    assert.equal(h.completions[0].ownership_verified, true);
    assert.deepEqual(h.storedOrders[0], original, "previous operation is immutable");
    const oldDecision = { decision_id: "pending-pre-patch-decision", cycle_id: run.id, slot_id: slot.id,
      operation_sequence: 2, action_type: "CREATE_TP", target_price: 114.86, target_notional: slot.balance_usdc, result: "PENDING" };
    const recovered = recovery.recoverTestnetStrategyDecisions({ runId: run.id, decisions: [oldDecision], slots: [slot],
      orders: [tp as recovery.RecoveryTestnetOrder] });
    assert.equal(recovered[0]?.decisionId, oldDecision.decision_id);
    assert.equal(recovered[0]?.observed.matched_by, "EXACT_SLOT_SEQUENCE_PURPOSE_PRICE");
    await h.ensure(orders);
    assert.equal(h.requests.length, 1, "resident/partial/filled TP covers this operation without duplicate");
    assert.equal(h.decisions.length, 1);
  });
}

test("revision namespace ignores other physical slots, BUY revisions and other runs", async () => {
  const orders = [order({ side: "SELL" }), order({ side: "BUY", revision: 90, operation_sequence: 2 }),
    order({ side: "SELL", revision: 50, slot_id: "other-slot", slot_number: 6 }),
    order({ side: "SELL", revision: 70, run_id: "other-run", operation_sequence: 1 })];
  const h = harness(orders);
  await h.ensure(orders);
  assert.equal(orders.at(-1)!.revision, 2);
  assert.equal(h.requests.length, 1);
});

test("canceled current-operation TP is replaced using the next physical-slot revision", async () => {
  const orders = [order({ side: "SELL" }), order({ side: "BUY", revision: 2, operation_sequence: 2 }),
    order({ side: "SELL", revision: 2, operation_sequence: 2, status: "CANCELED", executed_quantity: 0, cumulative_quote: 0 })];
  const h = harness(orders);
  await h.ensure(orders);
  assert.equal(orders.at(-1)!.revision, 3);
  assert.equal(orders.at(-1)!.requested_quantity, 0.087);
  assert.equal(h.requests.length, 1);
});

test("prepareOrder rejects an old-operation client-ID collision instead of silently accepting FILLED", async () => {
  const h = harness([order({ side: "SELL" })]);
  await assert.rejects(h.runtime.prepareOrder(h.service, run, slot, "SELL", "TP", 1, 0.087, null, 114.86, "new-decision"), /COINOPS_TESTNET_ORDER_IDENTITY_COLLISION/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.storedOrders.length, 1);
});

test("same-operation prepared-order retry preserves identity and rejects changed economics", async () => {
  const h = harness([]);
  const first = await h.runtime.prepareOrder(h.service, run, slot, "SELL", "TP", 2, 0.087, null, 114.86, "decision");
  const retry = await h.runtime.prepareOrder(h.service, run, slot, "SELL", "TP", 2, 0.087, null, 114.86, "decision");
  assert.equal(retry.id, first.id);
  assert.equal(h.storedOrders.length, 1);
  await assert.rejects(h.runtime.prepareOrder(h.service, run, slot, "SELL", "TP", 2, 0.088, null, 114.86), /COINOPS_TESTNET_ORDER_IDENTITY_COLLISION/);
  await assert.rejects(h.runtime.prepareOrder(h.service, run, slot, "SELL", "TP", 2, 0.087, null, 114.87), /COINOPS_TESTNET_ORDER_IDENTITY_COLLISION/);
  h.storedOrders[0].product_id = "foreign-product";
  await assert.rejects(h.runtime.prepareOrder(h.service, run, slot, "SELL", "TP", 2, 0.087, null, 114.86), /COINOPS_TESTNET_ORDER_IDENTITY_COLLISION/);
  assert.equal(h.storedOrders.length, 1);
});

test("first operation still uses SELL revision one and preexisting BUY identity is unchanged", async () => {
  const orders = [order({ side: "BUY", operation_sequence: 1 })];
  const h = harness(orders);
  h.slots[0].operation_sequence = 1;
  const buyBefore = structuredClone(orders[0]);
  await h.ensure(orders);
  assert.equal(orders.at(-1)!.revision, 1);
  assert.equal(orders.at(-1)!.operation_sequence, 1);
  assert.equal(orders.at(-1)!.client_order_id, cycle.testnetClientOrderId(run.id, "SOL", 5, "SELL", 1));
  assert.deepEqual(orders[0], buyBefore);
});

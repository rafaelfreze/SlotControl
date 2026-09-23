import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

import { BinanceSpotAdapter } from "../execution/binance-spot-adapter.ts";
import { BinanceSpotTestnetAdapter } from "../execution/binance-spot-testnet-adapter.ts";
import { needsTestnetInitialEntry, needsTestnetOrderSync, planTestnetClosedAccounting, planTestnetUncoveredProtection, testnetBoughtQuantity, testnetSoldOrCoveredQuantity, type AccountingOrder } from "../execution/testnet-fill-accounting.ts";
import { planTerminalTestnetRestart, testnetOpenPositionQuantity } from "../execution/robot-v1-testnet-cycle.ts";
import { renewExecutionLease } from "../execution/execution-lease.ts";

const buyId = "COV1-BTC-2-1-BUY-0123456789abcdef01";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const payload = (status = "FILLED") => ({ orderId: 42, clientOrderId: buyId, symbol: "BTCUSDC", side: "BUY", status, executedQty: "1", cummulativeQuoteQty: "100", price: "100" });
const order = (changes: Partial<AccountingOrder> = {}): AccountingOrder => ({ side: "BUY", status: "FILLED", executed_quantity: 1,
  requested_quantity: 1, cumulative_quote: 100, fee_base: 0, fee_quote: 0, trades_reconciled: true, client_order_id: "buy", revision: 1, ...changes });
const sell = (changes: Partial<AccountingOrder> = {}) => order({ side: "SELL", cumulative_quote: 101, client_order_id: "tp", ...changes });

for (const fill of [0.1, 0.5, 0.99]) {
  for (const status of ["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH"]) {
    test(`terminal BUY ${status} at ${fill * 100}% credits only its actual completed partial`, () => {
      const buy = order({ status, executed_quantity: fill, cumulative_quote: 100 * fill });
      const tp = sell({ executed_quantity: fill, requested_quantity: fill, cumulative_quote: 101 * fill });
      const closed = planTestnetClosedAccounting([buy], [tp], 0.001);
      assert.ok(closed);
      assert.equal(closed.profit, fill);
      assert.equal(closed.remainingDust, 0);
      // Retry does not consume principal: the pure plan is stable and the
      // persisted last_credited_sell_client_order_id is the runtime's CAS key.
      for (let retry = 0; retry < 20; retry++) assert.deepEqual(planTestnetClosedAccounting([buy], [tp], 0.001), closed);
    });
  }
}

test("terminal partial cannot settle until its trades and commissions are reconciled", () => {
  const buy = order({ status: "CANCELED", executed_quantity: 0.5, cumulative_quote: 50, trades_reconciled: false });
  assert.equal(needsTestnetOrderSync(buy), true);
  assert.equal(planTestnetClosedAccounting([buy], [sell({ executed_quantity: 0.5, cumulative_quote: 50.5 })], 0.001), null);
  assert.equal(needsTestnetOrderSync({ ...buy, trades_reconciled: true }), false);
  assert.equal(needsTestnetOrderSync({ ...buy, executed_quantity: 0 }), false);
});

test("initial MARKET retries zero-fill rejection without repeating any existing acquisition", () => {
  assert.equal(needsTestnetInitialEntry([]), true);
  for (const status of ["CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"]) {
    assert.equal(needsTestnetInitialEntry([order({ status, executed_quantity: 0 })]), true);
    assert.equal(needsTestnetInitialEntry([order({ status, executed_quantity: 0.01 })]), false);
  }
  for (const status of ["PREPARED", "NEW", "PARTIALLY_FILLED", "UNKNOWN"])
    assert.equal(needsTestnetInitialEntry([order({ status, executed_quantity: 0 })]), false);
  assert.equal(needsTestnetInitialEntry([order(), sell()]), false);
});

test("multiple terminal partial TPs close once, including base/quote commissions", () => {
  const buy = order({ fee_base: 0.001, fee_quote: 0.01 });
  const sells = [sell({ status: "CANCELED", executed_quantity: 0.5, cumulative_quote: 51, fee_quote: 0.01 }),
    sell({ status: "EXPIRED", executed_quantity: 0.498, fee_base: 0.001, cumulative_quote: 50.796, client_order_id: "tp2", revision: 2 })];
  const result = planTestnetClosedAccounting([buy], sells, 0.001);
  assert.equal(result?.profit, 1.776);
  assert.equal(result?.closingSell.client_order_id, "tp2");
  assert.ok(Math.abs(result!.remainingDust) < 1e-10);
});

test("live partial BUY and partial TP never create a gain or credit unfilled principal", () => {
  const buy = order({ status: "PARTIALLY_FILLED", executed_quantity: 0.5, cumulative_quote: 50 });
  assert.equal(planTestnetClosedAccounting([buy], [sell({ executed_quantity: 0.5, cumulative_quote: 51 })], 0.001), null);
  assert.equal(planTestnetClosedAccounting([order()], [sell({ status: "PARTIALLY_FILLED", executed_quantity: 0.5, cumulative_quote: 51 })], 0.001), null);
  assert.equal(testnetSoldOrCoveredQuantity([sell({ status: "PARTIALLY_FILLED", executed_quantity: 0.5, cumulative_quote: 51 })]), 1);
});

test("partial TP reserved remainder prevents overselling; fees and dust remain explicit", () => {
  const bought = testnetBoughtQuantity([order({ fee_base: 0.001 })]);
  const covered = testnetSoldOrCoveredQuantity([sell({ status: "PARTIALLY_FILLED", requested_quantity: 0.6, executed_quantity: 0.2 })]);
  assert.equal(bought, 0.999);
  assert.equal(covered, 0.6);
  assert.ok(bought - covered < 0.4);
  assert.throws(() => planTestnetClosedAccounting([order()], [sell({ executed_quantity: 1.01 })], 0.001), /OVERSOLD/);
  assert.throws(() => planTestnetClosedAccounting([order({ fee_other: [{ asset: "BNB", amount: 0.01 }] })], [sell()], 0.001), /UNPRICED_FEE/);
});

test("small partial fill holds new entries visibly until Binance permits a protecting TP", () => {
  const filters = { quantityStep: 0.001, minQuantity: 0.001, maxQuantity: 100, minNotional: 5 };
  const partial = order({ status: "PARTIALLY_FILLED", executed_quantity: 0.01, cumulative_quote: 1 });
  assert.deepEqual(planTestnetUncoveredProtection([partial], [], 101, filters), { uncovered: 0.01, canSubmit: false, blockedByFilter: true });
  assert.deepEqual(planTestnetUncoveredProtection([{ ...partial, executed_quantity: 0.1 }], [], 101, filters), { uncovered: 0.1, canSubmit: true, blockedByFilter: false });
  assert.deepEqual(planTestnetUncoveredProtection([order()], [sell({ status: "NEW", executed_quantity: 0 })], 101, filters), { uncovered: 0, canSubmit: false, blockedByFilter: false });
  assert.throws(() => planTestnetUncoveredProtection([partial], [sell({ status: "NEW", executed_quantity: 0 })], 101, filters), /TP_OVERCOVERED/);
});

test("terminal partial sell permits cycle recovery only after all acquired base is gone", () => {
  const rows = [order({ status: "CANCELED", executed_quantity: 0.5 }), sell({ status: "EXPIRED", executed_quantity: 0.5 })]
    .map((row) => ({ ...row, executed_quantity: Number(row.executed_quantity ?? 0), fee_base: Number(row.fee_base ?? 0),
      slot_number: 1, purpose: row.side === "BUY" ? "INITIAL" as const : "TP" as const, exchange_order_id: row.client_order_id }));
  assert.equal(testnetOpenPositionQuantity(rows), 0);
  assert.equal(planTerminalTestnetRestart(rows, 0.001).shouldRestart, true);
  assert.throws(() => testnetOpenPositionQuantity([...rows, { ...rows[1]!, executed_quantity: 0.01 }]), /OVERSOLD/);
});

test("cancel-renamed partial trade recovery uses exact known exchange ID and GET only", async () => {
  const calls: string[] = [];
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "fixture", apiSecret: "fixture" }, { now: () => 1000, fetcher: async (url, init) => {
    calls.push(init?.method ?? "GET");
    const target = new URL(url);
    if (target.pathname === "/api/v3/time") return json({ serverTime: 1000 });
    if (target.pathname === "/api/v3/order") return target.searchParams.has("orderId")
      ? json({ ...payload("CANCELED"), clientOrderId: "cancel-renamed" }) : json({ code: -2013 }, 400);
    return json([{ id: 0, orderId: 42, qty: "1", quoteQty: "100", commission: "0.001", commissionAsset: "BTC", isBuyer: true }]);
  } });
  assert.equal((await adapter.getOwnedTrades("BTCUSDC", buyId, "42"))[0]!.id, "0");
  assert.ok(calls.every((method) => method === "GET"));
});

test("more than 1000 partial fills paginate from oldest trade and stay idempotent", async () => {
  const cursors: string[] = [];
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "fixture", apiSecret: "fixture" }, { now: () => 1000, fetcher: async (url) => {
    const target = new URL(url);
    if (target.pathname === "/api/v3/time") return json({ serverTime: 1000 });
    if (target.pathname === "/api/v3/order") return json(payload());
    const from = Number(target.searchParams.get("fromId"));
    cursors.push(String(from));
    return json(Array.from({ length: from === 0 ? 1000 : 1 }, (_, i) => ({ id: from + i, orderId: 42,
      qty: "0.001", quoteQty: "0.1", commission: "0", commissionAsset: "BTC", isBuyer: true })));
  } });
  const result = await adapter.getOwnedTrades("BTCUSDC", buyId, "42");
  assert.equal(result.length, 1001);
  assert.deepEqual(cursors, ["0", "1000"]);
  assert.deepEqual(await adapter.getOwnedTrades("BTCUSDC", buyId, "42"), result);
});

test("malformed or opposite-side exchange evidence fails before downstream accounting", async () => {
  for (const invalid of [{ executedQty: "NaN" }, { cummulativeQuoteQty: "-1" }, { symbol: "SOLUSDC" }, { side: "SELL" }]) {
    const adapter = new BinanceSpotTestnetAdapter({ apiKey: "fixture", apiSecret: "fixture" }, { fetcher: async (url) =>
      json(url.endsWith("/api/v3/time") ? { serverTime: 1000 } : { ...payload(), ...invalid }) });
    await assert.rejects(adapter.getOwnedOrder("BTCUSDC", buyId), /RESPONSE_INVALID/);
  }
});

test("LIMIT ladder uses LOT_SIZE even when MARKET_LOT_SIZE has a different positive step", async () => {
  const adapter = new BinanceSpotAdapter(null, { fetcher: async () => json({ symbols: [{ symbol: "BTCUSDC", baseAsset: "BTC", quoteAsset: "USDC", filters: [
    { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
    { filterType: "MARKET_LOT_SIZE", minQty: "0.1", maxQty: "10", stepSize: "0.1" },
    { filterType: "MIN_NOTIONAL", minNotional: "5" }, { filterType: "PRICE_FILTER", tickSize: "0.01" },
  ] }] }) });
  const filters = await adapter.getSymbolInfo("BTCUSDC");
  assert.equal(filters.quantityStep, 0.001);
  assert.equal(filters.minQuantity, 0.001);
  assert.equal(filters.maxQuantity, 100);
});

test("lease CAS rejects expired owner, new owner and a renewal response after expiry", async () => {
  let now = 1000, owner = "worker-a", expires = 91_000, writes = 0;
  const persist = async (expected: string, observed: string, next: string) => {
    if (owner !== expected || expires <= Date.parse(observed)) return false;
    writes++;
    expires = Date.parse(next);
    return true;
  };
  const invoke = (expected = "worker-a", expiry = expires) => renewExecutionLease({ owner: expected,
    expiresAt: new Date(expiry).toISOString(), now: () => now, persist });
  assert.equal(await invoke(), new Date(91_000).toISOString());
  now = 80_000;
  assert.equal(await invoke(), new Date(170_000).toISOString());
  owner = "worker-b";
  await assert.rejects(invoke(), /LEASE_LOST/);
  assert.equal(writes, 2);
  now = expires;
  await assert.rejects(invoke("worker-b"), /LEASE_LOST/);
  assert.equal(writes, 2);
  now = 1000;
  await assert.rejects(renewExecutionLease({ owner: "worker-a", expiresAt: new Date(91_000).toISOString(), now: () => now,
    persist: async () => { now = 92_000; return true; } }), /LEASE_LOST/);
});

test("losing lease during a slow lookup blocks order POST and cancel DELETE", async () => {
  for (const action of ["create", "cancel"]) {
    let now = 1000, mutations = 0;
    const adapter = new BinanceSpotTestnetAdapter({ apiKey: "fixture", apiSecret: "fixture" }, {
      now: () => now,
      beforeWrite: async () => { await renewExecutionLease({ owner: "worker-a", expiresAt: new Date(91_000).toISOString(), now: () => now, persist: async () => true }); },
      fetcher: async (url, init) => {
        if (url.endsWith("/api/v3/time")) return json({ serverTime: now });
        if (init?.method !== "GET") { mutations++; return json(payload()); }
        now = 92_000;
        return action === "create" ? json({ code: -2013 }, 400) : json(payload("NEW"));
      },
    });
    if (action === "create") await assert.rejects(adapter.ensureOwnedOrder({ type: "LIMIT", symbol: "BTCUSDC", side: "BUY", quantity: "1", price: "100", clientOrderId: buyId, maxNotional: 100 }), /LEASE_LOST/);
    else await assert.rejects(adapter.cancelOwnedOrder("BTCUSDC", "42", buyId), /LEASE_LOST/);
    assert.equal(mutations, 0);
  }
});

test("durable consumed permit prevents a duplicate POST across lost ACK and fresh invocations", async () => {
  let guarded = false, posts = 0, visible = false;
  const adapter = () => new BinanceSpotTestnetAdapter({ apiKey: "fixture", apiSecret: "fixture" }, {
    now: () => 1000, fetcher: async (url, init) => {
      if (url.endsWith("/api/v3/time")) return json({ serverTime: 1000 });
      if (init?.method === "POST") { posts++; throw new Error("accepted and filled, ACK lost"); }
      return visible ? json(payload("FILLED")) : json({ code: -2013 }, 400);
    },
  });
  const request = { type: "MARKET" as const, symbol: "BTCUSDC" as const, side: "BUY" as const, quoteOrderQty: "100", clientOrderId: buyId, maxNotional: 100 };
  const submission = () => ({ allowCreate: !guarded, beforeCreate: async () => {
    if (guarded) throw new Error("COINOPS_TESTNET_SUBMISSION_OUTCOME_UNKNOWN");
    guarded = true;
  } });
  await assert.rejects(adapter().ensureOwnedOrder(request, submission()), /NETWORK_UNKNOWN_RESULT/);
  for (let retry = 0; retry < 20; retry++)
    await assert.rejects(adapter().ensureOwnedOrder(request, submission()), /SUBMISSION_OUTCOME_UNKNOWN/);
  assert.equal(posts, 1);
  visible = true;
  assert.equal((await adapter().ensureOwnedOrder(request, submission())).status, "FILLED");
  assert.equal(posts, 1);
});

test("crash after consuming submission permit but before POST remains explicitly uncertain", async () => {
  let posts = 0;
  const adapter = new BinanceSpotTestnetAdapter({ apiKey: "fixture", apiSecret: "fixture" }, {
    fetcher: async (url, init) => { if (init?.method === "POST") posts++;
      return url.endsWith("/api/v3/time") ? json({ serverTime: 1000 }) : json({ code: -2013 }, 400); },
  });
  await assert.rejects(adapter.ensureOwnedOrder({ type: "MARKET", symbol: "BTCUSDC", side: "BUY", quoteOrderQty: "100", clientOrderId: buyId, maxNotional: 100 },
    { allowCreate: false }), /SUBMISSION_OUTCOME_UNKNOWN/);
  assert.equal(posts, 0);
});

type ShadowFixtureRow = Record<string, unknown>;
function shadowMonthlyHarness() {
  const config: ShadowFixtureRow = { id: "shadow", tenant_id: "tenant", product_id: "product", user_id: "user", asset: "SOL",
    strategy_lease_owner: "owner", strategy_lease_until: new Date(Date.now() + 90_000).toISOString() };
  const slot: ShadowFixtureRow = { id: "slot", slot_number: 5, operation_sequence: 2, status: "PENDING", entry_state: "ARMED", armed_at: "2026-09-30T23:59:00Z" };
  const accounts = Array.from({ length: 25 }, (_, index) => ({ config_id: "shadow", tenant_id: "tenant", product_id: "product", user_id: "user",
    slot_number: index + 1, initial_balance_usdc: 10, balance_usdc: 10, gain_count: 0, net_profit_usdc: 0 }));
  const monthly = [{ physicalSlotNumber: 5, eligibleForNewEntry: true, periodKey: "2026-09" }];
  const audit: ShadowFixtureRow[] = [];
  const tables: Record<string, ShadowFixtureRow[]> = { robot_v1_configs: [config], robot_v1_slots: [slot], robot_v1_slot_accounts: accounts, robot_v1_audit_events: audit };
  const service = { from(table: string) {
    assert.ok(tables[table], `Unexpected table ${table}`);
    const predicates: Array<(row: ShadowFixtureRow) => boolean> = [];
    let update: ShadowFixtureRow | null = null;
    const result = () => {
      const rows = tables[table].filter((row) => predicates.every((predicate) => predicate(row)));
      if (update) rows.forEach((row) => Object.assign(row, update));
      return { data: structuredClone(rows), error: null };
    };
    const query = {
      select() { return query; }, order() { return query; },
      eq(key: string, value: unknown) { predicates.push((row) => row[key] === value); return query; },
      gt(key: string, value: unknown) { predicates.push((row) => String(row[key]) > String(value)); return query; },
      update(values: ShadowFixtureRow) { update = values; return query; },
      async upsert(row: ShadowFixtureRow) { tables[table].push(structuredClone(row)); return { error: null }; },
      async maybeSingle() { return { ...result(), data: result().data[0] ?? null }; },
      then(resolve: (value: ReturnType<typeof result>) => unknown) { return Promise.resolve(result()).then(resolve); },
    };
    return query;
  } };
  const source = readFileSync(new URL("../execution/robot-v1-shadow-server.ts", import.meta.url), "utf8")
    + "\nexport { revalidateShadowEntry };";
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = createRequire(import.meta.url);
  const runtime = {} as { revalidateShadowEntry: (...args: unknown[]) => Promise<boolean> };
  new Function("require", "exports", compiled)((name: string) => {
    if (name === "node:crypto") return require(name);
    if (name === "./execution-lease") return { renewExecutionLease };
    if (name === "./monthly-slot-server") return { loadMonthlySlotStatuses: async () => monthly };
    if (name === "./robot-v1") return { V1_SLOT_COUNT: 25 };
    return {};
  }, runtime);
  return { slot, monthly, audit, validate: () => runtime.revalidateShadowEntry(service, config, { id: "cycle" }, slot, "2026-10-01T00:00:59Z") };
}

test("Shadow ARMED entry rechecks manual monthly gain before materializing a fill", async () => {
  const h = shadowMonthlyHarness();
  h.monthly[0].eligibleForNewEntry = false;
  assert.equal(await h.validate(), false);
  assert.equal(h.slot.entry_state, "PLANNED");
  assert.equal(h.slot.armed_at, null);
  assert.equal(h.slot.status, "PENDING", "a held entry never becomes OPEN");
  assert.equal(h.audit[0].event_type, "MONTHLY_TARGET_HOLD");
});

test("Shadow monthly rollover rechecks current eligibility without cancelling a valid resident entry", async () => {
  const h = shadowMonthlyHarness();
  h.monthly[0].periodKey = "2026-10";
  assert.equal(await h.validate(), true);
  assert.equal(h.slot.entry_state, "ARMED");
  assert.equal(h.audit.length, 0);
});

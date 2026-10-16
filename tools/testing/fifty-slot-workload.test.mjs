import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BinanceLiveTransport } from '../../apps/live-executor/src/binance-live.mjs';
import { readAccountOrderBudget, createAccountOrderBudgetReader } from '../../apps/live-executor/src/account-order-budget.mjs';
import { liveClientOrderId, liveEngineOrderPrefix } from '../../apps/web/lib/execution/robot-v1-live-cycle.ts';
import * as strategy from '../../apps/web/lib/execution/strategy-engine.ts';
import { createHundredFillFixture, reconcilePhase } from './hundred-fills-reconciliation.test.mjs';
import { createCycleContinuation } from './hundred-cycle-continuation.test.mjs';

// Exact authorized economics. These tests never load an env/vault or use the
// network. Exchange POSTs below exist only inside an in-memory fetch fixture.
// A component request inventory is NOT a full ACTIVE/minute certificate.
const ECONOMICS = Object.freeze({ slot_count: 50, slot_capital: 22, capital: 1100,
  gain_rate: .03, monthly_target: 3, normal_spacing_rate: .02, post_ath_spacing_rate: .03 });
const NOW = Date.parse('2026-10-16T18:00:01Z');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const engine = { id: uuid(4), trading_engine_id: uuid(4), operator_id: uuid(1), exchange_account_id: uuid(2),
  environment: 'REAL', executor_shard_id: 'executor-03', symbol: 'SOLBRL', base_asset: 'SOL', quote_asset: 'BRL',
  slot_count: 50, legacy_compatible: false, hard_cap_quote: 1100, account_cap_quote: 1375, max_order_quote: 1100 };
const symbols = ['BTCUSDT', 'SOLBRL', 'SOLUSDT'];
const filters = [ { filterType: 'LOT_SIZE', minQty: '.001', maxQty: '100000', stepSize: '.001' },
  { filterType: 'PRICE_FILTER', minPrice: '.1', maxPrice: '1000000', tickSize: '.1' },
  { filterType: 'NOTIONAL', minNotional: '10' }, { filterType: 'MAX_NUM_ORDERS', maxNumOrders: 200 } ];

// Official current inventory verified 2026-10-16, not measured Production use:
// https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account
// https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general
// https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market
const weight = (url, method) => {
  if (url.pathname === '/api/v3/time') return 1;
  if (url.pathname === '/api/v3/account' || url.pathname === '/api/v3/exchangeInfo') return 20;
  if (url.pathname === '/api/v3/ticker/price') return 2;
  if (url.pathname === '/sapi/v1/account/apiRestrictions') return 1;
  if (url.pathname === '/api/v3/openOrders') return url.searchParams.has('symbol') ? 6 : 80;
  if (url.pathname === '/api/v3/rateLimit/order' || url.pathname === '/api/v3/myFilters') return 40;
  if (url.pathname === '/api/v3/order') return method === 'POST' ? 1 : 4;
  if (url.pathname === '/api/v3/myTrades') { assert(url.searchParams.has('orderId')); return 5; }
  assert.fail(`Unreviewed request ${url.pathname}`);
};

function transportFixture({ globalOrdersFilter = false, failFirstPermissionReads = 0, marketPrice = 500 } = {}) {
  const calls = [], orders = new Map(); let nextOrder = 10000, permissionFailures = failFirstPermissionReads;
  const idFor = (slot, side, revision = 1, sequence = 1) => liveClientOrderId(uuid(6), 'SOL', slot, sequence, side, revision, engine);
  const addOrder = (slot, side, status, revision = 1) => {
    const id = String(++nextOrder), client = idFor(slot, side, revision);
    const value = { orderId: Number(id), symbol: engine.symbol, clientOrderId: client, side, status,
      executedQty: status === 'FILLED' ? '.044' : '0', cummulativeQuoteQty: status === 'FILLED' ? '22' : '0',
      price: side === 'BUY' ? '500' : '515', origQty: '.044' };
    orders.set(client, value); return value;
  };
  for (let slot = 1; slot <= 50; slot++) { addOrder(slot, 'BUY', 'FILLED'); addOrder(slot, 'SELL', 'NEW'); }
  const fetcher = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET';
    assert(['api.binance.com', 'data-api.binance.vision'].includes(url.hostname));
    assert(method === 'GET' || method === 'POST' && url.pathname === '/api/v3/order');
    calls.push({ host: url.hostname, path: url.pathname, method, weight: weight(url, method), at: NOW });
    if (url.pathname === '/api/v3/time') return Response.json({ serverTime: NOW });
    if (url.pathname === '/api/v3/account') return Response.json({ canTrade: true, balances: [
      { asset: 'BRL', free: '1100', locked: '0' }, { asset: 'SOL', free: '100', locked: '0' },
      { asset: 'BNB', free: '.005', locked: '0' }] });
    if (url.pathname === '/sapi/v1/account/apiRestrictions') {
      if (permissionFailures > 0) { permissionFailures--; return Response.json({ code: -1000 }, { status: 503 }); }
      return Response.json({ ipRestrict: true, enableReading: true, enableSpotAndMarginTrading: true,
        enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false, enableMargin: false,
        enableFutures: false, enableVanillaOptions: false, enablePortfolioMarginTrading: false, enableFixApiTrade: false });
    }
    if (url.pathname === '/api/v3/exchangeInfo') return Response.json({
      exchangeFilters: globalOrdersFilter ? [{ filterType: 'EXCHANGE_MAX_NUM_ORDERS', maxNumOrders: 1000 }] : [],
      symbols: symbols.map(symbol => ({ symbol, status: 'TRADING', baseAsset: symbol.startsWith('BTC') ? 'BTC' : 'SOL',
        quoteAsset: symbol.endsWith('USDT') ? 'USDT' : 'BRL', filters, allowedSelfTradePreventionModes: ['NONE', 'EXPIRE_TAKER'] })) });
    if (url.pathname === '/api/v3/myFilters') return Response.json({ symbolFilters: [{ filterType: 'MAX_NUM_ORDERS', maxNumOrders: 200 }],
      exchangeFilters: [], assetFilters: [] });
    if (url.pathname === '/api/v3/rateLimit/order') return Response.json([
      { rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 50, count: 2 },
      { rateLimitType: 'ORDERS', interval: 'DAY', intervalNum: 1, limit: 160000, count: 2 } ]);
    if (url.pathname === '/api/v3/ticker/price') return Response.json({ symbol: url.searchParams.get('symbol'), price: String(marketPrice) });
    if (url.pathname === '/api/v3/openOrders') return Response.json([...orders.values()].filter(order =>
      (!url.searchParams.has('symbol') || order.symbol === url.searchParams.get('symbol'))
      && ['NEW', 'PARTIALLY_FILLED'].includes(order.status)));
    if (url.pathname === '/api/v3/order') {
      if (method === 'POST') {
        const body = new URLSearchParams(init.body), value = { orderId: ++nextOrder, symbol: body.get('symbol'),
          clientOrderId: body.get('newClientOrderId'), side: body.get('side'), status: body.get('side') === 'BUY' ? 'FILLED' : 'NEW',
          executedQty: body.get('side') === 'BUY' ? body.get('quantity') : '0',
          cummulativeQuoteQty: body.get('side') === 'BUY' ? String(Number(body.get('quantity')) * Number(body.get('price'))) : '0',
          price: body.get('price'), origQty: body.get('quantity') };
        orders.set(value.clientOrderId, value); return Response.json(value);
      }
      const order = orders.get(url.searchParams.get('origClientOrderId'))
        ?? [...orders.values()].find(value => String(value.orderId) === url.searchParams.get('orderId'));
      return order ? Response.json(order) : Response.json({ code: -2013 }, { status: 400 });
    }
    if (url.pathname === '/api/v3/myTrades') {
      const order = [...orders.values()].find(value => String(value.orderId) === url.searchParams.get('orderId'));
      assert(order);
      return Response.json(Number(order.executedQty) > 0 ? [{ id: order.orderId, orderId: order.orderId,
        qty: order.executedQty, quoteQty: order.cummulativeQuoteQty, commission: '.00000001',
        commissionAsset: 'BNB', isBuyer: order.side === 'BUY', time: NOW }] : []);
    }
    assert.fail(url.pathname);
  };
  const transport = () => new BinanceLiveTransport({ apiKey: 'offline-dummy-key', apiSecret: 'offline-dummy-secret', engine,
    fetcher, now: () => NOW });
  const totals = () => ({ all: calls.reduce((sum, row) => sum + row.weight, 0),
    api: calls.filter(row => row.host === 'api.binance.com').reduce((sum, row) => sum + row.weight, 0),
    public: calls.filter(row => row.host === 'data-api.binance.vision').reduce((sum, row) => sum + row.weight, 0) });
  return { calls, orders, transport, totals, idFor, failNextPermissionSnapshot: () => { permissionFailures = 1; } };
}

test('exact50×22 economics; native snapshot retry and50TP GET costs are inventoried, not extrapolated from25', async () => {
  assert.equal(ECONOMICS.slot_count * ECONOMICS.slot_capital, ECONOMICS.capital);
  const f = transportFixture();
  await f.transport().safetySnapshot('SOLBRL');
  assert.deepEqual(f.totals(), { all: 54, api: 30, public: 24 });
  for (const order of [...f.orders.values()].filter(order => order.side === 'SELL')) {
    const observed = await f.transport().queryOrder('SOLBRL', order.clientOrderId, String(order.orderId));
    const t = f.transport(); await t.queryOrder('SOLBRL', order.clientOrderId, observed.orderId);
    await t.ownedTrades('SOLBRL', order.clientOrderId, observed.orderId);
  }
  assert.deepEqual(f.totals(), { all: 1004, api: 980, public: 24 });
  const retry = transportFixture({ failFirstPermissionReads: 1 });
  await retry.transport().safetySnapshot('SOLBRL');
  assert.deepEqual(retry.totals(), { all: 106, api: 58, public: 48 });
});

for (const globalOrdersFilter of [false, true]) test(`account budget includes all3markets and cross-shard orders; global=${globalOrdersFilter}`, async () => {
  const f = transportFixture({ globalOrdersFilter });
  const result = await readAccountOrderBudget(f.transport(), symbols);
  assert.equal(result.symbols.length, 3);
  assert.equal(f.calls.filter(call => call.path === '/api/v3/myFilters').length, 3);
  assert.equal(f.calls.filter(call => call.path === '/api/v3/rateLimit/order').length, 1);
  assert(f.calls.every(call => call.method === 'GET'));
  assert.equal(result.exchangeOrders?.limit ?? null, globalOrdersFilter ? 1000 : null);
  const expected = globalOrdersFilter ? { all: 261, api: 241, public: 20 } : { all: 199, api: 179, public: 20 };
  assert.deepEqual(f.totals(), expected);
  const cachedFixture = transportFixture({ globalOrdersFilter });
  const reader = createAccountOrderBudgetReader({ now: () => NOW });
  await Promise.all(Array.from({ length: 20 }, () => reader(engine, cachedFixture.transport(), symbols)));
  assert.deepEqual(cachedFixture.totals(), expected, 'one account probe in flight, not20copies');
  console.log(JSON.stringify({ component: 'THYELY_3_MARKET_ACCOUNT_BUDGET', global_filter: globalOrdersFilter,
    weights: expected, three_attempt_envelope: expected.all * 3, scope: 'COMPONENT_ONLY_NOT_FULL_ACTIVE_CERTIFICATE' }));
});

test('full ACTIVE cannot be certified by counting only the fifty observed TPs', () => {
  const live = readFileSync(new URL('../../apps/web/lib/execution/robot-v1-live-server.ts', import.meta.url), 'utf8');
  assert(live.includes('settledSellsBefore') && live.includes('> 25'), 'review concentrated checkpoint if its predicate changes');
  assert(live.indexOf('await ensureTakeProfits(service, run, ledger, state)') < live.indexOf('if (await yieldForProgress("CREDIT_SLOTS", concentratedSettlement))'));
  const migration = readFileSync(new URL('../../supabase/migrations/20261016161550_configurable_live_engine_slots.sql', import.meta.url), 'utf8');
  assert(migration.includes('TRANSIENT_RETRIES') && migration.includes("upper_bound>units*(policy->>'incremental_weight')::numeric"));
  //49partialTP+1BUYfill can create a protectiveTP before the checkpoint.
  //25terminalTP+24partialTP+1BUYfill can recycle and create NEXT+itsTP. The
  // separately executed native trace below inventories this concrete branch.
});

test('exact50×22 cycle: fifty gains, unique SQL successor, first BUY+TP+NEXT once; siblings untouched', async t => {
  const f = await createHundredFillFixture({ slotCount: 50, slotCapital: 22, gainRate: .03,
    normalSpacingRate: .02, postAthSpacingRate: .03, monthlyTarget: 3, fillCount: 50,
    clockFollowsModel: false, sqlLatencyMs: 0, exchangeLatencyMs: 0 });
  t.after(() => f.db.close());
  const sibling = f.beforeSibling;
  await reconcilePhase(f);
  await f.api.creditClosedSlots(f.service, f.run, await f.api.runRows(f.service, f.run), await f.state());
  const { client, helpers } = await createCycleContinuation(f);
  const ledger = await f.api.runRows(client, f.run);
  const state = await f.state();
  assert.equal(ledger.slots.filter(slot => slot.entry_state === 'CLOSED').length, 50);
  assert.equal(ledger.accounts.reduce((sum, account) => sum + Number(account.gain_count), 0), 50);
  const accountsBefore = JSON.stringify(ledger.accounts);
  assert.equal(await helpers.recycleClosedSlots(client, f.run, ledger), false);
  const successorId = await helpers.restartClosedCycle(client, f.run, ledger, state);
  const reset = client.rpcCalls.find(call => call.name === 'restart_robot_v1_live_cycle');
  assert.equal((await client.rpc(reset.name, reset.input)).data[0].id, successorId);
  const run = { ...await f.api.claim(f.service, successorId), engine: f.engine };
  const current = await f.api.runRows(client, run);
  assert.equal(run.slot_count, 50); assert.equal(current.slots.length, 50);
  assert.equal(Number(run.gain_rate), .03); assert.equal(Number(run.entry_spacing), .02);
  assert.equal(Number(run.config_snapshot.post_ath_spacing_rate), .03);
  const context = { asset: 'SOL', cycleId: run.id, observedAt: new Date().toISOString(), quoteAsset: 'BRL', slotCount: 50 };
  const candidates = current.slots.map(slot => ({ id: slot.id, slotNumber: slot.slot_number,
    operationSequence: slot.operation_sequence, buyPrice: Number(slot.target_buy_price),
    balanceQuote: Number(current.accounts.find(account => account.slot_number === slot.slot_number).balance_brl),
    operationalRank: slot.operational_rank, monthlyTargetReached: false, monthlyEntryEligible: true, state: 'PLANNED' }));
  const first = candidates.find(candidate => candidate.operationalRank === 1);
  const initial = strategy.planStrategyInitialEntry(context, first);
  const selected = current.slots.find(slot => slot.id === first.id);
  const order = await helpers.prepareOrder(client, run, selected, initial, 'BUY', 'INITIAL', 1,
    null, initial.target_notional, null);
  await helpers.updateSlot(client, run, selected, { entry_state: 'ARMED' });
  const trade = { id: '995001', quantity: .044, quoteQuantity: 22, commission: .00000001,
    commissionAsset: 'BNB', isBuyer: true, filledAt: new Date().toISOString() };
  const sync = (order, status, exchange, quantity = 0, quote = 0, trades = []) => client.rpc('sync_robot_v1_live_order', {
    p_order_id: order.id, p_exchange_order_id: exchange, p_status: status, p_executed_quantity: quantity,
    p_cumulative_quote: quote, p_trades: trades, p_bnb_brl_price: 500,
    p_bnb_brl_observed_at: new Date().toISOString(), p_lease_owner: run.lease_owner });
  await sync(order, 'FILLED', '995001', .044, 22, [trade]);
  await sync(order, 'FILLED', '995001', .044, 22, [trade]);
  const tp = strategy.planStrategyTakeProfit(context, { ...first, state: 'OPEN' }, 500,
    state.filters, { gainRate: .03, entrySpacing: .02 });
  const open = (await f.api.runRows(client, run)).slots.find(slot => slot.id === selected.id);
  assert.equal(Number(open.position_quantity), .044); assert.equal(Number(open.position_committed_brl), 22.000005);
  const tpOrder = await helpers.prepareOrder(client, run, open, tp, 'SELL', 'TP', 1, .044, null, tp.target_price);
  await sync(tpOrder, 'NEW', '995002');
  const next = strategy.planStrategyNextEntry(context, candidates.filter(candidate => candidate.id !== first.id), 500);
  assert.equal(next.decision.action_type, 'ARM_NEXT_BUY');
  const nextSlot = current.slots.find(slot => slot.id === next.decision.slot_id);
  const nextBalance = Number(current.accounts.find(account => account.slot_number === nextSlot.slot_number).balance_brl);
  const nextQuantity = Math.floor(nextBalance / next.decision.target_price / state.filters.quantityStep) * state.filters.quantityStep;
  const buy = await helpers.prepareOrder(client, run, nextSlot, next.decision, 'BUY', 'ENTRY', 1,
    nextQuantity, null, next.decision.target_price);
  await helpers.updateSlot(client, run, nextSlot, { entry_state: 'ARMED' });
  await sync(buy, 'NEW', '995003');
  assert.equal((await helpers.prepareOrder(client, run, nextSlot, next.decision, 'BUY', 'ENTRY', 1,
    nextQuantity, null, next.decision.target_price)).id, buy.id);
  await sync(tpOrder, 'NEW', '995002'); await sync(buy, 'NEW', '995003');
  const final = await f.api.runRows(client, run);
  assert.equal(final.orders.length, 3);
  assert.equal(final.slots.filter(slot => slot.entry_state === 'OPEN').length, 1);
  assert.equal(final.slots.filter(slot => slot.entry_state === 'ARMED').length, 1);
  assert.equal(final.orders.filter(order => order.side === 'SELL' && order.status === 'NEW').length, 1);
  assert.equal(final.orders.filter(order => order.side === 'BUY' && order.status === 'NEW').length, 1);
  assert(final.orders.every(order => order.client_order_id.startsWith(liveEngineOrderPrefix(f.engine))));
  assert.equal(JSON.stringify(final.accounts), accountsBefore);
  assert.equal(JSON.stringify(await f.query('select * from coinops.robot_v1_live_slot_accounts where trading_engine_id=$1 order by slot_number', [uuid(5)])), sibling);
  assert.equal((await f.query('select count(*)::int n from coinops.robot_v1_live_runs where previous_run_id=$1', [f.run.id]))[0].n, 1);
  console.log(JSON.stringify({ component: 'EXACT_50_GLOBAL_RESET_FINANCIAL_SQL', economics: ECONOMICS,
    successor_slots: 50, credited_gains: 50, initial_buy_fills: 1, resident_tp: 1, resident_next_buy: 1,
    sibling_preserved: true, financial_duplicate_effects: 0,
    limitation: 'Canonical planner/prepare/update and actual financial SQL; simulated ACKs, not executor create dispatch/per-minute certificate' }));
});

test('reproducible mixed ACTIVE component chain exceeds2700total inside60s with15 independently retried safety snapshots', async () => {
  const f = transportFixture({ marketPrice: 501 }), phases = [], starts = performance.now(), cpuBefore = process.cpuUsage(), rssBefore = process.memoryUsage().rss;
  const record = async (phase, operation) => {
    const at = f.calls.length, wall = performance.now(); await operation();
    phases.push({ phase, calls: f.calls.length - at, total_weight: f.calls.slice(at).reduce((sum, call) => sum + call.weight, 0),
      from_ms: Number((wall - starts).toFixed(3)), to_ms: Number((performance.now() - starts).toFixed(3)) });
  };
  const snapshot = async phase => record(phase, async () => {
    f.failNextPermissionSnapshot(); await f.transport().safetySnapshot('SOLBRL');
  });
  // Exact state-machine branch under review:25TPs terminal,24partialTPs and a
  // newly FILLED residentBUY.25terminalSELLs do not trigger the >25 early yield.
  // The partial SELLs still protect their known remaining position quantities.
  const observedOrders = [];
  for (let slot = 1; slot <= 49; slot++) {
    const order = f.orders.get(f.idFor(slot, 'SELL'));
    Object.assign(order, { status: slot <= 25 ? 'FILLED' : 'PARTIALLY_FILLED',
      executedQty: slot <= 25 ? '.044' : '.022', cummulativeQuoteQty: slot <= 25 ? '22.66' : '11.33' });
    observedOrders.push(order);
  }
  f.orders.delete(f.idFor(50, 'SELL'));
  observedOrders.push(f.orders.get(f.idFor(50, 'BUY')));
  await snapshot('RECONCILE_ORDERS:initial_state');
  await record('RECONCILE_ORDERS:49SELL+1BUY', async () => {
    for (const order of observedOrders) {
      await f.transport().queryOrder('SOLBRL', order.clientOrderId, String(order.orderId));
      const t = f.transport(); await t.queryOrder('SOLBRL', order.clientOrderId, String(order.orderId));
      await t.ownedTrades('SOLBRL', order.clientOrderId, String(order.orderId));
    }
  });
  await snapshot('READ_STATE');
  await record('ACCOUNT_BUDGET:3markets_fresh_first_try', () => readAccountOrderBudget(f.transport(), symbols));
  const create = async (phase, input) => {
    // This mirrors actual reconcileOrder's missingPREPARED query, fresh web
    // safety, native createOwnedOrder's independent safety+source proof, exact
    // trades endpoint and legacy fee snapshot. None is a new test-only engine.
    await record(`${phase}:query_PREPARED`, () => f.transport().queryOrder('SOLBRL', input.clientOrderId));
    await snapshot(`${phase}:web_pre_dispatch_state`);
    let observed;
    await record(`${phase}:native_create_with_own_safety`, async () => {
      f.failNextPermissionSnapshot();
      observed = await f.transport().createOwnedOrder({ symbol: 'SOLBRL',
        expectedOwnedOpenIds: [...f.orders.values()].filter(order => ['NEW', 'PARTIALLY_FILLED'].includes(order.status))
          .map(order => order.clientOrderId), assetCapBrl: 1100, globalCapBrl: 1375,
        assetExposureBeforeBrl: 600, globalExposureBeforeBrl: 600, ...input },
      { allowCreate: true, tradingEnabled: true, killSwitch: false });
    });
    await record(`${phase}:query_and_ownedTrades`, async () => {
      const t = f.transport(); await t.queryOrder('SOLBRL', input.clientOrderId, observed.orderId);
      await t.ownedTrades('SOLBRL', input.clientOrderId, observed.orderId);
    });
    await snapshot(`${phase}:fee_valuation_state`);
    return observed;
  };
  await create('PROTECT_TP:initial_filled_BUY', { side: 'SELL', purpose: 'TP', type: 'LIMIT', quantity: '0.044', price: '515',
    clientOrderId: f.idFor(50, 'SELL'), sourceBuyClientOrderId: f.idFor(50, 'BUY'),
    sourceBuyOrderId: String(f.orders.get(f.idFor(50, 'BUY')).orderId) });
  await snapshot('ASSERT_PROTECTION:after25gain_and25local_reentry');
  await snapshot('ARM_ENTRY:current_state');
  const candidates = Array.from({ length: 50 }, (_, index) => ({ id: uuid(100 + index), slotNumber: index + 1,
    operationSequence: index < 25 ? 2 : 1, buyPrice: 500, balanceQuote: index < 25 ? 22.659995 : 22,
    operationalRank: index + 1, monthlyEntryEligible: true, monthlyTargetReached: false,
    state: index < 25 ? 'PLANNED' : 'OPEN' }));
  const plan = strategy.planStrategyNextEntry({ asset: 'SOL', cycleId: uuid(6), observedAt: new Date(NOW).toISOString(),
    quoteAsset: 'BRL', slotCount: 50 }, candidates, 501);
  assert.equal(plan.decision.action_type, 'ARM_NEXT_BUY');
  assert.equal(plan.decision.target_price, 500);
  assert.equal(plan.decision.slot_id, candidates[0].id);
  const nextQuantity = Math.floor(candidates[0].balanceQuote / 500 / .001) * .001;
  assert.equal(nextQuantity, .045, 'canonical compounded slot sizing, no retroactive/catch-up BUY');
  const next = await create('ARM_ENTRY:NEXT_BUY_immediate_fill', { side: 'BUY', purpose: 'ENTRY', type: 'LIMIT',
    quantity: String(nextQuantity), price: '500', clientOrderId: f.idFor(1, 'BUY', 1, 2) });
  assert.equal(next.status, 'FILLED');
  await snapshot('ASSERT_NEW_POSITION:post_NEXT_BUY');
  await create('ASSERT_NEW_POSITION:TP_for_NEXT_fill', { side: 'SELL', purpose: 'TP', type: 'LIMIT', quantity: String(nextQuantity), price: '515',
    clientOrderId: f.idFor(1, 'SELL', 1, 2), sourceBuyClientOrderId: next.clientOrderId, sourceBuyOrderId: next.orderId });
  await snapshot('ASSERT_NEW_POSITION:final_protection_state');
  const weights = f.totals(), cpu = process.cpuUsage(cpuBefore), wallMs = performance.now() - starts;
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 3, 'only3 synthetic financial dispatches, none retried');
  assert.equal(f.calls.filter(call => call.path === '/sapi/v1/account/apiRestrictions').length, 30, '15safety observations each retry oneGET');
  assert(weights.all > 2700 && wallMs < 60_000, 'this concrete component trace must not be signed as a2700/minute profile');
  console.log(JSON.stringify({ component: 'EXACT_50_MIXED_ACTIVE_NATIVE_CALL_TRACE', economics: ECONOMICS,
    phases, weights, requests: f.calls.length, financial_posts_in_memory: 3, external_network_calls: 0,
    wall_ms: Number(wallMs.toFixed(3)), cpu_user_ms: cpu.user / 1000, cpu_system_ms: cpu.system / 1000,
    rss_before: rssBefore, rss_after: process.memoryUsage().rss, peak_rss: process.resourceUsage().maxRSS * 1024,
    capacity_units: null, status: 'NOT_CERTIFIED',
    limitation: 'Canonical native transport calls composed along ACTIVE branch; financial SQL continuation separately tested. This is not complete advanceLiveRun or Production latency measurement.' }));
});

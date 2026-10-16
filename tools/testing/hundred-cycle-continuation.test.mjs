import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as strategy from '../../apps/web/lib/execution/strategy-engine.ts';
import * as topology from '../../apps/web/lib/execution/engine-slot-topology.ts';
import * as cycle from '../../apps/web/lib/execution/robot-v1-live-cycle.ts';
import { planAthLadder } from '../../apps/web/lib/execution/ath-ladder.ts';
import { rankMonthlySlots, monthlyPeriodKey } from '../../apps/web/lib/execution/monthly-slot-policy.ts';
import { createHundredFillFixture, reconcilePhase } from './hundred-fills-reconciliation.test.mjs';

const root = new URL('../../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
const ts = createRequire(new URL('../../apps/web/package.json', import.meta.url))('typescript');

function compile(sourceText, dependencies, extras = '') {
  const compiled = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = {};
  new Function('require', 'exports', compiled + extras)(name => dependencies[name] ?? {}, loaded);
  return loaded;
}
const serverSource = source('apps/web/lib/execution/robot-v1-live-server.ts').replaceAll('\r\n', '\n');
const section = (start, end) => {
  const first = serverSource.indexOf(start), last = serverSource.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, start); return serverSource.slice(first, last);
};

function sqlClient(f) {
  const query = async (sql, args = []) => (await f.db.query(sql, args)).rows;
  const rpcCalls = [];
  return { from(table) {
    assert(/^[a-z0-9_]+$/.test(table));
    const args = [], predicates = []; let values = null, insert = false, options = null;
    const execute = async single => {
      const keys = values ? Object.keys(values) : [];
      let sql;
      const encoded = key => ['expected_next_state', 'observed_next_state', 'details', 'config_snapshot'].includes(key)
        ? JSON.stringify(values[key]) : values[key];
      if (insert) {
        const conflict = options?.onConflict;
        assert(!conflict || /^[a-z_,]+$/.test(conflict));
        args.push(...keys.map(encoded));
        sql = `insert into coinops.${table}(${keys.join(',')}) values(${keys.map((_, i) => `$${i + 1}`).join(',')})`
          + (conflict ? ` on conflict(${conflict}) do nothing` : '') + ' returning *';
      } else if (values) {
        const fields = keys.map(key => { args.push(encoded(key)); return `${key}=$${args.length}`; });
        sql = `update coinops.${table} set ${fields.join(',')}${predicates.length ? ' where ' + predicates.join(' and ') : ''} returning *`;
      } else sql = `select * from coinops.${table}${predicates.length ? ' where ' + predicates.join(' and ') : ''}`;
      const rows = await query(sql, args);
      return { data: single ? rows[0] ?? null : rows, error: single && rows.length > 1 ? { code: 'MULTIPLE_ROWS' } : null };
    };
    const comparison = (key, value, op) => { assert(/^[a-z_]+$/.test(key)); args.push(value); predicates.push(`${key}${op}$${args.length}`); return chain; };
    const chain = { select: () => chain, order: () => chain, range: () => chain, limit: () => chain, abortSignal: () => chain,
      eq: (key, value) => comparison(key, value, '='), neq: (key, value) => comparison(key, value, '<>'),
      gt: (key, value) => comparison(key, value, '>'),
      in: (key, vals) => { predicates.push(`${key} in (${vals.map(value => { args.push(value); return `$${args.length}`; }).join(',')})`); return chain; },
      is: (key, value) => { assert.equal(value, null); predicates.push(`${key} is null`); return chain; },
      update: input => { values = input; return chain; }, upsert: (input, opts) => { values = input; insert = true; options = opts; return chain; },
      single: () => execute(true), maybeSingle: () => execute(true), then: (done, fail) => execute(false).then(done, fail) };
    return chain;
  }, async rpc(name, input) {
    assert(['restart_robot_v1_live_cycle', 'prepare_robot_v1_live_order', 'sync_robot_v1_live_order'].includes(name), name);
    const entries = Object.entries(input);
    rpcCalls.push({ name, input: structuredClone(input) });
    const args = entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value);
    const rows = await query(`select * from coinops.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')})`, args);
    return { data: rows, error: null };
  }, query, rpcCalls };
}

async function continuation(f) {
  const client = sqlClient(f);
  await client.query('create unique index test_strategy_decision_identity on coinops.robot_v1_strategy_decisions(trading_engine_id,decision_id)');
  const decisions = compile(source('apps/web/lib/execution/strategy-decision-server.ts'), {
    './operator-context-server': { resolveOperatorEngine: async (_service, scope) => {
      const rows = await client.query('select * from coinops.trading_engines where id=$1 and operator_id=$2 and exchange_account_id=$3',
        [scope.trading_engine_id, scope.operator_id, scope.exchange_account_id]);
      assert.equal(rows.length, 1); return { ...rows[0], trading_engine_id: rows[0].id };
    } }, './operator-context': { isIdentity: () => true },
  });
  const monthly = async (_service, run, slots, accounts) => rankMonthlySlots('SOL', new Date(), slots.map(slot => {
    const account = accounts.find(account => account.slot_number === slot.slot_number);
    return { physicalSlotNumber: slot.slot_number, physicalSlotId: slot.id, lifetimeGainCount: Number(account.gain_count),
      monthlyGainCount: Number(account.gain_count), balanceUsdc: Number(account.balance_brl), entryState: slot.entry_state };
  }), 3, 100);
  const profile = { gain_rate: .03, normal_spacing_rate: .01, post_ath_spacing_rate: .02,
    regime: 'NORMAL', config_version: 1, transition_key: null, ath_price: 500, ath_source: 'OFFLINE_FIXTURE' };
  const glue = [section('const amount =', 'const athScope ='), section('const context =', '\n\nfunction assertScope'),
    section('function candidate(', '\nasync function monthly('), section('async function updateSlot(', '\nasync function updateOrder('),
    section('async function renewLease(', '\nasync function claim('),
    section('async function prepareOrder(', '\nfunction assertLiveOrderPrice('),
    section('async function recycleClosedSlots(', '\nasync function refreshRealAthProfile('),
    section('async function restartClosedCycle(', '\nasync function assertAllPositionsProtected(')].join('\n');
  const names = { monthly, runRows: f.api.runRows, planStrategyClosedSlot: strategy.planStrategyClosedSlot,
    configuredEngineSlotCount: topology.configuredEngineSlotCount, LIVE_ACTIVE_ORDER_STATUSES: cycle.LIVE_ACTIVE_ORDER_STATUSES,
    liveClientOrderId: cycle.liveClientOrderId,
    LIVE_LEASE_MS: 180000, planAthLadder, monthlyPeriodKey, ...decisions,
    cancelOwnedEntry: () => assert.fail('all-filled scenario cannot cancel an order'),
    refreshRealAthProfile: async () => profile, activateQueuedRealProfile: async (_service, _run, value) => value,
    scopedPreparation: async () => (await client.query('select * from coinops.robot_v1_live_preparations where trading_engine_id=$1', [f.run.trading_engine_id]))[0],
    event: async (service, run, key, type, slot, details) => {
      const result = await service.from('robot_v1_live_events').upsert({ run_id: run.id,
        product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id, operator_id: run.operator_id,
        exchange_account_id: run.exchange_account_id, trading_engine_id: run.trading_engine_id, quote_asset: run.quote_asset,
        event_key: key, event_type: type, slot_number: slot, details }, { onConflict: 'run_id,event_key' });
      assert(!result.error);
    },
  };
  const compiled = ts.transpileModule(glue, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const helpers = new Function(...Object.keys(names), `${compiled}\nreturn {restartClosedCycle,recycleClosedSlots,prepareOrder,updateSlot};`)(...Object.values(names));
  return { client, helpers, monthly };
}

test('100 settled gains use actual restart helper and SQL: one successor with100 slots, then canonical BUY/TP/NEXT prepared and synced once', async t => {
  const f = await createHundredFillFixture({ fillCount: 100, clockFollowsModel: false, sqlLatencyMs: 0, exchangeLatencyMs: 0 });
  t.after(() => f.db.close());
  await reconcilePhase(f);
  await f.api.creditClosedSlots(f.service, f.run, await f.api.runRows(f.service, f.run), await f.state());
  const { client, helpers } = await continuation(f), before = JSON.stringify(await client.query('select * from coinops.robot_v1_live_slot_accounts order by trading_engine_id,slot_number'));
  const ledger = await f.api.runRows(f.service, f.run), state = await f.state();
  assert.equal(ledger.slots.filter(slot => slot.entry_state === 'CLOSED').length, 100);
  assert.equal(await helpers.recycleClosedSlots(client, f.run, ledger), false);
  assert.equal(ledger.slots.filter(slot => slot.entry_state === 'CLOSED').length, 100, 'global reset is not100 local reentries');
  const successorId = await helpers.restartClosedCycle(client, f.run, ledger, state);
  assert(successorId && successorId !== f.run.id);
  const reset = client.rpcCalls.find(call => call.name === 'restart_robot_v1_live_cycle');
  const replay = await client.rpc(reset.name, reset.input);
  assert.equal(replay.data[0].id, successorId, 'uncertain reset commit replays the same SQL successor');
  assert.equal((await client.query('select count(*)::int n from coinops.robot_v1_live_runs where previous_run_id=$1', [f.run.id]))[0].n, 1);
  const [successor] = await client.query('select * from coinops.robot_v1_live_runs where id=$1', [successorId]);
  const slots = await client.query('select * from coinops.robot_v1_live_slots where run_id=$1 order by slot_number', [successorId]);
  assert.equal(successor.previous_run_id, f.run.id); assert.equal(successor.slot_count, 100); assert.equal(slots.length, 100);
  assert.equal((await client.query('select status from coinops.robot_v1_live_runs where id=$1', [f.run.id]))[0].status, 'COMPLETED');
  assert.equal(JSON.stringify(await client.query('select * from coinops.robot_v1_live_slot_accounts order by trading_engine_id,slot_number')), before);
  const accounts = ledger.accounts, context = { asset: 'SOL', cycleId: successor.id, observedAt: new Date().toISOString(), quoteAsset: 'BRL', slotCount: 100 };
  const candidates = slots.map(slot => ({ id: slot.id, slotNumber: slot.slot_number, operationSequence: slot.operation_sequence,
    buyPrice: Number(slot.target_buy_price), balanceQuote: Number(accounts.find(account => account.slot_number === slot.slot_number).balance_brl),
    operationalRank: slot.operational_rank, monthlyTargetReached: false, monthlyEntryEligible: true, state: 'PLANNED' }));
  const first = candidates.find(slot => slot.operationalRank === 1), initial = strategy.planStrategyInitialEntry(context, first);
  assert.equal(initial.action_type, 'OPEN_INITIAL_MARKET');
  const tp = strategy.planStrategyTakeProfit(context, { ...first, state: 'OPEN' }, first.buyPrice, state.filters, { gainRate: .03, entrySpacing: .01 });
  assert.equal(tp.action_type, 'CREATE_TP');
  const next = strategy.planStrategyNextEntry(context, candidates.filter(candidate => candidate.id !== first.id), first.buyPrice);
  assert.equal(next.decision.action_type, 'ARM_NEXT_BUY');
  assert.notEqual(next.decision.slot_id, initial.slot_id);
  assert.equal(candidates.length, 100);
  const run = { ...await f.api.claim(f.service, successor.id), engine: f.run.engine };
  assert.equal(run.id, successor.id);
  const firstSlot = slots.find(slot => slot.id === initial.slot_id);
  const prepared = await helpers.prepareOrder(client, run, firstSlot, initial, 'BUY', 'INITIAL', 1,
    null, initial.target_notional, null);
  await helpers.updateSlot(client, run, firstSlot, { entry_state: 'ARMED' });
  const fill = { id: '990001', quantity: .022, quoteQuantity: 11, commission: .00000001,
    commissionAsset: 'BNB', isBuyer: true, filledAt: new Date().toISOString() };
  const sync = (order, status, exchangeId, quantity = 0, quote = 0, trades = []) => client.rpc('sync_robot_v1_live_order', {
    p_order_id: order.id, p_exchange_order_id: exchangeId, p_status: status,
    p_executed_quantity: quantity, p_cumulative_quote: quote, p_trades: trades,
    p_bnb_brl_price: 500, p_bnb_brl_observed_at: new Date().toISOString(), p_lease_owner: run.lease_owner });
  await sync(prepared, 'FILLED', '990001', .022, 11, [fill]);
  await sync(prepared, 'FILLED', '990001', .022, 11, [fill]);
  let current = await f.api.runRows(client, run);
  const open = current.slots.find(slot => slot.id === firstSlot.id);
  assert.equal(open.entry_state, 'OPEN'); assert.equal(Number(open.position_quantity), .022);
  assert.equal(Number(open.position_committed_brl), 11.000005);
  assert.equal((await client.query('select count(*)::int n from coinops.robot_v1_live_fills where order_id=$1', [prepared.id]))[0].n, 1);
  const tpOrder = await helpers.prepareOrder(client, run, open, tp, 'SELL', 'TP', 1, .022, null, tp.target_price);
  await sync(tpOrder, 'NEW', '990002');
  const selected = current.slots.find(slot => slot.id === next.decision.slot_id);
  const nextAccount = current.accounts.find(account => account.slot_number === selected.slot_number);
  const quantity = Math.floor(Number(nextAccount.balance_brl) / next.decision.target_price / state.filters.quantityStep) * state.filters.quantityStep;
  assert(quantity * next.decision.target_price >= state.filters.minNotional);
  const nextOrder = await helpers.prepareOrder(client, run, selected, next.decision, 'BUY', 'ENTRY', 1,
    quantity, null, next.decision.target_price);
  await helpers.updateSlot(client, run, selected, { entry_state: 'ARMED' });
  await sync(nextOrder, 'NEW', '990003');
  for (const [slot, decision, side, purpose, qty, quote, price, order] of [
    [open, tp, 'SELL', 'TP', .022, null, tp.target_price, tpOrder],
    [selected, next.decision, 'BUY', 'ENTRY', quantity, null, next.decision.target_price, nextOrder],
  ]) assert.equal((await helpers.prepareOrder(client, run, slot, decision, side, purpose, 1, qty, quote, price)).id, order.id);
  await sync(tpOrder, 'NEW', '990002'); await sync(nextOrder, 'NEW', '990003');
  current = await f.api.runRows(client, run);
  assert.equal(current.slots.length, 100); assert.equal(current.orders.length, 3);
  assert.equal(current.slots.filter(slot => slot.entry_state === 'OPEN').length, 1);
  assert.equal(current.slots.filter(slot => slot.entry_state === 'ARMED').length, 1);
  assert.equal(current.orders.filter(order => order.side === 'SELL' && order.purpose === 'TP' && order.status === 'NEW').length, 1);
  assert.equal(current.orders.filter(order => order.side === 'BUY' && order.status === 'NEW').length, 1);
  assert(current.orders.every(order => order.client_order_id.startsWith(cycle.liveEngineOrderPrefix(run.engine))));
  assert.equal(JSON.stringify(await client.query('select * from coinops.robot_v1_live_slot_accounts order by trading_engine_id,slot_number')), before);
  console.log(JSON.stringify({ proof: 'CANONICAL_100_GLOBAL_RESET_AND_INITIAL_TP_NEXT_SQL', successor_slots: 100,
    predecessor_complete: true, unique_successor: true, accounts_unchanged: true,
    initial_fills: 1, protected_positions: 1, resident_tp: 1, resident_next_buy: 1,
    limitation: 'First BUY/TP/NEXT use canonical planners, prepare helper and financial SQL with synthetic exchange acknowledgments; not executor dispatch or Production latency certification.' }));
});

test('75 fills with25 positions preserve those TPs, recycle75 locally once and choose one canonical NEXT BUY', async t => {
  const f = await createHundredFillFixture({ fillCount: 75, clockFollowsModel: false, sqlLatencyMs: 0, exchangeLatencyMs: 0 });
  t.after(() => f.db.close());
  await reconcilePhase(f);
  await f.api.creditClosedSlots(f.service, f.run, await f.api.runRows(f.service, f.run), await f.state());
  const { client, helpers, monthly } = await continuation(f);
  const original = await client.query("select * from coinops.robot_v1_live_orders where side='SELL' and slot_number>75 order by slot_number");
  const ledger = await f.api.runRows(f.service, f.run);
  assert.equal(await helpers.recycleClosedSlots(client, f.run, ledger), false);
  const after = await f.api.runRows(f.service, f.run);
  assert.equal(after.slots.filter(slot => slot.entry_state === 'PLANNED' && slot.operation_sequence === 2).length, 75);
  assert.equal(after.slots.filter(slot => slot.entry_state === 'OPEN' && slot.operation_sequence === 1).length, 25);
  assert.deepEqual(await client.query("select * from coinops.robot_v1_live_orders where side='SELL' and slot_number>75 order by slot_number"), original);
  await helpers.recycleClosedSlots(client, f.run, after);
  assert.equal((await client.query("select count(*)::int n from coinops.robot_v1_strategy_decisions where action_type='PLAN_LOCAL_REENTRY'"))[0].n, 75);
  const ranked = await monthly(client, f.run, after.slots, after.accounts);
  const candidates = after.slots.map(slot => ({ id: slot.id, slotNumber: slot.slot_number, operationSequence: slot.operation_sequence,
    buyPrice: Number(slot.target_buy_price), balanceQuote: Number(after.accounts.find(account => account.slot_number === slot.slot_number).balance_brl),
    operationalRank: ranked.find(rank => rank.physicalSlotNumber === slot.slot_number).operationalRank,
    monthlyTargetReached: false, monthlyEntryEligible: true, state: slot.entry_state }));
  const context = { asset: 'SOL', cycleId: f.run.id,
    observedAt: new Date().toISOString(), quoteAsset: 'BRL', slotCount: 100 };
  const crossed = strategy.planStrategyNextEntry(context, candidates, 500);
  assert.equal(crossed.decision.action_type, 'WAIT', 'no retroactive BUY when all reentries are already crossed');
  const next = strategy.planStrategyNextEntry(context, candidates, 501);
  assert.equal(next.decision.action_type, 'ARM_NEXT_BUY');
  assert.equal(typeof next.decision.slot_id, 'string');
  const selected = after.slots.find(slot => slot.id === next.decision.slot_id);
  const account = after.accounts.find(account => account.slot_number === selected.slot_number);
  const state = await f.state();
  const quantity = Math.floor(Number(account.balance_brl) / next.decision.target_price / state.filters.quantityStep) * state.filters.quantityStep;
  const resident = await helpers.prepareOrder(client, f.run, selected, next.decision, 'BUY', 'ENTRY', 1,
    quantity, null, next.decision.target_price);
  await helpers.updateSlot(client, f.run, selected, { entry_state: 'ARMED' });
  const ack = { p_order_id: resident.id, p_exchange_order_id: '990004', p_status: 'NEW',
    p_executed_quantity: 0, p_cumulative_quote: 0, p_trades: [], p_bnb_brl_price: null,
    p_bnb_brl_observed_at: null, p_lease_owner: f.run.lease_owner };
  await client.rpc('sync_robot_v1_live_order', ack);
  assert.equal((await helpers.prepareOrder(client, f.run, selected, next.decision, 'BUY', 'ENTRY', 1,
    quantity, null, next.decision.target_price)).id, resident.id);
  await client.rpc('sync_robot_v1_live_order', ack);
  const settled = await f.api.runRows(client, f.run);
  assert.equal(settled.orders.filter(order => order.side === 'BUY' && order.status === 'NEW').length, 1);
  assert.equal(settled.slots.filter(slot => slot.entry_state === 'ARMED').length, 1);
  assert.equal(settled.slots.filter(slot => slot.entry_state === 'PLANNED').length, 74);
  assert.deepEqual(await client.query("select * from coinops.robot_v1_live_orders where side='SELL' and slot_number>75 order by slot_number"), original);
  assert.equal((await client.query("select count(*)::int n from coinops.robot_v1_live_runs where previous_run_id=$1", [f.run.id]))[0].n, 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Row = Record<string, any>;
const BASE = Date.parse("2026-10-16T18:00:00Z");
const bnbTrade = { commissionAsset: "BNB", commission: .00001 };

/** Load the actual private valuation helpers, without importing Supabase,
 * credentials, runtime environment or any real exchange transport. */
function fixture() {
  let clock = BASE, reads = 0;
  const run: Row = { id: "run-a", operator_id: "operator-a", exchange_account_id: "account-a",
    trading_engine_id: "engine-a", symbol: "SOLBRL", quote_asset: "BRL",
    engine: { executor_shard_id: "executor-03" } };
  const quote = (at = clock) => ({ symbol: `BNB${run.quote_asset}`, price: 4000,
    observedAt: new Date(at).toISOString() });
  let nextState: Row = { bnb_brl_price: quote() };
  const deps: Row = { "./live-executor-transport": { readLiveExecutorState: async (selected: Row) => {
    assert.equal(selected, run); reads++; return nextState;
  } } };
  class Clock extends Date { static now() { return clock; } }
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const helpers: Row = {};
  new Function("require", "exports", "Date", `${compiled}\nObject.assign(exports, {
    createReconciliationFeeValuation, readReconciliationFeeValuation });`)(
    (name: string) => deps[name] ?? {}, helpers, Clock);
  return { run, quote, helpers, reads: () => reads, advance: (ms: number) => { clock += ms; },
    setState: (state: Row) => { nextState = state; } };
}

test("100 same-run BNB fee conversions reuse only the fresh quote, not financial state", async () => {
  const f = fixture(), state = { bnb_brl_price: f.quote(), balances: [{ asset: "BRL", free: 1100 }],
    filters: { minNotional: 10 }, open_orders: ["original"] };
  const context = f.helpers.createReconciliationFeeValuation(f.run, state);
  state.bnb_brl_price.price = 1;
  assert.deepEqual(Object.keys(context).sort(), ["quote", "scope_key"]);
  assert.equal(context.quote.price, 4000, "caller snapshot cannot mutate the retained quote");
  for (let index = 0; index < 100; index++) {
    const actual = await f.helpers.readReconciliationFeeValuation(f.run, [bnbTrade], context);
    assert.equal(actual.price, 4000);
  }
  assert.equal(f.reads(), 0);
});

test("fee quote expires after 60 seconds and refreshes through the scoped state reader", async () => {
  const f = fixture(), context = f.helpers.createReconciliationFeeValuation(f.run, { bnb_brl_price: f.quote() });
  f.advance(60_000);
  await f.helpers.readReconciliationFeeValuation(f.run, [bnbTrade], context);
  assert.equal(f.reads(), 0);
  f.advance(1);
  f.setState({ bnb_brl_price: f.quote() });
  await f.helpers.readReconciliationFeeValuation(f.run, [bnbTrade], context);
  assert.equal(f.reads(), 1);
});

test("four concurrent acknowledged fills share one expired fee-quote refresh", async () => {
  const f = fixture(), context = f.helpers.createReconciliationFeeValuation(f.run, { bnb_brl_price: f.quote() });
  f.advance(60_001); f.setState({ bnb_brl_price: f.quote() });
  const quotes = await Promise.all(Array.from({ length: 4 }, () =>
    f.helpers.readReconciliationFeeValuation(f.run, [bnbTrade], context)));
  assert.equal(f.reads(), 1);
  assert.equal(quotes.every(quote => quote.symbol === "BNBBRL"), true);
  assert.equal(context.refresh, undefined);
});

test("a future, foreign-currency or missing quote cannot become a BNB fee valuation", async () => {
  for (const invalid of [null, { symbol: "BNBUSDT", price: 1, observedAt: new Date(BASE).toISOString() },
    { symbol: "BNBBRL", price: 1, observedAt: new Date(BASE + 5001).toISOString() }]) {
    const f = fixture(), context = f.helpers.createReconciliationFeeValuation(f.run, { bnb_brl_price: invalid });
    f.setState({ bnb_brl_price: invalid });
    await assert.rejects(f.helpers.readReconciliationFeeValuation(f.run, [bnbTrade], context), /BNB_FEE_PRICE_STALE/);
    assert.equal(f.reads(), 1);
  }
});

test("run, engine, account, operator, symbol, currency and shard identities cannot share the context", async () => {
  for (const field of ["id", "trading_engine_id", "exchange_account_id", "operator_id", "symbol", "quote_asset", "shard"]) {
    const f = fixture(), context = f.helpers.createReconciliationFeeValuation(f.run, { bnb_brl_price: f.quote() });
    const foreign = structuredClone(f.run);
    if (field === "shard") foreign.engine.executor_shard_id = "executor-02";
    else foreign[field] = "foreign";
    await assert.rejects(f.helpers.readReconciliationFeeValuation(foreign, [bnbTrade], context), /FEE_VALUATION_SCOPE_MISMATCH/);
    assert.equal(f.reads(), 0);
  }
});

test("non-BNB commissions never require or invent a BNB valuation", async () => {
  const f = fixture(), context = f.helpers.createReconciliationFeeValuation(f.run, { bnb_brl_price: null });
  assert.equal(await f.helpers.readReconciliationFeeValuation(f.run,
    [{ commissionAsset: "SOL", commission: .00001 }, { commissionAsset: "BRL", commission: 0 }], context), null);
  assert.equal(f.reads(), 0);
});

test("zero BNB commission still supplies the quote required by canonical financial SQL", async () => {
  const f = fixture(), context = f.helpers.createReconciliationFeeValuation(f.run, { bnb_brl_price: f.quote() });
  const quote = await f.helpers.readReconciliationFeeValuation(f.run, [{ commissionAsset: "BNB", commission: 0 }], context);
  assert.equal(quote.symbol, "BNBBRL");
  assert.equal(f.reads(), 0);
});

test("USDT valuation retains its own BNBUSDT quote and cannot consume BNBBRL", async () => {
  const f = fixture(); f.run.quote_asset = "USDT"; f.run.symbol = "SOLUSDT";
  const context = f.helpers.createReconciliationFeeValuation(f.run, { bnb_brl_price: { symbol: "BNBBRL", price: 4000,
    observedAt: new Date(BASE).toISOString() }, bnb_quote_price: f.quote() });
  const actual = await f.helpers.readReconciliationFeeValuation(f.run, [bnbTrade], context);
  assert.equal(actual.symbol, "BNBUSDT");
  assert.equal(f.reads(), 0);
});

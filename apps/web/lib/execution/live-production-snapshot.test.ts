import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { parseLiveRules } from "./live-preparation.ts";

const engine = (id: string, shard: string) => ({ trading_engine_id: id, executor_shard_id: shard,
  operator_id: "operator", exchange_account_id: "same-account", environment: "REAL", symbol: "SOLBRL", quote_asset: "BRL" });
const A = engine("A", "executor-02"), B = engine("B", "executor-03");
function fixture(unavailable = false) {
  const calls: string[] = [], engineReads: string[] = [];
  const compiled = ts.transpileModule(readFileSync(new URL("./live-preparation-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies: Record<string, unknown> = { "server-only": {},
    "./live-preparation": { parseLiveRules }, "./live-executor-transport": {
      readLiveExecutorState: async (row: typeof A) => {
        engineReads.push(row.trading_engine_id);
        if (unavailable) throw new Error("missing source");
        return { ...row, balances: [{ asset: "BRL", free: 100, locked: 5, total: 105 }] };
      },
    } };
  const loaded: Record<string, unknown> = {};
  const fetcher = async (url: string) => {
    calls.push(url);
    const symbols = JSON.parse(new URL(url).searchParams.get("symbols")!);
    assert.deepEqual(symbols, ["SOLBRL"]);
    return new URL(url).pathname.endsWith("price") ? Response.json([{ symbol: "SOLBRL", price: "100" }])
      : Response.json({ symbols: [{ symbol: "SOLBRL", status: "TRADING", baseAsset: "SOL", quoteAsset: "BRL",
        baseAssetPrecision: 8, quoteAssetPrecision: 8, quoteOrderQtyMarketAllowed: true,
        orderTypes: ["MARKET", "LIMIT"], filters: [
        { filterType: "LOT_SIZE", minQty: "0.01", maxQty: "10000", stepSize: "0.01" },
        { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" }, { filterType: "MIN_NOTIONAL", minNotional: "10" },
      ] }] });
  };
  new Function("require", "exports", "fetch", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];
  }, loaded, fetcher);
  return { calls, engineReads, load: loaded.loadLiveProductionSnapshot as
    (engines: typeof A[]) => Promise<{ markets: Array<{ trading_engine_id: string }>;
      quoteFree: number | null; quoteLocked: number | null; permissions: string }> };
}
test("same-symbol cross-shard snapshots retain each engine ID but observe the physical wallet once", async () => {
  const f = fixture(), result = await f.load([A, B]);
  assert.deepEqual(result.markets.map((row) => row.trading_engine_id), ["A", "B"]);
  assert.deepEqual(f.engineReads, ["A"]);
  assert.equal(f.calls.length, 2);
  assert.equal(result.quoteFree, 100); assert.equal(result.quoteLocked, 5);
});
test("duplicate identity/mixed operator is rejected before any exchange I/O", async () => {
  const f = fixture();
  await assert.rejects(f.load([A, A]), /DUPLICATE_ENGINE/);
  await assert.rejects(f.load([A, { ...B, operator_id: "foreign" }]), /SCOPE_MIXED/);
  assert.equal(f.calls.length, 0); assert.equal(f.engineReads.length, 0);
});
test("missing wallet evidence stays unknown and is never a balance or credential PASS", async () => {
  const result = await fixture(true).load([A, B]);
  assert.equal(result.quoteFree, null); assert.equal(result.quoteLocked, null);
  assert.equal(result.permissions, "UNVERIFIED");
});

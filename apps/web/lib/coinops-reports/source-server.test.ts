import assert from "node:assert/strict";
import test from "node:test";

import { assertOwnedRows, readScopedPages, validateReportScope, type ReportFilters, type ReportReadClient, type ReportScope, type SourceQuery, type SourceRow } from "./source-contract.ts";

const scope: ReportScope = {
  productId: "10000000-0000-4000-8000-000000000001",
  tenantId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
};
const filters: ReportFilters = { start: "2026-09-01T04:00:00.000Z", end: "2026-09-23T04:00:00.000Z", assets: ["SOL"], environments: ["SHADOW"] };
const row = (id: number): SourceRow => ({ id, product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId });
type QueryLog = { table: string; columns: string; filters: Array<[string, string, unknown]>; range: [number, number]; order: string[] };
function fakeClient(rows: SourceRow[], logs: QueryLog[]): ReportReadClient {
  return { from(table) { return { select(columns) {
    const log: QueryLog = { table, columns, filters: [], range: [0, 0], order: [] }; logs.push(log);
    const query = {
      eq(column: string, value: string) { log.filters.push(["eq", column, value]); return query; },
      in(column: string, value: string[]) { log.filters.push(["in", column, value]); return query; },
      gte(column: string, value: string) { log.filters.push(["gte", column, value]); return query; },
      lt(column: string, value: string) { log.filters.push(["lt", column, value]); return query; },
      lte(column: string, value: string) { log.filters.push(["lte", column, value]); return query; },
      order(column: string) { log.order.push(column); return query; },
      range(from: number, to: number) { log.range = [from, to]; return query; },
      then(resolve: (value: { data: SourceRow[]; error: null }) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve({ data: rows.slice(log.range[0], log.range[1] + 1), error: null }).then(resolve, reject);
      },
    };
    return query as unknown as SourceQuery;
  } }; } };
}

test("source scope rejects absent or malformed server identity", () => {
  assert.deepEqual(validateReportScope(scope), scope);
  assert.throws(() => validateReportScope({ ...scope, tenantId: "client-selected-tenant" }), /SCOPE_INVALID/);
  assert.throws(() => validateReportScope({ ...scope, userId: "" }), /SCOPE_INVALID/);
});

test("post-query defense rejects a different tenant, user or product before exporting", () => {
  for (const field of ["tenant_id", "user_id", "product_id"]) {
    assert.throws(() => assertOwnedRows([{ ...row(1), [field]: "another-owner" }], scope), /SCOPE_MISMATCH/);
  }
  assert.deepEqual(assertOwnedRows([row(1)], scope), [row(1)]);
});

test("every evidence page carries all ownership, asset, period and deterministic order constraints", async () => {
  const logs: QueryLog[] = []; const rows = Array.from({ length: 1003 }, (_, index) => row(index)); const received: SourceRow[] = [];
  for await (const page of readScopedPages(fakeClient(rows, logs), scope, "robot_v1_market_candles", {
    columns: "id,candle_open_at", order: ["candle_open_at", "id"], time: "candle_open_at", from: filters.start, until: filters.end, assetColumn: "symbol",
  }, filters)) received.push(...page);
  assert.equal(received.length, 1003);
  assert.deepEqual(logs.map((log) => log.range), [[0, 999], [1000, 1999]]);
  for (const log of logs) {
    assert.deepEqual(log.filters.slice(0, 3), [["eq", "product_id", scope.productId], ["eq", "tenant_id", scope.tenantId], ["eq", "user_id", scope.userId]]);
    assert.ok(log.filters.some(([method, column, value]) => method === "gte" && column === "candle_open_at" && value === filters.start));
    assert.ok(log.filters.some(([method, column, value]) => method === "lt" && column === "candle_open_at" && value === filters.end));
    assert.deepEqual(log.filters.find(([method]) => method === "in")?.[2], ["SOLUSDC", "SOLUSDT", "SOLBRL"]);
    assert.deepEqual(log.order, ["candle_open_at", "id"]);
    assert.equal(log.columns, "product_id,tenant_id,user_id,id,candle_open_at");
  }
});

test("empty owned parent set never falls back to an unfiltered child query", async () => {
  const logs: QueryLog[] = [];
  for await (const _page of readScopedPages(fakeClient([row(1)], logs), scope, "robot_v1_testnet_orders", { columns: "id", order: ["id"], related: { column: "run_id", ids: [] } }, filters)) assert.fail("No page expected");
  assert.equal(logs.length, 0);
});

test("large parent scope is queried in bounded groups without dropping parents", async () => {
  const logs: QueryLog[] = []; const ids = Array.from({ length: 201 }, (_, index) => String(index));
  for await (const _page of readScopedPages(fakeClient([], logs), scope, "robot_v1_slots", { columns: "id", order: ["id"], related: { column: "cycle_id", ids } }, filters)) assert.fail("No page expected");
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.flatMap((log) => log.filters.find(([method, column]) => method === "in" && column === "cycle_id")?.[2] as string[]), ids);
});

test("tenant mismatch aborts paginated download instead of silently discarding unsafe evidence", async () => {
  const unsafe = [{ ...row(1), tenant_id: "other" }];
  await assert.rejects(async () => {
    for await (const _page of readScopedPages(fakeClient(unsafe, []), scope, "robot_v1_slots", { columns: "id", order: ["id"] }, filters)) assert.fail("Unsafe page must not escape");
  }, /SCOPE_MISMATCH/);
});

test("reconciliation detail compression only selects mismatches while remaining explicitly scoped", async () => {
  const logs: QueryLog[] = [];
  for await (const _page of readScopedPages(fakeClient([], logs), scope, "exchange_reconciliation_items", { columns: "id,classification", order: ["id"], reconciliationDivergencesOnly: true }, filters)) assert.fail("No page expected");
  assert.deepEqual(logs[0]?.filters.find(([method, column]) => method === "in" && column === "classification")?.[2], ["QUANTITY_MISMATCH", "PRICE_MISMATCH", "STATUS_MISMATCH", "UNKNOWN"]);
  assert.ok(logs[0]?.filters.some(([method, column, value]) => method === "eq" && column === "tenant_id" && value === scope.tenantId));
});

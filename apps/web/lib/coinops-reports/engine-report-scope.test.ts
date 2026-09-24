import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuditReport, type AuditInput, type AuditFilters } from "./report-engine.ts";
import { engineSources, selectedReportEngines } from "./engine-report-scope.ts";
import { resolveEngineContext, type DomainRegistry } from "../execution/operator-context.ts";
import { parseReportFilters } from "./filters.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-09-24T12:00:00Z";
const registry: DomainRegistry = {
  operator: { id: id(1), product_id: id(2), tenant_id: id(3), user_id: id(4), status: "ACTIVE", kill_switch: false },
  accounts: [5, 6].map((n) => ({ id: id(n), operator_id: id(1), display_name: `Fictícia ${n}`, status: "ACTIVE", is_legacy_default: n === 5, kill_switch: false })),
  engines: [5, 6].flatMap((account, index) => ["BTCBRL", "SOLBRL", "BTCUSDT", "SOLUSDT"].map((symbol, n) => ({
    id: id(10 + index * 4 + n), operator_id: id(1), exchange_account_id: id(account), symbol,
    environment: "REAL" as const, base_asset: symbol.slice(0, 3), quote_asset: symbol.slice(3),
    hard_cap_quote: 100, status: "ACTIVE", kill_switch: false, legacy_compatible: index === 0 && n < 2,
  }))),
};
const filters: AuditFilters = { start: "2026-09-24T04:00:00Z", end: "2026-09-25T04:00:00Z", assets: ["BTC", "SOL"], environments: ["REAL"] };
const scoped = (n: number) => { const engine = registry.engines[n]!; return { operator_id: id(1),
  product_id: id(2), tenant_id: id(3), user_id: id(4), exchange_account_id: engine.exchange_account_id,
  trading_engine_id: engine.id, asset: engine.base_asset, symbol: engine.symbol, quote_asset: engine.quote_asset }; };
function input(): AuditInput {
  return { generatedAt: at, scope: { tenantId: id(3), userId: id(4) }, registry, warnings: [], incompleteSources: [], sources: {
    robot_v1_live_runs: registry.engines.map((_, n) => ({ ...scoped(n), id: id(100 + n), status: "ACTIVE", created_at: at, last_reconciled_at: at, last_error: null })),
    robot_v1_live_slot_accounts: registry.engines.flatMap((_, n) => Array.from({ length: 25 }, (_, slot) => ({ ...scoped(n), slot_number: slot + 1,
      balance_quote: 10 + n, balance_brl: 10 + n, market_pnl_quote: 0, fees_quote: 0, gain_count: 0 }))),
    robot_v1_live_slots: registry.engines.flatMap((_, n) => Array.from({ length: 25 }, (_, slot) => ({ ...scoped(n), id: id(200 + n * 25 + slot),
      run_id: id(100 + n), slot_number: slot + 1, position_committed_quote: 0, entry_state: "PLANNED" }))),
  } };
}

test("reports: A/B and four native markets partition before any aggregation", () => {
  const report = buildAuditReport(input(), filters);
  assert.equal(report.datasets.summary.length, 8);
  for (let n = 0; n < registry.engines.length; n++) {
    const row = report.datasets.summary.find((item) => item.trading_engine_id === registry.engines[n]!.id)!;
    assert.equal(row.capital_end, 25 * (10 + n));
    assert.equal(row.capital_start, null);
    assert.equal(row.quote_asset, registry.engines[n]!.quote_asset);
    assert.equal(row.symbol, registry.engines[n]!.symbol);
    assert.equal(row.exchange_account_id, registry.engines[n]!.exchange_account_id);
  }
});

test("reports: manipulated engine/account and cross-account rows are denied", () => {
  assert.throws(() => selectedReportEngines(registry, { ...filters, exchangeAccountId: id(5), tradingEngineId: id(14) }), /DENIED/);
  assert.throws(() => selectedReportEngines(registry, { ...filters, exchangeAccountId: id(5), tradingEngineId: id(99) }), /DENIED/);
  const data = input();
  data.sources.robot_v1_live_runs![0]!.exchange_account_id = id(6);
  const engine = resolveEngineContext(registry, { environment: "REAL", exchange_account_id: id(5), trading_engine_id: id(10) });
  assert.throws(() => engineSources(data, engine), /MISMATCH/);
});

test("reports: filtered account contains no order, balance or check from B", () => {
  const report = buildAuditReport(input(), { ...filters, exchangeAccountId: id(5), tradingEngineId: id(12) });
  assert.equal(report.datasets.summary.length, 1);
  for (const rows of Object.values(report.datasets)) for (const row of rows) {
    assert.equal(row.exchange_account_id, id(5)); assert.equal(row.trading_engine_id, id(12));
    assert.equal(row.symbol, "BTCUSDT"); assert.equal(row.quote_asset, "USDT");
  }
});

test("reports: IDs are selectors, never tenant authorization; invalid routing rejected", () => {
  assert.throws(() => parseReportFilters(new URLSearchParams({ account: "Rafael" }), new Date(at)), /INVALID/);
  assert.throws(() => parseReportFilters(new URLSearchParams({ engine: id(10) }), new Date(at)), /INVALID/);
  assert.throws(() => parseReportFilters(new URLSearchParams({ tenant_id: id(3) }), new Date(at)), /SCOPE_NOT_ACCEPTED/);
  const parsed = parseReportFilters(new URLSearchParams({ account: id(5), engine: id(10), preset: "today" }), new Date(at));
  assert.equal(parsed.exchangeAccountId, id(5)); assert.equal(parsed.tradingEngineId, id(10));
});

test("reports: account market balances remain isolated by native quote", () => {
  const data = input();
  data.sources.live_market_snapshot = ["BRL", "USDT"].map((quote, n) => ({ operator_id: id(1),
    exchange_account_id: id(5), quote_asset: quote, environment: "REAL", available_quote: 100 + n }));
  const engine = resolveEngineContext(registry, { environment: "REAL", exchange_account_id: id(5), trading_engine_id: id(12) });
  const selected = engineSources(data, engine).live_market_snapshot;
  assert.equal(selected.length, 1); assert.equal(selected[0]!.quote_asset, "USDT");
  assert.equal(selected[0]!.available_quote, 101);
});

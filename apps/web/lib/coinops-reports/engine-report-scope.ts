import { assertDomainRegistry, resolveEngineContext, type DomainRegistry, type EngineContext } from "../execution/operator-context.ts";
import type { AuditFilters, AuditInput, AuditReport, ReportRuleDefinition } from "./report-engine.ts";
import type { AuditRow } from "./trigger-audit.ts";

export function selectedReportEngines(registry: DomainRegistry, filters: AuditFilters) {
  assertDomainRegistry(registry, registry.operator);
  if (filters.exchangeAccountId && !registry.accounts.some((account) => account.id === filters.exchangeAccountId))
    throw new Error("COINOPS_REPORT_ACCOUNT_DENIED");
  if (filters.tradingEngineId) {
    const found = registry.engines.find((engine) => engine.id === filters.tradingEngineId);
    if (!found || !filters.exchangeAccountId || found.exchange_account_id !== filters.exchangeAccountId
      || filters.symbol && filters.symbol !== found.symbol || !filters.environments.includes(found.environment)
      || !filters.assets.includes(found.base_asset as "BTC" | "SOL")) throw new Error("COINOPS_REPORT_ENGINE_DENIED");
  }
  return registry.engines.filter((engine) => (!filters.exchangeAccountId || engine.exchange_account_id === filters.exchangeAccountId)
    && (!filters.tradingEngineId || engine.id === filters.tradingEngineId) && (!filters.symbol || engine.symbol === filters.symbol)
    && filters.environments.includes(engine.environment) && filters.assets.includes(engine.base_asset as "BTC" | "SOL"));
}

/** Partition BEFORE existing aggregations. Same asset/slot numbers in another
 * engine never enter the calculation, even for a privileged report caller. */
export function engineSources(input: AuditInput, engine: EngineContext) {
  const sources: Record<string, AuditRow[]> = {};
  for (const [table, rows] of Object.entries(input.sources)) {
    sources[table] = rows.filter((row) => {
      if (row.tenant_id !== undefined && row.tenant_id !== input.scope.tenantId
        || row.user_id !== undefined && row.user_id !== input.scope.userId) throw new Error("COINOPS_REPORT_SCOPE_MISMATCH");
      if (row.trading_engine_id !== undefined && row.trading_engine_id !== null) {
        const registered = input.registry!.engines.find((candidate) => candidate.id === row.trading_engine_id);
        if (!registered || registered.exchange_account_id !== row.exchange_account_id || registered.operator_id !== row.operator_id)
          throw new Error("COINOPS_REPORT_ENGINE_MISMATCH");
        return row.trading_engine_id === engine.trading_engine_id;
      }
      // Deliberately unscoped historical platform/manual observations are not
      // guessed into any engine. Account-scoped snapshots/caps are explicit.
      if (row.exchange_account_id !== undefined && row.exchange_account_id === engine.exchange_account_id
        && row.operator_id === engine.operator_id && row.quote_asset === engine.quote_asset)
        return (row.environment === undefined || row.environment === engine.environment)
          && (!row.asset || row.asset === engine.base_asset) && (!row.symbol || row.symbol === engine.symbol);
      return false;
    });
  }
  return sources;
}

const numeric = (value: unknown) => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
const total = (rows: AuditRow[], field: string) => rows.some((row) => numeric(row[field]) === null) ? null
  : Number(rows.reduce((sum, row) => sum + Number(row[field]), 0).toFixed(8));

function enrich(report: AuditReport, sources: Record<string, AuditRow[]>, context: EngineContext, input: AuditInput, filters: AuditFilters) {
  for (const rows of Object.values(report.datasets)) for (const row of rows) {
    Object.assign(row, { operator_id: context.operator_id, exchange_account_id: context.exchange_account_id,
      account_display_name: context.account_display_name, trading_engine_id: context.trading_engine_id,
      environment: context.environment, symbol: context.symbol, quote_asset: context.quote_asset,
      ath_reference_symbol: context.ath_reference_symbol });
    if (row.unit === "USDC" || row.unit === "BRL") row.unit = context.quote_asset;
    // Suffixes of legacy storage/exports are retained for compatibility only;
    // their native equivalents and quote are the canonical 5.6 contract.
    for (const [key, value] of Object.entries(row)) if (/_usdc$|_brl$/.test(key)) {
      row[key.replace(/_(usdc|brl)$/, "_quote")] = value;
      if (!key.endsWith(`_${context.quote_asset.toLowerCase()}`)) row[key] = null;
    }
  }
  if (context.environment !== "REAL") return;
  const accounts = sources.robot_v1_live_slot_accounts ?? [], runs = sources.robot_v1_live_runs ?? [],
    slots = sources.robot_v1_live_slots ?? [], orders = sources.robot_v1_live_orders ?? [];
  for (const summary of report.datasets.summary) {
    const current = Date.parse(filters.end) >= Date.parse(input.generatedAt);
    const activeRuns = runs.filter((run) => ["ACTIVE", "PAUSED"].includes(String(run.status)));
    const ownSlots = slots.filter((slot) => activeRuns.some((run) => run.id === slot.run_id));
    const ownOrders = orders.filter((order) => activeRuns.some((run) => run.id === order.run_id));
    const ledgerComplete = accounts.length === 25 && ownSlots.length === 25;
    const balance = ledgerComplete ? total(accounts, "balance_quote") : null;
    const committed = ledgerComplete ? total(ownSlots, "position_committed_quote") : null;
    const reserved = ownOrders.filter((order) => order.side === "BUY" && ["NEW", "PARTIALLY_FILLED", "PREPARED"].includes(String(order.status)))
      .reduce((sum, order) => sum + Math.max(0, Number(order.reserved_notional_quote) - Number(order.cumulative_quote)), 0);
    summary.capital_start = null; // A current snapshot cannot reconstruct the period start.
    summary.capital_end = current ? balance : null;
    summary.committed_capital = current && committed !== null && Number.isFinite(reserved) ? Number((committed + reserved).toFixed(8)) : null;
    summary.free_capital = current && balance !== null && summary.committed_capital !== null ? Number((balance - Number(summary.committed_capital)).toFixed(8)) : null;
    summary.capital_basis = "NATIVE_ENGINE_LEDGER_CURRENT_SNAPSHOT; HISTORICAL_CAPITAL_WITHOUT_SNAPSHOT_UNAVAILABLE";
    summary.capital_snapshot_at = input.generatedAt;
    summary.realized_pnl = null; // Detailed fills/events retain evidence; lifetime is not period performance.
    summary.lifetime_market_pnl_quote = ledgerComplete ? total(accounts, "market_pnl_quote") : null;
    summary.lifetime_fees_quote = ledgerComplete ? total(accounts, "fees_quote") : null;
    summary.total_result = null;
    summary.open_operations = current ? ownSlots.filter((slot) => slot.entry_state === "OPEN").length : null;
    summary.operational_open = summary.open_operations;
    summary.operational_next_buy = current ? ownSlots.filter((slot) => slot.entry_state === "ARMED").length : null;
    summary.operational_planned = current ? ownSlots.filter((slot) => slot.entry_state === "PLANNED").length : null;
    summary.last_reconciliation = activeRuns[0]?.last_reconciled_at ?? null;
  }
}

export function buildScopedEngineReports(input: AuditInput, filters: AuditFilters, extensions: readonly ReportRuleDefinition[],
  build: (input: AuditInput, filters: AuditFilters, extensions: readonly ReportRuleDefinition[]) => AuditReport): AuditReport {
  const registry = input.registry!;
  if (registry.operator.tenant_id !== input.scope.tenantId || registry.operator.user_id !== input.scope.userId)
    throw new Error("COINOPS_REPORT_SCOPE_MISMATCH");
  const reports = selectedReportEngines(registry, filters).map((engine) => {
    const context = resolveEngineContext(registry, { environment: engine.environment,
      exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.id });
    const sources = engineSources(input, context);
    const report = build({ ...input, sources, registry: undefined }, { ...filters,
      assets: [engine.base_asset as "BTC" | "SOL"], environments: [engine.environment] }, extensions);
    enrich(report, sources, context, input, filters);
    return report;
  });
  if (!reports.length) throw new Error("COINOPS_REPORT_ENGINE_UNAVAILABLE");
  const result = reports[0]!;
  for (const report of reports.slice(1)) {
    for (const key of Object.keys(result.datasets) as Array<keyof AuditReport["datasets"]>) result.datasets[key].push(...report.datasets[key]);
    result.warnings.push(...report.warnings); result.incompleteSources.push(...report.incompleteSources);
  }
  // Manual legacy reconciliation remains separate from LIVE engine health.
  const legacyAccount = registry.accounts.find((account) => account.is_legacy_default);
  if (legacyAccount && !filters.tradingEngineId && (!filters.exchangeAccountId || filters.exchangeAccountId === legacyAccount.id)
    && filters.environments.includes("REAL")) {
    const legacySources = Object.fromEntries(Object.entries(input.sources).filter(([key]) => key.startsWith("exchange_") || key.startsWith("execution_")));
    if (Object.values(legacySources).some((rows) => rows.length)) {
      const legacy = build({ ...input, registry: undefined, sources: legacySources, warnings: [], incompleteSources: [] },
        { ...filters, environments: ["REAL"] }, extensions);
      for (const key of ["reconciliation", "real", "alerts"] as const) for (const row of legacy.datasets[key]) {
        if (filters.symbol && row.symbol !== filters.symbol) continue;
        result.datasets[key].push({ ...row, operator_id: registry.operator.id, exchange_account_id: legacyAccount.id,
          account_display_name: legacyAccount.display_name, trading_engine_id: null, quote_asset: null,
          evidence_scope: "LEGACY_MANUAL_PRODUCTION_NOT_ENGINE", engine_operational_issue: false });
      }
    }
  }
  if (Object.values(input.sources).some((rows) => rows.some((row) => !row.trading_engine_id && !row.exchange_account_id))) {
    result.incompleteSources.push("legacy_manual_evidence:unassigned_to_engine");
    result.warnings.push("Evidência legada sem vínculo inequívoco com motor não foi atribuída a outra conta ou mercado.");
  }
  result.warnings = [...new Set(result.warnings)]; result.incompleteSources = [...new Set(result.incompleteSources)];
  return result;
}

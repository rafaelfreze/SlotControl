import type { DomainRegistry } from "../execution/operator-context.ts";
/** Persisted evidence only. These types never carry exchange credentials. */
export type ReportEnvironment = "SHADOW" | "TESTNET" | "REAL";
export type ReportAsset = "BTC" | "SOL";
export type SourceRow = Record<string, unknown>;
export type ReportFilters = { start: string; end: string; assets: ReportAsset[]; environments: ReportEnvironment[]; temporalWindow?: "SINCE_STRATEGY_4_1";
  exchangeAccountId?: string; tradingEngineId?: string; symbol?: string };
export type ReportScope = { tenantId: string; userId: string; productId: string };
export type RawReportSources = {
  sources: Record<string, SourceRow[]>;
  incompleteSources: string[];
  warnings: string[];
  generatedAt: string;
  scope: ReportScope;
  registry?: DomainRegistry;
};

export class ReportSourceError extends Error {
  readonly status: number;
  constructor(code: string, status = 503) { super(code); this.name = "ReportSourceError"; this.status = status; }
}

export type SourceQuery = PromiseLike<{ data: unknown; error: unknown }> & {
  eq(column: string, value: string): SourceQuery;
  in(column: string, values: string[]): SourceQuery;
  gte(column: string, value: string): SourceQuery;
  lt(column: string, value: string): SourceQuery;
  lte(column: string, value: string): SourceQuery;
  order(column: string, options?: { ascending: boolean }): SourceQuery;
  range(from: number, to: number): SourceQuery;
};
export type ReportReadClient = { from(table: string): { select(columns: string): SourceQuery } };
export type SourceDefinition = {
  columns: string;
  order: string[];
  time?: string;
  from?: string;
  until?: string;
  assetColumn?: "asset" | "symbol";
  environmentColumn?: boolean;
  reconciliationDivergencesOnly?: boolean;
  related?: { column: string; ids: string[] };
  engineIds?: string[];
  accountIds?: string[];
};

export const REPORT_PAGE_SIZE = 1000;

/** Fail closed before querying. A browser-supplied tenant is never accepted. */
export function validateReportScope(scope: ReportScope): ReportScope {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![scope.productId, scope.tenantId, scope.userId].every((value) => uuid.test(value))) {
    throw new ReportSourceError("COINOPS_REPORT_SCOPE_INVALID", 403);
  }
  return scope;
}

/** Defense in depth after RLS: reject, rather than export, a mismatched row. */
export function assertOwnedRows(data: unknown, scope: ReportScope): SourceRow[] {
  if (!Array.isArray(data)) throw new ReportSourceError("COINOPS_REPORT_SOURCE_INVALID");
  for (const row of data) {
    if (!row || typeof row !== "object" || row.product_id !== scope.productId || row.tenant_id !== scope.tenantId || row.user_id !== scope.userId) {
      throw new ReportSourceError("COINOPS_REPORT_SCOPE_MISMATCH", 403);
    }
  }
  return data as SourceRow[];
}

/** Stable pagination over immutable evidence, scoped on every page. */
export async function* readScopedPages(
  client: ReportReadClient,
  scopeInput: ReportScope,
  table: string,
  definition: SourceDefinition,
  filters: ReportFilters,
): AsyncGenerator<SourceRow[]> {
  const scope = validateReportScope(scopeInput);
  if (definition.related && definition.related.ids.length === 0) return;
  if (definition.engineIds && definition.engineIds.length === 0) return;
  if (definition.accountIds && definition.accountIds.length === 0) return;
  const groups = definition.related
    ? Array.from({ length: Math.ceil(definition.related.ids.length / 100) }, (_, index) => definition.related!.ids.slice(index * 100, index * 100 + 100))
    : [null];
  for (const ids of groups) {
    for (let offset = 0; ; offset += REPORT_PAGE_SIZE) {
      const engineColumns = definition.engineIds || definition.accountIds ? "operator_id,exchange_account_id,trading_engine_id,quote_asset," : "";
      let query = client.from(table).select(`product_id,tenant_id,user_id,${engineColumns}${definition.columns}`)
        .eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
      if (definition.time && definition.from) query = query.gte(definition.time, definition.from);
      if (definition.time && definition.until) query = query.lt(definition.time, definition.until);
      if (definition.assetColumn && !(definition.engineIds && definition.assetColumn === "symbol")) query = query.in(definition.assetColumn, definition.assetColumn === "asset"
        ? filters.assets : filters.assets.flatMap((asset) => [`${asset}USDC`, `${asset}USDT`, `${asset}BRL`]));
      if (definition.environmentColumn) query = query.in("environment", filters.environments);
      if (definition.reconciliationDivergencesOnly) query = query.in("classification", ["QUANTITY_MISMATCH", "PRICE_MISMATCH", "STATUS_MISMATCH", "UNKNOWN"]);
      if (ids && definition.related) query = query.in(definition.related.column, ids);
      if (definition.engineIds) query = query.in("trading_engine_id", definition.engineIds);
      if (definition.accountIds) query = query.in("exchange_account_id", definition.accountIds);
      for (const column of definition.order) query = query.order(column, { ascending: true });
      if ((definition.engineIds || definition.accountIds) && !definition.order.includes("trading_engine_id"))
        query = query.order("trading_engine_id", { ascending: true });
      const { data, error } = await query.range(offset, offset + REPORT_PAGE_SIZE - 1);
      if (error) throw new ReportSourceError(`COINOPS_REPORT_SOURCE_UNAVAILABLE:${table}`);
      const rows = assertOwnedRows(data ?? [], scope);
      if (definition.engineIds && rows.some((row) => typeof row.trading_engine_id !== "string" || !definition.engineIds!.includes(row.trading_engine_id)))
        throw new ReportSourceError("COINOPS_REPORT_ENGINE_MISMATCH", 403);
      if (definition.accountIds && rows.some((row) => typeof row.exchange_account_id !== "string" || !definition.accountIds!.includes(row.exchange_account_id)))
        throw new ReportSourceError("COINOPS_REPORT_ACCOUNT_MISMATCH", 403);
      if (rows.length) yield rows;
      if (rows.length < REPORT_PAGE_SIZE) break;
    }
  }
}

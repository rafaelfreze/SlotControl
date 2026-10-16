import "server-only";

import type { createClient } from "../supabase/server";
import { buildAccountFunding, type AccountFundingInput } from "./account-funding";
import type { LiveExecutorState } from "./live-executor-transport";
import { assertDomainRegistry, isIdentity, type DomainRegistry, type OperatorScope } from "./operator-context";
import { liveEngineOrderPrefix } from "./robot-v1-live-cycle";

type AuthenticatedClient = ReturnType<typeof createClient>;
type PageResult = { data: unknown[] | null; error: unknown; count: number | null };
type PageQuery = PromiseLike<PageResult> & {
  range(start: number, end: number): PageQuery;
  abortSignal(signal: AbortSignal): PageQuery;
};
const PAGE_SIZE = 500;
const MAX_ROWS = 100_000;
const READ_ERROR = "COINOPS_ACCOUNT_FUNDING_READ_UNAVAILABLE";
type StoredFundingOrder = Omit<AccountFundingInput["orders"][number], "symbol"> & {
  id: string; quote_asset: string;
};

function readFailure(stage: string, error?: unknown): never {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && /^(?:[0-9A-Z]{5}|PGRST[0-9X]{3})$/.test(error.code) ? error.code : null;
  // Provider text/payload, account identity, balances and order data never log.
  console.warn("COINOPS_ACCOUNT_FUNDING_READ_FAILED", { stage, provider_code: code });
  throw new Error(READ_ERROR);
}

/** Complete RLS reads only. Exact counts and unique keys prevent provider row
 * limits or concurrent page changes from producing a persuasive partial total. */
async function pages<T>(query: () => PageQuery, identity: (row: T) => string,
  deadline: AbortSignal, stage: string): Promise<T[]> {
  const rows: T[] = [], seen = new Set<string>();
  let expected: number | null = null;
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    let response: PageResult;
    try { response = await query().range(offset, offset + PAGE_SIZE - 1).abortSignal(deadline); }
    catch (error) { readFailure(stage, error); }
    if (response.error || !Array.isArray(response.data) || !Number.isSafeInteger(response.count)
      || response.count! < 0 || response.count! > MAX_ROWS
      || expected !== null && expected !== response.count || response.data.length > PAGE_SIZE)
      readFailure(stage, response.error);
    expected = response.count!;
    for (const value of response.data as T[]) {
      const key = identity(value);
      if (!key || seen.has(key)) readFailure(stage);
      seen.add(key); rows.push(value);
    }
    if (rows.length === expected) return rows;
    if (response.data.length < PAGE_SIZE || rows.length > expected) readFailure(stage);
  }
  return readFailure(stage);
}

/** Informational account-level funding diagnostic. The caller supplies its
 * authenticated RLS client, owned registry and already collected Binance reads.
 * No service-role fallback, RPC, exchange request, reconciliation or write. */
export async function loadAccountFunding(db: AuthenticatedClient, options: {
  scope: OperatorScope; registry: DomainRegistry; accountId: string;
  states: LiveExecutorState[]; now?: number;
}) {
  const { scope, registry, accountId } = options;
  assertDomainRegistry(registry, scope);
  const account = registry.accounts.find((row) => row.id === accountId);
  if (!isIdentity(accountId) || !account || ["DISABLED", "REVOKED"].includes(account.status))
    throw new Error("COINOPS_ACCOUNT_FUNDING_SCOPE_DENIED");
  const operatorId = registry.operator.id;
  const deadline = AbortSignal.timeout(5_000);
  const query = (table: string, columns: string, tenantScoped = true) => {
    const result = db.from(table).select(columns, { count: "exact" })
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId);
    return tenantScoped ? result.eq("product_id", scope.product_id)
      .eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id) : result;
  };
  const engines = await pages<AccountFundingInput["engines"][number] & { base_asset: string; legacy_compatible: boolean }>(() =>
    query("trading_engines", "id,operator_id,exchange_account_id,environment,quote_asset,symbol,executor_shard_id,status,hard_cap_quote,base_asset,legacy_compatible,slot_count,config", false)
      .eq("environment", "REAL").neq("status", "DISABLED").order("id"), (row) => row.id, deadline, "engines");
  const expectedEngines = registry.engines.filter((row) => row.environment === "REAL"
    && row.exchange_account_id === accountId && row.status !== "DISABLED");
  const expectedIds = new Set(expectedEngines.map((row) => row.id));
  if (engines.length !== expectedIds.size || engines.some((row) => !expectedIds.has(row.id)))
    readFailure("engine_inventory");
  const engineIds = engines.map((row) => row.id);
  const runs: AccountFundingInput["runs"] = [], slotAccounts: AccountFundingInput["slotAccounts"] = [];
  const slots: AccountFundingInput["slots"] = [], orders: AccountFundingInput["orders"] = [];
  const pending: AccountFundingInput["pending"] = [];
  for (let offset = 0; offset < engineIds.length; offset += 100) {
    const ids = engineIds.slice(offset, offset + 100);
    const [currentRuns, accounts, allocations] = await Promise.all([
      pages<AccountFundingInput["runs"][number]>(() => query("robot_v1_live_runs",
        "id,trading_engine_id,operator_id,exchange_account_id,status,last_reconciled_at,last_error")
        .in("trading_engine_id", ids).in("status", ["PREPARING", "ACTIVE", "PAUSED"]).order("id"),
      (row) => row.id, deadline, "runs"),
      pages<AccountFundingInput["slotAccounts"][number]>(() => query("robot_v1_live_slot_accounts",
        "operator_id,exchange_account_id,trading_engine_id,slot_number,balance_quote,dust_cost_quote")
        .in("trading_engine_id", ids).order("trading_engine_id").order("slot_number"),
      (row) => `${row.trading_engine_id}:${row.slot_number}`, deadline, "slot_accounts"),
      pages<AccountFundingInput["pending"][number] & { id: string }>(() =>
        query("robot_v1_live_selective_contribution_allocations", "id,trading_engine_id,amount_quote")
          .in("trading_engine_id", ids).eq("status", "PENDING").order("id"), (row) => row.id, deadline, "pending_allocations"),
    ]);
    runs.push(...currentRuns); slotAccounts.push(...accounts); pending.push(...allocations);
  }
  for (let offset = 0; offset < runs.length; offset += 100) {
    const ids = runs.slice(offset, offset + 100).map((row) => row.id);
    const [positions, residentOrders] = await Promise.all([
      pages<AccountFundingInput["slots"][number]>(() => query("robot_v1_live_slots",
        "id,run_id,operator_id,exchange_account_id,trading_engine_id,slot_number,position_quantity,position_committed_quote")
        .in("run_id", ids).order("id"), (row) => row.id, deadline, "slots"),
      pages<StoredFundingOrder>(() => query("robot_v1_live_orders",
        "id,run_id,operator_id,exchange_account_id,trading_engine_id,quote_asset,side,status,client_order_id,exchange_order_id,requested_quantity,executed_quantity,reserved_notional_quote,cumulative_quote,price,trades_reconciled")
        .in("run_id", ids)
        .or("status.in.(PREPARED,NEW,PARTIALLY_FILLED),and(executed_quantity.gt.0,trades_reconciled.eq.false)")
        .order("id"), (row) => row.id, deadline, "orders"),
    ]);
    slots.push(...positions);
    orders.push(...residentOrders.map((order) => {
      // The orders table has no symbol column. Recover it exclusively from the
      // exact owned engine/current-run relationship, never account + symbol.
      const engine = engines.find((item) => item.id === order.trading_engine_id);
      const run = runs.find((item) => item.id === order.run_id);
      if (!engine || !run || order.operator_id !== operatorId || order.exchange_account_id !== accountId
        || run.operator_id !== operatorId || run.exchange_account_id !== accountId
        || run.trading_engine_id !== engine.id || order.quote_asset !== engine.quote_asset)
        return readFailure("order_scope");
      return { ...order, symbol: engine.symbol };
    }));
  }
  // Historical INACTIVE preparations are not an operational grid. A newly
  // prepared engine with a current run is retained and stays incomplete until
  // its own reconciliation is proven; never substitute configured capital.
  const operational = engines.filter((engine) => ["ACTIVE", "PAUSED"].includes(engine.status)
    || runs.some((run) => run.trading_engine_id === engine.id && run.status === "PREPARING"))
    .map((engine) => ({ ...engine, orderPrefix: liveEngineOrderPrefix({
      exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.id,
      base_asset: engine.base_asset, legacy_compatible: engine.legacy_compatible,
    }) }));
  const operationalIds = new Set(operational.map((engine) => engine.id));
  return buildAccountFunding({ operatorId, accountId, accountName: account.display_name,
    engines: operational, runs: runs.filter((row) => operationalIds.has(row.trading_engine_id)),
    slotAccounts: slotAccounts.filter((row) => operationalIds.has(row.trading_engine_id)),
    slots: slots.filter((row) => operationalIds.has(row.trading_engine_id)),
    orders: orders.filter((row) => operationalIds.has(row.trading_engine_id)),
    pending: pending.filter((row) => operationalIds.has(row.trading_engine_id)), states: options.states,
    now: options.now ?? Date.now() });
}

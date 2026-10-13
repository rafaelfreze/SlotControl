import "server-only";

import type { createClient } from "../../lib/supabase/server";
import type { createServiceRoleClient } from "../../lib/supabase/service-role";
import { assertPhysicalLedger, boundedLedgerRead, observeLedgerRecord, observeLedgerRows } from "../../lib/execution/live-ledger-read";
import { LiveLedgerReadFailed, LiveReadUnavailable } from "../../lib/execution/live-read-error";
import { isIdentity } from "../../lib/execution/operator-context";
import type { LiveAssetData } from "./automation-mobile";

type Asset = "BTC" | "SOL";
type Scope = { operatorId: string; accountId: string; engineIds: string[]; productId: string; tenantId: string; userId: string };
type Owner = { operator_id: string; exchange_account_id: string; trading_engine_id: string };
type CurrentRun = LiveAssetData["run"] & Owner;
type Stage = "run" | "slots" | "orders" | "accounts" | "allocations" | "events" | "alerts";
type Resource = Parameters<typeof observeLedgerRows>[0];
type Response = { data: unknown[] | null; error: unknown; status?: number; count?: number | null };
type Query = PromiseLike<Response> & { range(start: number, end: number): Query; abortSignal(signal: AbortSignal): Query };
const failureStages = new WeakMap<object, Stage>();
const PAGE_SIZE = 500, MAX_ROWS = 100_000;

async function staged<T>(stage: Stage, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error && typeof error === "object") failureStages.set(error, stage);
    throw error;
  }
}

async function completeRows<T>(stage: Stage, resource: Resource, query: () => Query,
  key: (row: T) => string, deadline: AbortSignal, attempt: number): Promise<T[]> {
  return staged(stage, async () => {
    const result: T[] = [], seen = new Set<string>();
    let expected: number | null = null;
    for (let start = 0; start < MAX_ROWS; start += PAGE_SIZE) {
      let count: number | null = null;
      const page = await observeLedgerRows<T>(resource, Promise.resolve(query()
        .range(start, start + PAGE_SIZE - 1).abortSignal(deadline)).then((response) => {
        count = response.count ?? null;
        return { ...response, data: response.data as T[] | null };
      }), deadline, attempt);
      if (!Number.isSafeInteger(count) || count! < 0 || count! > MAX_ROWS
        || expected !== null && count !== expected || page.length > PAGE_SIZE)
        throw new Error("COINOPS_LIVE_LEDGER_INCOMPLETE");
      expected = count!;
      for (const row of page) {
        const identity = key(row);
        if (!identity || seen.has(identity)) throw new Error("COINOPS_LIVE_LEDGER_INCOMPLETE");
        seen.add(identity); result.push(row);
      }
      if (result.length === expected) return result;
      if (page.length < PAGE_SIZE || result.length > expected) throw new Error("COINOPS_LIVE_LEDGER_INCOMPLETE");
    }
    throw new Error("COINOPS_LIVE_LEDGER_INCOMPLETE");
  });
}

/** Legacy presentation observation only. A failed asset discards its entire
 * read set without failing its sibling or fabricating a healthy/empty ledger. */
export async function loadLegacyLiveDashboard(supabase: ReturnType<typeof createClient>,
  service: ReturnType<typeof createServiceRoleClient>, scope: Scope): Promise<{
    data: Partial<Record<Asset, LiveAssetData>>; unavailableAssets: Asset[]; historyUnavailableAssets: Asset[];
  }> {
  if (![scope.operatorId, scope.accountId, scope.productId, scope.tenantId, scope.userId, ...scope.engineIds].every(isIdentity)
    || new Set(scope.engineIds).size !== scope.engineIds.length)
    throw new Error("COINOPS_LEGACY_DASHBOARD_SCOPE_DENIED");
  if (!scope.engineIds.length) return { data: {}, unavailableAssets: [], historyUnavailableAssets: [] };
  const scoped = (client: typeof supabase, table: string, columns: string, exact = false) => client.from(table)
    .select(columns, exact ? { count: "exact" } : undefined)
    .eq("operator_id", scope.operatorId).eq("exchange_account_id", scope.accountId).eq("product_id", scope.productId)
    .eq("tenant_id", scope.tenantId).eq("user_id", scope.userId)
    .in("trading_engine_id", scope.engineIds);
  const entries = await Promise.all((["BTC", "SOL"] as const).map(async (asset) => {
    try {
      const data = await boundedLedgerRead(async (deadline, attempt) => {
        const current = await staged("run", () => observeLedgerRecord<CurrentRun | { absent: true }>("preparation",
          Promise.resolve(scoped(supabase, "robot_v1_live_runs",
            "id,operator_id,trading_engine_id,exchange_account_id,status,symbol,entry_regime,last_reconciled_at,last_error,config_version,gain_rate,entry_spacing")
            .eq("asset", asset).in("status", ["PREPARING", "ACTIVE", "PAUSED"]).abortSignal(deadline).maybeSingle())
            .then((response) => ({ ...response, data: response.data === null ? { absent: true as const }
              : response.data as unknown as CurrentRun })),
          deadline, attempt, "COINOPS_LIVE_RUN_READ_FAILED"));
        if ("absent" in current) return null;
        const run = current;
        if (run.operator_id !== scope.operatorId || run.exchange_account_id !== scope.accountId || !scope.engineIds.includes(run.trading_engine_id)
          || !isIdentity(run.id) || run.symbol !== `${asset}BRL`)
          throw new Error("COINOPS_LEGACY_DASHBOARD_SCOPE_DENIED");
        const owned = (client: typeof supabase, table: string, columns: string, exact = false) =>
          scoped(client, table, columns, exact).eq("trading_engine_id", run.trading_engine_id);
        const assertOwned = (row: Owner) => {
          if (row.operator_id !== scope.operatorId || row.exchange_account_id !== scope.accountId || row.trading_engine_id !== run.trading_engine_id)
            throw new Error("COINOPS_LEGACY_DASHBOARD_SCOPE_DENIED");
        };
        const [slots, orders, accounts, allocations, alerts] = await Promise.all([
          completeRows<LiveAssetData["slots"][number] & Owner & { id: string }>("slots", "slots", () =>
            owned(supabase, "robot_v1_live_slots", "id,operator_id,trading_engine_id,exchange_account_id,slot_number,entry_state,target_buy_price,operational_rank,post_ath_group,post_ath_group_rank,operation_sequence,position_quantity,position_committed_brl,missed_at", true)
              .eq("run_id", run.id).order("slot_number").order("id"), (row) => row.id, deadline, attempt),
          completeRows<LiveAssetData["orders"][number] & Owner & { id: string }>("orders", "orders", () =>
            owned(supabase, "robot_v1_live_orders", "id,operator_id,trading_engine_id,exchange_account_id,side,purpose,status,slot_number,client_order_id,exchange_order_id,price,requested_quantity,requested_quote,executed_quantity,cumulative_quote,created_at,updated_at,fee_base,fee_quote,fee_other,reserved_notional_brl,trades_reconciled", true)
              .eq("run_id", run.id).order("created_at").order("id"), (row) => row.id, deadline, attempt),
          completeRows<LiveAssetData["accounts"][number] & Owner>("accounts", "slot_accounts", () =>
            owned(supabase, "robot_v1_live_slot_accounts", "operator_id,trading_engine_id,exchange_account_id,slot_number,balance_brl,contribution_brl,market_pnl_brl,manual_gain_brl,fees_brl,gain_count,dust_quantity,dust_cost_brl", true)
              .eq("asset", asset).order("slot_number"), (row) => String(row.slot_number), deadline, attempt),
          completeRows<NonNullable<LiveAssetData["selectiveAllocations"]>[number] & Owner & { id: string }>("allocations", "bulk_checkpoint", () =>
            owned(service, "robot_v1_live_selective_contribution_allocations", "id,operator_id,trading_engine_id,exchange_account_id,slot_number,amount_quote,status,created_at,applied_at", true)
              .eq("symbol", `${asset}BRL`).in("status", ["PENDING", "APPLIED"]).order("created_at").order("id"),
          (row) => row.id, deadline, attempt),
          completeRows<LiveAssetData["alerts"][number] & Owner & { id: string }>("alerts", "monthly_target", () =>
            owned(supabase, "robot_v1_live_alerts", "id,operator_id,trading_engine_id,exchange_account_id,severity,code,last_seen_at", true)
              .eq("asset", asset).is("resolved_at", null).order("last_seen_at", { ascending: false }).order("id"),
          (row) => row.id, deadline, attempt),
        ]);
        for (const row of [...slots, ...orders, ...accounts, ...allocations, ...alerts]) assertOwned(row);
        await staged("slots", async () => { assertPhysicalLedger(slots); });
        await staged("accounts", async () => { assertPhysicalLedger(accounts); });
        return { run, slots, orders, accounts, selectiveAllocations: allocations,
          events: [] as LiveAssetData["events"], alerts, monthlyGains: [], displayProtectionComplete: true } satisfies LiveAssetData;
      });
      let historyUnavailable = false;
      if (data) {
        // History is optional presentation, never current position truth. A
        // timeout here cannot discard/retry a complete financial observation.
        const deadline = AbortSignal.timeout(5_000);
        try {
          const events = await staged("events", () => observeLedgerRows<LiveAssetData["events"][number] & Owner>("monthly_gains",
            Promise.resolve(scoped(supabase, "robot_v1_live_events", "operator_id,trading_engine_id,exchange_account_id,event_type,slot_number,observed_at,details")
              .eq("trading_engine_id", data.run.trading_engine_id).eq("run_id", data.run.id)
              .order("observed_at", { ascending: false }).limit(20).abortSignal(deadline)).then((response) => ({ ...response,
                data: response.data as unknown as Array<LiveAssetData["events"][number] & Owner> | null })), deadline, 1));
          if (events.some((row) => row.operator_id !== scope.operatorId || row.exchange_account_id !== scope.accountId
            || row.trading_engine_id !== data.run.trading_engine_id))
            throw new Error("COINOPS_LEGACY_DASHBOARD_SCOPE_DENIED");
          data.events = events;
        } catch (error) {
          historyUnavailable = true;
          const typed = error instanceof LiveReadUnavailable || error instanceof LiveLedgerReadFailed ? error : null;
          console.warn("COINOPS_LEGACY_DASHBOARD_HISTORY_UNAVAILABLE", {
            stage: "events", http_status: typed?.httpStatus ?? null, provider_code: typed?.providerCode ?? null,
            attempts: typed?.attempts ?? 1,
          });
        }
      }
      return { asset, data, unavailable: false, historyUnavailable };
    } catch (error) {
      const typed = error instanceof LiveReadUnavailable || error instanceof LiveLedgerReadFailed ? error : null;
      console.warn("COINOPS_LEGACY_DASHBOARD_READ_UNAVAILABLE", {
        stage: error && typeof error === "object" ? failureStages.get(error) ?? "run" : "run",
        http_status: typed?.httpStatus ?? null, provider_code: typed?.providerCode ?? null,
        attempts: typed?.attempts ?? 1,
      });
      return { asset, data: null, unavailable: true, historyUnavailable: false };
    }
  }));
  return { data: Object.fromEntries(entries.filter((entry) => entry.data).map((entry) => [entry.asset, entry.data])),
    unavailableAssets: entries.filter((entry) => entry.unavailable).map((entry) => entry.asset),
    historyUnavailableAssets: entries.filter((entry) => entry.historyUnavailable).map((entry) => entry.asset) };
}

import type { createServiceRoleClient } from "../supabase/service-role";
import { liveEngineExposure } from "./engine-exposure.ts";
import { assertPhysicalLedger, boundedLedgerRead, observeLedgerRecord, observeLedgerRows } from "./live-ledger-read.ts";
import { LiveReadUnavailable } from "./live-read-error.ts";
import { LIVE_ACTIVE_ORDER_STATUSES } from "./robot-v1-live-cycle.ts";
import type { V1Asset } from "./robot-v1";

type Service = ReturnType<typeof createServiceRoleClient>;
export type ExposureScope = { id: string; asset: V1Asset; symbol: string;
  product_id: string; tenant_id: string; user_id: string; operator_id: string;
  exchange_account_id: string; trading_engine_id: string; quote_asset: string };
type Ownership = Pick<ExposureScope, "product_id" | "tenant_id" | "user_id" | "operator_id"
  | "exchange_account_id" | "trading_engine_id" | "quote_asset">;
type ExposureRun = Ownership & { id: string; asset: V1Asset; symbol: string; status: string };
type ExposureEngine = { id: string; operator_id: string; exchange_account_id: string;
  environment: string; symbol: string; quote_asset: string; base_asset: V1Asset;
  hard_cap_quote: number | string; executor_shard_id: string };
type ExposureSlot = Ownership & { id: string; run_id: string; slot_number: number;
  position_committed_brl: number | string };
type ExposureOrder = Ownership & { id: string; run_id: string; slot_id: string; side: string;
  status: string; reserved_notional_brl: number | string; cumulative_quote: number | string };
type ExposureResource = "exposure_runs" | "exposure_engines" | "exposure_slots" | "exposure_orders";
type Page<T> = { data: T[] | null; error: unknown; status?: number; count?: number | null };

const incomplete = (): never => { throw new Error("COINOPS_LIVE_EXPOSURE_INCOMPLETE"); };
const sameOwner = (row: Omit<Ownership, "trading_engine_id">, scope: ExposureScope) =>
  row.product_id === scope.product_id && row.tenant_id === scope.tenant_id && row.user_id === scope.user_id
  && row.operator_id === scope.operator_id && row.exchange_account_id === scope.exchange_account_id
  && row.quote_asset === scope.quote_asset;
const amount = (value: number | string) => {
  if (typeof value !== "number" && typeof value !== "string" || typeof value === "string" && !value.trim()) return incomplete();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return incomplete();
  return parsed;
};

/** Finish every bounded GET so a quick transient failure cannot hide a
 * simultaneous permission/schema failure in another exposure source. */
async function observations<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const results = await Promise.allSettled([first, second]);
  for (const result of results) if (result.status === "rejected" && !(result.reason instanceof LiveReadUnavailable)) throw result.reason;
  if (results[0].status === "rejected") throw results[0].reason;
  if (results[1].status === "rejected") throw results[1].reason;
  return [results[0].value, results[1].value];
}

/** Complete GET pages with an exact provider count; a shorter provider page
 * cannot silently understate account exposure. Permission/schema/network
 * classification and sanitized evidence remain at observeLedgerRows. */
async function pages<T extends { id: string }>(resource: ExposureResource,
  page: (start: number, end: number) => PromiseLike<Page<T>>, deadline: AbortSignal, attempt: number) {
  const rows: T[] = [], ids = new Set<string>();
  let total: number | undefined;
  for (let start = 0; ; start += 500) {
    let responseCount: number | null | undefined;
    const current = await observeLedgerRows<T>(resource, Promise.resolve(page(start, start + 499)).then(response => {
      responseCount = response.count;
      return response;
    }), deadline, attempt);
    if (!Number.isSafeInteger(responseCount) || Number(responseCount) < 0 || current.length > 500) return incomplete();
    if (total === undefined) total = Number(responseCount);
    if (total !== responseCount || current.length !== Math.min(500, Math.max(0, total - start))) return incomplete();
    for (const row of current) {
      if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id)) return incomplete();
      ids.add(row.id); rows.push(row);
    }
    if (rows.length === total) return rows;
  }
}

/** Account-global native-quote exposure, including same-symbol engines on
 * different shards. Only a complete bounded observation may reach the existing
 * financial kernel; this helper never writes, dispatches or changes a cap.
 * Separate GETs are not an atomic snapshot: a changed page count is rejected,
 * never silently certified by extending freshness or reusing a partial total. */
export async function readLiveExposure(service: Service, scope: ExposureScope) {
  return boundedLedgerRead(async (deadline, attempt) => {
    const runs = await pages<ExposureRun>("exposure_runs", (start, end) => service.from("robot_v1_live_runs")
      .select("id,asset,symbol,status,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,quote_asset", { count: "exact" })
      .eq("product_id", scope.product_id).eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id)
      .eq("operator_id", scope.operator_id).eq("exchange_account_id", scope.exchange_account_id)
      .eq("quote_asset", scope.quote_asset).in("status", ["ACTIVE", "PAUSED"]).order("id")
      .range(start, end).abortSignal(deadline), deadline, attempt);
    const selected = runs.find(row => row.id === scope.id);
    if (!selected || selected.trading_engine_id !== scope.trading_engine_id || selected.asset !== scope.asset
      || selected.symbol !== scope.symbol || runs.some(row => !sameOwner(row, scope)
        || !["ACTIVE", "PAUSED"].includes(row.status) || !["BTC", "SOL"].includes(row.asset)
        || row.symbol !== `${row.asset}${scope.quote_asset}`)
      || new Set(runs.map(row => row.trading_engine_id)).size !== runs.length) return incomplete();
    const [engines, cap] = await observations(
      pages<ExposureEngine>("exposure_engines", (start, end) => service.from("trading_engines")
        .select("id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,hard_cap_quote,executor_shard_id", { count: "exact" })
        .eq("operator_id", scope.operator_id).eq("exchange_account_id", scope.exchange_account_id)
        .eq("environment", "REAL").eq("quote_asset", scope.quote_asset).order("id")
        .range(start, end).abortSignal(deadline), deadline, attempt),
      observeLedgerRecord<{ operator_id: string; exchange_account_id: string; quote_asset: string; hard_cap_quote: number | string }>("quote_cap",
        service.from("account_quote_caps").select("operator_id,exchange_account_id,quote_asset,hard_cap_quote")
          .eq("operator_id", scope.operator_id).eq("exchange_account_id", scope.exchange_account_id)
          .eq("quote_asset", scope.quote_asset).abortSignal(deadline).single(), deadline, attempt,
        "COINOPS_LIVE_GLOBAL_CAP_UNAVAILABLE"),
    );
    const engineById = new Map(engines.map(row => [row.id, row]));
    if (!engineById.has(scope.trading_engine_id) || engines.some(row => row.operator_id !== scope.operator_id
      || row.exchange_account_id !== scope.exchange_account_id || row.environment !== "REAL"
      || row.quote_asset !== scope.quote_asset || row.symbol !== `${row.base_asset}${scope.quote_asset}`)
      || runs.some(row => engineById.get(row.trading_engine_id)?.base_asset !== row.asset)
      || cap.operator_id !== scope.operator_id || cap.exchange_account_id !== scope.exchange_account_id
      || cap.quote_asset !== scope.quote_asset || amount(cap.hard_cap_quote) <= 0) return incomplete();
    const runById = new Map(runs.map(row => [row.id, row]));
    const slots: ExposureSlot[] = [], orders: ExposureOrder[] = [];
    const runIds = runs.map(row => row.id);
    for (let offset = 0; offset < runIds.length; offset += 200) {
      const selectedRuns = runIds.slice(offset, offset + 200);
      const [positions, resident] = await observations(
        pages<ExposureSlot>("exposure_slots", (start, end) => service.from("robot_v1_live_slots")
          .select("id,run_id,slot_number,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,quote_asset,position_committed_brl", { count: "exact" })
          .eq("operator_id", scope.operator_id).eq("exchange_account_id", scope.exchange_account_id)
          .in("run_id", selectedRuns).order("id")
          .range(start, end).abortSignal(deadline), deadline, attempt),
        pages<ExposureOrder>("exposure_orders", (start, end) => service.from("robot_v1_live_orders")
          .select("id,run_id,slot_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,quote_asset,side,status,reserved_notional_brl,cumulative_quote", { count: "exact" })
          .eq("operator_id", scope.operator_id).eq("exchange_account_id", scope.exchange_account_id)
          .in("run_id", selectedRuns)
          .in("status", [...LIVE_ACTIVE_ORDER_STATUSES]).order("id").range(start, end).abortSignal(deadline), deadline, attempt),
      );
      slots.push(...positions); orders.push(...resident);
    }
    const slotById = new Map(slots.map(row => [row.id, row]));
    if (slotById.size !== slots.length || new Set(orders.map(row => row.id)).size !== orders.length
      || [...slots, ...orders].some(row => !sameOwner(row, scope)
        || row.trading_engine_id !== runById.get(row.run_id)?.trading_engine_id)
      || orders.some(row => !["BUY", "SELL"].includes(row.side) || !LIVE_ACTIVE_ORDER_STATUSES.has(row.status)
        || slotById.get(row.slot_id)?.run_id !== row.run_id
        || slotById.get(row.slot_id)?.trading_engine_id !== row.trading_engine_id)) return incomplete();
    for (const run of runs) assertPhysicalLedger(slots.filter(row => row.run_id === run.id));
    return liveEngineExposure(scope.trading_engine_id,
      engines.map(row => ({ id: row.id, asset: row.base_asset, cap: amount(row.hard_cap_quote) })),
      slots.map(row => ({ engineId: row.trading_engine_id, committed: amount(row.position_committed_brl) })),
      orders.map(row => ({ engineId: row.trading_engine_id, side: row.side, status: row.status,
        reserved: amount(row.reserved_notional_brl), executedQuote: amount(row.cumulative_quote) })), amount(cap.hard_cap_quote));
  });
}

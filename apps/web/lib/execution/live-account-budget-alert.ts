import type { createServiceRoleClient } from "../supabase/service-role";
import { boundedLedgerRead, observeLedgerRows } from "./live-ledger-read.ts";
import { LiveReadUnavailable } from "./live-read-error.ts";
import { liveEngineOrderPrefix, LIVE_TERMINAL_ORDER_STATUSES } from "./robot-v1-live-cycle.ts";

type Service = ReturnType<typeof createServiceRoleClient>;
type Scope = { product_id: string; tenant_id: string; user_id: string; operator_id: string;
  exchange_account_id: string; trading_engine_id: string };
type Run = Scope & { id: string; asset: string; symbol: string;
  engine?: { exchange_account_id: string; trading_engine_id: string; base_asset: string;
    legacy_compatible: boolean; executor_shard_id?: string } };
type Order = Scope & { id: string; run_id: string; slot_id: string; operation_sequence: number;
  client_order_id: string; strategy_decision_id: string | null; exchange_order_id: string | null;
  side: string; status: string; executed_quantity: number | string; trades_reconciled: boolean };
type Alert = Scope & { id: string; alert_key: string; code: string; first_seen_at: string;
  last_seen_at: string; resolved_at: string | null;
  details: { run_id?: unknown; side?: unknown; client_order_id?: unknown } };
type Decision = Scope & { decision_id: string; environment: string; cycle_id: string; slot_id: string;
  operation_sequence: number; asset: string; action_type: string; result: string;
  completed_at: string | null; exchange_ack_at: string | null;
  observed_next_state: { exchange_order_id?: unknown } };
type Reservation = { operator_id: string; exchange_account_id: string; trading_engine_id: string;
  executor_shard_id: string; client_order_id: string; reserved_at: string; acknowledged_at: string | null };

const ALLOWED_NEXT = new Set(["INITIAL_SUBMITTED", "NEXT_BUY_ARMED",
  "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT", "NO_UNCROSSED_ENTRY_CANDIDATE", "VERIFIED_METADATA_RECOVERY"]);
const BUDGET_CODES = new Set(["COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN", "COINOPS_ACCOUNT_ORDER_CAPACITY_REQUIRED",
  "COINOPS_ACCOUNT_ORDER_NOT_SUBMITTED"]);
const CONNECTION_CODES = new Set(["PGRST000", "PGRST001", "PGRST002", "PGRST003", "08000", "08003", "08006", "53300"]);
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const providerCode = (value: unknown) => typeof value === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9X]{3})$/.test(value) ? value : null;

/** A metadata write is not a GET outage and can never inherit financial retry. */
export class AccountBudgetAlertResolutionError extends Error {
  readonly code: string; readonly path = "alert/account_budget/resolve";
  readonly attempts: number; readonly httpStatus: number | null; readonly providerCode: string | null;
  constructor(transient: boolean, attempts: number, httpStatus: number | null, code: unknown) {
    super(transient ? "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_RETRY" : "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED");
    this.name = "AccountBudgetAlertResolutionError"; this.code = this.message;
    this.attempts = attempts; this.httpStatus = httpStatus; this.providerCode = providerCode(code);
  }
}

function sameScope(value: Scope, run: Scope) {
  return (["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id", "trading_engine_id"] as const)
    .every(key => value[key] === run[key]);
}
function scopedAlert(service: Service, run: Run) {
  return service.from("robot_v1_live_alerts").select("id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,alert_key,code,first_seen_at,last_seen_at,resolved_at,details")
    .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
    .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
    .eq("trading_engine_id", run.trading_engine_id).eq("alert_key", `LIVE_RUN:${run.id}:ACCOUNT_ORDER_BUDGET`).limit(2);
}
function sameAlert(value: Alert, expected: Alert) {
  return value.id === expected.id && value.alert_key === expected.alert_key && value.code === expected.code
    && value.first_seen_at === expected.first_seen_at && value.last_seen_at === expected.last_seen_at
    && value.details?.run_id === expected.details.run_id && value.details?.side === expected.details.side
    && value.details?.client_order_id === expected.details.client_order_id;
}
async function readAlert(service: Service, run: Run): Promise<Alert | null> {
  const rows = await boundedLedgerRead((deadline, attempt) => observeLedgerRows<Alert>("account_budget_alert",
    scopedAlert(service, run).abortSignal(deadline), deadline, attempt));
  if (rows.length > 1 || rows[0] && (!sameScope(rows[0], run) || !rows[0].id
    || !validTime(rows[0].first_seen_at) || !validTime(rows[0].last_seen_at)
    || rows[0].resolved_at !== null && !validTime(rows[0].resolved_at)
    || rows[0].alert_key !== `LIVE_RUN:${run.id}:ACCOUNT_ORDER_BUDGET`))
    throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_PROOF_INVALID");
  return rows[0] ?? null;
}

async function heldDispatchCompleted(service: Service, run: Run, alert: Alert, orders: readonly Order[]) {
  if (!run.engine || run.engine.exchange_account_id !== run.exchange_account_id
    || run.engine.trading_engine_id !== run.trading_engine_id || !run.engine.executor_shard_id
    || !alert.id || !BUDGET_CODES.has(alert.code) || !validTime(alert.first_seen_at) || !validTime(alert.last_seen_at)
    || alert.details?.run_id !== run.id || !["BUY", "SELL"].includes(String(alert.details?.side))
    || typeof alert.details?.client_order_id !== "string")
    throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_PROOF_INVALID");
  const matches = orders.filter(order => order.client_order_id === alert.details.client_order_id);
  if (matches.length !== 1) return false;
  const order = matches[0];
  if (!sameScope(order, run) || order.run_id !== run.id || order.side !== alert.details.side
    || !order.client_order_id.startsWith(liveEngineOrderPrefix(run.engine)))
    throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_PROOF_INVALID");
  if (!order.strategy_decision_id || !order.exchange_order_id
    || !Number.isFinite(Number(order.executed_quantity)) || Number(order.executed_quantity) < 0
    || order.status !== "NEW" && !LIVE_TERMINAL_ORDER_STATUSES.has(order.status)
    || order.status === "NEW" && Number(order.executed_quantity) !== 0
    || order.status !== "NEW" && !order.trades_reconciled) return false;
  const [decisions, reservations] = await boundedLedgerRead(async (deadline, attempt) => {
    const results = await Promise.allSettled([
      observeLedgerRows<Decision>("account_budget_decision", service.from("robot_v1_strategy_decisions")
        .select("product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,decision_id,environment,cycle_id,slot_id,operation_sequence,asset,action_type,result,completed_at,exchange_ack_at,observed_next_state")
        .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
        .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
        .eq("trading_engine_id", run.trading_engine_id).eq("environment", "REAL")
        .eq("decision_id", order.strategy_decision_id).limit(2).abortSignal(deadline), deadline, attempt),
      observeLedgerRows<Reservation>("account_budget_reservation", service.from("account_order_budget_reservations")
        .select("operator_id,exchange_account_id,trading_engine_id,executor_shard_id,client_order_id,reserved_at,acknowledged_at")
        .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
        .eq("trading_engine_id", run.trading_engine_id).eq("client_order_id", order.client_order_id)
        .limit(2).abortSignal(deadline), deadline, attempt),
    ]);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const failed = rejected.find(result => !(result.reason instanceof LiveReadUnavailable)) ?? rejected[0];
    if (failed) throw failed.reason;
    return results.map(result => (result as PromiseFulfilledResult<unknown[]>).value) as [Decision[], Reservation[]];
  });
  if (decisions.length !== 1 || reservations.length !== 1) return false;
  const decision = decisions[0], reservation = reservations[0];
  if (!sameScope(decision, run) || decision.environment !== "REAL" || decision.cycle_id !== run.id
    || decision.decision_id !== order.strategy_decision_id || decision.slot_id !== order.slot_id
    || decision.operation_sequence !== order.operation_sequence || decision.asset !== run.asset
    || reservation.operator_id !== run.operator_id || reservation.exchange_account_id !== run.exchange_account_id
    || reservation.trading_engine_id !== run.trading_engine_id || reservation.executor_shard_id !== run.engine.executor_shard_id
    || reservation.client_order_id !== order.client_order_id)
    throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_PROOF_INVALID");
  return decision.result === "COMPLETED" && validTime(decision.completed_at) && validTime(decision.exchange_ack_at)
    && decision.observed_next_state?.exchange_order_id === order.exchange_order_id
    && (order.side === "SELL" ? decision.action_type === "CREATE_TP"
      : ["OPEN_INITIAL_MARKET", "ARM_NEXT_BUY", "CANCEL_REPLACE_NEXT_BUY"].includes(decision.action_type))
    && validTime(reservation.reserved_at) && validTime(reservation.acknowledged_at)
    && Date.parse(reservation.acknowledged_at) >= Date.parse(reservation.reserved_at);
}

function writeFailure(error: unknown, status: number | undefined, attempt: number) {
  const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  const code = typeof value.code === "string" ? value.code.trim() : "";
  const http = Number.isInteger(status) && status! >= 0 && status! <= 599 ? status! : null;
  const network = error instanceof TypeError || error instanceof DOMException
    && ["AbortError", "TimeoutError"].includes(error.name)
    || !code && http === 0 && typeof value.message === "string" && /^TypeError:\s*fetch failed(?:\s|$)/.test(value.message);
  const transient = network || [502, 503, 504].includes(http ?? -1) && (!code || CONNECTION_CODES.has(code));
  return new AccountBudgetAlertResolutionError(transient, attempt, http, code);
}

/** Called only after canonical reconciliation/protection. This closes one
 * proven completed hold, never certifies current Binance budget or retries a
 * financial operation. An absent target performs no empty UPDATE. */
export async function resolveAccountBudgetAlert(service: Service, run: Run, orders: readonly Order[], next: string,
  options: { renewLease?: () => Promise<void> } = {}): Promise<{ status: "ABSENT" | "DEFERRED" | "RESOLVED" }> {
  const alert = await readAlert(service, run);
  if (!alert || alert.resolved_at !== null) return { status: "ABSENT" };
  if (!ALLOWED_NEXT.has(next) || !await heldDispatchCompleted(service, run, alert, orders)) return { status: "DEFERRED" };
  const resolvedAt = new Date().toISOString();
  for (let attempt = 1; attempt <= 2; attempt++) {
    // The production caller must hold and renew the actual run lease. No
    // renewal means no authority to perform even this scoped metadata CAS.
    if (!options.renewLease) throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_LEASE_REQUIRED");
    await options.renewLease();
    let failure: AccountBudgetAlertResolutionError | null = null;
    try {
      const result = await service.from("robot_v1_live_alerts").update({ resolved_at: resolvedAt })
        .eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", run.user_id)
        .eq("operator_id", run.operator_id).eq("exchange_account_id", run.exchange_account_id)
        .eq("trading_engine_id", run.trading_engine_id).eq("id", alert.id).eq("alert_key", alert.alert_key)
        .eq("code", alert.code).eq("first_seen_at", alert.first_seen_at).eq("last_seen_at", alert.last_seen_at)
        .eq("details->>run_id", run.id).eq("details->>side", alert.details.side)
        .eq("details->>client_order_id", alert.details.client_order_id).is("resolved_at", null)
        .select("id").abortSignal(AbortSignal.timeout(5_000));
      if (result.error) failure = writeFailure(result.error, result.status, attempt);
      else if (Array.isArray(result.data) && result.data.length === 1 && result.data[0].id === alert.id)
        return { status: "RESOLVED" };
      else throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_CHANGED");
    } catch (error) {
      if (error instanceof Error && error.message === "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_CHANGED") throw error;
      failure = writeFailure(error, undefined, attempt);
    }
    if (failure!.code === "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED") throw failure;
    // A lost response may already have applied. Observe the exact identity
    // before considering the sole second metadata CAS; never repeat trading.
    const current = await readAlert(service, run);
    if (!current || !sameAlert(current, alert)) throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_CHANGED");
    if (validTime(current.resolved_at) && Date.parse(current.resolved_at) === Date.parse(resolvedAt)) return { status: "RESOLVED" };
    if (current.resolved_at !== null) throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_CHANGED");
    if (attempt === 2) throw failure;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED");
}

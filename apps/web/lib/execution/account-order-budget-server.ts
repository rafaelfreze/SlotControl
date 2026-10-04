import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { projectAccountBudgetObservation, type BudgetObservation, type BudgetEngineIdentity, type KnownBudgetOrder } from "./account-order-budget-observation.ts";
import { parseExecutorValidatedVersions, resolveExecutorForConnection, withExecutorShard } from "./executor-shards-server.ts";
import { signedExecutorHeaders } from "./live-executor-client.ts";
import type { createServiceRoleClient } from "../supabase/service-role";
import type { ExecutorEngineScope } from "./live-executor-transport.ts";
import type { AccountBudgetReservation } from "./account-order-budget-permit.ts";
import { resolveExecutorForEngine } from "./executor-shards-server.ts";

type Service = ReturnType<typeof createServiceRoleClient>;
const code = "COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN";
export class AccountOrderBudgetHold extends Error {
  readonly clientOrderId: string;
  readonly side: string;
  constructor(reason: string, clientOrderId: string, side: string) {
    super(reason); this.clientOrderId = clientOrderId; this.side = side;
  }
}
export async function accountExecutionPolicyRequired(service: Service, engine: ExecutorEngineScope) {
  const result = await service.from("account_execution_policies").select("contract,status")
    .eq("exchange_account_id", engine.exchange_account_id).eq("operator_id", engine.operator_id).maybeSingle();
  if (result.error || result.data && (result.data.contract !== "ENGINE_ISOLATION_V2"
    || !["PREPARING", "ACTIVE"].includes(result.data.status))) throw new Error("COINOPS_ENGINE_ISOLATION_POLICY_UNKNOWN");
  return Boolean(result.data);
}

/** Called only at a new engine-owned dispatch under its current run lease.
 * Reservation precedes submission_guarded_at. A BUSY/unknown sample defers
 * dispatch, never releases uncertain ownership or triggers a Binance POST. */
export async function reserveAccountOrderDispatch(service: Service, engine: ExecutorEngineScope,
  clientOrderId: string, side: string, leaseOwner: string | null, required: boolean): Promise<AccountBudgetReservation | undefined> {
  if (!required) return undefined;
  const reserve = () => service.rpc("reserve_account_order_budget", { p_operator_id: engine.operator_id,
    p_account_id: engine.exchange_account_id, p_engine_id: engine.trading_engine_id,
    p_client_order_id: clientOrderId, p_lease_owner: leaseOwner });
  let result = await reserve();
  if (!result.error && result.data?.code === "ACCOUNT_ORDER_BUDGET_UNKNOWN") {
    const target = await resolveExecutorForEngine(engine.operator_id, engine.exchange_account_id, engine.trading_engine_id);
    try { await collectAccountOrderBudget(service, engine.operator_id, engine.exchange_account_id, target.shardId, [engine.symbol]); }
    catch { throw new AccountOrderBudgetHold(code, clientOrderId, side); }
    result = await reserve();
  }
  if (result.error) throw new Error("COINOPS_ACCOUNT_ORDER_RESERVE_FAILED");
  if (result.data?.code !== "PASS") throw new AccountOrderBudgetHold(
    result.data?.code === "ACCOUNT_ORDER_CAPACITY_REQUIRED" ? "COINOPS_ACCOUNT_ORDER_CAPACITY_REQUIRED" : code, clientOrderId, side);
  const reservation = result.data as AccountBudgetReservation;
  if (reservation.operatorId !== engine.operator_id || reservation.accountId !== engine.exchange_account_id
    || reservation.engineId !== engine.trading_engine_id || reservation.clientOrderId !== clientOrderId)
    throw new Error("COINOPS_ACCOUNT_ORDER_RESERVE_SCOPE_DENIED");
  return reservation;
}

export async function acknowledgeAccountOrderDispatch(service: Service, engine: ExecutorEngineScope,
  clientOrderId: string, leaseOwner: string | null) {
  const existing = await service.from("account_order_budget_reservations").select("client_order_id")
    .eq("client_order_id", clientOrderId).eq("operator_id", engine.operator_id)
    .eq("exchange_account_id", engine.exchange_account_id).eq("trading_engine_id", engine.trading_engine_id).maybeSingle();
  if (existing.error) throw new Error("COINOPS_ACCOUNT_ORDER_ACK_UNKNOWN");
  if (!existing.data) return; // Installed historic orders have no new reservation.
  const result = await service.rpc("acknowledge_account_order_budget", { p_operator_id: engine.operator_id,
    p_account_id: engine.exchange_account_id, p_engine_id: engine.trading_engine_id,
    p_client_order_id: clientOrderId, p_lease_owner: leaseOwner });
  if (result.error || result.data !== true) throw new Error("COINOPS_ACCOUNT_ORDER_ACK_UNPROVEN");
}
/** Explicit onboarding/preflight collection only. No render/GET, hidden cron,
 * exchange writes, account-primary fallback or full Binance trade history. */
export async function collectAccountOrderBudget(service: Service, operatorId: string, accountId: string,
  shardId: string, newSymbols: readonly string[], fetcher: typeof fetch = fetch,
  options: { deadline?: number; minimumValidityMs?: number } = {}) {
  const target = await resolveExecutorForConnection(operatorId, accountId, shardId);
  const versions = parseExecutorValidatedVersions(target.validatedVersion);
  if (!versions || newSymbols.some((symbol) => !/^(BTC|SOL)(BRL|USDT)$/.test(symbol))) throw new Error(code);
  const engines = await completeLedgerRead<BudgetEngineIdentity>(async (start, end) =>
    service.from("trading_engines").select("id,operator_id,exchange_account_id,symbol")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId).eq("environment", "REAL")
      .order("id").range(start, end), code);
  const symbols = [...new Set([...engines.map((engine) => engine.symbol), ...newSymbols])].sort();
  if (!symbols.length || symbols.some((symbol) => !/^(BTC|SOL)(BRL|USDT)$/.test(symbol))) throw new Error(code);
  const rawOrders = await completeLedgerRead<Omit<KnownBudgetOrder, "symbol">>(async (start, end) =>
    service.from("robot_v1_live_orders").select("id,operator_id,exchange_account_id,trading_engine_id,client_order_id,exchange_order_id,side")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId)
      .in("status", ["NEW", "PARTIALLY_FILLED"]).not("exchange_order_id", "is", null)
      .order("id").range(start, end), code);
  const engineById = new Map(engines.map((engine) => [engine.id, engine]));
  const ledger = rawOrders.map((order) => ({ ...order, symbol: engineById.get(order.trading_engine_id)?.symbol ?? "" }));
  // The executor rejects a probe crossing a Binance counter interval. Its
  // failed-probe cooldown is 5s; retry only that read-only rejection, bounded
  // by attempts/time, never a Binance POST or a bypass of sample validation.
  const deadline = Math.min(Date.now() + 35_000, options.deadline ?? Infinity);
  const minimumValidity = options.minimumValidityMs ?? 0;
  if (!Number.isFinite(deadline) || !Number.isFinite(minimumValidity) || minimumValidity < 0 || minimumValidity > 5000)
    throw new Error(code);
  for (let attempt = 0; attempt < 3; attempt++) {
    const leaseOwner = randomUUID();
    const lease = await service.rpc("acquire_account_order_budget_probe", { p_operator_id: operatorId,
      p_account_id: accountId, p_lease_owner: leaseOwner });
    if (lease.error) throw new Error(code);
    if (lease.data !== true) {
      if (attempt < 2 && Date.now() + 1000 < deadline) { await wait(1000); continue; }
      throw new Error("COINOPS_ACCOUNT_ORDER_BUDGET_PROBE_BUSY");
    }
    let recorded = false, retryable = false;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(code);
      const requestId = randomUUID(), path = "/v1/admin/order-budget", key = `ORDER_BUDGET:${requestId}`;
      const body = JSON.stringify(withExecutorShard({ operator_id: operatorId, exchange_account_id: accountId,
        environment: "REAL", credential_ref: target.credentialRef, symbols, request_id: requestId }, target));
      const response = await fetcher(`${target.base}${path}`, { method: "POST", cache: "no-store", body,
        headers: signedExecutorHeaders(target.secret, path, body, key), signal: AbortSignal.timeout(Math.min(20_000, remaining)) });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        retryable = response.status === 503 && failure?.error === "EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN";
        throw new Error(code);
      }
      const observed = await response.json() as BudgetObservation;
      const identity = { operatorId, accountId, shardId, ip: target.ip,
        credentialRef: target.credentialRef, versions, symbols, engines, ledger };
      // Validate ALL ownership/payload fields at observation time first, so
      // an expired window is retryable without masking a malformed sample.
      const inspected = projectAccountBudgetObservation(observed, identity, observed.observedAt);
      const windowEnd = Math.min(...inspected.intervals.map(row =>
        (Math.floor(inspected.serverTime / row.intervalMs) + 1) * row.intervalMs
          - (inspected.serverTime - inspected.observedAt)));
      if (Date.now() >= windowEnd && Date.now() - inspected.observedAt <= 30_000) {
        retryable = true; throw new Error(code);
      }
      const sample = projectAccountBudgetObservation(observed, identity);
      // Retain the original Binance window and clock offset. This is a
      // scheduling margin, NOT an extension of freshness or assumed reset.
      const validUntil = Math.min(sample.observedAt + 30_000, ...sample.intervals.map(row =>
        (Math.floor(sample.serverTime / row.intervalMs) + 1) * row.intervalMs
          - (sample.serverTime - sample.observedAt)));
      if (validUntil - Date.now() < minimumValidity) { retryable = true; throw new Error(code); }
      const saved = await service.rpc("record_account_order_budget_sample", { p_operator_id: operatorId,
        p_account_id: accountId, p_lease_owner: leaseOwner, p_shard_id: shardId,
        p_observed_at: new Date(sample.observedAt).toISOString(), p_server_time_ms: sample.serverTime,
        p_intervals: sample.intervals, p_symbol_limits: sample.symbols, p_restrictions: sample.restrictions,
        p_exchange_limits: sample.exchangeOrders ?? null });
      if (saved.error || saved.data !== true) throw new Error(code);
      recorded = true; // The record RPC atomically releases this probe lease.
      if (validUntil - Date.now() < minimumValidity) { retryable = true; throw new Error(code); }
      return { observedAt: new Date(sample.observedAt).toISOString(), shardId };
    } catch (error) {
      if (!retryable || attempt === 2 || Date.now() + 5500 >= deadline) throw error;
    } finally {
      if (!recorded) {
        // Compare-and-set only OUR probe lease. Never release another worker,
        // order permit, run lease or reservation; failure stays fail-closed.
        const released = await service.from("account_order_budget_probe_leases")
          .update({ expires_at: new Date().toISOString() }).eq("operator_id", operatorId)
          .eq("exchange_account_id", accountId).eq("lease_owner", leaseOwner);
        if (released.error) throw new Error(code);
      }
    }
    await wait(5500);
  }
  throw new Error(code);
}

export async function previewAccountOrderBudget(service: Service, operatorId: string, accountId: string,
  newSymbols: readonly string[], existingSymbols: readonly string[] = []) {
  if ([...newSymbols, ...existingSymbols].some((symbol) => !/^(BTC|SOL)(BRL|USDT)$/.test(symbol))) throw new Error(code);
  const resident = Object.fromEntries(existingSymbols.map((symbol) => [symbol, 0]));
  const counts = newSymbols.reduce<Record<string, number>>((result, symbol) => {
    result[symbol] = (result[symbol] ?? 0) + 1; return result;
  }, resident);
  const result = await service.rpc("preview_account_order_budget", { p_operator_id: operatorId,
    p_account_id: accountId, p_new_orders: 3 * newSymbols.length, p_symbol_counts: counts });
  if (result.error || !result.data || !["PASS", "ACCOUNT_ORDER_BUDGET_UNKNOWN", "ACCOUNT_ORDER_CAPACITY_REQUIRED"].includes(result.data.code))
    throw new Error(code);
  return result.data as { code: string; reason: string; intervals: Array<{ intervalMs: number; projected: number; limit: number }> };
}

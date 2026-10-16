import { liveEngineOrderPrefix } from "./robot-v1-live-cycle.ts";
import { pausedPositionCovered } from "./paused-position-protection.ts";
import { configuredEngineSlotCount, hasCompletePhysicalSlotSet } from "./engine-slot-topology.ts";

type Owner = { operator_id: string; exchange_account_id: string; trading_engine_id: string };
export type AccountPauseLedger = {
  operatorId: string; accountId: string; accountGateClosed: boolean; operatorGateClosed: boolean;
  engines: Array<{ id: string; symbol: string; base_asset: string; legacy_compatible: boolean;
    status: string; kill_switch: boolean; strategy_config_pending: boolean; hard_cap_quote: number | string; slot_count?: number }>;
  runs: Array<Owner & { id: string; status: string; last_error: string | null; last_reconciled_at: string | null; slot_count?: number }>;
  slots: Array<Owner & { id: string; run_id: string; slot_number: number; entry_state: string;
    position_quantity: number | string; position_committed_quote: number | string }>;
  accounts: Array<Owner & { slot_number: number; balance_quote: number | string }>;
  orders: Array<Owner & { run_id: string; slot_id: string; side: string; purpose: string; status: string;
    client_order_id: string; exchange_order_id: string | null; requested_quantity: number | string | null;
    executed_quantity: number | string; trades_reconciled: boolean }>;
  preparations: Array<Owner & { symbol: string; kill_switch: boolean; live_enabled: boolean; slot_count?: number }>;
  alerts: Array<Owner & { code: string; severity: string }>;
  proofs: Array<Owner & { run_id: string; observed_at: string; details: unknown }>;
};

const safeWarnings = new Set(["COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", "COINOPS_LIVE_BNB_FEE_RESERVE_MISSING"]);
const pending = new Set(["PREPARED", "UNKNOWN", "SUBMITTING", "PENDING_CANCEL"]);
const resident = new Set(["NEW", "PARTIALLY_FILLED"]);
const finite = (value: unknown) => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0;
const fresh = (value: string | null, now: number) => value !== null && Number.isFinite(Date.parse(value))
  && now - Date.parse(value) >= -1_000 && now - Date.parse(value) <= 180_000;

/** Display authorization only. This can never permit orders, resume, or resolve an incident. */
export function accountPauseProtection(input: AccountPauseLedger, now = Date.now()) {
  const active = input.engines.filter((engine) => engine.status === "ACTIVE");
  if (!active.length || input.accountGateClosed || input.operatorGateClosed) return false;
  const owned = (row: Owner, engineId: string) => row.operator_id === input.operatorId
    && row.exchange_account_id === input.accountId && row.trading_engine_id === engineId;
  return active.every((engine) => {
    let slotCount: number;
    try { slotCount = configuredEngineSlotCount(engine); } catch { return false; }
    const runs = input.runs.filter((row) => row.trading_engine_id === engine.id);
    if (runs.length !== 1 || !owned(runs[0], engine.id)) return false;
    const run = runs[0];
    if (configuredEngineSlotCount(run) !== slotCount) return false;
    if (run.status !== "PAUSED" || run.last_error || !fresh(run.last_reconciled_at, now)
      || !engine.kill_switch || engine.strategy_config_pending || !finite(engine.hard_cap_quote)) return false;
    const slots = input.slots.filter((row) => row.trading_engine_id === engine.id);
    const accounts = input.accounts.filter((row) => row.trading_engine_id === engine.id);
    const orders = input.orders.filter((row) => row.trading_engine_id === engine.id);
    const preparations = input.preparations.filter((row) => row.trading_engine_id === engine.id);
    const physical = (rows: Array<Owner & { slot_number: number }>) => hasCompletePhysicalSlotSet(rows.map(row => row.slot_number), slotCount)
      && rows.every((row) => owned(row, engine.id));
    if (!physical(slots) || !physical(accounts) || new Set(slots.map((row) => row.id)).size !== slotCount
      || slots.some((row) => row.run_id !== run.id || !finite(row.position_quantity) || !finite(row.position_committed_quote)
        || Number(row.position_quantity) > 0 && row.entry_state !== "OPEN")
      || accounts.some((row) => !finite(row.balance_quote)) || preparations.length !== 1
      || !owned(preparations[0], engine.id) || preparations[0].symbol !== engine.symbol
      || !preparations[0].kill_switch || !preparations[0].live_enabled
      || configuredEngineSlotCount(preparations[0]) !== slotCount) return false;
    if (input.alerts.filter((row) => row.trading_engine_id === engine.id).some((row) => !owned(row, engine.id)
      || row.severity !== "WARNING" || !safeWarnings.has(row.code))) return false;
    const prefix = liveEngineOrderPrefix({ exchange_account_id: input.accountId, trading_engine_id: engine.id,
      base_asset: engine.base_asset, legacy_compatible: engine.legacy_compatible });
    if (orders.some((row) => !owned(row, engine.id) || row.run_id !== run.id
      || !row.client_order_id.startsWith(prefix) || !slots.some((slot) => slot.id === row.slot_id)
      || !finite(row.executed_quantity) || pending.has(row.status)
      || row.side === "BUY" && resident.has(row.status)
      || Number(row.executed_quantity) > 0 && row.trades_reconciled !== true)) return false;
    const proof = input.proofs.filter((row) => owned(row, engine.id) && row.run_id === run.id)
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
    const details = proof?.details && typeof proof.details === "object" ? proof.details as Record<string, unknown> : null;
    const step = Number(details?.quantity_step);
    if (!proof || !fresh(proof.observed_at, now) || details?.protection_verified !== true
      || details.resident_buy_count !== 0 || !(step > 0 && Number.isFinite(step))) return false;
    const open = slots.filter((row) => Number(row.position_quantity) > 0);
    if (details.open_positions !== open.length
      || slots.reduce((total, row) => total + Number(row.position_committed_quote), 0) > Number(engine.hard_cap_quote) + 1e-8) return false;
    return open.every((slot) => {
      const tps = orders.filter((row) => row.slot_id === slot.id && row.side === "SELL" && resident.has(row.status));
      if (tps.length !== 1 || tps[0].purpose !== "TP" || !tps[0].exchange_order_id || !finite(tps[0].requested_quantity)) return false;
      const remaining = Number(tps[0].requested_quantity) - Number(tps[0].executed_quantity);
      return pausedPositionCovered(Number(slot.position_quantity), remaining, step);
    }) && orders.filter((row) => row.side === "SELL" && resident.has(row.status)).length === open.length;
  });
}

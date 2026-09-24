import { createHash } from "node:crypto";

import type { V1Asset } from "./robot-v1";
import type { EngineContext } from "./operator-context";

export function liveEngineOrderPrefix(engine: Pick<EngineContext, "exchange_account_id" | "trading_engine_id" | "base_asset" | "legacy_compatible">) {
  return engine.legacy_compatible ? `COR1-${engine.base_asset}-`
    : `C2-${createHash("sha256").update(`${engine.exchange_account_id}|${engine.trading_engine_id}`).digest("hex").slice(0, 10)}-`;
}

export const LIVE_ACTIVE_ORDER_STATUSES = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
export const LIVE_TERMINAL_ORDER_STATUSES = new Set(["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"]);

export function liveClientOrderId(runId: string, asset: V1Asset, slotNumber: number,
  operationSequence: number, side: "BUY" | "SELL", revision: number,
  engine?: Pick<EngineContext, "exchange_account_id" | "trading_engine_id" | "base_asset" | "legacy_compatible">) {
  if (!/^[0-9a-f-]{36}$/.test(runId) || !["BTC", "SOL"].includes(asset)
    || !Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 25
    || !Number.isInteger(operationSequence) || operationSequence < 1
    || !Number.isInteger(revision) || revision < 1) throw new Error("COINOPS_LIVE_CLIENT_ID_INVALID");
  const identity = `coinops-live|${runId}|${asset}|${slotNumber}|${operationSequence}|${side}|${revision}`;
  const hash = createHash("sha256").update(engine && !engine.legacy_compatible
    ? `${engine.exchange_account_id}|${engine.trading_engine_id}|${identity}` : identity)
    .digest("hex").slice(0, 14);
  const id = engine && !engine.legacy_compatible
    ? `${liveEngineOrderPrefix(engine)}${slotNumber}-${side === "BUY" ? "B" : "S"}-${hash}`
    : `COR1-${asset}-${slotNumber}-${revision}-${side}-${hash}`;
  if (id.length > 36) throw new Error("COINOPS_LIVE_CLIENT_ID_INVALID");
  return id;
}

type PositionOrder = { side: "BUY" | "SELL"; status: string;
  executed_quantity: number | string; fee_base: number | string;
  requested_quantity?: number | string | null; reserved_notional_brl?: number | string;
  cumulative_quote?: number | string };
const amount = (value: number | string | null | undefined) => Number(value ?? 0);

export function liveUncoveredQuantity(orders: readonly PositionOrder[], quantityStep: number) {
  if (!Number.isFinite(quantityStep) || quantityStep <= 0) throw new Error("COINOPS_LIVE_QUANTITY_STEP_INVALID");
  const bought = orders.filter((order) => order.side === "BUY")
    .reduce((sum, order) => sum + amount(order.executed_quantity) - amount(order.fee_base), 0);
  const soldOrResident = orders.filter((order) => order.side === "SELL")
    .reduce((sum, order) => sum + amount(order.executed_quantity) + amount(order.fee_base)
      + (LIVE_ACTIVE_ORDER_STATUSES.has(order.status)
        ? Math.max(0, amount(order.requested_quantity) - amount(order.executed_quantity)) : 0), 0);
  const missing = bought - soldOrResident;
  if (!Number.isFinite(missing) || missing < -1e-10) throw new Error("COINOPS_LIVE_TP_OVERCOVERED");
  return Number((Math.floor((Math.max(0, missing) + 1e-10) / quantityStep) * quantityStep).toFixed(12));
}

export function liveExposure(positions: readonly { asset: V1Asset; committedBrl: number }[],
  orders: readonly (PositionOrder & { asset: V1Asset })[], caps = { BTC: 450, SOL: 275, global: 725 }) {
  const totals = { BTC: 0, SOL: 0 };
  for (const position of positions) {
    if (!["BTC", "SOL"].includes(position.asset) || !Number.isFinite(position.committedBrl)
      || position.committedBrl < 0) throw new Error("COINOPS_LIVE_EXPOSURE_INVALID");
    totals[position.asset] += position.committedBrl;
  }
  for (const order of orders) {
    if (!["BTC", "SOL"].includes(order.asset)) throw new Error("COINOPS_LIVE_EXPOSURE_INVALID");
    if (order.side !== "BUY" || !LIVE_ACTIVE_ORDER_STATUSES.has(order.status)) continue;
    const reserve = amount(order.reserved_notional_brl) - amount(order.cumulative_quote);
    if (!Number.isFinite(reserve)) throw new Error("COINOPS_LIVE_EXPOSURE_INVALID");
    totals[order.asset] += Math.max(0, reserve);
  }
  const global = totals.BTC + totals.SOL;
  if (![caps.BTC, caps.SOL, caps.global].every((value) => Number.isFinite(value) && value >= 0)
    || totals.BTC > caps.BTC + 1e-8 || totals.SOL > caps.SOL + 1e-8 || global > caps.global + 1e-8)
    throw new Error("COINOPS_LIVE_HARD_CAP_BREACHED");
  return { ...totals, global };
}

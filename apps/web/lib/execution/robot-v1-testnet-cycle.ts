import { createHash } from "node:crypto";

export const TESTNET_ACTIVE_ORDER_STATUSES = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);

export function testnetClientOrderId(runId: string, asset: "BTC" | "SOL", slot: number, side: "BUY" | "SELL", revision: number) {
  if (!runId || !Number.isInteger(slot) || slot < 1 || slot > 25 || !Number.isInteger(revision) || revision < 1) throw new Error("COINOPS_TESTNET_ORDER_ID_INVALID");
  // Preserve SOL's original hash contract so PREPARED orders recover the same
  // Binance client ID after deployment. BTC receives its own namespace.
  const source = asset === "SOL" ? `coinops-testnet|${runId}|${slot}|${side}|${revision}` : `coinops-testnet|${runId}|BTC|${slot}|${side}|${revision}`;
  return `COV1-${asset}-${slot}-${revision}-${side}-${createHash("sha256").update(source).digest("hex").slice(0, 18)}`;
}

export type TestnetCycleOrderState = {
  slot_number: number;
  side: "BUY" | "SELL";
  purpose: "INITIAL" | "ENTRY" | "TP";
  client_order_id: string;
  exchange_order_id: string | null;
  status: string;
  executed_quantity: number | string;
  requested_quantity?: number | string | null;
  fee_base?: number | string;
  updated_at?: string;
};

const amount = (value: number | string | null | undefined) => Number(value || 0);

export function testnetResetIdempotencyKey(oldRunId: string, terminalFillClientOrderId: string) {
  return createHash("sha256").update(`coinops-testnet-reset|${oldRunId}|${terminalFillClientOrderId}`).digest("hex");
}

export function testnetOpenPositionQuantity(orders: TestnetCycleOrderState[], slotNumber?: number) {
  const scoped = slotNumber == null ? orders : orders.filter((order) => order.slot_number === slotNumber);
  const bought = scoped.filter((order) => order.side === "BUY")
    .reduce((sum, order) => sum + amount(order.executed_quantity) - amount(order.fee_base), 0);
  const sold = scoped.filter((order) => order.side === "SELL")
    .reduce((sum, order) => sum + amount(order.executed_quantity), 0);
  return Math.max(0, bought - sold);
}

export function planTerminalTestnetRestart(orders: TestnetCycleOrderState[], quantityStep: number) {
  const terminalFill = [...orders].reverse().find((order) => order.side === "SELL" && order.purpose === "TP" && order.status === "FILLED") || null;
  const activeNextBuys = orders.filter((order) => order.side === "BUY" && order.purpose === "ENTRY" && TESTNET_ACTIVE_ORDER_STATUSES.has(order.status));
  const openQuantity = testnetOpenPositionQuantity(orders);
  if (!terminalFill) return { shouldRestart: false as const, reason: "NO_TERMINAL_TP" as const, terminalFill: null, activeNextBuy: null, openQuantity };
  if (openQuantity + 1e-10 >= quantityStep) return { shouldRestart: false as const, reason: "OPEN_POSITION_REMAINS" as const, terminalFill, activeNextBuy: activeNextBuys[0] || null, openQuantity };
  if (activeNextBuys.length > 1) throw new Error("COINOPS_TESTNET_MULTIPLE_ACTIVE_BUYS");
  const activeNextBuy = activeNextBuys[0] || null;
  if (activeNextBuy && amount(activeNextBuy.executed_quantity) > 0) return { shouldRestart: false as const, reason: "NEXT_BUY_PARTIALLY_FILLED" as const, terminalFill, activeNextBuy, openQuantity };
  return { shouldRestart: true as const, reason: "LAST_OPEN_TP_FILLED" as const, terminalFill, activeNextBuy, openQuantity };
}

export function testnetOperationalState(input: {
  runStatus?: string | null;
  lastError?: string | null;
  resetStartedAt?: string | null;
  resetCompletedAt?: string | null;
  initialBuyStatus?: string | null;
  openPositions: number;
  activeTakeProfits: number;
  activeNextBuys: number;
}) {
  if (input.lastError) return "ERRO" as const;
  if (input.runStatus === "PAUSED") return "PAUSADO" as const;
  if (input.resetStartedAt && !input.resetCompletedAt) return "REINICIANDO CICLO" as const;
  if (input.initialBuyStatus && TESTNET_ACTIVE_ORDER_STATUSES.has(input.initialBuyStatus)) return "AGUARDANDO FILL" as const;
  if (input.openPositions === 1 && input.activeTakeProfits === 1 && input.activeNextBuys === 1) return "OPERANDO" as const;
  return input.runStatus === "ACTIVE" ? "RECONCILIANDO" as const : "ATENÇÃO" as const;
}

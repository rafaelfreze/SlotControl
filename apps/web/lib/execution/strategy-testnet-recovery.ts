/** Read-only postcondition recovery. The caller supplies ledger rows already
 * scoped to one product/tenant/user and a verified persisted successor relation.
 * No inferred fill, historical timestamp, order submission or slot mutation. */
type Numeric = number | string | null;
export type RecoverableTestnetDecision = {
  decision_id: string; cycle_id: string; slot_id: string | null; operation_sequence: number | null;
  action_type: string; target_price: Numeric; target_notional?: Numeric; result: string;
};
export type RecoveryTestnetSlot = {
  id: string; run_id: string; operation_sequence: number; entry_state: string;
  target_buy_price: Numeric; balance_usdc?: Numeric;
};
export type RecoveryTestnetOrder = {
  run_id: string; slot_id: string; operation_sequence: number; side: string; purpose: string;
  status: string; client_order_id: string; exchange_order_id: string | null;
  price: Numeric; requested_quote?: Numeric; executed_quantity: Numeric; cumulative_quote?: Numeric;
  strategy_decision_id?: string | null;
};
export type RecoveredTestnetDecision = {
  decisionId: string;
  observed: Record<string, string | number | boolean | null>;
  exchangeAck: boolean;
};

const number = (value: Numeric | undefined) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const samePrice = (left: Numeric | undefined, right: Numeric | undefined) => {
  const a = number(left), b = number(right);
  return a !== null && b !== null && a > 0 && b > 0 && a.toFixed(8) === b.toFixed(8);
};
const acknowledged = new Set(["NEW", "PARTIALLY_FILLED", "FILLED"]);

/** Slot entry state is a projection, never proof that an exchange order exists.
 * Preserve uncovered positions even when their amount cannot form a valid TP. */
export function projectTestnetEntryState(slot: RecoveryTestnetSlot, orders: readonly (RecoveryTestnetOrder & { fee_base?: Numeric })[]) {
  const current = orders.filter((order) => order.run_id === slot.run_id && order.slot_id === slot.id && order.operation_sequence === slot.operation_sequence);
  if (current.some((order) => order.side === "BUY" && ["PREPARED", "NEW", "PARTIALLY_FILLED"].includes(order.status))) return "ARMED";
  if (!["ARMED", "PLANNED"].includes(slot.entry_state)) return slot.entry_state;
  const position = current.reduce((quantity, order) => order.side === "BUY"
    ? quantity + (number(order.executed_quantity) ?? 0) - (number(order.fee_base) ?? 0)
    : quantity - (number(order.executed_quantity) ?? 0), 0);
  return position > 1e-10 ? "OPEN" : "PLANNED";
}

export function recoverTestnetStrategyDecisions(input: {
  runId: string;
  decisions: readonly RecoverableTestnetDecision[];
  slots: readonly RecoveryTestnetSlot[];
  orders: readonly RecoveryTestnetOrder[];
  successorId?: string | null;
}): RecoveredTestnetDecision[] {
  const recovered: RecoveredTestnetDecision[] = [];
  for (const decision of input.decisions) {
    if (decision.cycle_id !== input.runId || decision.result === "COMPLETED") continue;
    const base = { recovered_from_ledger: true, recovery_evidence: "PERSISTED_POSTCONDITION", decision_action: decision.action_type };
    if (["COMPLETE_CYCLE", "REANCHOR"].includes(decision.action_type)) {
      if (input.successorId && input.successorId !== input.runId) recovered.push({
        decisionId: decision.decision_id, exchangeAck: false,
        observed: { ...base, state: decision.action_type === "COMPLETE_CYCLE" ? "COMPLETED" : "READY_FOR_INITIAL_MARKET", next_cycle_id: input.successorId },
      });
      continue;
    }
    if (!decision.slot_id || !Number.isInteger(decision.operation_sequence) || Number(decision.operation_sequence) < 1) continue;
    const slot = input.slots.find((row) => row.run_id === input.runId && row.id === decision.slot_id);
    if (!slot) continue;
    if (decision.action_type === "PLAN_LOCAL_REENTRY") {
      if (slot.operation_sequence === decision.operation_sequence && ["PLANNED", "ARMED", "OPEN"].includes(slot.entry_state)
        && samePrice(slot.target_buy_price, decision.target_price)) recovered.push({
        decisionId: decision.decision_id, exchangeAck: false,
        observed: { ...base, state: slot.entry_state, operation_sequence: slot.operation_sequence,
          reentry_price: number(slot.target_buy_price), balance_usdc: number(slot.balance_usdc) },
      });
      continue;
    }
    const matches = input.orders.filter((order) => {
      if (order.run_id !== input.runId || order.slot_id !== decision.slot_id || order.operation_sequence !== decision.operation_sequence
        || !order.exchange_order_id || !acknowledged.has(order.status)) return false;
      if (decision.action_type === "OPEN_INITIAL_MARKET") return order.side === "BUY" && order.purpose === "INITIAL"
        && order.status === "FILLED" && (number(order.executed_quantity) ?? 0) > 0 && (number(order.cumulative_quote) ?? 0) > 0
        && (decision.target_notional == null || samePrice(order.requested_quote, decision.target_notional));
      if (decision.action_type === "CREATE_TP") return order.side === "SELL" && order.purpose === "TP" && samePrice(order.price, decision.target_price);
      if (["ARM_NEXT_BUY", "CANCEL_REPLACE_NEXT_BUY"].includes(decision.action_type)) return order.side === "BUY" && order.purpose === "ENTRY" && samePrice(order.price, decision.target_price);
      return false;
    });
    // Prefer the explicit durable link; an exact sequence/price match also
    // proves a replacement completed through a new recovery decision.
    const match = matches.find((order) => order.strategy_decision_id === decision.decision_id) || matches[0];
    if (!match) continue;
    if (decision.action_type === "CANCEL_REPLACE_NEXT_BUY" && input.orders.some((order) => order.run_id === input.runId
      && order.side === "BUY" && ["PREPARED", "NEW", "PARTIALLY_FILLED"].includes(order.status)
      && order.client_order_id !== match.client_order_id)) continue;
    recovered.push({
      decisionId: decision.decision_id, exchangeAck: true,
      observed: { ...base, order_status: match.status, client_order_id: match.client_order_id,
        exchange_order_id: match.exchange_order_id, operation_sequence: match.operation_sequence,
        resident_slot_id: match.slot_id, resident_target_price: number(match.price),
        executed_quantity: number(match.executed_quantity), cumulative_quote: number(match.cumulative_quote),
        ownership_verified: true,
        matched_by: match.strategy_decision_id === decision.decision_id ? "STRATEGY_DECISION_ID" : "EXACT_SLOT_SEQUENCE_PURPOSE_PRICE",
      },
    });
  }
  return recovered;
}

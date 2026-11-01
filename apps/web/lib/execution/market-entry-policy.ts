import { ENTRY_MARKET_POLICY } from "./strategy-engine.ts";

export type MarketEntryIntent = { policy: typeof ENTRY_MARKET_POLICY; run_id: string; engine_id: string;
  slot_id: string; slot_number: number; operation_sequence: number; decision_id: string;
  quote: number; reference_price: number; reason: "PROSPECTIVE_CROSSED_ENTRY" | "OPERATOR_MISSED_ENTRY";
  period: string };

/** ENTRY+quote is never enough to reinterpret a historical LIMIT order. The
 * explicit immutable, scoped intent is required at every market dispatch. */
export function marketEntryIntent(order: { side: string; purpose: string; run_id: string;
  trading_engine_id: string; slot_id: string; slot_number: number; operation_sequence: number;
  requested_quote: number|string|null; requested_quantity: number|string|null; price: number|string|null;
  strategy_decision_id: string|null; config_snapshot: Record<string,unknown> }): MarketEntryIntent | null {
  if(order.side!=="BUY" || order.purpose!=="ENTRY" || order.requested_quote===null)return null;
  const intent=order.config_snapshot.market_entry_intent as MarketEntryIntent|undefined;
  if(!intent || intent.policy!==ENTRY_MARKET_POLICY || intent.run_id!==order.run_id
    || intent.engine_id!==order.trading_engine_id || intent.slot_id!==order.slot_id
    || intent.slot_number!==order.slot_number || intent.operation_sequence!==order.operation_sequence
    || intent.decision_id!==order.strategy_decision_id || intent.quote!==Number(order.requested_quote)
    || !Number.isFinite(intent.quote) || intent.quote<=0 || !Number.isFinite(intent.reference_price)
    || intent.reference_price<=0 || order.price!==null || order.requested_quantity!==null
    || !["PROSPECTIVE_CROSSED_ENTRY","OPERATOR_MISSED_ENTRY"].includes(intent.reason)
    || !/^\d{4}-\d{2}$/.test(intent.period))throw new Error("COINOPS_MARKET_ENTRY_INTENT_INVALID");
  return intent;
}

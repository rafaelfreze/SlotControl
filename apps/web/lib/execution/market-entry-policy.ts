import { ENTRY_MARKET_POLICY, planStrategyMissedMarketEntry, type StrategyContext,
  type StrategyCandidate, type StrategyResidentBuy } from "./strategy-engine.ts";
import { monthlyPeriodKey } from "./monthly-slot-policy.ts";
import { partialEntryRecoveryIntent } from "./partial-entry-recovery.ts";

export const EXPLICIT_MISSED_RECOVERY = "EXPLICIT_OPERATION_V1" as const;

export type MarketEntryIntent = { policy: typeof ENTRY_MARKET_POLICY; run_id: string; engine_id: string;
  slot_id: string; slot_number: number; operation_sequence: number; decision_id: string;
  quote: number; reference_price: number; reason: "PROSPECTIVE_CROSSED_ENTRY" | "OPERATOR_MISSED_ENTRY";
  period: string; recovery_priority?: typeof EXPLICIT_MISSED_RECOVERY };

/** An operator-requested historical recovery is a bounded allowed set for one
 * empty operation, not a rewrite of monthly gains or normal entry priority.
 * The canonical engine still enforces resident fill/cancel, regime and sizing.
 * Preparation independently requires the exact immutable authorization event. */
export function planExplicitMissedMarketRecovery(context: StrategyContext, engineId:string,
  candidates:readonly StrategyCandidate[],price:number,regime:"NORMAL"|"POST_ATH",
  resident:StrategyResidentBuy|null,authorization:unknown){
  if(!authorization || typeof authorization!=="object" || Array.isArray(authorization))return null;
  const a=authorization as Record<string,unknown>;
  if(a.recovery_priority!==EXPLICIT_MISSED_RECOVERY)return null;
  const target=candidates.find(s=>s.id===a.slot_id);
  if(a.policy!==ENTRY_MARKET_POLICY || a.run_id!==context.cycleId || a.engine_id!==engineId
    || a.period!==monthlyPeriodKey(context.observedAt) || !target || a.slot_number!==target.slotNumber
    || a.operation_sequence!==target.operationSequence || target.state!=="MISSED"
    || !target.marketEntryEligible || typeof a.authorization_event_key!=="string"
    || !a.authorization_event_key.endsWith(`:${EXPLICIT_MISSED_RECOVERY}`)
    || !Number.isFinite(Number(a.quote_cap))
    || Number(a.quote_cap)<(target.balanceQuote??target.balanceUsdc??Infinity))return null;
  if(target.monthlyEntryEligible!==true || regime==="POST_ATH"
    && target.postAthGroup==="RESERVE" && target.entryOrigin!=="REENTRY")return null;
  return planStrategyMissedMarketEntry({...context,
    transitionKey:`${context.transitionKey??""}:RECOVERY:${a.authorization_event_key}`},
    candidates.map(s=>s.id===target.id?s:{...s,monthlyEntryEligible:false}),price,regime,resident);
}

/** ENTRY+quote is never enough to reinterpret a historical LIMIT order. The
 * explicit immutable, scoped intent is required at every market dispatch. */
export function marketEntryIntent(order: { side: string; purpose: string; run_id: string;
  trading_engine_id: string; slot_id: string; slot_number: number; operation_sequence: number;
  requested_quote: number|string|null; requested_quantity: number|string|null; price: number|string|null;
  strategy_decision_id: string|null; config_snapshot: Record<string,unknown> }): MarketEntryIntent | null {
  if(order.side!=="BUY" || order.purpose!=="ENTRY" || order.requested_quote===null)return null;
  if(partialEntryRecoveryIntent(order))return null;
  const intent=order.config_snapshot.market_entry_intent as MarketEntryIntent|undefined;
  if(!intent || intent.policy!==ENTRY_MARKET_POLICY || intent.run_id!==order.run_id
    || intent.engine_id!==order.trading_engine_id || intent.slot_id!==order.slot_id
    || intent.slot_number!==order.slot_number || intent.operation_sequence!==order.operation_sequence
    || intent.decision_id!==order.strategy_decision_id || intent.quote!==Number(order.requested_quote)
    || !Number.isFinite(intent.quote) || intent.quote<=0 || !Number.isFinite(intent.reference_price)
    || intent.reference_price<=0 || order.price!==null || order.requested_quantity!==null
    || !["PROSPECTIVE_CROSSED_ENTRY","OPERATOR_MISSED_ENTRY"].includes(intent.reason)
    || !/^\d{4}-\d{2}$/.test(intent.period)
    || intent.recovery_priority!==undefined && (intent.recovery_priority!==EXPLICIT_MISSED_RECOVERY
      || intent.reason!=="OPERATOR_MISSED_ENTRY"))throw new Error("COINOPS_MARKET_ENTRY_INTENT_INVALID");
  return intent;
}

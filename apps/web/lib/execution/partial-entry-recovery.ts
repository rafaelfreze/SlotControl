/** Financial recovery of a terminal tiny partial BUY. This never selects a new
 * slot or resizes its strategy: it funds only one venue-valid protective rescue
 * in the original operation, after an exact owner authorization. */
import { createHash } from "node:crypto";
import { STRATEGY_VERSION, type StrategyContext, type StrategyDecision } from "./strategy-engine.ts";

export const PARTIAL_ENTRY_RECOVERY_POLICY = "ORPHANED_PARTIAL_RECOVERY_V1" as const;
export type PartialEntryRecovery = {
  policy:typeof PARTIAL_ENTRY_RECOVERY_POLICY;run_id:string;engine_id:string;slot_id:string;
  slot_number:number;operation_sequence:number;source_order_id:string;source_client_order_id:string;
  source_exchange_order_id:string;source_quantity:number;source_quote:number;source_fee_base:number;
  source_committed:number;quote:number;slot_balance:number;gain_rate:number;spacing:number;
  incident_key:string;incident_first_seen_at:string;authorization_event_key:string;authorized_at:string;
};
export type PartialRecoveryOrder = {side:string;purpose:string;run_id:string;trading_engine_id:string;
  slot_id:string;slot_number:number;operation_sequence:number;requested_quote:number|string|null;
  requested_quantity:number|string|null;price:number|string|null;config_snapshot:Record<string,unknown>};
const fail=():never=>{throw Error("COINOPS_PARTIAL_RECOVERY_INTENT_UNPROVEN");};
const positive=(n:unknown)=>typeof n==="number"&&Number.isFinite(n)&&n>0;

/** One quantity step above the minimum notionally executable quantity. The
 * extra step covers MARKET quantity flooring, not arbitrary new slot capital. */
export function minimalPartialRecoveryQuote(price:number,minNotional:number,step:number){
  if(![price,minNotional,step].every(positive))return fail();
  const unit=price*step;
  const quote=Math.ceil((Math.ceil(minNotional/unit-1e-10)+1)*unit*100-1e-8)/100;
  if(!positive(quote)||quote<minNotional||quote>minNotional+2*unit+.01000001)return fail();
  return quote;
}
export function partialEntryRecoveryIntent(order:PartialRecoveryOrder):PartialEntryRecovery|null{
  const raw=order.config_snapshot?.partial_entry_recovery_intent;
  if(raw===undefined||raw===null)return null;
  if(typeof raw!=="object"||Array.isArray(raw))return fail();
  const p=raw as PartialEntryRecovery;
  if(p.policy!==PARTIAL_ENTRY_RECOVERY_POLICY||order.side!=="BUY"||order.purpose!=="ENTRY"
    ||p.run_id!==order.run_id||p.engine_id!==order.trading_engine_id||p.slot_id!==order.slot_id
    ||p.slot_number!==order.slot_number||p.operation_sequence!==order.operation_sequence
    ||Number(order.requested_quote)!==p.quote||order.requested_quantity!==null||order.price!==null
    ||![p.source_quantity,p.source_quote,p.source_committed,p.quote,p.slot_balance,p.gain_rate,p.spacing].every(positive)
    ||!Number.isFinite(p.source_fee_base)||p.source_fee_base<0||p.source_fee_base>=p.source_quantity
    ||p.source_committed+p.quote>p.slot_balance+1e-8||p.gain_rate>=1||p.spacing>=1
    ||!p.source_order_id||!p.source_client_order_id||!/^\d+$/.test(p.source_exchange_order_id)
    ||!p.incident_key||!Number.isFinite(Date.parse(p.incident_first_seen_at))
    ||!Number.isFinite(Date.parse(p.authorized_at))||typeof p.authorization_event_key!=="string")return fail();
  return p;
}
export function planPartialEntryRecovery(context:StrategyContext,proof:PartialEntryRecovery):StrategyDecision{
  if(context.cycleId!==proof.run_id)return fail();
  const key=JSON.stringify([proof.policy,proof.run_id,proof.engine_id,proof.slot_id,proof.operation_sequence,
    proof.source_order_id,proof.authorization_event_key,proof.quote]);
  return {decision_id:createHash("sha256").update(key).digest("hex"),strategy_version:STRATEGY_VERSION,
    asset:context.asset,cycle_id:context.cycleId,slot_id:proof.slot_id,operation_id:`${proof.slot_id}:${proof.operation_sequence}`,
    action_type:"OPEN_ENTRY_MARKET",target_price:null,target_notional:proof.quote,priority:0,
    reason:PARTIAL_ENTRY_RECOVERY_POLICY,expected_next_state:"PARTIAL_ENTRY_RECOVERY_PROTECT_TP",created_at:context.observedAt};
}

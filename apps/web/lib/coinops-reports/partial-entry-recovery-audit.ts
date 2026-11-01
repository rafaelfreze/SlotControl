import type {AuditRow}from"./trigger-audit.ts";
const obj=(x:unknown)=>x&&typeof x==="object"&&!Array.isArray(x)?x as AuditRow:{};
/** Persisted evidence only. A complete historical chain cannot certify current
 * Binance state, and an authorization without execution is never a recovery. */
export function auditPartialEntryRecovery(rows:AuditRow[],incompleteSources:string[]=[]):AuditRow[]{
 return rows.filter(r=>r.row_type==="EVENT"&&r.event_type==="PARTIAL_ENTRY_RECOVERY_REQUESTED").map(event=>{
  const a=obj(event.details),broken:string[]=[],missing:string[]=[];
  const same=(r:AuditRow)=>r.run_id===event.run_id&&r.trading_engine_id===event.trading_engine_id
    &&r.exchange_account_id===event.exchange_account_id&&r.slot_id===a.slot_id&&Number(r.operation_sequence)===Number(a.operation_sequence);
  const orders=rows.filter(r=>r.row_type==="ORDER"&&same(r));
  const parent=orders.find(r=>r.id===a.source_order_id);
  const children=orders.filter(r=>obj(obj(r.config_snapshot).partial_entry_recovery_intent).authorization_event_key===a.authorization_event_key);
  if(a.policy!=="ORPHANED_PARTIAL_RECOVERY_V1")broken.push("política divergente");
  if(!parent)missing.push("BUY parcial de origem");
  else if(!["CANCELED","EXPIRED","EXPIRED_IN_MATCH"].includes(String(parent.status))||parent.trades_reconciled!==true
    ||Number(parent.executed_quantity)!==Number(a.source_quantity)||Number(parent.cumulative_quote)!==Number(a.source_quote))broken.push("origem sem parcial terminal exata");
  if(children.length>1)broken.push("complemento duplicado");
  if(!children.length)missing.push("complemento ainda não preparado");
  const child=children[0];
  if(incompleteSources.some(s=>/robot_v1_live_(orders|fills|events)/.test(s)))missing.push("fonte financeira incompleta");
  if(child){
   if(child.side!=="BUY"||child.purpose!=="ENTRY"||Number(child.requested_quote)!==Number(a.quote)
     ||Number(a.quote)+Number(a.source_committed)>Number(a.slot_balance)+1e-8)broken.push("identidade ou limite do complemento");
   if(!(Number(child.executed_quantity)>0)||child.trades_reconciled!==true)missing.push("fill terminal reconciliado do complemento");
   if(!orders.some(r=>r.side==="SELL"&&r.purpose==="TP"&&["NEW","PARTIALLY_FILLED","FILLED"].includes(String(r.status))))missing.push("TP da operação combinada");
  }
  for(const order of [parent,child].filter((r):r is AuditRow=>Boolean(r)&&Number(r!.executed_quantity)>0)){
   const fills=rows.filter(f=>f.row_type==="FILL"&&f.order_id===order.id&&f.trading_engine_id===order.trading_engine_id
     &&f.exchange_account_id===order.exchange_account_id);
   if(!fills.length)missing.push("fills imutáveis da BUY");
   else if(Math.abs(fills.reduce((s,f)=>s+Number(f.quantity),0)-Number(order.executed_quantity))>1e-12
     ||Math.abs(fills.reduce((s,f)=>s+Number(f.quote_quantity),0)-Number(order.cumulative_quote))>1e-8)missing.push("totais dos fills não confirmados");
  }
  return{code:"ORPHANED_PARTIAL_RECOVERY_AUDIT",environment:"REAL",asset:event.asset,cycle_id:event.run_id,
   slot_number:event.slot_number,operation_sequence:a.operation_sequence,source_order_id:a.source_order_id,
   status:broken.length?"FAIL":missing.length?"WARNING":"PASS",evidence_scope:"PERSISTED_SAME_OPERATION_NOT_CURRENT_BINANCE",
   explanation:[...broken,...missing].join("; ")||"Origem, complemento único e TP vinculados ao mesmo motor/slot/operação; somente evidência persistida, sem certificar Binance atual."};
 });
}

import test from"node:test";import assert from"node:assert/strict";
import{auditPartialEntryRecovery}from"./partial-entry-recovery-audit.ts";
import{REPORT_VERSION}from"./filters.ts";
test("v32 partial recovery evidence distinguishes authorization, exact chain and duplicate/foreign operation",()=>{
 assert.equal(REPORT_VERSION,32);
 const scope={run_id:"r",trading_engine_id:"e",exchange_account_id:"a",slot_id:"s",operation_sequence:3};
 const proof={policy:"ORPHANED_PARTIAL_RECOVERY_V1",...scope,slot_number:8,source_order_id:"parent",source_quantity:.004,
  source_quote:2,quote:10.5,source_committed:2.001,slot_balance:1122,authorization_event_key:"auth"};
 const event={...scope,row_type:"EVENT",event_type:"PARTIAL_ENTRY_RECOVERY_REQUESTED",details:proof};
 const parent={...scope,row_type:"ORDER",id:"parent",side:"BUY",status:"CANCELED",executed_quantity:.004,cumulative_quote:2,trades_reconciled:true};
 const child={...scope,row_type:"ORDER",id:"child",side:"BUY",purpose:"ENTRY",status:"FILLED",executed_quantity:.021,cumulative_quote:10.5,requested_quote:10.5,
  trades_reconciled:true,config_snapshot:{partial_entry_recovery_intent:proof}};
 const tp={...scope,row_type:"ORDER",side:"SELL",purpose:"TP",status:"NEW"};
 const fills=[{...scope,row_type:"FILL",order_id:"parent",quantity:.004,quote_quantity:2},
  {...scope,row_type:"FILL",order_id:"child",quantity:.021,quote_quantity:10.5}];
 assert.equal(auditPartialEntryRecovery([event,parent])[0].status,"WARNING");
 assert.equal(auditPartialEntryRecovery([event,parent,child,tp,...fills])[0].status,"PASS");
 assert.equal(auditPartialEntryRecovery([event,parent,child,tp])[0].status,"WARNING");
 assert.equal(auditPartialEntryRecovery([event,parent,child,tp,...fills],["robot_v1_live_fills"])[0].status,"WARNING");
 assert.equal(auditPartialEntryRecovery([event,parent,child,child,tp])[0].status,"FAIL");
 assert.equal(auditPartialEntryRecovery([event,parent,child,{...tp,trading_engine_id:"sibling"}])[0].status,"WARNING");
 assert.equal(auditPartialEntryRecovery([event,{...parent,executed_quantity:.005},child,tp])[0].status,"FAIL");
});

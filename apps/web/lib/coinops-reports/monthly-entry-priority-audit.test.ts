import assert from "node:assert/strict";
import test from "node:test";
import {buildAuditReport} from "./report-engine.ts";
import {REPORT_VERSION} from "./filters.ts";
const at="2026-10-26T14:00:00Z";
test("v31 exports the policy and committed allocation without rewriting legacy runs",()=>{
 const checkpoint={policy:"MONTHLY_GAINS_V1",plan_id:"a".repeat(64),period:"2026-10",assignments:[{slotNumber:7,price:436645}]};
 const sources={robot_v1_live_runs:[{id:"r",asset:"BTC",symbol:"BTCBRL",status:"ACTIVE",created_at:at,
   config_snapshot:{entry_priority_policy:"MONTHLY_GAINS_V1",entry_priority_checkpoint:checkpoint}},
  {id:"legacy",asset:"SOL",symbol:"SOLUSDT",status:"COMPLETED",created_at:at,config_snapshot:{}}],
  robot_v1_live_events:[{run_id:"r",event_type:"ENTRY_PRIORITY_ALLOCATED",observed_at:at,details:checkpoint}]};
 const original=structuredClone(sources);
 const report=buildAuditReport({sources,incompleteSources:[],warnings:[],generatedAt:at,scope:{tenantId:"t",userId:"u"}},
  {start:"2026-10-01T00:00:00Z",end:"2026-11-01T00:00:00Z",assets:["BTC","SOL"],environments:["REAL"]});
 assert.equal(REPORT_VERSION,32);assert.ok(report.datasets.rules.some(r=>r.parameter==="monthly_entry_priority"));
 const rows=report.datasets.live_execution;
 assert.equal(rows.find(r=>r.row_type==="RUN"&&r.id==="r")?.entry_priority_policy,"MONTHLY_GAINS_V1");
 assert.equal(rows.find(r=>r.row_type==="RUN"&&r.id==="legacy")?.entry_priority_policy,"LEGACY_PRICE_FIRST");
 assert.deepEqual(rows.find(r=>r.row_type==="EVENT")?.details,checkpoint);assert.deepEqual(sources,original);
});

test("monthly level preservation exports persisted rollover and explains limits without changing history",()=>{
 const rollover={policy:"MONTHLY_GAINS_V1",period:"2026-11",previous_period:"2026-10",reanchored:false,levels_preserved:true};
 const sources={robot_v1_live_runs:[{id:"r",asset:"SOL",symbol:"SOLUSDT",status:"ACTIVE",created_at:at,
   config_snapshot:{monthly_priority_rollover:rollover,ladder_anchor_price:119.7}}],
  robot_v1_live_events:[{run_id:"r",event_type:"MONTHLY_PRIORITY_REFRESHED",observed_at:at,details:rollover}]};
 const before=structuredClone(sources);
 const r=buildAuditReport({sources,incompleteSources:[],warnings:[],generatedAt:at,scope:{tenantId:"t",userId:"u"}},
  {start:"2026-10-01T00:00:00Z",end:"2026-12-01T00:00:00Z",assets:["SOL"],environments:["REAL"]});
 assert.equal(r.datasets.rules.find(r=>r.parameter==="monthly_entry_level_preservation")?.value,"PRESERVE_PROVEN_LEVELS");
 assert.deepEqual((r.datasets.live_execution.find(r=>r.row_type==="RUN")?.config_snapshot as Record<string,unknown>).monthly_priority_rollover,rollover);
 assert.deepEqual(r.datasets.live_execution.find(r=>r.row_type==="EVENT")?.details,rollover);
 assert.deepEqual(sources,before);
});

test("monthly JSONB recovery is an explicit read-only exported rule and retains typed mismatch diagnostics", () => {
 const details={stage:"ATH_TRANSITION",root_code:"COINOPS_LIVE_EVENT_PERSIST_FAILED",audit_phase:"READBACK",
  audit_reason:"READBACK_MISMATCH",audit_event_type:"MONTHLY_PRIORITY_REFRESHED",audit_attempts:1,
  audit_http_status:null,audit_provider_code:null};
 const sources={robot_v1_live_runs:[{id:"r",asset:"SOL",symbol:"SOLBRL",status:"ACTIVE",created_at:at}],
  robot_v1_live_alerts:[{id:"a",run_id:"r",asset:"SOL",code:"COINOPS_LIVE_EVENT_PERSIST_FAILED",details}]};
 const before=structuredClone(sources),r=buildAuditReport({sources,incompleteSources:[],warnings:[],generatedAt:at,scope:{tenantId:"t",userId:"u"}},
  {start:"2026-10-01T00:00:00Z",end:"2026-12-01T00:00:00Z",assets:["SOL"],environments:["REAL"]});
 const rule=r.datasets.rules.find(row=>row.parameter==="monthly_priority_metadata_recovery")!;
 assert.equal(rule.version,1);assert.match(String(rule.notes),/duas vezes/);assert.match(String(rule.notes),/lease\/CAS/);
 assert.deepEqual(r.datasets.live_execution.find(row=>row.id==="a")?.details,details);
 assert.deepEqual(sources,before);
});

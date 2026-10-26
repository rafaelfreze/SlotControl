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
 assert.equal(REPORT_VERSION,31);assert.ok(report.datasets.rules.some(r=>r.parameter==="monthly_entry_priority"));
 const rows=report.datasets.live_execution;
 assert.equal(rows.find(r=>r.row_type==="RUN"&&r.id==="r")?.entry_priority_policy,"MONTHLY_GAINS_V1");
 assert.equal(rows.find(r=>r.row_type==="RUN"&&r.id==="legacy")?.entry_priority_policy,"LEGACY_PRICE_FIRST");
 assert.deepEqual(rows.find(r=>r.row_type==="EVENT")?.details,checkpoint);assert.deepEqual(sources,original);
});

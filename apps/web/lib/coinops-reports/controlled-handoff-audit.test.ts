import {test} from "node:test";import assert from "node:assert/strict";
import {buildAuditReport} from "./report-engine.ts";
import {buildReportPackage} from "./report-package.ts";
import {REPORT_VERSION} from "./filters.ts";
import {resolveEngineContext,resolveReportEngineContext,type DomainRegistry} from "../execution/operator-context.ts";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
test("offboarded account remains auditable but is never an operational permission or current green/zero financial snapshot",()=>{
 const registry:DomainRegistry={operator:{id:id(1),product_id:id(2),tenant_id:id(3),user_id:id(4),status:"ACTIVE",kill_switch:false},
  accounts:[{id:id(5),operator_id:id(1),display_name:"Cliente",status:"DISABLED",kill_switch:true,is_legacy_default:false}],
  engines:[{id:id(6),operator_id:id(1),exchange_account_id:id(5),symbol:"SOLBRL",base_asset:"SOL",quote_asset:"BRL",status:"DISABLED",kill_switch:true,legacy_compatible:false,hard_cap_quote:275,environment:"REAL",executor_shard_id:"executor-02"}]};
 const selection={environment:"REAL" as const,exchange_account_id:id(5),trading_engine_id:id(6)};
 assert.throws(()=>resolveEngineContext(registry,selection),/ACCOUNT_DISABLED/);
 assert.equal(resolveReportEngineContext(registry,selection).status,"DISABLED");
 const owned={operator_id:id(1),product_id:id(2),tenant_id:id(3),user_id:id(4),exchange_account_id:id(5),trading_engine_id:id(6),quote_asset:"BRL",asset:"SOL",symbol:"SOLBRL"};
 const now="2026-10-25T22:00:00Z",filters={start:"2026-10-25T00:00:00Z",end:"2026-10-26T00:00:00Z",assets:["SOL" as const],environments:["REAL" as const]};
 const report=buildAuditReport({registry,scope:{tenantId:id(3),userId:id(4)},generatedAt:now,warnings:[],incompleteSources:[],sources:{
  robot_v1_live_runs:[{...owned,id:id(7),status:"OFFBOARDED",created_at:now,last_reconciled_at:now}],
  engine_handoffs:[{...owned,id:id(8),run_id:id(7),kind:"CLIENT_MANAGED",phase:"COMMITTED",committed_at:now}],
 }},filters);
 const summary=report.datasets.summary[0]!;assert.equal(summary.mode,"CLIENT_MANAGED_ARCHIVE");
 assert.equal(summary.health,"ENCERRADO — GESTÃO DO CLIENTE");assert.equal(summary.free_capital,null);assert.equal(summary.operational_open,null);
 assert.equal(report.datasets.live_execution.find(r=>r.row_type==="HANDOFF")?.kind,"CLIENT_MANAGED");
 assert.ok(report.datasets.rules.some(r=>r.parameter==="controlled_engine_handoff"));assert.equal(REPORT_VERSION,30);
 const pack=buildReportPackage(report,filters,now,"test");assert.equal(pack.manifest.report_version,30);
});

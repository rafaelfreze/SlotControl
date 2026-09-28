import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as model from "./model.ts";
import * as repair from "./fx-repair.ts";
import type { FinopsDashboard, FinopsScope } from "./types";

const now = new Date("2026-09-27T01:20:00Z");
const usd = { base:"USD",quote:"BRL" as const,rate:5.1991,source:"BCB",observedAt:"2026-09-25T16:00:00Z",fetchedAt:now.toISOString() };
const usdt = { base:"USDT",quote:"BRL" as const,rate:5.1,source:"public Binance",observedAt:now.toISOString(),fetchedAt:now.toISOString() };
function fixture(): FinopsDashboard {
  const cost=model.enrichService({id:"cost",provider:"DigitalOcean",name:"Executor",currency:"USD",recurring_monthly:6,
    allocation_percent:100,cost_period:"2026-09-01",enabled:true,origin:"ESTIMADO",source_mode:"DOCUMENTED",sync_status:"OK"},[usd],now);
  return { capturedAt:"2026-09-27T01:04:56.610Z",period:"2026-09-01",syncStatus:"OK",fx:[usd],services:[cost],executors:[],history:[],alerts:[],sources:[],
    summary:{accounts:2,engines:2,executors:2,capitalBrl:null,capitalByCurrency:{BRL:2338.59,USDT:838.62},capitalComplete:false,
      actualBrl:null,projectedBrl:cost.projectedBrl,knownActualBrl:0,knownProjectedBrl:cost.projectedBrl!,costPerAccountBrl:15.6,costPerEngineBrl:15.6,unavailableServices:0},
    capital:{markets:[],notes:[],accounts:[{accountId:"one",accountName:"One",shardId:"executor-01",currency:"BRL",monitored:2338.59,free:2000,reserved:10,
      positions:338.59,realizedPnl:1,openPnl:2,observedAt:"2026-09-27T01:05:00Z",source:"stored Binance",complete:true},
    {accountId:"two",accountName:"Two",shardId:"executor-02",currency:"USDT",monitored:838.62,free:800,reserved:10,
      positions:38.62,realizedPnl:0,openPnl:1,observedAt:"2026-09-27T01:05:00Z",source:"stored Binance",complete:true}]} };
}
test("FX coverage detects partial source success for every used currency",()=>{
  const data=fixture();
  assert.deepEqual(repair.missingFinopsFx(data.capital,data.services,[usd]),["USDT"]);
  assert.deepEqual(repair.missingFinopsFx(data.capital,data.services,[]),["USD","USDT"]);
  assert.deepEqual(repair.missingFinopsFx(data.capital,data.services,[usd,usdt]),[]);
});
test("repair appends a new valuation, preserves native wallet timestamps and never mutates the original snapshot",()=>{
  const original=fixture(), before=JSON.stringify(original);
  const fixed=repair.revalueFinopsFx(original,[usdt],now);
  assert.equal(fixed.summary.capitalBrl,6615.55);
  assert.equal(fixed.summary.capitalComplete,true);
  assert.equal(fixed.syncStatus,"OK");
  assert.equal(fixed.externalCapturedAt,original.capturedAt);
  assert.deepEqual(fixed.capital,original.capital);
  assert.equal(JSON.stringify(original),before);
  assert.equal(fixed.fx.find(quote=>quote.base==="USD")?.rate,5.1991);
});
test("outage remains partial without inventing zero, and a successful FX repair cannot heal unrelated missing capital",()=>{
  const original=fixture();
  const failed=repair.revalueFinopsFx(original,[],now);
  assert.equal(failed.syncStatus,"PARTIAL");
  assert.equal(failed.summary.capitalBrl,null);
  const incomplete=fixture(); incomplete.capital.accounts[0]!.complete=false;
  assert.equal(repair.revalueFinopsFx(incomplete,[usdt],now).syncStatus,"PARTIAL");
  assert.equal(repair.revalueFinopsFx(incomplete,[usdt],now).summary.capitalBrl,null);
});
test("FX-only retry has its own one-minute cooldown",()=>{
  assert.equal(repair.nextFinopsFxRepair("2026-09-27T01:19:30Z",now),"2026-09-27T01:20:30.000Z");
  assert.equal(repair.nextFinopsFxRepair("2026-09-27T01:19:00Z",now),null);
});

test("FX repair describes the operational clock without changing source observations",()=>{
  const original=fixture();
  original.externalCapturedAt=original.capturedAt;
  original.operationalCapturedAt="2026-09-27T01:19:00Z";
  const fixed=repair.revalueFinopsFx(original,[usdt],now);
  assert.match(fixed.sources.at(-1)!,/Última coleta operacional: 2026-09-27T01:19:00Z/);
  assert.deepEqual(fixed.capital,original.capital);
  assert.equal(fixed.externalCapturedAt,original.externalCapturedAt);
});

const localRequire=createRequire(import.meta.url);
const ts=localRequire("typescript") as typeof import("typescript");
function worker(freshRepair=false,failFx=false) {
  const data=fixture(), at=new Date();
  data.capturedAt=new Date(at.getTime()-600_000).toISOString();data.period=model.periodAt(at);
  // Operational data was just collected; this request exercises only FX repair.
  data.operationalCapturedAt=at.toISOString();
  const scope: FinopsScope={operatorId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",tenantId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",userId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"};
  const calls:Array<{name:string;args?:Record<string,unknown>}>=[];
  const service={from(table:string){
    if(!["finops_snapshots","finops_sync_state","finops_alerts"].includes(table))throw new Error(`FORBIDDEN_DB_${table}`);
    let repairQuery=false;
    const query:Record<string,unknown>={};
    for(const method of ["select","eq","order","limit","is","update","upsert"])
      query[method]=()=>query;
    query.like=()=>{repairQuery=true;return query;};
    const response=()=>({error:null,data:table==="finops_sync_state"?{last_external_synced_at:data.capturedAt}
      :table==="finops_alerts"?[]:repairQuery?(freshRepair?{captured_at:new Date(at.getTime()-10_000).toISOString()}:null):{payload:data}});
    query.maybeSingle=async()=>response();
    query.then=(done:(value:unknown)=>unknown)=>Promise.resolve(response()).then(done);
    return query;
  },async rpc(name:string,args:Record<string,unknown>){calls.push({name,args});return {error:null,data:name==="finops_claim_sync"?true:name==="finops_monthly_history"?[]:null};}};
  const compiled=ts.transpileModule(readFileSync(new URL("./server.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod={exports:{} as {syncFinops:(scope:FinopsScope)=>Promise<{status:string}>}};
  const imports:Record<string,unknown>={"server-only":{},"../supabase/server":{},"../supabase/service-role":{createServiceRoleClient:()=>service},
    "../supabase/env":{getSupabaseDataSchema:()=>"coinops",getCoinOpsServiceTenantId:()=>scope.tenantId},"../execution/operator-context":{isIdentity:()=>true},
    "../coinops-capacity/capacity-manager":{},"../coinops-capacity/capacity-server":{},"./capital-server":{loadFinopsCapital:()=>{throw new Error("PRIVATE_WALLET_FORBIDDEN");}},
    "./capital":{},"./model":model,"./fx-repair":repair,"./providers":{fetchFinopsFx:async()=>{calls.push({name:"public-fx"});if(failFx)throw new Error("FX_DOWN");return [usdt];},
      fetchDigitalOceanCosts:()=>{throw new Error("BILLING_FORBIDDEN");},fetchVercelProjectCosts:()=>{throw new Error("BILLING_FORBIDDEN");}}};
  new Function("require","module","exports",compiled)((name:string)=>name==="node:crypto"?localRequire(name):imports[name],mod,mod.exports);
  return {run:()=>mod.exports.syncFinops(scope),calls,data};
}
test("actual sync worker repairs FX under the existing lease without private wallet, billing, registry or external cooldown writes",async()=>{
  const instance=worker();
  assert.equal((await instance.run()).status,"OK");
  assert.equal(instance.calls.filter(call=>call.name==="public-fx").length,1);
  const save=instance.calls.find(call=>call.name==="finops_finish_sync")!.args!;
  assert.match(String(save.p_snapshot_key),/^FX_REPAIR:/);
  assert.equal(save.p_external,false);
  assert.deepEqual((save.p_payload as FinopsDashboard).capital,instance.data.capital);
});
test("worker cooldown prevents repeated public FX requests",async()=>{
  const limited=worker(true);
  assert.equal((await limited.run()).status,"FRESH");
  assert.equal(limited.calls.some(call=>call.name==="public-fx"),false);
  assert.equal(limited.calls.some(call=>call.name==="finops_finish_sync"),false);
});
test("worker records an FX outage as a new partial attempt without resetting private-read cooldown",async()=>{
  const failed=worker(false,true);
  assert.equal((await failed.run()).status,"PARTIAL");
  const save=failed.calls.find(call=>call.name==="finops_finish_sync")!.args!;
  assert.equal(save.p_external,false);
  assert.equal((save.p_payload as FinopsDashboard).summary.capitalBrl,null);
  assert.match(String(save.p_snapshot_key),/^FX_REPAIR:/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { convertBrl, enrichService, nextFinopsExternalSync, projectedCost, requireFinopsOwnership, sumKnown, validateManualService } from "./model.ts";

const now = new Date("2026-09-16T00:00:00Z");
const fx = [{ base: "USD", quote: "BRL" as const, rate: 5.2, source: "BCB/PTAX",
  observedAt: "2026-09-15T16:00:00Z", fetchedAt: now.toISOString() }];
test("only authenticated active operator owner can enter FinOps, never VIEWER or another tenant", () => {
  const operator={id:"op",tenant_id:"tenant",user_id:"admin",status:"ACTIVE"};
  assert.deepEqual(requireFinopsOwnership({id:"admin"},operator,"tenant"),{operatorId:"op",tenantId:"tenant",userId:"admin"});
  assert.throws(()=>requireFinopsOwnership(null,operator,"tenant"),/AUTH_REQUIRED/);
  assert.throws(()=>requireFinopsOwnership({id:"admin",role:"VIEWER"},operator,"tenant"),/ADMIN_REQUIRED/);
  assert.throws(()=>requireFinopsOwnership({id:"visitor"},operator,"tenant"),/ADMIN_REQUIRED/);
  assert.throws(()=>requireFinopsOwnership({id:"admin"},{...operator,status:"DISABLED"},"tenant"),/ADMIN_REQUIRED/);
  assert.throws(()=>requireFinopsOwnership({id:"admin"},operator,"other"),/ADMIN_REQUIRED/);
});
test("currencies require their own quote; USDT is never silently USD", () => {
  assert.equal(convertBrl(6,"USD",fx),31.2);
  assert.equal(convertBrl(6,"BRL",fx),6);
  assert.equal(convertBrl(6,"USDT",fx),null);
  assert.equal(convertBrl(null,"USD",fx),null);
});
test("missing costs remain incomplete rather than an apparently free platform", () => {
  assert.deepEqual(sumKnown([31.2,null,31.2]),{known:62.4,complete:false,total:null});
  assert.deepEqual(sumKnown([.1,.2]),{known:.3,complete:true,total:.3});
});
test("projection separates full monthly tariff, variable run rate and billed evidence", () => {
  assert.equal(projectedCost(6,3,8,now),12);
  assert.equal(projectedCost(6,null,null,now),6);
  assert.equal(projectedCost(null,3,8,now),8); // Known usage subtotal, not an invented fixed tariff.
  assert.equal(projectedCost(6,0,20,now),20);
});
test("rolling six-hour cooldown cannot be bypassed across a UTC bucket boundary", () => {
  assert.equal(nextFinopsExternalSync(null, now), null);
  assert.equal(nextFinopsExternalSync("2026-09-15T23:59:00Z", now), "2026-09-16T05:59:00.000Z");
  assert.equal(nextFinopsExternalSync("2026-09-15T18:00:00Z", now), null);
  assert.throws(() => nextFinopsExternalSync("invalid", now), /SYNC_TIME_INVALID/);
});
test("real charges and estimated remainder reconcile without discarding variable-only project cost", () => {
  const row = { id:"v",provider:"Vercel",name:"Usage",currency:"USD",cost_period:"2026-09-01",
    actual_month_cost:4,recurring_monthly:null,allocation_percent:100,origin:"REAL",source_mode:"API",sync_status:"OK",enabled:true };
  const usage = enrichService(row, fx, now);
  assert.equal(usage.actualBrl,20.8);
  assert.equal(usage.projectedBrl,20.8);
  assert.equal(usage.estimatedBrl,0);
  const base = enrichService({...row,recurring_monthly:6}, fx, now);
  assert.equal(base.actualBrl,20.8);
  assert.equal(base.estimatedBrl,10.4);
  assert.equal(base.projectedBrl,31.2);
});
test("billing outage makes current API usage unavailable while preserving a documented tariff estimate", () => {
  const row = { id:"v",provider:"Vercel",name:"Usage",currency:"USD",cost_period:"2026-09-01",
    actual_month_cost:4,allocation_percent:100,origin:"REAL",source_mode:"API",sync_status:"FAILED",enabled:true };
  const failed = enrichService(row, fx, now);
  assert.equal(failed.actualBrl,null);
  assert.equal(failed.projectedBrl,null);
  assert.equal(failed.origin,"INDISPONIVEL");
  const documented = enrichService({...row,recurring_monthly:6}, fx, now);
  assert.equal(documented.actualBrl,null);
  assert.equal(documented.projectedBrl,31.2);
  assert.equal(documented.origin,"ESTIMADO");
});
test("provider billing cycle, not calendar month, governs usage projection and expiry", () => {
  const at = new Date("2026-09-27T00:50:00Z");
  const cycle = {start:"2026-09-14T00:00:00Z",end:"2026-10-14T00:00:00Z"};
  assert.equal(projectedCost(20,16.15,null,at,cycle),57.17);
  const row={id:"v",provider:"Vercel",name:"Shared",currency:"USD",cost_period:"2026-09-01",
    recurring_monthly:20,variable_month_to_date:16.15,allocation_percent:12.5,origin:"RATEIO_ESTIMADO",enabled:true,
    billing_period_start:cycle.start,billing_period_end:cycle.end,synced_at:at.toISOString()};
  assert.equal(enrichService(row,fx,new Date("2026-10-01T00:00:00Z")).variableMonthToDate,16.15);
  assert.equal(enrichService(row,fx,new Date("2026-10-01T00:00:00Z")).projectedOriginal,57.17);
  const expired=enrichService(row,fx,new Date("2026-10-15T00:00:00Z"));
  assert.equal(expired.variableMonthToDate,null);
  assert.equal(expired.projectedOriginal,20);
  const form={serviceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",currency:"USD",sourceNote:"Contrato",allocationPercent:100};
  assert.throws(()=>validateManualService({...form,billingPeriodStart:cycle.start,billingPeriodEnd:null}),/BILLING_PERIOD_INVALID/);
  assert.throws(()=>validateManualService({...form,billingPeriodStart:null,billingPeriodEnd:cycle.end}),/BILLING_PERIOD_INVALID/);
  assert.equal(validateManualService({...form,billingPeriodStart:cycle.start,billingPeriodEnd:cycle.end}).billingPeriodEnd,cycle.end);
});
test("shared bill is not assigned without explicit allocation and stale month actual is unavailable", () => {
  const row={id:"x",provider:"Supabase",name:"Shared",currency:"USD",recurring_monthly:25,
    actual_month_cost:28,variable_month_to_date:null,cost_period:"2026-09-01",enabled:true,
    origin:"REAL",source_mode:"MANUAL",sync_status:"MANUAL"};
  assert.equal(enrichService(row,fx,now).projectedBrl,null);
  const own=enrichService({...row,allocation_percent:20},fx,now);
  assert.equal(own.actualBrl,null); // Attribution is estimated even when the provider invoice is real.
  assert.equal(own.projectedBrl,29.12);
  assert.equal(own.origin,"RATEIO_ESTIMADO");
  assert.equal(own.sourceMode,"MANUAL");
  assert.equal(enrichService({...row,allocation_percent:20,cost_period:"2026-08-01"},fx,now).actualBrl,null);
});
test("documented tariff is estimated, never an invoice, and unconfirmed shared plans stay unavailable", () => {
  const documented = enrichService({ id:"do",provider:"DigitalOcean",name:"Executor",currency:"USD",
    recurring_monthly:6,actual_month_cost:6,allocation_percent:100,cost_period:"2026-09-01",enabled:true,
    origin:"ESTIMADO",source_mode:"DOCUMENTED",sync_status:"OK" },fx,now);
  assert.equal(documented.actualBrl,null);
  assert.equal(documented.projectedBrl,31.2);
  assert.equal(documented.estimatedBrl,31.2);
  assert.equal(documented.sourceMode,"DOCUMENTED");
  const unknown = enrichService({id:"shared",provider:"Supabase",name:"Shared",currency:"USD",
    recurring_monthly:null,allocation_percent:null,origin:"INDISPONIVEL",source_mode:"DOCUMENTED",
    cost_period:"2026-09-01",enabled:true},fx,now);
  assert.equal(unknown.projectedBrl,null);
  assert.equal(unknown.actualBrl,null);
});
test("manual source does not permit estimated values to be marked as real charges", () => {
  const input={serviceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",currency:"USD",sourceNote:"Tarifa publicada",allocationPercent:100};
  assert.throws(()=>validateManualService({...input,origin:"ESTIMADO",actualMonthCost:6}),/REAL_EVIDENCE_REQUIRED/);
  assert.throws(()=>validateManualService({...input,origin:"REAL"}),/REAL_AMOUNT_REQUIRED/);
  assert.throws(()=>validateManualService({...input,origin:"RATEIO_ESTIMADO",allocationPercent:null}),/ALLOCATION_REQUIRED/);
  assert.equal(validateManualService({...input,origin:"REAL",actualMonthCost:6}).sourceMode,"MANUAL");
});
test("manual cost validates amount/currency/provenance without accepting role or scope from client", () => {
  const form={serviceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",currency:"BRL",recurringMonthly:"12.35",
    actualMonthCost:"",variableMonthToDate:null,allocationPercent:100,sourceNote:"Contrato do provedor",
    tenantId:"attacker",operatorId:"attacker"};
  const parsed=validateManualService(form);
  assert.equal(parsed.recurringMonthly,12.35);
  assert.equal(parsed.actualMonthCost,null);
  assert.equal("operatorId" in parsed,false);
  assert.throws(()=>validateManualService({...form,recurringMonthly:-1}));
  assert.throws(()=>validateManualService({...form,recurringMonthly:.001}));
  assert.throws(()=>validateManualService({...form,allocationPercent:101}));
  assert.throws(()=>validateManualService({...form,currency:"BTC"}));
});
test("snapshot quote is immutable data and revaluation does not change prior result", () => {
  const frozen=JSON.parse(JSON.stringify({fx,amount:convertBrl(6,"USD",fx)}));
  assert.equal(convertBrl(6,"USD",[{...fx[0],rate:6}]),36);
  assert.equal(frozen.amount,31.2);
  assert.equal(frozen.fx[0].rate,5.2);
});

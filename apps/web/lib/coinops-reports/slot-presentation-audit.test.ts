import assert from "node:assert/strict";
import test from "node:test";
import { buildSlotPresentationAudit } from "./slot-presentation-audit.ts";

const at = "2026-10-01T12:00:00Z";
function fixture() {
  const slots = Array.from({ length: 25 }, (_, i) => ({ id: `slot-${i + 1}`, run_id: "run", trading_engine_id: "engine",
    slot_number: i + 1, entry_state: i === 1 ? "OPEN" : i === 0 ? "ARMED" : "PLANNED", operational_rank: i < 3 ? i + 1 : i - 2 }));
  return { robot_v1_live_runs: [{ id: "run", trading_engine_id: "engine", status: "ACTIVE", asset: "BTC" }],
    robot_v1_live_slots: slots, robot_v1_live_slot_accounts: slots.map((row) => ({ trading_engine_id: "engine",
      slot_number: row.slot_number, gain_count: 0, balance_quote: 18 })),
    robot_v1_live_preparations: [{ trading_engine_id: "engine", monthly_target: 7 }],
    robot_v1_monthly_slot_gains: [{ trading_engine_id: "engine", environment: "REAL", slot_number: 2,
      effective_gain_at: "2026-09-30T12:00:00Z", period_key: "2026-09", gain_units: 4 }] };
}
test("operational export distinguishes current rank, grid rank, monthly and lifetime without changing raw rows", () => {
  const source = fixture(), before = structuredClone(source);
  const model = buildSlotPresentationAudit(source, at);
  assert.equal(model.get("slot-2")?.visual_order, 1);
  assert.equal(model.get("slot-1")?.visual_order, 2);
  assert.equal(model.get("slot-4")?.current_operational_rank, 4);
  assert.equal(model.get("slot-4")?.grid_operational_rank, 1);
  assert.equal(model.get("slot-2")?.monthly_gain_count, 0);
  assert.equal(model.get("slot-2")?.lifetime_gain_count, 4);
  assert.deepEqual(source, before);
});
test("missing monthly source or incomplete physical set never certifies a presentation rank", () => {
  const source = fixture();
  assert.equal(buildSlotPresentationAudit({ ...source, robot_v1_live_slots: source.robot_v1_live_slots.slice(1) }, at).size, 0);
  const { robot_v1_monthly_slot_gains: _credits, ...missing } = source;
  assert.equal(buildSlotPresentationAudit(missing, at).size, 0);
});

test("corrected October accrual preserves September lifetime evidence in the current export",()=>{
 const policy={policy:"CUMULATIVE_LIFETIME_V1",anchor_at:"2026-10-01T04:00:00Z",execution_anchor_at:"2026-09-24T05:14:21Z",
  anchor_correction:{policy:"EXCLUDE_SEPTEMBER_TEST_V1",event_key:"SLOT_GOAL_START:OCTOBER_2026_V1"},
  schedule:[{effective_period:"2026-10",monthly_target:7,source:"FIRST_BUY"}]};
 const source={...fixture(),robot_v1_live_preparations:[{trading_engine_id:"engine",monthly_target:7,slot_goal_policy:policy}]};
 const before=structuredClone(source),model=buildSlotPresentationAudit(source,"2026-11-03T13:00:00Z"),slot=model.get("slot-2")!;
 assert.equal(slot.lifetime_gain_count,4);assert.equal(slot.monthly_gain_count,0);assert.equal(slot.monthly_gain_target,14);
 const goal=slot.slot_goal as {cycleMonth:number;nextTarget:number;anchorAt:string};
 assert.equal(goal.cycleMonth,2);assert.equal(goal.nextTarget,21);assert.equal(goal.anchorAt,policy.anchor_at);
 assert.deepEqual(source,before);
});

test("Thyely November start exports lifetime1/target3 and next6, keeping the October gain",()=>{
 const source={...fixture(),robot_v1_live_runs:[{id:"run",trading_engine_id:"engine",status:"ACTIVE",asset:"SOL"}],
  robot_v1_live_preparations:[{trading_engine_id:"engine",monthly_target:3,slot_goal_policy:{policy:"CUMULATIVE_LIFETIME_V1",
   anchor_at:"2026-11-01T04:00:00Z",execution_anchor_at:"2026-10-27T23:33:55.329Z",
   schedule:[{effective_period:"2026-11",monthly_target:3,source:"FIRST_BUY"}]}}],
  robot_v1_monthly_slot_gains:[{trading_engine_id:"engine",environment:"REAL",slot_number:2,effective_gain_at:"2026-10-30T12:00:00Z",period_key:"2026-10",gain_units:1}]};
 const before=structuredClone(source),slot=buildSlotPresentationAudit(source,"2026-11-03T14:00:00Z").get("slot-2")!;
 assert.equal(slot.lifetime_gain_count,1);assert.equal(slot.monthly_gain_count,0);assert.equal(slot.monthly_gain_target,3);
 const goal=slot.slot_goal as{cycleMonth:number;nextTarget:number};assert.equal(goal.cycleMonth,1);assert.equal(goal.nextTarget,6);
 assert.deepEqual(source,before);
});

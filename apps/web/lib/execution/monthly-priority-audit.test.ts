import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { cumulativeSlotGoal } from "./cumulative-slot-goal.ts";
import { sameMonthlyGoal, monthlyPriorityEventKey, assertMonthlyPriorityAuditRecoveryEvidence } from "./monthly-priority-audit.ts";
import { isMonthlyPriorityAuditReplayRecovery, mayRecoverReadOutage, verifiedReadRecoveryAlert,
  type ReadRecoveryAlert } from "./live-read-recovery.ts";
import { LiveAuditEventPersistError } from "./live-audit-event.ts";

const at = "2026-11-04T20:30:00Z";
const goal = cumulativeSlotGoal({ policy: "CUMULATIVE_LIFETIME_V1", anchor_at: "2026-10-01T04:00:00Z",
  schedule: [{ effective_period: "2026-10", monthly_target: 2, source: "BASELINE" }] }, at);
const scope = { product_id: "p", tenant_id: "t", user_id: "u", operator_id: "o", exchange_account_id: "a",
  trading_engine_id: "engine-a", quote_asset: "BRL" };
const details = { root_code: "COINOPS_LIVE_EVENT_PERSIST_FAILED", stage: "ATH_TRANSITION",
  audit_phase: "READBACK", audit_reason: "READBACK_MISMATCH", audit_event_type: "MONTHLY_PRIORITY_REFRESHED",
  audit_attempts: 1, audit_http_status: null, audit_provider_code: null };
function fixture(count = 25) {
  const checkpoint = { policy: "MONTHLY_GAINS_V1", goal, period: goal.period, previous_period: "2026-10",
    observed_at: "2026-11-03T13:45:36.869Z", reanchored: false, levels_preserved: true,
    slot_count: count, primary: 0, reserve: 0 };
  const event = { ...scope, run_id: "run-a", event_key: monthlyPriorityEventKey(goal.period, goal),
    event_type: "MONTHLY_PRIORITY_REFRESHED", slot_number: null, observed_at: "2026-11-03T13:45:36.953Z",
    details: structuredClone(checkpoint) };
  const run = { ...scope, id: "run-a", ath_period_key: goal.period, config_snapshot: { slot_goal_state: goal,
    monthly_priority_rollover: { ...checkpoint, observed_at: at, previous_period: "2026-11" } } };
  const incident: ReadRecoveryAlert = { alert_key: "LIVE_RUN:run-a:CRITICAL",
    code: details.root_code, first_seen_at: "2026-11-04T20:29:20.669Z", last_seen_at: "2026-11-04T20:29:20.657Z",
    details: { ...details } };
  return { checkpoint, event, run, incident };
}

test("goal equality ignores JSONB object order and no semantic field or unknown field", () => {
  const sorted = Object.fromEntries(Object.entries(goal).sort(([a], [b]) => a.localeCompare(b)));
  assert.equal(sameMonthlyGoal(sorted, goal), true);
  for (const key of Object.keys(goal)) assert.equal(sameMonthlyGoal({ ...sorted, [key]: "changed" }, goal), false);
  assert.equal(sameMonthlyGoal({ ...sorted, extra: true }, goal), false);
  assert.equal(sameMonthlyGoal(null, goal), false); assert.equal(sameMonthlyGoal(null, null), true);
});

test("monthly audit key remains exactly compatible with deployed legacy hash and DB order", () => {
  const sorted = Object.fromEntries(Object.entries(goal).sort(([a], [b]) => a.localeCompare(b))) as typeof goal;
  assert.equal(monthlyPriorityEventKey(goal.period, goal), "MONTHLY_PRIORITY_REFRESHED:2026-11:9ecb6ab52a2a19ab");
  assert.equal(monthlyPriorityEventKey(goal.period, sorted), monthlyPriorityEventKey(goal.period, goal));
  assert.equal(monthlyPriorityEventKey(goal.period, goal), `MONTHLY_PRIORITY_REFRESHED:${goal.period}:${createHash("sha256").update(JSON.stringify(goal)).digest("hex").slice(0, 16)}`);
  assert.equal(new LiveAuditEventPersistError("READBACK", "READBACK_MISMATCH", 1,
    "MONTHLY_PRIORITY_REFRESHED", undefined, monthlyPriorityEventKey(goal.period, goal)).eventKey, monthlyPriorityEventKey(goal.period, goal));
});

test("only the exact typed monthly mismatch permits guarded recovery eligibility", () => {
  const { incident } = fixture();
  assert.equal(isMonthlyPriorityAuditReplayRecovery(incident.code, details), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", incident.code, details), true);
  assert.equal(verifiedReadRecoveryAlert("ACTIVE", "run-a", [incident]), incident);
  for (const change of [{ root_code: "OTHER" }, { stage: "AUDIT_EVENT" }, { stage: "ARM_ENTRY" },
    { audit_reason: "UNKNOWN" }, { audit_reason: "READBACK_UNAVAILABLE" }, { audit_phase: "WRITE" },
    { audit_event_type: "RECONCILED" }, { audit_event_key: "invalid" }, { audit_attempts: 0 },
    { audit_attempts: 3 }, { audit_attempts: "1" }, { audit_http_status: 503 }, { audit_http_status: undefined },
    { audit_provider_code: "42501" }, { audit_provider_code: undefined }, { http_status: 503 }, { provider_code: "PGRST002" }])
    assert.equal(isMonthlyPriorityAuditReplayRecovery(incident.code, { ...details, ...change }), false, JSON.stringify(change));
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", incident.code, details), false);
  assert.equal(mayRecoverReadOutage("ACTIVE", "RETRY", incident.code, details), false);
});

test("historical monthly checkpoint can prove exact metadata replay for 25/50/100 while preserving history", () => {
  for (const count of [25, 50, 100]) {
    const f = fixture(count), before = structuredClone(f);
    assert.equal(assertMonthlyPriorityAuditRecoveryEvidence(f.incident, f.run, goal, count, f.event), f.event);
    assert.deepEqual(f, before);
  }
});

test("foreign scope, changed goal, malformed timing or semantic mismatch never opens a gate", () => {
  for (const key of [...Object.keys(scope), "run_id", "event_type", "event_key", "slot_number"])
    { const f = fixture(); (f.event as any)[key] = "foreign";
      assert.throws(() => assertMonthlyPriorityAuditRecoveryEvidence(f.incident, f.run, goal, 25, f.event), /UNPROVEN/); }
  for (const change of [{ goal: { ...goal, target: 6 } }, { period: "2026-10" }, { slot_count: 50 },
    { reanchored: true }, { levels_preserved: false }, { policy: "OTHER" }, { primary: 1 }, { reserve: -1 },
    { previous_period: "2026-12" }, { observed_at: "2026-11-04T20:30:00Z" }]) {
    const f = fixture(); Object.assign(f.event.details, change);
    assert.throws(() => assertMonthlyPriorityAuditRecoveryEvidence(f.incident, f.run, goal, 25, f.event), /UNPROVEN/);
  }
  for (const change of [{ observed_at: "2026-11-04T20:30:00Z" }, { observed_at: "invalid" }]) {
    const f = fixture(); Object.assign(f.event, change);
    assert.throws(() => assertMonthlyPriorityAuditRecoveryEvidence(f.incident, f.run, goal, 25, f.event), /UNPROVEN/);
  }
  const f = fixture(); f.run.config_snapshot.slot_goal_state = { ...goal, target: 99 };
  assert.throws(() => assertMonthlyPriorityAuditRecoveryEvidence(f.incident, f.run, goal, 25, f.event), /UNPROVEN/);
  assert.throws(() => assertMonthlyPriorityAuditRecoveryEvidence(f.incident, f.run, goal, 25, null), /UNPROVEN/);
});

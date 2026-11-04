import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SlotGoal } from "./cumulative-slot-goal.ts";
import type { AuditRecoveryEvent, ReadRecoveryAlert } from "./live-read-recovery.ts";
import { isMonthlyPriorityAuditReplayRecovery } from "./live-read-recovery.ts";

/** JSONB object key order is not a strategy change. Keep all fields strict. */
export const sameMonthlyGoal = (stored: unknown, current: unknown) => isDeepStrictEqual(stored, current);

/** Preserve the deployed key format, independent of JSONB's property order. */
export function monthlyPriorityEventKey(period: string, goal: SlotGoal | null) {
  const ordered = goal ? { policy: goal.policy, anchorAt: goal.anchorAt, cycleMonth: goal.cycleMonth,
    target: goal.target, nextTarget: goal.nextTarget, period: goal.period,
    nextPeriodAt: goal.nextPeriodAt, monthlyTarget: goal.monthlyTarget } : null;
  return `MONTHLY_PRIORITY_REFRESHED:${period}:${createHash("sha256")
    .update(JSON.stringify(ordered)).digest("hex").slice(0, 16)}`;
}

type Scope = { id: string; product_id: string; tenant_id: string; user_id: string; operator_id: string;
  exchange_account_id: string; trading_engine_id: string; quote_asset: string; ath_period_key: string | null;
  config_snapshot: Record<string, unknown> };

/** Prove this historical metadata replay, never a generic mismatching write.
 * Fresh financial/dispatch/audit proofs and incident CAS are enforced twice by
 * the canonical resume flow. Do not alter the immutable first-writer event. */
export function assertMonthlyPriorityAuditRecoveryEvidence(incident: ReadRecoveryAlert, run: Scope,
  goal: SlotGoal | null, slotCount: number, event: AuditRecoveryEvent | null) {
  const fail = (): never => { throw new Error("COINOPS_LIVE_MONTHLY_AUDIT_RECOVERY_UNPROVEN"); };
  if (!isMonthlyPriorityAuditReplayRecovery(incident.code, incident.details)
    || !goal || goal.policy !== "CUMULATIVE_LIFETIME_V1" || !event || event.run_id !== run.id
    || event.event_type !== "MONTHLY_PRIORITY_REFRESHED" || event.slot_number !== null
    || event.event_key !== monthlyPriorityEventKey(goal.period, goal)
    || incident.alert_key !== `LIVE_RUN:${run.id}:CRITICAL`
    || incident.details?.audit_event_key !== undefined && incident.details.audit_event_key !== event.event_key
    || run.ath_period_key !== goal.period || !sameMonthlyGoal(run.config_snapshot.slot_goal_state, goal)) return fail();
  for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id",
    "trading_engine_id", "quote_asset"] as const) if (!run[key] || event[key] !== run[key]) return fail();
  const saved = run.config_snapshot.monthly_priority_rollover as Record<string, unknown> | undefined;
  const original = event.details;
  if (!saved || !original || !sameMonthlyGoal(original.goal, goal)
    || !sameMonthlyGoal(saved.goal, goal) || original.policy !== "MONTHLY_GAINS_V1"
    || original.period !== goal.period || original.slot_count !== slotCount
    || original.reanchored !== false || original.levels_preserved !== true) return fail();
  const semantic = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["observed_at", "previous_period"].includes(key)));
  if (!isDeepStrictEqual(semantic(original), semantic(saved))) return fail();
  for (const checkpoint of [original, saved]) {
    const previous = checkpoint.previous_period;
    if (typeof previous !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(previous)
      || previous > goal.period || !Number.isInteger(checkpoint.primary) || Number(checkpoint.primary) < 0
      || Number(checkpoint.primary) > Math.min(15, slotCount) || !Number.isInteger(checkpoint.reserve)
      || Number(checkpoint.reserve) < 0 || Number(checkpoint.primary) + Number(checkpoint.reserve) > slotCount) return fail();
  }
  const first = Date.parse(incident.first_seen_at ?? ""), last = Date.parse(incident.last_seen_at),
    observed = Date.parse(event.observed_at), emitted = Date.parse(String(original.observed_at)),
    savedAt = Date.parse(String(saved.observed_at));
  if (![first, last, observed, emitted, savedAt].every(Number.isFinite)
    || observed >= Math.min(first, last) || emitted > observed + 1_000 || observed - emitted > 65_000
    || savedAt < emitted) return fail();
  return event;
}

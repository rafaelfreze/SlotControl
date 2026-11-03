import { monthlyPeriodKey, nextMonthlyResetAt } from "./monthly-slot-policy.ts";

export const CUMULATIVE_SLOT_GOAL_POLICY = "CUMULATIVE_LIFETIME_V1" as const;
export type SlotGoalPolicy = { policy: typeof CUMULATIVE_SLOT_GOAL_POLICY; anchor_at: string;
  schedule: Array<{ effective_period: string; monthly_target: number; source: string }> };
export type SlotGoal = { policy: typeof CUMULATIVE_SLOT_GOAL_POLICY; anchorAt: string; cycleMonth: number;
  target: number; nextTarget: number; period: string; nextPeriodAt: string; monthlyTarget: number };

function ordinal(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("COINOPS_SLOT_GOAL_PERIOD_INVALID");
  return Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1;
}

/** Sum immutable calendar competences. An edit changes only subsequent months,
 * never the target already accrued. No wall-clock elapsed-duration arithmetic. */
export function cumulativeSlotGoal(value: SlotGoalPolicy, at: string | Date): SlotGoal {
  if (value?.policy !== CUMULATIVE_SLOT_GOAL_POLICY || !Array.isArray(value.schedule) || !value.schedule.length)
    throw new Error("COINOPS_SLOT_GOAL_POLICY_INVALID");
  const anchor = monthlyPeriodKey(value.anchor_at), period = monthlyPeriodKey(at);
  const start = ordinal(anchor), current = ordinal(period);
  if (current < start) throw new Error("COINOPS_SLOT_GOAL_BEFORE_ANCHOR");
  let previous = -1;
  const versions = value.schedule.map((v, i) => {
    const month = ordinal(v.effective_period);
    if (month <= previous || month < start || i === 0 && month !== start
      || !Number.isInteger(v.monthly_target) || v.monthly_target < 1 || v.monthly_target > 1000 || !v.source)
      throw new Error("COINOPS_SLOT_GOAL_SCHEDULE_INVALID");
    previous = month;
    return { month, rate: v.monthly_target };
  });
  const total = (until: number) => versions.reduce((sum, v, i) => sum
    + Math.max(0, Math.min(until + 1, versions[i + 1]?.month ?? until + 1) - v.month) * v.rate, 0);
  const target = total(current), nextTarget = total(current + 1);
  if (!Number.isSafeInteger(target) || target < 1 || !Number.isSafeInteger(nextTarget))
    throw new Error("COINOPS_SLOT_GOAL_TARGET_INVALID");
  return { policy: value.policy, anchorAt: value.anchor_at, cycleMonth: current - start + 1,
    target, nextTarget, period, nextPeriodAt: nextMonthlyResetAt(at),
    monthlyTarget: versions.filter(v => v.month <= current).at(-1)!.rate };
}

/** Financial guards remain independent. OPEN/partial/MISSED cannot release or
 * consume the goal exception; CLOSED can compete after its normal settlement. */
export function goalEntryStateEligible(state: string) {
  return ["PLANNED", "PENDING", "ARMED", "CLOSED", "NONE"].includes(state);
}

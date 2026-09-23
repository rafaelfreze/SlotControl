import { monthlyPeriodKey } from "../execution/monthly-slot-policy.ts";
import type { AuditRow } from "./trigger-audit.ts";

/** The monthly policy introduced in 4.2 remains enforced by later engines. */
export function hasMonthlyTargetPolicy(version: unknown): boolean {
  const match = typeof version === "string" && /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  return Boolean(match && (Number(match[1]) > 4 || Number(match[1]) === 4 && Number(match[2]) >= 2));
}

export function auditMonthlyEntryEvidence(input: {
  events: { slot: number; at: unknown }[]; credits: AuditRow[]; goals: AuditRow[]; adoptedAt: number;
}): "PASS" | "WARNING" | "FAIL" {
  if (!Number.isFinite(input.adoptedAt)) return "WARNING";
  let uncertain = false;
  for (const event of input.events) {
    const time = Date.parse(String(event.at ?? ""));
    if (!Number.isFinite(time)) { uncertain = true; continue; }
    if (time < input.adoptedAt) continue;
    const period = monthlyPeriodKey(new Date(time).toISOString());
    const goal = input.goals.find((row) => Number(row.physical_slot_number) === event.slot && row.period_key === period);
    if (!goal || !(Number(goal.monthly_gain_target) > 0)) { uncertain = true; continue; }
    const facts = input.credits.filter((row) => Number(row.slot_number) === event.slot && row.period_key === period);
    let total = 0, ambiguous = false;
    for (const fact of facts) {
      const credited = Date.parse(String(fact.credited_at ?? "")), units = Number(fact.gain_units ?? 1);
      if (!Number.isFinite(credited) || !Number.isFinite(units)) { ambiguous = true; continue; }
      if (credited < time) total += units;
      else if (credited === time) ambiguous = true;
    }
    // Use the signed ledger known when the action occurred. A later reversal
    // neither invalidates a legitimate reentry nor erases an earlier violation.
    if (ambiguous) uncertain = true;
    else if (total >= Number(goal.monthly_gain_target)) return "FAIL";
  }
  return uncertain ? "WARNING" : "PASS";
}

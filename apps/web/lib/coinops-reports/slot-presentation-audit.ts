import { projectCurrentLiveSlotRanks } from "../slotgain/live-slot-read-model.ts";
import { orderOperationalSlots, ledgerSlotKey } from "../slotgain/operational-slot-order.ts";
import { monthlyPeriodKey } from "../execution/monthly-slot-policy.ts";
import type { AuditRow } from "./trigger-audit.ts";

/** Current read model only. Never infer a historical rank from today's state.
 * Keeps the raw ledger operational_rank and annotates the distinct current rank. */
export function buildSlotPresentationAudit(sources: Record<string, AuditRow[]>, at: string) {
  const output = new Map<string, AuditRow>(), period = monthlyPeriodKey(at);
  for (const run of sources.robot_v1_live_runs ?? []) {
    if (!["ACTIVE", "PAUSED"].includes(String(run.status)) || !["BTC", "SOL"].includes(String(run.asset))) continue;
    const engineId = run.trading_engine_id;
    const rawSlots = (sources.robot_v1_live_slots ?? []).filter((slot) => slot.run_id === run.id);
    const rawAccounts = (sources.robot_v1_live_slot_accounts ?? []).filter((row) => row.trading_engine_id === engineId);
    const preparation = (sources.robot_v1_live_preparations ?? []).find((row) => row.trading_engine_id === engineId);
    if (!engineId || rawSlots.length !== 25 || rawAccounts.length !== 25 || !preparation
      || !Object.hasOwn(sources, "robot_v1_monthly_slot_gains")) continue;
    const credits = (sources.robot_v1_monthly_slot_gains ?? []).filter((row) => row.trading_engine_id === engineId
      && row.environment === "REAL" && Date.parse(String(row.effective_gain_at)) <= Date.parse(at));
    const totals = rawSlots.map((slot) => {
      const own = credits.filter((row) => row.slot_number === slot.slot_number);
      const units = (rows: AuditRow[]) => rows.reduce((sum, row) => sum + Number(row.gain_units ?? 1), 0);
      return { slot_number: Number(slot.slot_number), lifetime_gain_count: units(own),
        monthly_gain_count: units(own.filter((row) => row.period_key === period)) };
    });
    const target = Number(preparation.monthly_target);
    // A partial historical credit source cannot certify current lifetime/rank.
    if (rawAccounts.some((row) => Number(row.gain_count) > (totals.find((total) => total.slot_number === row.slot_number)?.lifetime_gain_count ?? 0))) continue;
    const ranked = projectCurrentLiveSlotRanks(rawSlots.map((slot) => ({
      id: String(slot.id), slot_number: Number(slot.slot_number), entry_state: String(slot.entry_state),
      operational_rank: slot.operational_rank == null ? null : Number(slot.operational_rank),
      post_ath_group: slot.post_ath_group == null ? null : String(slot.post_ath_group),
    })), rawAccounts.map((row) => ({ slot_number: Number(row.slot_number), gain_count: Number(row.gain_count),
      balance_quote: Number(row.balance_quote ?? row.balance_brl) })), totals,
    run.asset === "BTC" ? "BTC" : "SOL", target, at);
    for (const [index, slot] of orderOperationalSlots(ranked, ledgerSlotKey).entries()) {
      const total = totals.find((row) => row.slot_number === slot.slot_number)!;
      output.set(slot.id, { visual_order: index + 1, current_operational_rank: slot.operational_rank,
        grid_operational_rank: slot.grid_operational_rank, monthly_gain_count: total.monthly_gain_count,
        lifetime_gain_count: total.lifetime_gain_count, monthly_gain_target: target, period_key: period,
        presentation_basis: "CURRENT_ENGINE_MONTHLY_POLICY; STATE_THEN_RANK; READ_ONLY" });
    }
  }
  return output;
}

import { rankMonthlySlots } from "../execution/monthly-slot-policy.ts";
import type { LiveAssetData } from "../../app/automacao/automation-mobile";

type Slot = { slot_number: number; entry_state: string; operational_rank: number | null;
  grid_operational_rank?: number | null; post_ath_group?: string | null };
type Account = { slot_number: number; balance_quote?: number | string; balance_brl?: number | string; gain_count: number };
type Total = { slot_number: number; lifetime_gain_count: number; monthly_gain_count: number };

/** Uses the exact monthly engine policy, not a frontend ranking algorithm.
 * Mirrors candidate() in robot-v1-live-server: NORMAL uses the current monthly
 * rank; POST_ATH retains its persisted group/grid rank while eligible.
 * The persisted ledger/grid is never written or repriced by this projection. */
export function projectLiveSlotRanks(data: LiveAssetData, asset: "BTC" | "SOL", target: number,
  observedAt: string): LiveAssetData {
  return { ...data, slots: projectCurrentLiveSlotRanks(data.slots, data.accounts, data.monthlyGains, asset, target, observedAt) };
}

export function projectCurrentLiveSlotRanks<T extends Slot>(slots: readonly T[], accountRows: readonly Account[],
  totalRows: readonly Total[], asset: "BTC" | "SOL", target: number, observedAt: string): Array<T & { grid_operational_rank?: number | null }> {
  if (slots.length !== 25 || accountRows.length !== 25) return [...slots];
  const totals = new Map(totalRows.map((row) => [row.slot_number, row]));
  const accounts = new Map(accountRows.map((row) => [row.slot_number, row]));
  const ranks = rankMonthlySlots(asset, observedAt, slots.map((slot) => {
    const account = accounts.get(slot.slot_number), total = totals.get(slot.slot_number);
    return { physicalSlotNumber: slot.slot_number, physicalSlotId: `READ:${slot.slot_number}`,
      entryState: slot.entry_state, lifetimeGainCount: Number(total?.lifetime_gain_count ?? account?.gain_count ?? 0),
      monthlyGainCount: total ? Number(total.monthly_gain_count) : Number(account?.gain_count) === 0 ? 0 : null,
      balanceUsdc: Number(account?.balance_quote ?? account?.balance_brl) };
  }), target);
  const byNumber = new Map(ranks.map((row) => [row.physicalSlotNumber, row]));
  return slots.map((slot) => {
    const rank = byNumber.get(slot.slot_number)!.operationalRank;
    return { ...slot, grid_operational_rank: slot.grid_operational_rank !== undefined ? slot.grid_operational_rank : slot.operational_rank,
      operational_rank: rank === null ? null : slot.post_ath_group
        ? slot.operational_rank ?? rank : rank };
  });
}

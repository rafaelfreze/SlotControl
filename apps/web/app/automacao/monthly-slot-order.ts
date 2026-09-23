import type { MonthlySlotStatus } from "../../lib/execution/monthly-slot-policy.ts";

export type MonthlySlotFilter = "operational" | "physical" | "gain_desc" | "gain_asc" | "reached" | "eligible" | "open" | "waiting";

const isOpen = (state: string) => ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(state);
const stateOrder = (state: string) => isOpen(state) ? 0 : state === "ARMED" ? 1 : 2;

/** Sorts the existing slot list; physical identities and ledger rows never change. */
export function orderMonthlySlotRows<T>(rows: readonly T[], statuses: readonly MonthlySlotStatus[], slotNumber: (row: T) => number, filter: MonthlySlotFilter): T[] {
  if (statuses.length !== 25) return [...rows];
  const byNumber = new Map(statuses.map((status) => [status.physicalSlotNumber, status]));
  const included = rows.filter((row) => {
    const status = byNumber.get(slotNumber(row));
    if (!status) return true;
    if (filter === "reached") return status.monthlyTargetReached;
    if (filter === "eligible") return status.eligibleForNewEntry;
    if (filter === "open") return isOpen(status.entryState);
    if (filter === "waiting") return !isOpen(status.entryState) && status.entryState !== "ARMED" && !status.monthlyTargetReached;
    return true;
  });
  return included.sort((left, right) => {
    const a = byNumber.get(slotNumber(left)), b = byNumber.get(slotNumber(right));
    if (!a || !b) return slotNumber(left) - slotNumber(right);
    if (filter === "physical") return a.physicalSlotNumber - b.physicalSlotNumber;
    if (filter === "gain_desc") return b.lifetimeGainCount - a.lifetimeGainCount || a.physicalSlotNumber - b.physicalSlotNumber;
    if (filter === "gain_asc") return a.lifetimeGainCount - b.lifetimeGainCount || a.physicalSlotNumber - b.physicalSlotNumber;
    return stateOrder(a.entryState) - stateOrder(b.entryState)
      || (a.operationalRank ?? 99) - (b.operationalRank ?? 99)
      || a.physicalSlotNumber - b.physicalSlotNumber;
  });
}

export function monthlyNextAction(status: MonthlySlotStatus): string {
  if (isOpen(status.entryState)) return "Aguardar TP";
  if (status.monthlyTargetReached) return "Aguardar próximo mês";
  if (!status.eligibleForNewEntry) return "Reconciliar evidência";
  if (status.entryState === "MISSED") return "Aguardar próximo ciclo";
  if (status.entryState === "ARMED") return "Próxima BUY armada";
  return "Aguardar preço/reentrada";
}

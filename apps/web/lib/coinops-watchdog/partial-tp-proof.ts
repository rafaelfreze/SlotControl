import type { FastOrder, FastRun } from "./watchdog-policy";

const UNAVAILABLE = Object.freeze({ contract: "PARTIAL_TP_PROOF_UNAVAILABLE" });
const denied = (error: unknown) => /\bCOINOPS_LIVE_PARTIAL_TP_PROOF_(?:SCOPE_DENIED|STALE|UNSAFE)\b/.test(
  error && typeof error === "object" && "message" in error ? String(error.message) : String(error));

/** One bounded, internal database GET per checkpointed run, never per fill.
 * Failure provides no proof; it cannot clear an incident or authorize trading. */
export async function readPartialTpCheckpointProof(read: (runId: string, checkpoint: unknown,
  signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>, run: FastRun,
  slotCount: number, orders: FastOrder[]): Promise<unknown | null> {
  if (run.status !== "ACTIVE" || !Number.isSafeInteger(slotCount) || slotCount <= 25 || slotCount > 100
    || !run.reconciliation_checkpoint || !orders.some(order => order.side === "SELL" && order.purpose === "TP"
      && order.status === "PARTIALLY_FILLED" && Number(order.executed_quantity) > 0 && order.trades_reconciled !== true)) return null;
  const signal = AbortSignal.timeout(5_000);
  try {
    const result = await read(run.id, run.reconciliation_checkpoint, signal);
    if (signal.aborted) return UNAVAILABLE;
    return result.error ? denied(result.error) ? null : UNAVAILABLE : result.data;
  } catch (error) { return denied(error) ? null : UNAVAILABLE; }
}

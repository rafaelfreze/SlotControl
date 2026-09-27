export type LiveAdvanceResult = {
  status: string;
  nextRunId?: string;
  next?: unknown;
  code?: string;
};

export type LiveAdvanceTrace = {
  runId: string;
  status: string;
  nextRunId?: string;
  next?: unknown;
};

export type LiveAdvanceChainResult = LiveAdvanceResult & {
  continuation: LiveAdvanceTrace[];
};

export const LIVE_ADVANCE_MAX_STEPS = 4;

/**
 * Continue the authoritative LIVE state machine across the two boundaries that
 * deliberately create durable checkpoints:
 *
 * 1. a completed cycle creates an idempotent successor run;
 * 2. the successor MARKET is reconciled and protected before its NEXT BUY is
 *    armed in a fresh lease.
 *
 * The callback remains the only implementation of the trading strategy. This
 * coordinator merely follows its persisted run IDs and outcomes, so a retry,
 * crash or watchdog execution resumes the same state instead of inventing a
 * second transition.
 */
export async function continueLiveAdvance(
  initialRunId: string,
  source: string,
  advanceOnce: (runId: string, source: string) => Promise<LiveAdvanceResult>,
  maxSteps = LIVE_ADVANCE_MAX_STEPS,
): Promise<LiveAdvanceChainResult> {
  let runId = initialRunId;
  const continuation: LiveAdvanceTrace[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const result = await advanceOnce(runId, source);
    continuation.push({ runId, status: result.status,
      ...(result.nextRunId ? { nextRunId: result.nextRunId } : {}),
      ...(result.next !== undefined ? { next: result.next } : {}) });

    if (result.status === "RESTARTED" && result.nextRunId) {
      runId = result.nextRunId;
      continue;
    }
    if (result.status === "OK" && result.next === "INITIAL_SUBMITTED") continue;
    return { ...result, continuation };
  }

  throw new Error("COINOPS_LIVE_CONTINUATION_LIMIT");
}

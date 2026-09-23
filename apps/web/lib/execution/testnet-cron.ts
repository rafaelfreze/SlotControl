export const TESTNET_REACTOR_INTERVAL_SECONDS = 60;
export const TESTNET_WATCHDOG_INTERVAL_SECONDS = 300;
export const TESTNET_STALE_AFTER_MS = 90_000;
export type TestnetCronMode = "REACTOR" | "WATCHDOG";
export type TestnetCronRun = {
  id: string; asset: "BTC" | "SOL"; product_id: string; tenant_id: string; user_id: string;
  status: string; last_reconciled_at: string | null; lease_until: string | null; last_error: string | null;
};
export type TestnetCronResult = {
  runId: string; asset: "BTC" | "SOL"; status: string; ageBeforeMs: number | null;
  durationMs: number; lastReconciledAt?: string | null; error?: string;
};
export type TestnetCronEvidence = {
  type: "RECONCILIATION_STARTED" | "RECONCILIATION_FINISHED";
  observedAt: string; details: Record<string, string | number | boolean | null>;
};
type Dependencies = {
  now: () => number;
  advance: (runId: string, source: string) => Promise<{ status: string; nextRunId?: string }>;
  currentRun: (runId: string) => Promise<TestnetCronRun | null>;
  record: (run: TestnetCronRun, evidence: TestnetCronEvidence) => Promise<void>;
};

export function reconciliationAge(run: Pick<TestnetCronRun, "last_reconciled_at">, now: number) {
  const time = Date.parse(run.last_reconciled_at || "");
  return Number.isFinite(time) ? Math.max(0, now - time) : null;
}

function safeError(error: unknown) {
  return error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message)
    ? error.message : "COINOPS_TESTNET_RECONCILIATION_FAILED";
}

/** The watchdog never becomes a second trading loop when the minute reactor is healthy. */
export async function reconcileTestnetCronRun(run: TestnetCronRun, mode: TestnetCronMode, deps: Dependencies): Promise<TestnetCronResult> {
  const started = deps.now();
  const ageBeforeMs = reconciliationAge(run, started);
  const base = { runId: run.id, asset: run.asset, ageBeforeMs };
  if (mode === "WATCHDOG" && !run.last_error && ageBeforeMs !== null && ageBeforeMs < TESTNET_STALE_AFTER_MS) {
    return { ...base, status: "WATCHDOG_HEALTHY", durationMs: 0, lastReconciledAt: run.last_reconciled_at };
  }
  const source = mode === "REACTOR" ? "FAST_REACTOR_RECONCILIATION" : "WATCHDOG_RECONCILIATION";
  const details = {
    mode: "TESTNET", recovery_source: source, expected_interval_seconds: TESTNET_REACTOR_INTERVAL_SECONDS,
    fallback_interval_seconds: TESTNET_WATCHDOG_INTERVAL_SECONDS, age_before_ms: ageBeforeMs,
    started_at: new Date(started).toISOString(), previous_last_reconciled_at: run.last_reconciled_at,
  };
  let result: TestnetCronResult;
  try {
    // Evidence precedes execution so a killed invocation differs from no invocation.
    await deps.record(run, { type: "RECONCILIATION_STARTED", observedAt: details.started_at, details });
    const advanced = await deps.advance(run.id, source);
    const current = await deps.currentRun(advanced.nextRunId || run.id);
    if (!current) throw new Error("COINOPS_TESTNET_RECONCILIATION_RUN_MISSING");
    if (advanced.status === "BUSY_OR_INACTIVE") {
      const leaseActive = Date.parse(current.lease_until || "") > deps.now();
      if (current.status === "ACTIVE" && !leaseActive) throw new Error("COINOPS_TESTNET_RECONCILIATION_SKIPPED_ACTIVE_RUN");
      result = { ...base, status: current.status === "ACTIVE" ? "BUSY_ACTIVE_LEASE" : "CYCLE_ALREADY_COMPLETED", durationMs: deps.now() - started, lastReconciledAt: current.last_reconciled_at };
    } else {
      // HTTP 200 alone is not proof that a discovered cycle was reconciled.
      if (!current.last_reconciled_at || Date.parse(current.last_reconciled_at) < started || current.last_error) {
        throw new Error("COINOPS_TESTNET_RECONCILIATION_CHECKPOINT_STALE");
      }
      result = { ...base, status: advanced.status, durationMs: deps.now() - started, lastReconciledAt: current.last_reconciled_at };
    }
  } catch (error) {
    result = { ...base, status: "FAILED", durationMs: deps.now() - started, error: safeError(error) };
  }
  try {
    await deps.record(run, {
      type: "RECONCILIATION_FINISHED", observedAt: new Date(deps.now()).toISOString(),
      details: { ...details, finished_at: new Date(deps.now()).toISOString(), duration_ms: result.durationMs,
        outcome: result.status, last_reconciled_at: result.lastReconciledAt ?? null, error: result.error ?? null },
    });
  } catch {
    return { ...result, status: "FAILED", error: "COINOPS_TESTNET_RECONCILIATION_EVIDENCE_FAILED" };
  }
  return result;
}

/** One asset's failure cannot prevent the other asset from starting. */
export async function runTestnetCronBatch(runs: TestnetCronRun[], mode: TestnetCronMode, deps: Dependencies) {
  const results: TestnetCronResult[] = [];
  for (let index = 0; index < runs.length; index += 2) {
    results.push(...await Promise.all(runs.slice(index, index + 2).map((run) => reconcileTestnetCronRun(run, mode, deps))));
  }
  return results;
}

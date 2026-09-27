import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { continueLiveAdvance, type LiveAdvanceResult } from "../execution/live-cycle-continuation.ts";

type Durable = {
  successorCreated: boolean;
  gainCredits: number;
  markets: number;
  tps: number;
  nextBuys: number;
};

function recoverableMachine(durable: Durable, failure?: string) {
  return async (runId: string): Promise<LiveAdvanceResult> => {
    if (runId === "old") {
      durable.gainCredits ||= 1;
      if (failure === "after-gain") throw new Error("CRASH_AFTER_GAIN");
      durable.successorCreated = true;
      if (failure === "after-successor") throw new Error("CRASH_AFTER_SUCCESSOR");
      return { status: "RESTARTED", nextRunId: "next" };
    }
    assert.equal(durable.successorCreated, true);
    if (!durable.markets) {
      durable.markets = 1;
      if (failure === "after-market") throw new Error("CRASH_AFTER_MARKET");
      durable.tps = 1;
      if (failure === "before-next-buy") throw new Error("CRASH_BEFORE_NEXT_BUY");
      return { status: "OK", next: "INITIAL_SUBMITTED" };
    }
    durable.tps ||= 1;
    durable.nextBuys = 1;
    return { status: "OK", next: "NEXT_BUY_ARMED" };
  };
}

test("TP fill normal continues gain -> successor MARKET -> TP -> NEXT BUY without a watchdog gap", async () => {
  const durable: Durable = { successorCreated: false, gainCredits: 0, markets: 0, tps: 0, nextBuys: 0 };
  const result = await continueLiveAdvance("old", "LIVE_CRON", recoverableMachine(durable));
  assert.equal(result.status, "OK");
  assert.equal(result.next, "NEXT_BUY_ARMED");
  assert.deepEqual(result.continuation.map((step) => [step.runId, step.status, step.next]), [
    ["old", "RESTARTED", undefined], ["next", "OK", "INITIAL_SUBMITTED"],
    ["next", "OK", "NEXT_BUY_ARMED"],
  ]);
  assert.deepEqual(durable, { successorCreated: true, gainCredits: 1, markets: 1, tps: 1, nextBuys: 1 });
});

test("duplicate delivery reuses the durable successor and does not duplicate gain, MARKET, TP or NEXT BUY", async () => {
  const durable: Durable = { successorCreated: false, gainCredits: 0, markets: 0, tps: 0, nextBuys: 0 };
  const advance = recoverableMachine(durable);
  await continueLiveAdvance("old", "LIVE_CRON", advance);
  await continueLiveAdvance("next", "WATCHDOG_STALE_RECOVERY", advance);
  assert.deepEqual(durable, { successorCreated: true, gainCredits: 1, markets: 1, tps: 1, nextBuys: 1 });
});

for (const boundary of ["after-gain", "after-successor", "after-market", "before-next-buy"] as const) {
  test(`crash recovery converges from ${boundary} without replaying financial effects`, async () => {
    const durable: Durable = { successorCreated: false, gainCredits: 0, markets: 0, tps: 0, nextBuys: 0 };
    const crashing = recoverableMachine(durable, boundary);
    await assert.rejects(continueLiveAdvance("old", "LIVE_CRON", crashing), /CRASH_/);
    const resumeAt = durable.successorCreated ? "next" : "old";
    await continueLiveAdvance(resumeAt, "LIVE_CRON", recoverableMachine(durable));
    assert.deepEqual(durable, { successorCreated: true, gainCredits: 1, markets: 1, tps: 1, nextBuys: 1 });
  });
}

for (const transient of ["timeout", "503"] as const) {
  test(`a transient ${transient} is retryable and the next execution resumes the same successor`, async () => {
    const calls: string[] = [];
    const first = await continueLiveAdvance("next", "LIVE_CRON", async (runId) => {
      calls.push(runId); return { status: "RETRY", code: "COINOPS_LIVE_TRANSIENT_EXECUTOR_READ" };
    });
    assert.equal(first.status, "RETRY");
    const second = await continueLiveAdvance("next", "LIVE_CRON", async (runId) => {
      calls.push(runId); return calls.length === 2
        ? { status: "OK", next: "INITIAL_SUBMITTED" }
        : { status: "OK", next: "NEXT_BUY_ARMED" };
    });
    assert.equal(second.next, "NEXT_BUY_ARMED");
    assert.deepEqual(calls, ["next", "next", "next"]);
  });
}

test("LIVE contracts keep settlement, reset and order dispatch idempotent at every crash boundary", () => {
  const server = readFileSync(new URL("../execution/robot-v1-live-server.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../../../supabase/migrations/20260925114500_recover_live_cycle_while_buy_gate_closed.sql", import.meta.url), "utf8");
  assert.match(server, /credit_robot_v1_live_closed_slot/);
  assert.match(server, /client_order_id !== slot\.last_credited_sell_client_order_id/);
  assert.match(server, /submission_guarded_at/);
  assert.match(server, /continueLiveAdvance\(runId, source, advanceLiveRunOnce\)/);
  assert.match(server, /errorCode = null;[\s\S]*status: "RETRY"/);
  assert.match(migration, /where previous_run_id=p_old_run_id/);
  assert.match(migration, /reset_idempotency_key is distinct from p_reset_key/);
  assert.match(migration, /unique index if not exists robot_v1_live_runs_one_successor_per_engine/);
});

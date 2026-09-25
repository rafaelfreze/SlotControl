import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { liveClientOrderId } from "./robot-v1-live-cycle.ts";
import { planStrategyClosedSlot, planStrategyInitialEntry, type StrategyCandidate } from "./strategy-engine.ts";

const oldCycle = "11111111-2222-4333-8444-555555555555";
const nextCycle = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const context = (cycleId: string) => ({ asset: "SOL" as const, quoteAsset: "BRL",
  cycleId, observedAt: "2026-09-25T11:00:00.000Z" });
const slots = (goal: number, count: number): StrategyCandidate[] => Array.from({ length: 25 }, (_, index) => ({
  id: `slot-${index + 1}`, slotNumber: index + 1, operationSequence: 1,
  buyPrice: 600 - index * 6, balanceQuote: 11, operationalRank: index + 1,
  monthlyTargetReached: index === 0 && count >= goal,
  state: index === 0 ? "CLOSED" : "PLANNED",
}));

for (const target of [1, 2, 7]) {
  test(`LIVE final gain ${target}/${target} closes the old cycle and begins a distinct MARKET identity`, () => {
    const candidates = slots(target, target);
    const rollover = planStrategyClosedSlot(context(oldCycle), candidates, "slot-1");
    assert.equal(rollover.mode, "GLOBAL_RESET");
    assert.deepEqual(rollover.decisions.map((item) => item.action_type), ["COMPLETE_CYCLE", "REANCHOR"]);
    assert.equal(rollover.decisions[1]?.target_notional, 275);
    const newSlot = { ...candidates[1]!, operationalRank: 1 };
    const market = planStrategyInitialEntry(context(nextCycle), newSlot);
    assert.equal(market.action_type, "OPEN_INITIAL_MARKET");
    assert.notEqual(market.decision_id, rollover.decisions[1]?.decision_id);
    assert.notEqual(liveClientOrderId(oldCycle, "SOL", 2, 1, "BUY", 1),
      liveClientOrderId(nextCycle, "SOL", 2, 1, "BUY", 1));
  });
}

test("LIVE reset stays on monthly hold when all slots reached their configurable target", () => {
  const candidates = slots(2, 2).map((slot) => ({ ...slot, monthlyTargetReached: true,
    operationalRank: null }));
  const result = planStrategyClosedSlot(context(oldCycle), candidates, "slot-1");
  assert.equal(result.mode, "MONTHLY_HOLD");
  assert.equal(result.decisions[0]?.reason, "ALL_MONTHLY_TARGETS_REACHED");
});

test("LIVE ledger reset migration permits fail-closed recovery but still rejects positions and unverified fills", () => {
  const migration = readFileSync(new URL("../../../../supabase/migrations/20260925114500_recover_live_cycle_while_buy_gate_closed.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /or v_old\.last_error is not null\s+or p_lease_owner/);
  assert.doesNotMatch(migration, /or v_config\.kill_switch\s+or p_reset_key/);
  assert.match(migration, /where run_id=v_old\.id and position_quantity>0/);
  assert.match(migration, /where run_id=v_old\.id and status in \('PREPARED','NEW','PARTIALLY_FILLED'\)/);
  assert.match(migration, /where run_id=v_old\.id and executed_quantity>0 and not trades_reconciled/);
  assert.match(migration, /where previous_run_id=p_old_run_id/);
  assert.match(migration, /reset_idempotency_key is distinct from p_reset_key/);
  assert.match(migration, /unique index if not exists robot_v1_live_runs_one_successor_per_engine/);
});

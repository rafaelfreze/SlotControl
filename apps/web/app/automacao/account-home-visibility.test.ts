import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { homeVisibleEngines, safeHiddenAccountIds, type AccountHomePreference } from "./account-home-visibility.ts";
import type { PremiumEngine } from "./premium-operator";

const preference: AccountHomePreference = { accountId: "A", hidden: true, updatedAt: "2026-10-13T12:00:00Z" };
const paused = (engineId = "A-SOL", changes: Partial<PremiumEngine> = {}): PremiumEngine => ({
  engineId, accountId: "A", environment: "REAL", symbol: "SOLBRL", engineStatus: "ACTIVE",
  status: "PAUSED", cycleId: "run-A", killSwitch: true, entryPauseProtected: true, ...changes,
} as PremiumEngine);

test("only persisted intentional pause with complete canonical protection can hide the account", () => {
  assert.deepEqual([...safeHiddenAccountIds([paused()], [preference])], ["A"]);
  assert.equal(safeHiddenAccountIds([paused()], [{ ...preference, hidden: false }]).size, 0);
  assert.equal(safeHiddenAccountIds([paused()], []).size, 0);
  assert.equal(safeHiddenAccountIds([], [preference]).size, 0);
  for (const changes of [{ entryPauseProtected: false }, { entryPauseProtected: undefined }, { status: "ACTIVE" },
    { status: "PREPARING" }, { status: "FAILED" }, { engineStatus: "BLOCKED" }, { killSwitch: false }])
    assert.equal(safeHiddenAccountIds([paused("A-SOL", changes)], [preference]).size, 0);
});

test("multiple same-symbol engines across shards must all prove paused protection", () => {
  const a = paused("A-SOL-01", { executorShardId: "executor-02" });
  const b = paused("A-SOL-02", { executorShardId: "executor-03" });
  assert.equal(safeHiddenAccountIds([a, b], [preference]).has("A"), true);
  assert.equal(safeHiddenAccountIds([a, { ...b, entryPauseProtected: false }], [preference]).size, 0);
  // An ACTIVE registry engine without a run is not an assumed safe pause.
  assert.equal(safeHiddenAccountIds([a, { ...b, cycleId: null, status: "INACTIVE" }], [preference]).size, 0);
});

test("ALL home projects hidden paused REAL engines only; direct selection, siblings, historical modes remain", () => {
  const rows = [paused(), paused("A-Shadow", { environment: "SHADOW" }), paused("B-SOL", { accountId: "B" })];
  const hidden = safeHiddenAccountIds(rows, [preference]);
  assert.deepEqual(homeVisibleEngines(rows, { accountId: "ALL", symbol: "ALL" }, hidden).map((row) => row.engineId),
    ["A-Shadow", "B-SOL"]);
  assert.equal(homeVisibleEngines(rows, { accountId: "A", symbol: "ALL" }, hidden), rows);
  const fault = { ...rows[0], entryPauseProtected: false };
  assert.equal(homeVisibleEngines([fault, ...rows.slice(1)], { accountId: "ALL", symbol: "ALL" },
    safeHiddenAccountIds([fault, ...rows.slice(1)], [preference])).length, 3);
});

test("presentation hiding preserves full synchronization and selector inventories", () => {
  const source = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
  assert.match(source, /useAutomationLiveSync\(view, engines, selection/);
  assert.match(source, /accountOptions\(accounts, engines\.filter/);
  assert.match(source, /selectPremiumEngines\(renderedEngines, environment, selection\)/);
  const panel = readFileSync(new URL("./account-pause-home-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /localStorage|setInterval|resumeLiveRun|createOrder|cancelOrder/);
  assert.match(panel, /fetch\("\/api\/coinops-engine-control"/);
  assert.match(panel, /action: "RESUME", accountId: selectedAccountId, engineId: engine\.engineId/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /for \(let index = 0; index < current\.length; index\+\+\)/);
  assert.match(panel, /await request\(\{ action: "PAUSE_ENGINE"/);
  assert.match(panel, /expectedEngineIds: current\.map/);
  assert.match(panel, /AbortSignal\.timeout\(60_000\)/);
});

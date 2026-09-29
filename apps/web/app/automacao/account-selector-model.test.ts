import assert from "node:assert/strict";
import test from "node:test";
import { accountOptions, searchAccountOptions } from "./account-selector-model.ts";
import type { PremiumAccount, PremiumEngine } from "./premium-operator.ts";

const accounts = (count: number): PremiumAccount[] => Array.from({ length: count }, (_, index) => ({
  id: `safe-${index}`, displayName: `Conta ${String(index).padStart(4, "0")}`,
  status: "ACTIVE", killSwitch: false,
}));
const engine = (accountId: string, changes: Partial<PremiumEngine> = {}): PremiumEngine => ({
  accountId, engineId: `${accountId}:SOLBRL`, symbol: "SOLBRL", engineStatus: "ACTIVE",
  killSwitch: false, health: { healthy: true, tone: "ok", label: "OPERACIONAL", reason: "" },
  activeIssueCount: 0, ...changes,
} as PremiumEngine);

for (const size of [10, 100, 1000]) {
  test(`account selector searches and sorts ${size} accounts without losing matches`, () => {
    const rows = accounts(size);
    const result = accountOptions(rows, rows.map((row) => engine(row.id)));
    assert.equal(result.length, size);
    assert.deepEqual(searchAccountOptions(result, "safe-1").map((row) => row.id).includes("safe-1"), true);
    assert.equal(searchAccountOptions(result, `Conta ${String(size - 1).padStart(4, "0")}`).length, 1);
    assert.equal(searchAccountOptions(result, "solbrl").length, size);
  });
}

test("critical, alert, recovering, operational, inactive; resolved alert returns to normal order", () => {
  const rows = ["Zulu", "Ana", "Bia", "Cida", "Dora"].map((displayName, index) => ({
    id: `a${index}`, displayName, status: index === 4 ? "INACTIVE" : "ACTIVE", killSwitch: index === 0,
  }));
  const engines = [engine("a0"), engine("a1", { activeIssueCount: 1,
    health: { healthy: false, tone: "error", label: "REVISAR LIVE", reason: "active alert" } }),
  engine("a2", { engineStatus: "RECOVERING" }), engine("a3"), engine("a4")];
  assert.deepEqual(accountOptions(rows, engines).map((row) => row.state),
    ["CRITICAL", "ALERT", "RECOVERING", "OPERATIONAL", "INACTIVE"]);
  assert.deepEqual(accountOptions(rows, engines).map((row) => row.displayName),
    ["Zulu", "Ana", "Bia", "Cida", "Dora"]);
  const resolved = accountOptions(rows, engines.map((item) => item.accountId === "a1" ? engine("a1") : item));
  assert.deepEqual(resolved.filter((row) => row.state === "OPERATIONAL").map((row) => row.displayName),
    ["Ana", "Cida"]);
});

test("search is case/accent insensitive and accepts safe identifiers", () => {
  const result = accountOptions([{ id: "public-id-1", displayName: "João", status: "ACTIVE", killSwitch: false }],
    [engine("public-id-1")]);
  assert.equal(searchAccountOptions(result, "JOAO").length, 1);
  assert.equal(searchAccountOptions(result, "PUBLIC-ID-1").length, 1);
});

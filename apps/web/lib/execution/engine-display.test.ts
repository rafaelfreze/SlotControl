import assert from "node:assert/strict";
import test from "node:test";
import { engineDisplayName } from "./engine-display.ts";

test("same-symbol names are stable across visual sorting and scoped to the account", () => {
  const a = { id: "a", symbol: "SOLBRL", exchange_account_id: "account", created_at: "2026-10-01T00:00:00Z" };
  const b = { ...a, id: "b", created_at: "2026-10-02T00:00:00Z" };
  const other = { ...a, id: "0", exchange_account_id: "other" };
  for (const rows of [[b, a, other], [other, a, b]]) {
    assert.equal(engineDisplayName(a, rows), "SOLBRL · Motor 1");
    assert.equal(engineDisplayName(b, rows), "SOLBRL · Motor 2");
    assert.equal(engineDisplayName(other, rows), "SOLBRL");
  }
  assert.equal(engineDisplayName(b, []), "SOLBRL");
  assert.equal(engineDisplayName(b, [a]), "SOLBRL · Motor 2");
});

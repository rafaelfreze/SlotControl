import assert from "node:assert/strict";
import test from "node:test";
import { reportExportSelectionReason } from "./export-selection.ts";

test("a concrete engine only enables exports in its selected environment", () => {
  for (const environment of ["REAL", "SHADOW", "TESTNET"] as const) {
    const selection = Object.freeze({ account: "account-A", engine: "engine-A", environment });
    assert.equal(reportExportSelectionReason(selection, environment), null);
    for (const target of ["REAL", "SHADOW", "TESTNET"] as const) {
      if (target !== environment) assert.match(reportExportSelectionReason(selection, target)!, /escolha explicitamente/);
    }
  }
});

test("all-engines exports stay available without choosing another account or engine", () => {
  for (const account of ["ALL", "account-A"]) for (const target of ["ALL", "REAL", "SHADOW", "TESTNET"] as const) {
    assert.equal(reportExportSelectionReason({ account, engine: "ALL", environment: "ALL" }, target), null);
  }
});

test("incomplete concrete scope fails closed instead of inferring a replacement", () => {
  assert.ok(reportExportSelectionReason({ account: "ALL", engine: "engine-A", environment: "REAL" }, "REAL"));
  assert.ok(reportExportSelectionReason({ account: "account-A", engine: "engine-A", environment: "ALL" }, "REAL"));
});

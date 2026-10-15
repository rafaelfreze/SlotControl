import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./push.ts", import.meta.url), "utf8");

test("informational asset/Binance transitions and recoveries never send automatic pushes", async () => {
  const loadedModule = { exports: {} as { dispatchAssetHealthPush: () => Promise<{ status: string; sent: number; failed: number }> } };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const accessed: string[] = [];
  new Function("require", "module", "exports", compiled)((name: string) => {
    accessed.push(name);
    if (name === "server-only") return {};
    throw new Error(`Informational push must not access ${name}`);
  }, loadedModule, loadedModule.exports);
  for (const state of ["HEALTHY", "ATTENTION", "STRUCTURAL_RISK", "CRITICAL_RISK", "INSUFFICIENT_DATA"]) {
    assert.deepEqual(await loadedModule.exports.dispatchAssetHealthPush(), { status: "PANEL_ONLY", sent: 0, failed: 0 }, state);
  }
  assert.deepEqual(accessed, ["server-only"]);
});

test("collector and its persisted events remain separate from notification delivery", () => {
  const route = readFileSync(new URL("../../app/api/cron/coinops-asset-health/route.ts", import.meta.url), "utf8");
  assert.match(route, /syncAssetHealth\(/);
  assert.match(route, /dispatchAssetHealthPush\(\)/);
  assert.doesNotMatch(source, /\.from\(|sendToDevice|resolveIncident|cancelOrder/);
});

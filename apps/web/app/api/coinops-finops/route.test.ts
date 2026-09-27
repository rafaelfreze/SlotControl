import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript") as typeof import("typescript");
const next = localRequire("next/server") as typeof import("next/server");

function route(authError?: string) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const scope = { operatorId: "server-operator", tenantId: "server-tenant", userId: "server-admin" };
  const server = {
    requireFinopsAdmin: async () => { if (authError) throw new Error(authError); return scope; },
    loadFinopsDashboard: async (...args: unknown[]) => { calls.push({ name: "read", args }); return { capturedAt: null }; },
    saveFinopsManualService: async (...args: unknown[]) => { calls.push({ name: "manual", args }); return { ok: true }; },
    syncFinops: async (...args: unknown[]) => { calls.push({ name: "sync", args }); return { status: "FRESH", nextSyncAt: "2026-09-27T06:00:00Z" }; },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as { GET: () => Promise<Response>; POST: (request: import("next/server").NextRequest) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((name: string) => name === "next/server" ? next : server, mod, mod.exports);
  return { ...mod.exports, calls, scope };
}
const request = (body: Record<string, unknown>, origin = "https://coinops.test") => new next.NextRequest("https://coinops.test/api/coinops-finops", {
  method: "POST", headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body),
});

test("page API reads only persisted data; billing sync is explicit", async () => {
  const api = route();
  assert.equal((await api.GET()).status, 200);
  assert.deepEqual(api.calls.map((call) => call.name), ["read"]);
});
test("manual ADMIN sync uses server ownership and cannot forward a cooldown bypass", async () => {
  const api = route();
  const response = await api.POST(request({ action: "SYNC", force: true, refreshExternal: true,
    trigger: "SCHEDULED", operatorId: "attacker" }));
  assert.equal(response.status, 200);
  assert.deepEqual(api.calls, [{ name: "sync", args: [api.scope] }]);
  assert.deepEqual(await response.json(), { status: "FRESH", nextSyncAt: "2026-09-27T06:00:00Z" });
});
test("anonymous and VIEWER rejection happens before any FinOps read or sync", async () => {
  for (const [error, status] of [["AUTH_REQUIRED", 401], ["ADMIN_REQUIRED", 403]] as const) {
    const api = route(error);
    assert.equal((await api.GET()).status, status);
    assert.equal((await api.POST(request({ action: "SYNC" }))).status, status);
    assert.deepEqual(api.calls, []);
  }
});
test("cross-origin sync and unsupported actions cannot dispatch the worker", async () => {
  const api = route();
  assert.equal((await api.POST(request({ action: "SYNC" }, "https://other.test"))).status, 403);
  assert.equal((await api.POST(request({ action: "FORCE_SYNC" }))).status, 400);
  assert.deepEqual(api.calls, []);
});
test("manual service configuration keeps its existing authenticated path", async () => {
  const api = route(), input = { serviceId: "service", recurringMonthly: 6, currency: "USD" };
  assert.equal((await api.POST(request(input))).status, 200);
  assert.deepEqual(api.calls, [{ name: "manual", args: [api.scope, input] }]);
});

test("manual provider period and fractional allocation reach validation unchanged", async () => {
  const api = route(), input = { serviceId: "service", recurringMonthly: 20, currency: "USD",
    allocationPercent: 35.2243, billingPeriodStart: "2026-09-14T00:00:00.000Z", billingPeriodEnd: "2026-10-14T00:00:00.000Z" };
  assert.equal((await api.POST(request(input))).status, 200);
  assert.deepEqual(api.calls, [{ name: "manual", args: [api.scope, input] }]);
});

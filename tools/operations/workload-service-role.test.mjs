import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
const ts = createRequire(new URL("../../apps/web/package.json", import.meta.url))("typescript");
const path = new URL("../../apps/web/lib/supabase/service-role.ts", import.meta.url);
const js = ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const fingerprint = "a".repeat(64);
function load(schema = "coinops", tenant = "fixture-tenant") {
  const requests = [], exports = {}, fetch = (...args) => { requests.push(args); return Promise.resolve({ ok: true }); };
  const context = { exports, AbortSignal, process: { env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-key"
  } }, require(name) {
    if (name === "@supabase/supabase-js") return { createClient: (...args) => args };
    if (name === "./env") return { getSupabaseDataSchema: () => schema, getCoinOpsServiceTenantId: () => tenant };
    if (name === "./no-store-fetch") return { fetchOperationalData: fetch };
    if (name === "./workload-fingerprint.generated") return { WORKLOAD_CODE_SHA256: fingerprint };
    throw new Error("Unexpected import");
  } };
  vm.runInNewContext(js, context); return { client: exports.createServiceRoleClient, requests, fetch };
}
test("server-owned fingerprint and tenant headers are applied only to CoinOps, without caller override", () => {
  const fixture = load(), [, , config] = fixture.client();
  assert.equal(config.global.headers["x-coinops-workload-sha256"], fingerprint);
  assert.equal(config.global.headers["x-coinops-tenant-id"], "fixture-tenant");
  assert.equal(config.global.fetch, fixture.fetch);
  assert.equal(config.auth.autoRefreshToken, false); assert.equal(config.auth.persistSession, false);
  assert.equal(load("other").client()[2].global.headers, undefined);
  assert.equal(load("coinops", null).client()[2].global.headers["x-coinops-tenant-id"], undefined);
});
test("existing request timeout and supplied abort signal remain combined", async () => {
  const fixture = load(), config = fixture.client(500)[2], controller = new AbortController();
  await config.global.fetch("https://fixture.invalid", { signal: controller.signal, method: "GET" });
  const signal = fixture.requests[0][1].signal;
  assert.notEqual(signal, controller.signal); assert.equal(signal.aborted, false);
  controller.abort(); assert.equal(signal.aborted, true);
});

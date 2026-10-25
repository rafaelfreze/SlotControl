import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function request(user: string | null = "owner", authorized = true) {
  const filters: Array<[string, string, unknown]> = [];
  const shards = ["executor-01", "executor-02", "executor-03"].map((id, index) => ({
    id, enabled: index !== 2, egress_ipv4: `192.0.2.${index + 1}`,
    binance_limit_per_min: 6000, admission_ratio: .65, incremental_engine_weight: 900,
  }));
  const alerts = ["executor-02", "executor-03"].map(shard_id => ({
    shard_id, code: "EXECUTOR_OFFLINE", severity: "CRITICAL", first_seen_at: "2026-10-25T22:00:00Z",
  }));
  let serviceReads = 0;
  const service = { from(table: string) {
    serviceReads++;
    const chain = { select: () => chain, order: () => chain, is: () => chain, gt: () => chain,
      eq: (key: string, value: unknown) => { filters.push([table, key, value]); return chain; },
      then: (fn: (result: unknown) => unknown) => Promise.resolve({ error: null,
        // Deliberately return the archived row too: response must still exclude it.
        data: table === "executor_shards" ? shards : table === "executor_capacity_alerts" ? alerts : [],
      }).then(fn) };
    return chain;
  }, rpc: async () => ({ error: null, data: shards.map(shard => ({ shard_id: shard.id })) }) };
  const authChain = { select: () => authChain, eq: () => authChain,
    maybeSingle: async () => ({ data: authorized ? { id: "operator" } : null, error: null }) };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (value: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(value), init) } },
    "@/lib/coinops-capacity/capacity-server": { capacityScope: () => service, asShardMetrics: (v: unknown) => v },
    "@/lib/coinops-capacity/admission-reservations": { shardReservedWeight: () => 0 },
    "@/lib/coinops-capacity/capacity-manager": { DEFAULT_CAPACITY_POLICY: {},
      assessShardCapacity: () => ({ state: "OFFLINE", action: "INVESTIGATE", binancePercent: null }) },
    "@/lib/coinops-capacity/capacity-warning-mute": { capacityWarningMuted: () => false },
    "@/lib/coinops-capacity/admission-explanation": { withAdmissionTelemetry: (v: unknown) => v },
    "@/lib/supabase/env": { getCoinOpsServiceTenantId: () => "tenant", getSupabaseDataSchema: () => "coinops" },
    "@/lib/supabase/server": { createClient: () => ({ auth: { getUser: async () => ({ data: { user: user && { id: user } } }) },
      from: () => authChain }) },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, loaded);
  const response = await (loaded.GET as () => Promise<Response>)();
  return { response, body: await response.json(), filters, serviceReads };
}

test("operational capacity excludes retired shards without deleting their historical rows or alerts", async () => {
  const result = await request();
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.shards.map((s: { id: string }) => s.id), ["executor-01", "executor-02"]);
  assert.ok(result.filters.some(([table, key, value]) => table === "executor_shards" && key === "enabled" && value === true));
  const offline = result.body.shards.find((s: { id: string }) => s.id === "executor-02");
  assert.equal(offline.state, "OFFLINE");
  assert.deepEqual(offline.alerts.map((a: { code: string }) => a.code), ["EXECUTOR_OFFLINE"]);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
});

test("anonymous and non-admin requests cannot enumerate the operational fleet", async () => {
  for (const [user, authorized, status] of [[null, true, 401], ["other", false, 403]] as const) {
    const result = await request(user, authorized);
    assert.equal(result.response.status, status); assert.equal(result.serviceReads, 0);
  }
});

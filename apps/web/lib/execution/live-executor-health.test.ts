import assert from "node:assert/strict";
import test from "node:test";
import { loadLiveExecutorStatus } from "./live-executor-health.ts";
import { resolveExecutorShard } from "./executor-shards-server.ts";

const ip = "46.101.104.48";
const healthy = { healthy: true, version: "test", region: "FRA1", environment: "BINANCE_PRODUCTION_PREPARED",
  clock: "2026-09-24T00:00:00Z", clock_drift_ms: 100, binance_connectivity: "OK",
  account_permission: "SPOT_RESTRICTED", egress_ipv4: ip, egress_ipv4_verified: true,
  trading_enabled: false, kill_switch: true, latency_ms: 10 };
const rollingEnvironment = {
  COINOPS_EXECUTOR_01_NEXT_VALIDATED_VERSION: "release-new",
  COINOPS_EXECUTOR_01_VERSION_TRANSITION_START: "2026-09-28T04:00:00.000Z",
  COINOPS_EXECUTOR_01_VERSION_TRANSITION_UNTIL: "2026-09-28T05:00:00.000Z",
};
async function withVersionEnvironment<T>(values: Record<string, string | undefined>, read: () => Promise<T>): Promise<T> {
  const keys = new Set([...Object.keys(rollingEnvironment), ...Object.keys(values)]);
  const previous = Object.fromEntries([...keys].map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  }
  try { return await read(); }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
}

test("executor gate requires HTTPS, restricted Spot key, expected egress and both write blockers", async () => {
  const fetcher = async () => new Response(JSON.stringify(healthy), { status: 200 });
  assert.equal((await loadLiveExecutorStatus(`https://${ip}`, ip, fetcher as typeof fetch, "test")).gate,
    "LIVE_EXECUTOR_READY");
  assert.equal((await loadLiveExecutorStatus(`https://${ip}`, ip, fetcher as typeof fetch)).gate,
    "ATTENTION");
  assert.equal((await loadLiveExecutorStatus(`http://${ip}`, ip, fetcher as typeof fetch)).gate,
    "UNCONFIGURED");
  for (const [patch, gate] of [[{ trading_enabled: true }, "LIVE_EXECUTOR_PROTECTED"],
    [{ trading_enabled: true, kill_switch: false }, "LIVE_EXECUTOR_ACTIVE"],
    [{ kill_switch: false }, "ATTENTION"],
    [{ account_permission: "READ_ONLY" }, "ATTENTION"], [{ account_permission: "UNVERIFIED" }, "ATTENTION"],
    [{ egress_ipv4: "1.2.3.4" }, "ATTENTION"], [{ clock_drift_ms: 3000 }, "ATTENTION"]] as const) {
    const unsafe = async () => new Response(JSON.stringify({ ...healthy, ...patch }), { status: 200 });
    assert.equal((await loadLiveExecutorStatus(`https://${ip}`, ip, unsafe as typeof fetch, "test")).gate, gate);
  }
});

test("rolling health accepts only exact previous/new releases while all other gates remain mandatory", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-28T04:30:00Z"));
  const read = async (version: string, versions = "release-old", patch = {}, rolling = true) =>
    withVersionEnvironment(rolling ? rollingEnvironment : {}, () => loadLiveExecutorStatus(`https://${ip}`, ip,
      (async () => Response.json({ ...healthy, version, trading_enabled: true,
        kill_switch: false, ...patch })) as typeof fetch, versions));
  for (const version of ["release-old", "release-new"])
    assert.equal((await read(version)).gate, "LIVE_EXECUTOR_ACTIVE");
  for (const version of ["release", "release-ol", "release-old-extra", "Release-old", "release-old,release-new", "", "*"])
    assert.equal((await read(version)).gate, "ATTENTION");
  for (const versions of ["release-old,release-new,third", "release-old,", "release-old,,release-new",
    "release-old, release-new", "release-old\n", "release-old,*", "release-old,release-old"])
    assert.equal((await read("release-old", versions)).gate, "ATTENTION");
  for (const patch of [{ healthy: false }, { account_permission: "READ_ONLY" },
    { egress_ipv4: "203.0.113.55" }, { clock_drift_ms: 3000 }, { binance_connectivity: "UNAVAILABLE" }])
    assert.equal((await read("release-new", undefined, patch)).gate, "ATTENTION");
  assert.equal((await read("release-new", "release-new", {}, false)).gate, "LIVE_EXECUTOR_ACTIVE");
  assert.equal((await read("release-old", "release-new", {}, false)).gate, "ATTENTION");
  assert.equal((await read("release-old", "release-old,release-new", {}, false)).gate, "ATTENTION");
});

test("legacy banner shares the request-time window and closes old release at the exact cutoff without restart", async (t) => {
  let clock = Date.parse(rollingEnvironment.COINOPS_EXECUTOR_01_VERSION_TRANSITION_START) - 1;
  t.mock.method(Date, "now", () => clock);
  await withVersionEnvironment({ ...rollingEnvironment, LIVE_EXECUTOR_VALIDATED_VERSION: "release-old" }, async () => {
    const read = (actual: string) => loadLiveExecutorStatus(`https://${ip}`, ip,
      (async () => Response.json({ ...healthy, version: "legacy-compatibility-contract",
        actual_executor_version: actual })) as typeof fetch);
    assert.equal((await read("release-old")).gate, "LIVE_EXECUTOR_READY");
    assert.equal((await read("release-new")).gate, "ATTENTION");
    clock++;
    assert.equal((await read("release-new")).gate, "LIVE_EXECUTOR_READY");
    assert.equal((await read("release-old")).gate, "LIVE_EXECUTOR_READY");
    clock = Date.parse(rollingEnvironment.COINOPS_EXECUTOR_01_VERSION_TRANSITION_UNTIL);
    assert.equal((await read("release-old")).gate, "ATTENTION");
    assert.equal((await read("release-new")).gate, "LIVE_EXECUTOR_READY");
    assert.equal((await read("legacy-compatibility-contract")).gate, "ATTENTION");
  });
});

test("reported actual release cannot be bypassed by a matching legacy alias or malformed transition", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-28T04:30:00Z"));
  const read = (patch: Record<string, unknown>) => loadLiveExecutorStatus(`https://${ip}`, ip,
    (async () => Response.json({ ...healthy, version: "release-old", ...patch })) as typeof fetch, "release-old");
  await withVersionEnvironment(rollingEnvironment, async () => {
    assert.equal((await read({})).gate, "LIVE_EXECUTOR_READY", "old server without actual version retains exact fallback");
    for (const actual of [null, "", "unreviewed", "release-new-other", "release-old,release-new"])
      assert.equal((await read({ actual_executor_version: actual })).gate, "ATTENTION");
    assert.equal((await read({ actual_executor_version: "release-new" })).gate, "LIVE_EXECUTOR_READY");
  });
  await withVersionEnvironment({ ...rollingEnvironment, COINOPS_EXECUTOR_01_VERSION_TRANSITION_UNTIL: "" }, async () => {
    assert.equal((await read({ actual_executor_version: "release-old" })).gate, "ATTENTION");
  });
});

test("authenticated shard health accepts both exact rolling releases but never conflicting reported versions", async () => {
  const engine = { operator_id: "fixture-operator", exchange_account_id: "fixture-account",
    trading_engine_id: "fixture-engine", symbol: "SOLUSDT", quote_asset: "USDT" };
  const secondIp = "203.0.113.22";
  const env = { COINOPS_EXECUTOR_SHARDS_JSON: JSON.stringify({ "executor-02": {
    egressIp: secondIp, baseUrl: `https://${secondIp}`, hmacSecret: "fixture-secret-for-shard-health".repeat(2),
    validatedVersion: "old-shard02" } }), COINOPS_EXECUTOR_02_NEXT_VALIDATED_VERSION: "new-shard02",
    COINOPS_EXECUTOR_02_VERSION_TRANSITION_START: "2026-09-28T10:00:00Z",
    COINOPS_EXECUTOR_02_VERSION_TRANSITION_UNTIL: "2026-09-28T10:22:39Z" };
  let clock = Date.parse("2026-09-28T10:06:18Z");
  const resolver = async () => resolveExecutorShard("executor-02", env, clock);
  const read = (version: string, actualVersion = version) => loadLiveExecutorStatus(undefined, undefined,
    (async () => Response.json({ ...engine, ...healthy, executor_shard_id: "executor-02",
      version, actual_executor_version: actualVersion, environment: "REAL", egress_ipv4: secondIp,
      trading_enabled: true, kill_switch: false })) as typeof fetch, undefined, engine, resolver);
  assert.equal((await read("old-shard02")).gate, "LIVE_EXECUTOR_ACTIVE");
  assert.equal((await read("new-shard02")).gate, "LIVE_EXECUTOR_ACTIVE");
  assert.equal((await read("unreviewed", "new-shard02")).gate, "ATTENTION");
  assert.equal((await read("new-shard02", "unreviewed")).gate, "ATTENTION");
  clock = Date.parse(env.COINOPS_EXECUTOR_02_VERSION_TRANSITION_UNTIL);
  assert.equal((await read("old-shard02")).gate, "ATTENTION");
  assert.equal((await read("new-shard02")).gate, "LIVE_EXECUTOR_ACTIVE");
});

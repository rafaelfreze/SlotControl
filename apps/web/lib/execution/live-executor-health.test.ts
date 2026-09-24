import assert from "node:assert/strict";
import test from "node:test";
import { loadLiveExecutorStatus } from "./live-executor-health.ts";

const ip = "46.101.104.48";
const healthy = { healthy: true, version: "test", region: "FRA1", environment: "BINANCE_PRODUCTION_PREPARED",
  clock: "2026-09-24T00:00:00Z", clock_drift_ms: 100, binance_connectivity: "OK",
  account_permission: "SPOT_RESTRICTED", egress_ipv4: ip, egress_ipv4_verified: true,
  trading_enabled: false, kill_switch: true, latency_ms: 10 };

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

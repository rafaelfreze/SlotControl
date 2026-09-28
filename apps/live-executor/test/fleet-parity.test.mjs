import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTarget, discoverEnabledShards, discoverRuntimeFiles, evaluateFleetParity,
  probeScript, readGitRuntimeManifest, readManifest, runtimeFingerprint, validateManifest, verifyFleet } from "../deploy/fleet-parity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = readManifest();
const now = Date.parse("2026-09-28T13:30:00.000Z");
const registry = [
  { id: "executor-01", egress_ipv4: "203.0.113.11", enabled: true },
  { id: "executor-02", egress_ipv4: "203.0.113.22/32", enabled: true },
];
function evidenceFor(shard) {
  const ip = shard.egress_ipv4.replace(/\/32$/, "");
  return { shard_id: shard.id, ip, observed_at: new Date(now).toISOString(), probe_contract_version: 1,
    node_version: manifest.node_version, runtime_sha256: manifest.runtime_sha256,
    process_identity_verified: true, code_loaded_evidence: "DISK_UNCHANGED_SINCE_PROCESS_START",
    service: { active_state: "active", sub_state: "running", pid: shard.id.endsWith("01") ? 501 : 902,
      user: shard.id.endsWith("01") ? "coinops-legacy" : "coinops-executor", uid: 997,
      protect_system: "strict", no_new_privileges: "yes", private_tmp: "yes" },
    health: { healthy: true, actual_executor_version: manifest.target_sha, executor_shard_id: shard.id,
      egress_ipv4: ip, egress_ipv4_verified: true, clock: new Date(now - 20000).toISOString() } };
}
const fresh = () => registry.map(evidenceFor);
const verdict = (rows = fresh(), discovered = registry) => evaluateFleetParity(manifest, discovered, rows, now);

test("manifest pins reviewed target and local precheck never accepts another main SHA", () => {
  assert.equal(checkTarget(manifest, manifest.target_sha).status, "FLEET_TARGET_PASS");
  for (const sha of ["a".repeat(40), "main", "", undefined, `${manifest.target_sha}; restart`])
    assert.throws(() => checkTarget(manifest, sha), /FLEET_TARGET_MISMATCH/);
  for (const changed of [{ contract_version: 2 }, { runtime_sha256: "label" }, { runtime_entry: "../../.env" },
    { node_version: "v24" }, { max_evidence_age_ms: 99999999 }])
    assert.throws(() => validateManifest({ ...manifest, ...changed }), /FLEET_MANIFEST_INVALID/);
});

test("different correct identities, service names, PIDs and IPs retain runtime parity", () => {
  const result = verdict();
  assert.equal(result.status, "FLEET_PARITY_PASS"); assert.equal(result.verified, 2); assert.equal(result.total, 2);
});

test("one stale release and all equally old releases fail against the common target", () => {
  for (const indices of [[1], [0, 1]]) {
    const rows = fresh();
    for (const index of indices) rows[index].health.actual_executor_version = "a".repeat(40);
    const result = verdict(rows);
    assert.equal(result.status, "FLEET_PARITY_NOT_CONFIRMED");
    for (const index of indices) assert.ok(result.shards[index].reasons.includes("RELEASE_MISMATCH"));
  }
});

test("same declared SHA with different code or Node fails; legacy alias is not release evidence", () => {
  for (const patch of [{ runtime_sha256: "b".repeat(64) }, { node_version: "v24.16.0" }]) {
    const rows = fresh(); Object.assign(rows[1], patch);
    assert.equal(verdict(rows).shards[1].status, "FAIL");
  }
  const rows = fresh(); rows[1].health.version = manifest.target_sha; delete rows[1].health.actual_executor_version;
  assert.ok(verdict(rows).shards[1].reasons.includes("RELEASE_MISMATCH"));
});

test("stale or missing health/evidence cannot pass, including future timestamps", () => {
  for (const field of ["observed_at", "clock"]) for (const delta of [-120001, 30001]) {
    const rows = fresh();
    if (field === "clock") rows[1].health.clock = new Date(now + delta).toISOString();
    else rows[1].observed_at = new Date(now + delta).toISOString();
    assert.equal(verdict(rows).shards[1].status, "UNKNOWN");
  }
  assert.equal(verdict(fresh().slice(0, 1)).shards[1].status, "UNKNOWN");
  assert.equal(verdict([{ shard_id: "executor-01", error: "FLEET_SSH_PROBE_FAILED" }, fresh()[1]])
    .shards[0].status, "UNKNOWN");
  assert.equal(verdict([...fresh(), fresh()[1]]).shards[1].status, "UNKNOWN");
});

test("a future third enabled shard is required without hardcoded inventory", () => {
  const third = { id: "executor-03", egress_ipv4: "203.0.113.33", enabled: true };
  assert.equal(verdict(fresh(), [...registry, third]).status, "FLEET_PARITY_NOT_CONFIRMED");
  const result = verdict([...fresh(), evidenceFor(third)], [...registry, third]);
  assert.equal(result.status, "FLEET_PARITY_PASS"); assert.equal(result.total, 3);
  assert.equal(verdict(fresh(), [...registry, { ...third, enabled: false }]).total, 2);
});

test("registry and evidence reject identity collisions instead of checking the wrong executor", () => {
  for (const discovered of [[], [...registry, registry[1]],
    [registry[0], { ...registry[1], egress_ipv4: registry[0].egress_ipv4 }]])
    assert.throws(() => verdict(fresh(), discovered), /FLEET_REGISTRY_INVALID/);
  const rows = fresh(); rows[1].health.executor_shard_id = "executor-01";
  assert.ok(verdict(rows).shards[1].reasons.includes("SHARD_IDENTITY_MISMATCH"));
});

test("disk hash does not prove loaded code after a file change or process ambiguity", () => {
  for (const patch of [{ process_identity_verified: false }, { code_loaded_evidence: "UNKNOWN" }]) {
    const rows = fresh(); Object.assign(rows[1], patch);
    assert.equal(verdict(rows).shards[1].status, "UNKNOWN");
  }
  for (const patch of [{ user: "root" }, { uid: 0 }, { protect_system: "no" },
    { private_tmp: "no" }, { no_new_privileges: "no" }, { active_state: "failed" }]) {
    const rows = fresh(); Object.assign(rows[1].service, patch);
    assert.ok(verdict(rows).shards[1].reasons.includes("SERVICE_SAFETY_MISMATCH"));
  }
});

test("fingerprints use file bytes and names, not release labels, list order or unrelated web code", () => {
  const sources = {
    "apps/live-executor/package.json": '{"type":"module"}',
    "apps/live-executor/src/server.mjs": 'import { thing,\n other } from "./shared.mjs";\nimport "node:fs";',
    "apps/live-executor/src/shared.mjs": 'export { plan } from "../../web/lib/execution/strategy.ts";',
    "apps/web/lib/execution/strategy.ts": 'import type { Rules } from "./types.ts";\nexport const plan = 1;',
    "apps/web/lib/execution/types.ts": "export type Rules = number;",
    "apps/web/lib/execution/not-imported.ts": "web only",
  };
  const source = (path) => { assert.ok(Object.hasOwn(sources, path), path); return sources[path]; };
  const first = discoverRuntimeFiles(source);
  assert.equal(first.files.length, 5);
  assert.equal(runtimeFingerprint([...first.files].reverse()), first.runtime_sha256);
  sources["apps/web/lib/execution/not-imported.ts"] = "changed web only";
  assert.equal(discoverRuntimeFiles(source).runtime_sha256, first.runtime_sha256);
  sources["apps/web/lib/execution/strategy.ts"] += "\nexport const changed = true;";
  assert.notEqual(discoverRuntimeFiles(source).runtime_sha256, first.runtime_sha256);
  for (const unsafe of ['import("./dynamic.mjs");', 'const x = require("./dynamic.mjs");',
    'import x from "package";', 'import x from "../../../.env";']) {
    sources["apps/live-executor/src/server.mjs"] = unsafe;
    assert.throws(() => discoverRuntimeFiles(source), /FLEET_(?:DYNAMIC|RUNTIME)_IMPORT/);
  }
});

test("pinned fingerprint is derived from Git blobs of the reviewed release, including transitive strategy files", () => {
  const actual = readGitRuntimeManifest(ROOT, manifest.target_sha);
  assert.equal(actual.runtime_sha256, manifest.runtime_sha256);
  assert.ok(actual.files.some((f) => f.path === "apps/web/lib/execution/strategy-engine.ts"));
  assert.ok(actual.files.some((f) => f.path === "apps/web/lib/execution/binance-spot-adapter.ts"));
  assert.ok(!actual.files.some((f) => f.path.endsWith("live-executor-health.ts")), "web-only health does not force a VPS restart");
});

test("registry discovery is official CoinOps GET only and paginates without exposing credentials", async () => {
  const env = { SUPABASE_URL: "https://otdfpmsegjxpqrzisfmi.supabase.co", SUPABASE_DATA_SCHEMA: "coinops",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-server-key-never-real" };
  const generated = Array.from({ length: 101 }, (_, index) => ({ id: `executor-${String(index + 1).padStart(2, "0")}`,
    egress_ipv4: `203.0.113.${index + 1}`, enabled: true }));
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url); assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.headers["Accept-Profile"], "coinops");
    assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
    const offset = Number(new URL(url).searchParams.get("offset"));
    return { ok: true, json: async () => generated.slice(offset, offset + 100) };
  };
  assert.equal((await discoverEnabledShards(env, fetcher)).length, 101); assert.equal(calls.length, 2);
  await assert.rejects(discoverEnabledShards({ ...env, SUPABASE_DATA_SCHEMA: "public" }, fetcher), /FLEET_SUPABASE_SCOPE_INVALID/);
  await assert.rejects(discoverEnabledShards({ ...env, SUPABASE_URL: "https://other.supabase.co" }, fetcher), /FLEET_SUPABASE_SCOPE_INVALID/);
  await assert.rejects(discoverEnabledShards(env, async () => { throw new Error(env.SUPABASE_SERVICE_ROLE_KEY); }),
    (error) => error.message === "FLEET_REGISTRY_READ_FAILED" && !error.message.includes(env.SUPABASE_SERVICE_ROLE_KEY));
});

test("serialized SSH probe is parseable and reads only service/process/public code plus localhost GET health", () => {
  const script = probeScript({ id: registry[0].id, ip: registry[0].egress_ipv4 },
    { files: [{ path: manifest.runtime_entry, sha256: "a".repeat(64) }] });
  // Parse without invoking the remote function or any network/systemctl call.
  execFileSync(process.execPath, ["--input-type=module", "--check"], { input: script,
    encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  assert.ok(script.includes('"http://127.0.0.1:8080/health"'));
  assert.ok(script.includes("ExecMainStartTimestamp")); assert.ok(script.includes("stat.ctimeMs"));
  assert.ok(script.includes('"--timestamp=us"'));
  assert.ok(script.includes("newest <= startedAt")); assert.ok(!script.includes("startedAt + 1000"));
  assert.ok(script.includes("CODE_CHANGED_DURING_PROBE"));
  for (const forbidden of ["/environ", "live-executor.env", "writeFile", "mkdir", "restart", "create-order", "cancel-order"])
    assert.ok(!script.includes(forbidden), forbidden);
  const code = readFileSync(resolve(ROOT, "apps/live-executor/deploy/fleet-parity.mjs"), "utf8");
  assert.ok(code.includes('"StrictHostKeyChecking=yes"'));
  assert.ok(code.includes('"BatchMode=yes"'));
  assert.ok(!code.includes("rejectUnauthorized: false"));
});

test("bootstrap fixed Node version agrees with the fleet manifest", () => {
  const bootstrap = readFileSync(resolve(ROOT, "apps/live-executor/deploy/bootstrap-new-shard.sh"), "utf8");
  assert.equal(bootstrap.match(/^node_version=([^\r\n]+)$/m)?.[1], manifest.node_version.slice(1));
});

test("verify rechecks registry and cannot finish PASS while a third enabled executor appeared", async () => {
  let reads = 0;
  const third = { id: "executor-03", egress_ipv4: "203.0.113.33", enabled: true };
  const result = await verifyFleet({ manifest, now: () => now,
    env: { SUPABASE_URL: "https://otdfpmsegjxpqrzisfmi.supabase.co", SUPABASE_DATA_SCHEMA: "coinops",
      SUPABASE_SERVICE_ROLE_KEY: "fake-only" }, keyPath: "fixture-key-not-used",
    gitSource: () => ({ head_sha: manifest.target_sha, cached_main_sha: manifest.target_sha }),
    sourceReader: () => ({ runtime_sha256: manifest.runtime_sha256, files: [] }),
    fetcher: async () => ({ ok: true, json: async () => ++reads === 1 ? registry : [...registry, third] }),
    probe: async (shard) => evidenceFor({ ...shard, egress_ipv4: shard.ip }),
  });
  assert.equal(reads, 2); assert.equal(result.total, 3);
  assert.equal(result.status, "FLEET_PARITY_NOT_CONFIRMED");
  assert.equal(result.reason, "REGISTRY_CHANGED_DURING_VERIFICATION");
  assert.equal(result.shards[2].status, "UNKNOWN");
});

test("verify itself checks HEAD and cached main runtime before any remote read", async () => {
  for (const changed of ["HEAD", "MAIN"]) {
    const head = "a".repeat(40), main = "b".repeat(40), read = [];
    let remoteCalls = 0;
    await assert.rejects(verifyFleet({ manifest,
      gitSource: () => ({ head_sha: head, cached_main_sha: main }),
      sourceReader: (_repo, sha) => {
        read.push(sha);
        return { files: [], runtime_sha256: sha === (changed === "HEAD" ? head : main)
          ? "c".repeat(64) : manifest.runtime_sha256 };
      },
      fetcher: async () => { remoteCalls++; throw new Error("Must not reach network"); },
      probe: async () => { remoteCalls++; throw new Error("Must not reach SSH"); },
    }), /FLEET_RUNTIME_CHANGE_REQUIRES_RELEASE/);
    assert.ok(read.includes(head)); if (changed === "MAIN") assert.ok(read.includes(main));
    assert.equal(remoteCalls, 0);
  }
});

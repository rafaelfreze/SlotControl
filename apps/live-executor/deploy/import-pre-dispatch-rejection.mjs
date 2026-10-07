/** Root-only compatibility import for a pinned, proved pre-POST rejection.
 * No exchange request, no order/registry/credential mutation, no claim removal.
 * Canonical /v1/prove-unsent-order must still fence and perform the exact GET. */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync, renameSync, chownSync, existsSync } from "node:fs";
import { join, realpathSync } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadExecutorRegistry, loadCombinedRegistry, assertEngineOrder, durableIntent } from "../src/account-registry.mjs";
import { historicalPreDispatchProof, HISTORICAL_REJECTION_RUNTIME, HISTORICAL_REJECTION_FINGERPRINT } from "../src/pre-dispatch-evidence.mjs";
import { discoverRuntimeFiles } from "./fleet-parity.mjs";

const [shard, ip, engineId, clientOrderId, decisionId, dispatchedAt, expectedPid] = process.argv.slice(2);
if (process.getuid?.() !== 0 || !/^executor-\d{2}$/.test(shard ?? "") || !/^\d+(\.\d+){3}$/.test(ip ?? "")
  || !/^[a-f0-9-]{36}$/.test(engineId ?? "") || !/^\d+$/.test(expectedPid ?? "")
  || !Number.isFinite(Date.parse(dispatchedAt)) || Date.now() - Date.parse(dispatchedAt) < 90_000)
  throw new Error("PRE_DISPATCH_IMPORT_SCOPE_DENIED");
const system = (args) => execFileSync("systemctl", args, { encoding: "utf8" }).trim();
if (system(["show", "coinops-live-executor", "--property=MainPID", "--value"]) !== expectedPid)
  throw new Error("PRE_DISPATCH_IMPORT_PROCESS_CHANGED");
const source = realpathSync(shard === "executor-01" ? "/opt/coinops/source" : "/opt/coinops/current");
const graph = discoverRuntimeFiles(path => readFileSync(join(source, path)));
if (graph.runtime_sha256 !== HISTORICAL_REJECTION_FINGERPRINT)
  throw new Error("PRE_DISPATCH_IMPORT_RUNTIME_NOT_PINNED");
if (graph.files.some(file => statSync(join(source, file.path)).mtimeMs >= Date.parse(dispatchedAt)))
  throw new Error("PRE_DISPATCH_IMPORT_RUNTIME_CHANGED");
const env = Object.fromEntries(readFileSync("/etc/coinops/live-executor.env", "utf8").split(/\r?\n/)
  .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => {
    const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1).replace(/^(["'])(.*)\1$/, "$2")];
  }));
if (env.COINOPS_EXECUTOR_SHARD_ID !== shard || env.LIVE_EXECUTOR_EGRESS_IP !== ip
  || env.COINOPS_EXECUTOR_VERSION !== HISTORICAL_REJECTION_RUNTIME)
  throw new Error("PRE_DISPATCH_IMPORT_HOST_MISMATCH");
const registry = await loadCombinedRegistry(await loadExecutorRegistry(env.COINOPS_EXECUTOR_REGISTRY_PATH),
  env.COINOPS_EXECUTOR_STATE_DIR, () => { throw new Error("PRE_DISPATCH_IMPORT_REGISTRY_FAILED"); });
const engine = registry.engines.find(row => row.trading_engine_id === engineId);
if (!engine || engine.environment !== "REAL") throw new Error("PRE_DISPATCH_IMPORT_ENGINE_DENIED");
assertEngineOrder(engine, engine.symbol, clientOrderId, "BUY");
const claim = durableIntent(engine, {}, clientOrderId, "", "CREATE_ORDER");
const base = join(env.COINOPS_EXECUTOR_STATE_DIR, "orders", createHash("sha256").update(claim.key).digest("hex"));
if (existsSync(`${base}.json`)) throw new Error("PRE_DISPATCH_IMPORT_ORDER_ALREADY_COMPLETED");
const pending = statSync(`${base}.pending`);
const output = execFileSync("journalctl", ["-u", "coinops-live-executor", "--since", dispatchedAt,
  "--no-pager", "-o", "json", `_PID=${expectedPid}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const records = output.trim().split(/\r?\n/).filter(Boolean).flatMap(line => {
  const envelope = JSON.parse(line);
  if (envelope._PID !== expectedPid || envelope._SYSTEMD_UNIT !== "coinops-live-executor.service") return [];
  try {
    const row = JSON.parse(envelope.MESSAGE);
    return Math.abs(Number(envelope.__REALTIME_TIMESTAMP) / 1000 - Date.parse(row.timestamp)) <= 2_000 ? [row] : [];
  } catch { return []; }
});
const value = historicalPreDispatchProof({ secret: env.COINOPS_EXECUTOR_HMAC_SECRET,
  engine: { ...engine, executor_shard_id: shard }, clientOrderId, decisionId, dispatchedAt, claimKey: claim.key,
  pendingHash: readFileSync(`${base}.pending`, "utf8"), pendingMtime: pending.mtimeMs, records,
  runtimeSha: env.COINOPS_EXECUTOR_VERSION, runtimeFingerprint: graph.runtime_sha256 });
if (system(["show", "coinops-live-executor", "--property=MainPID", "--value"]) !== expectedPid
  || statSync(`${base}.pending`).mtimeMs !== pending.mtimeMs)
  throw new Error("PRE_DISPATCH_IMPORT_EVIDENCE_CHANGED");
const target = `${base}.pre-post-evidence`;
let previous = null;
try { previous = readFileSync(target, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const content = JSON.stringify(value);
if (previous !== null && previous !== content) throw new Error("PRE_DISPATCH_IMPORT_EVIDENCE_CONFLICT");
if (previous === null) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  chownSync(temporary, pending.uid, pending.gid);
  renameSync(temporary, target);
}
console.log(JSON.stringify({ status: previous === null ? "PRE_POST_EVIDENCE_IMPORTED" : "ALREADY_IMPORTED",
  shard, engineId, clientOrderId, decisionId, request_id: value.proof.request_id,
  rejectedAt: value.proof.rejectedAt, claim_preserved: true, exchange_writes: 0 }));

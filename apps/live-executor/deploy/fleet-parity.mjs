#!/usr/bin/env node
/** Publication-only verifier. No DB writes, service changes or exchange orders.
 * An incomplete rollout fails publication, never an existing trading engine. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(HERE, "../../..");
const MANIFEST_PATH = join(HERE, "fleet-release.json");
const PROJECT_URL = "https://otdfpmsegjxpqrzisfmi.supabase.co";
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const SHARD = /^executor-(?!00$)[0-9]{2,4}$/;
const ENTRY = "apps/live-executor/src/server.mjs";
const PACKAGE = "apps/live-executor/package.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(code); };
const allowedPath = (value) => typeof value === "string" && !value.includes("..")
  && /^[a-zA-Z0-9._/-]+$/.test(value) && (value === PACKAGE
    || value.startsWith("apps/live-executor/src/") || value.startsWith("apps/web/lib/execution/"));

export function validateManifest(input) {
  if (!input || input.contract_version !== 1 || !SHA.test(input.target_sha ?? "")
    || !/^v24\.\d+\.\d+$/.test(input.node_version ?? "") || input.runtime_entry !== ENTRY
    || !HASH.test(input.runtime_sha256 ?? "") || input.max_evidence_age_ms !== 120000
    || input.max_health_age_ms !== 45000) fail("FLEET_MANIFEST_INVALID");
  return input;
}

export function readManifest(path = MANIFEST_PATH) {
  try { return validateManifest(JSON.parse(readFileSync(path, "utf8"))); }
  catch { return fail("FLEET_MANIFEST_INVALID"); }
}

/** This gate is local and must run before deploy/bootstrap performs any write. */
export function checkTarget(manifest, revision) {
  validateManifest(manifest);
  if (!SHA.test(revision ?? "") || revision !== manifest.target_sha) fail("FLEET_TARGET_MISMATCH");
  return { status: "FLEET_TARGET_PASS", target_sha: manifest.target_sha };
}

export function runtimeFingerprint(files) {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!sorted.length || new Set(sorted.map((f) => f.path)).size !== sorted.length
    || sorted.some((f) => !allowedPath(f.path) || !HASH.test(f.sha256 ?? ""))) fail("FLEET_RUNTIME_FILES_INVALID");
  return sha256(sorted.map((f) => `${f.path}\0${f.sha256}\n`).join(""));
}

/** Fail closed on dynamic/external imports. The current executor uses explicit
 * static relative imports and node: builtins; changed loading needs review. */
export function discoverRuntimeFiles(readSource, entry = ENTRY) {
  const pending = [entry, PACKAGE], files = new Map();
  while (pending.length) {
    const path = pending.pop();
    if (files.has(path)) continue;
    if (!allowedPath(path)) fail("FLEET_RUNTIME_IMPORT_OUTSIDE_BUNDLE");
    const source = readSource(path);
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
    files.set(path, { path, sha256: sha256(bytes) });
    if (path === PACKAGE) continue;
    const code = bytes.toString("utf8");
    // Comments are removed only for import detection, never for content hashes.
    const imports = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/\bimport\s*\(|\brequire\s*\(/.test(imports)) fail("FLEET_DYNAMIC_IMPORT_REQUIRES_REVIEW");
    const pattern = /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?(?:[^;]*?\bfrom\s*)?["']([^"']+)["']/g;
    for (const match of imports.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".") || !/\.(?:mjs|cjs|js|ts|json)$/.test(specifier))
        fail("FLEET_RUNTIME_IMPORT_REQUIRES_REVIEW");
      pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
  }
  const result = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: result, runtime_sha256: runtimeFingerprint(result) };
}

export function readGitRuntimeManifest(repo, revision) {
  if (!SHA.test(revision ?? "")) fail("FLEET_FULL_GIT_SHA_REQUIRED");
  const git = (args) => {
    try { return execFileSync("git", ["-C", repo, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { return fail("FLEET_GIT_SOURCE_UNAVAILABLE"); }
  };
  if (git(["rev-parse", `${revision}^{commit}`]).toString().trim() !== revision) fail("FLEET_GIT_SOURCE_UNAVAILABLE");
  return { target_sha: revision, ...discoverRuntimeFiles((path) => {
    const tree = git(["ls-tree", revision, "--", path]).toString().trim();
    if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(tree) || !tree.endsWith(`\t${path}`))
      fail("FLEET_GIT_RUNTIME_FILE_INVALID");
    return git(["show", `${revision}:${path}`]);
  }) };
}

export function checkCode(manifest, repo, revision) {
  validateManifest(manifest);
  const expected = readGitRuntimeManifest(repo, manifest.target_sha);
  if (expected.runtime_sha256 !== manifest.runtime_sha256) fail("FLEET_MANIFEST_FINGERPRINT_MISMATCH");
  const actual = readGitRuntimeManifest(repo, revision);
  if (actual.runtime_sha256 !== expected.runtime_sha256) fail("FLEET_RUNTIME_CHANGE_REQUIRES_RELEASE");
  return { status: "FLEET_CODE_PASS", target_sha: manifest.target_sha, compared_sha: revision,
    runtime_sha256: actual.runtime_sha256, file_count: actual.files.length };
}

/** Uses the last explicitly fetched main; never fetches or mutates Git here. */
export function officialGitSource(manifest, repo) {
  const read = (args) => {
    try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 15000,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch { return fail("FLEET_OFFICIAL_GIT_UNAVAILABLE"); }
  };
  if (read(["remote", "get-url", "origin"]) !== "https://github.com/rafaelfreze/SlotControl.git")
    fail("FLEET_GIT_ORIGIN_MISMATCH");
  const head_sha = read(["rev-parse", "HEAD"]), cached_main_sha = read(["rev-parse", "refs/remotes/origin/main"]);
  if (!SHA.test(head_sha) || !SHA.test(cached_main_sha)) fail("FLEET_OFFICIAL_GIT_UNAVAILABLE");
  read(["merge-base", "--is-ancestor", manifest.target_sha, "refs/remotes/origin/main"]);
  return { head_sha, cached_main_sha };
}

function normalizeRegistry(rows) {
  if (!Array.isArray(rows)) fail("FLEET_REGISTRY_INVALID");
  const enabled = rows.filter((r) => r.enabled === true).map((r) => ({ id: r.id,
    ip: typeof r.egress_ipv4 === "string" ? r.egress_ipv4.replace(/\/32$/, "") : "" }));
  if (!enabled.length || enabled.some((r) => !SHARD.test(r.id ?? "") || isIP(r.ip) !== 4)
    || new Set(enabled.map((r) => r.id)).size !== enabled.length
    || new Set(enabled.map((r) => r.ip)).size !== enabled.length) fail("FLEET_REGISTRY_INVALID");
  return enabled;
}

export async function discoverEnabledShards(env = process.env, fetcher = fetch) {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  if (url !== PROJECT_URL || env.SUPABASE_DATA_SCHEMA !== "coinops"
    || typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string" || !env.SUPABASE_SERVICE_ROLE_KEY)
    fail("FLEET_SUPABASE_SCOPE_INVALID");
  const rows = [], pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    let response;
    try {
      response = await fetcher(`${url}/rest/v1/executor_shards?select=id,egress_ipv4,enabled&enabled=eq.true&order=id.asc&offset=${offset}&limit=${pageSize}`, {
        method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000),
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Accept-Profile": "coinops", Accept: "application/json" },
      });
      if (!response.ok) fail("FLEET_REGISTRY_READ_FAILED");
      const page = await response.json();
      if (!Array.isArray(page) || page.length > pageSize || page.some((r) => r.enabled !== true))
        fail("FLEET_REGISTRY_READ_FAILED");
      if (page.some((r) => rows.some((previous) => previous.id === r.id))) fail("FLEET_REGISTRY_READ_FAILED");
      rows.push(...page);
      if (page.length < pageSize) break;
    } catch { fail("FLEET_REGISTRY_READ_FAILED"); }
  }
  normalizeRegistry(rows);
  return rows;
}

/** Pure, side-effect-free publication verdict. Never creates a trading gate. */
export function evaluateFleetParity(manifest, registry, evidence, now = Date.now()) {
  validateManifest(manifest);
  const shards = normalizeRegistry(registry);
  if (!Number.isFinite(now) || !Array.isArray(evidence)) fail("FLEET_EVIDENCE_INVALID");
  const ageValid = (timestamp, maximum) => {
    const age = now - Date.parse(timestamp);
    return Number.isFinite(age) && age >= -30000 && age <= maximum;
  };
  const results = shards.map((shard) => {
    const found = evidence.filter((e) => e.shard_id === shard.id);
    const reasons = [], unknown = [];
    if (found.length !== 1) unknown.push(found.length ? "DUPLICATE_EVIDENCE" : "EVIDENCE_MISSING");
    const row = found.length === 1 ? found[0] : null;
    if (row?.error) unknown.push("PROBE_UNAVAILABLE");
    if (row && !row.error) {
      if (!ageValid(row.observed_at, manifest.max_evidence_age_ms)) unknown.push("EVIDENCE_STALE");
      if (row.ip !== shard.ip || row.health?.executor_shard_id !== shard.id
        || row.health?.egress_ipv4 !== shard.ip || row.health?.egress_ipv4_verified !== true)
        reasons.push("SHARD_IDENTITY_MISMATCH");
      if (row.health?.healthy !== true) reasons.push("HEALTH_NOT_CONFIRMED");
      if (!ageValid(row.health?.clock, manifest.max_health_age_ms)) unknown.push("HEALTH_STALE");
      if (row.health?.actual_executor_version !== manifest.target_sha) reasons.push("RELEASE_MISMATCH");
      if (row.node_version !== manifest.node_version) reasons.push("NODE_VERSION_MISMATCH");
      if (row.runtime_sha256 !== manifest.runtime_sha256) reasons.push("RUNTIME_FINGERPRINT_MISMATCH");
      const service = row.service;
      if (!service || service.active_state !== "active" || service.sub_state !== "running"
        || !Number.isInteger(service.pid) || service.pid <= 0 || !service.user || service.user === "root"
        || !Number.isInteger(service.uid) || service.uid <= 0 || service.protect_system !== "strict"
        || service.no_new_privileges !== "yes" || service.private_tmp !== "yes") reasons.push("SERVICE_SAFETY_MISMATCH");
      if (row.process_identity_verified !== true) unknown.push("PROCESS_IDENTITY_UNPROVEN");
      if (row.code_loaded_evidence !== "DISK_UNCHANGED_SINCE_PROCESS_START") unknown.push("LOADED_CODE_UNPROVEN");
      if (row.probe_contract_version !== manifest.contract_version) unknown.push("PROBE_CONTRACT_MISMATCH");
    }
    return { shard_id: shard.id, ip: shard.ip, status: reasons.length ? "FAIL" : unknown.length ? "UNKNOWN" : "PASS",
      reasons: [...reasons, ...unknown], actual_sha: row?.health?.actual_executor_version ?? null,
      observed_at: row?.observed_at ?? null, runtime_sha256: row?.runtime_sha256 ?? null };
  });
  return { status: results.every((r) => r.status === "PASS") ? "FLEET_PARITY_PASS" : "FLEET_PARITY_NOT_CONFIRMED",
    target_sha: manifest.target_sha, checked_at: new Date(now).toISOString(),
    verified: results.filter((r) => r.status === "PASS").length, total: shards.length, shards: results };
}

/** Serialized over SSH stdin. Only reads systemd, /proc, public source and GET
 * localhost health. No environment, vault, registry or financial-state reads. */
async function remoteProbe(input) {
  const fs = await import("node:fs"), path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const execute = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 }).trim();
  const properties = ["User", "Group", "MainPID", "ActiveState", "SubState", "WorkingDirectory",
    "ExecMainStartTimestamp", "NoNewPrivileges", "ProtectSystem", "PrivateTmp"];
  const serviceState = () => Object.fromEntries(execute("systemctl", ["--timestamp=us", "show", "coinops-live-executor.service",
    ...properties.map((p) => `--property=${p}`)]).split("\n").map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
  const before = serviceState(), pid = Number(before.MainPID);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("PROCESS_UNAVAILABLE");
  const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
  const root = path.resolve(cwd, "../..");
  if (cwd !== `${root}/apps/live-executor` || fs.realpathSync(before.WorkingDirectory) !== cwd
    || !(root === "/opt/coinops/source" && input.shard_id === "executor-01"
      || /^\/opt\/coinops\/releases\/[a-f0-9]{40}$/.test(root) && input.shard_id !== "executor-01"))
    throw new Error("PROCESS_ROOT_UNPROVEN");
  const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  const expectedEntry = `${root}/${input.runtime_entry}`;
  if (argv.length !== 3 || argv[1] !== "--experimental-strip-types"
    || fs.realpathSync(argv[2]) !== expectedEntry) throw new Error("PROCESS_ENTRY_UNPROVEN");
  const executable = fs.realpathSync(`/proc/${pid}/exe`);
  if (executable !== fs.realpathSync("/usr/local/bin/node")) throw new Error("PROCESS_NODE_UNPROVEN");
  const uid = Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1]);
  if (uid !== Number(execute("id", ["-u", before.User]))) throw new Error("PROCESS_USER_MISMATCH");
  const startedAt = Date.parse(before.ExecMainStartTimestamp);
  let newest = 0;
  const metadata = [];
  const signature = (stat) => [stat.size, stat.ino, stat.dev, stat.mtimeMs, stat.ctimeMs].join(":");
  const files = input.files.map(({ path: relative }) => {
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    if (!stat.isFile() || fs.realpathSync(absolute) !== absolute) throw new Error("PUBLIC_FILE_IDENTITY_INVALID");
    newest = Math.max(newest, stat.mtimeMs, stat.ctimeMs);
    metadata.push({ absolute, signature: signature(stat) });
    return { path: relative, sha256: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash("sha256").update(files.map((f) => `${f.path}\0${f.sha256}\n`).join("")).digest("hex");
  const response = await fetch("http://127.0.0.1:8080/health", { method: "GET", redirect: "error",
    signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("HEALTH_UNAVAILABLE");
  const raw = await response.json(), after = serviceState();
  if (after.MainPID !== before.MainPID || after.ExecMainStartTimestamp !== before.ExecMainStartTimestamp)
    throw new Error("PROCESS_CHANGED_DURING_PROBE");
  if (metadata.some((file) => fs.realpathSync(file.absolute) !== file.absolute
    || signature(fs.lstatSync(file.absolute)) !== file.signature)) throw new Error("CODE_CHANGED_DURING_PROBE");
  const health = Object.fromEntries(["healthy", "executor_shard_id", "actual_executor_version", "clock",
    "egress_ipv4", "egress_ipv4_verified"].map((key) => [key, raw[key]]));
  return { shard_id: input.shard_id, ip: input.ip, observed_at: new Date().toISOString(),
    probe_contract_version: 1, node_version: execute(executable, ["--version"]), runtime_sha256: digest,
    public_file_count: files.length, runtime_root: root, process_identity_verified: true,
    // systemctl reports microseconds; Date.parse truncates to milliseconds.
    // Any ambiguous sub-ms or post-start change remains UNKNOWN, never PASS.
    code_loaded_evidence: Number.isFinite(startedAt) && newest <= startedAt
      ? "DISK_UNCHANGED_SINCE_PROCESS_START" : "UNKNOWN", newest_code_change_at: new Date(newest).toISOString(),
    service: { active_state: after.ActiveState, sub_state: after.SubState, pid, user: before.User,
      group: before.Group, uid, started_at: before.ExecMainStartTimestamp,
      protect_system: after.ProtectSystem, no_new_privileges: after.NoNewPrivileges, private_tmp: after.PrivateTmp }, health };
}

export function probeScript(shard, expected) {
  if (!SHARD.test(shard.id ?? "") || isIP(shard.ip) !== 4 || !Array.isArray(expected.files)
    || expected.files.some((f) => !allowedPath(f.path))) fail("FLEET_PROBE_INPUT_INVALID");
  const input = JSON.stringify({ shard_id: shard.id, ip: shard.ip, runtime_entry: ENTRY, files: expected.files });
  return `(${remoteProbe.toString()})(${input}).then(value=>process.stdout.write(JSON.stringify(value)))`;
}

export function sshEvidence(shard, expected, { keyPath, sshUser = "root", sshBinary = "ssh" } = {}) {
  if (typeof keyPath !== "string" || !keyPath || !/^[a-z_][a-z0-9_-]*$/.test(sshUser)) fail("FLEET_SSH_CONFIG_INVALID");
  const script = probeScript(shard, expected);
  const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
    "-i", keyPath, `${sshUser}@${shard.ip}`, "/usr/local/bin/node", "--input-type=module"];
  const result = spawnSync(sshBinary, args, { input: script, encoding: "utf8", timeout: 45000,
    maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0 || result.error) return { shard_id: shard.id, ip: shard.ip, error: "FLEET_SSH_PROBE_FAILED" };
  try { return JSON.parse(result.stdout); }
  catch { return { shard_id: shard.id, ip: shard.ip, error: "FLEET_SSH_EVIDENCE_INVALID" }; }
}

export async function verifyFleet({ manifest = readManifest(), repo = DEFAULT_REPO,
  env = process.env, keyPath = env.COINOPS_FLEET_SSH_KEY, sshUser = env.COINOPS_FLEET_SSH_USER ?? "root",
  fetcher = fetch, probe = sshEvidence, now = Date.now,
  sourceReader = readGitRuntimeManifest, gitSource = officialGitSource } = {}) {
  validateManifest(manifest);
  const git = gitSource(manifest, repo);
  const expected = sourceReader(repo, manifest.target_sha);
  if (expected.runtime_sha256 !== manifest.runtime_sha256) fail("FLEET_MANIFEST_FINGERPRINT_MISMATCH");
  // Do not certify a uniformly old fleet when current main/HEAD changed runtime.
  for (const revision of new Set([git.head_sha, git.cached_main_sha])) {
    if (revision !== manifest.target_sha
      && sourceReader(repo, revision).runtime_sha256 !== expected.runtime_sha256)
      fail("FLEET_RUNTIME_CHANGE_REQUIRES_RELEASE");
  }
  const registry = await discoverEnabledShards(env, fetcher);
  const evidence = [];
  for (const shard of normalizeRegistry(registry)) evidence.push(await probe(shard, expected, { keyPath, sshUser }));
  // Re-read registry: an enabled shard created during the audit must not be omitted.
  const finalRegistry = await discoverEnabledShards(env, fetcher);
  const result = evaluateFleetParity(manifest, finalRegistry, evidence, now());
  if (JSON.stringify(normalizeRegistry(registry)) !== JSON.stringify(normalizeRegistry(finalRegistry))) {
    result.status = "FLEET_PARITY_NOT_CONFIRMED";
    result.reason = "REGISTRY_CHANGED_DURING_VERIFICATION";
  }
  return { ...result, git, evidence };
}

export async function main(args = process.argv.slice(2)) {
  const manifest = readManifest();
  if (args[0] === "--check-target" && args.length <= 2) return checkTarget(manifest, args[1] ?? manifest.target_sha);
  if (args[0] === "--check-code" && args.length <= 2) {
    officialGitSource(manifest, DEFAULT_REPO);
    let revision = args[1];
    if (!revision) revision = execFileSync("git", ["-C", DEFAULT_REPO, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
    return checkCode(manifest, DEFAULT_REPO, revision);
  }
  if (args[0] === "--verify") {
    const options = {};
    for (let i = 1; i < args.length; i += 2) {
      if (!["--ssh-key", "--ssh-user"].includes(args[i]) || !args[i + 1]) fail("FLEET_USAGE_INVALID");
      options[args[i] === "--ssh-key" ? "keyPath" : "sshUser"] = args[i + 1];
    }
    return verifyFleet({ manifest, ...options });
  }
  return fail("FLEET_USAGE_INVALID");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "FLEET_PARITY_NOT_CONFIRMED") process.exitCode = 1;
  }).catch((error) => {
    // Never print raw fetch/SSH/stdout/argv errors: they can contain credentials.
    const code = /^FLEET_[A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "FLEET_VERIFICATION_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "FAIL", code })}\n`); process.exitCode = 1;
  });
}

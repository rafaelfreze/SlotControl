#!/usr/bin/env node
/** Control-plane certification only. Default VERIFY performs no database write.
 * Uses the existing authenticated Supabase CLI and read-only fleet SSH kernel;
 * never reads dotenv, tokens, vaults, credentials or financial runtime state.
 * Usage: node tools/operations/certify-slot-workload.mjs --verify --evidence reviewed.json --ssh-key <existing-key-path>
 * --record is a separate, explicit operation; an uncertain result requires readback, never a blind retry.
 * IMPORTANT: the existing SQL slot-profile gate does NOT compare web_sha. This
 * CLI binds an artifact to current main at registration only. A relevant web
 * financial/observation change MUST be re-certified before new admission; old
 * persisted profiles are NOT automatically invalidated by a later web deploy. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRuntimeFiles, evaluateFleetParity, officialGitSource, readManifest, sshEvidence }
  from "../../apps/live-executor/deploy/fleet-parity.mjs";
import { certificateForFleet } from "../../apps/live-executor/deploy/capacity-preflight.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REF = "otdfpmsegjxpqrzisfmi", ORGANIZATION = "pzgqtvaitaawqgaabxve";
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const SHARD = /^executor-(?!00$)[0-9]{2,4}$/;
const MANIFEST = "apps/live-executor/deploy/fleet-release.json";
export const REQUIRED_SCENARIOS = Object.freeze(["STEADY", "ALL_TP_FILL_BURST", "TRANSIENT_RETRIES",
  "SIBLING_LOAD", "CPU_RAM", "RECONCILIATION_BACKLOG", "QUEUE_AND_RATE_LIMIT"]);
const fail = (code) => { throw new Error(code); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Sorted JSON object keys, preserving array order; the digest binds all its
 * fields except the top-level digest itself, including attached test results. */
export function canonicalJSON(value, depth = 0) {
  if (depth > 40) fail("SLOT_WORKLOAD_JSON_INVALID");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJSON(item, depth + 1)).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJSON(value[key], depth + 1)}`).join(",")}}`;
  return fail("SLOT_WORKLOAD_JSON_INVALID");
}
export function artifactDigest(artifact) {
  const unsigned = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "evidence_sha256"));
  return createHash("sha256").update(canonicalJSON(unsigned)).digest("hex");
}
export function validateArtifact(artifact, now = Date.now()) {
  if (!object(artifact) || artifact.contract !== "SLOT_WORKLOAD_EVIDENCE_V1" || artifact.environment !== "REAL"
    || !SHARD.test(artifact.shard_id ?? "") || !Number.isSafeInteger(artifact.slot_count)
    || artifact.slot_count < 2 || artifact.slot_count > 100 || artifact.slot_count === 25
    || !Number.isSafeInteger(artifact.capacity_units) || artifact.capacity_units < 1 || artifact.capacity_units > 25
    || !Number.isFinite(artifact.upper_bound_weight_per_minute) || artifact.upper_bound_weight_per_minute <= 0
    || artifact.upper_bound_weight_per_minute > artifact.capacity_units * 900
    || !SHA.test(artifact.web_sha ?? "") || !SHA.test(artifact.target_sha ?? "")
    || !HASH.test(artifact.runtime_sha256 ?? "") || !/^v24\.\d+\.\d+$/.test(artifact.node_version ?? "")
    || typeof artifact.policy_version !== "string" || !artifact.policy_version
    || !object(artifact.scenarios) || REQUIRED_SCENARIOS.some(key => artifact.scenarios[key] !== "PASS")
    || typeof artifact.observed_at !== "string" || !Number.isFinite(Date.parse(artifact.observed_at))
    || Date.parse(artifact.observed_at) > now + 10_000
    || !HASH.test(artifact.evidence_sha256 ?? "") || artifactDigest(artifact) !== artifact.evidence_sha256)
    fail("SLOT_WORKLOAD_EVIDENCE_INVALID");
  return artifact;
}

/** CLI2.121 may print connection notices before its single JSON document.
 * Scan a JSON boundary, not the first '{' (which can appear inside a notice).
 * Multiple documents and truncated/ambiguous output are rejected. */
export function parseCLIJSON(output) {
  if (typeof output !== "string" || output.length > 16 * 1024 * 1024) fail("SLOT_WORKLOAD_CLI_JSON_INVALID");
  const input = output.replace(/^\uFEFF/, "").replace(/\x1b\[[0-9;]*m/g, "");
  const results = [];
  for (const boundary of input.matchAll(/(?:^|\n)[ \t]*[\[{]/g)) {
    const start = boundary.index + boundary[0].search(/[\[{]/);
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let index = start; index < input.length; index++) {
      const char = input[index];
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") { depth--; if (depth === 0) { end = index + 1; break; } }
    }
    if (end < 0) continue;
    try { const value = JSON.parse(input.slice(start, end));
      if (object(value) || Array.isArray(value)) results.push({ start, end, value });
    } catch { /* A notice is not a JSON document. Never expose its text. */ }
  }
  const outer = results.filter(row => !results.some(other => other.start < row.start && other.end >= row.end));
  if (outer.length !== 1) fail("SLOT_WORKLOAD_CLI_JSON_INVALID");
  return outer[0].value;
}

function execute(file, args, options = {}) {
  try { return execFileSync(file, args, { encoding: "utf8", timeout: 70_000, maxBuffer: 16 * 1024 * 1024,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options }); }
  catch (error) {
    const known = String(error?.stderr ?? "").match(/\b(?:SLOT_WORKLOAD_CERTIFICATION_CONCURRENT_CHANGE|SLOT_WORKLOAD_RECORD_READBACK_FAILED|COINOPS_ADMISSION_[A-Z_]+)\b/);
    return fail(known?.[0] ?? "SLOT_WORKLOAD_CLI_COMMAND_FAILED");
  }
}
function cliPath(candidate) {
  if (candidate) return candidate;
  try { execute("supabase", ["--version"]); return "supabase"; } catch { /* Try an already-installed official CLI, never install one. */ }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const cache = join(process.env.LOCALAPPDATA, "npm-cache", "_npx");
    let entries = [];
    try { entries = readdirSync(cache, { withFileTypes: true }); } catch { /* no cached CLI */ }
    for (const entry of entries.filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const binary = join(cache, entry.name, "node_modules", "@supabase", "cli-windows-x64", "bin", "supabase.exe");
      try { const version = execute(binary, ["--version"]).trim();
        if (/^2\.(\d+)\.\d+$/.test(version) && Number(version.split(".")[1]) >= 121) return binary;
      } catch { /* not a compatible installed CLI */ }
    }
  }
  return fail("SLOT_WORKLOAD_CLI_REQUIRED");
}
export function createCLI({ path, runner = execute } = {}) {
  const binary = cliPath(path), version = runner(binary, ["--version"]).trim();
  if (!/^2\.(\d+)\.\d+$/.test(version) || Number(version.split(".")[1]) < 121) fail("SLOT_WORKLOAD_CLI_VERSION_UNSUPPORTED");
  return {
    version,
    verifyProject() {
      const projects = parseCLIJSON(runner(binary, ["projects", "list", "--output", "json"]));
      const found = Array.isArray(projects) ? projects.filter(row => row.id === REF) : [];
      if (found.length !== 1 || found[0].name !== "OnPlay Platform" || found[0].organization_id !== ORGANIZATION)
        fail("SLOT_WORKLOAD_PROJECT_IDENTITY_DENIED");
    },
    query(sql, field) {
      const result = parseCLIJSON(runner(binary, ["db", "query", "--linked", "--project-ref", REF, "--output", "json", sql]));
      if (!object(result) || !Array.isArray(result.rows) || result.rows.length !== 1 || !Object.hasOwn(result.rows[0], field))
        fail("SLOT_WORKLOAD_CLI_ROWS_INVALID");
      return result.rows[0][field];
    },
  };
}

function git(repo, args) { return execute("git", ["-C", repo, ...args], { timeout: 15_000 }); }
/** Equivalent runtime fingerprint proof with O(1) Git processes rather than
 * ls-tree+show for each of31 files. Git checks both published revisions; local
 * UTF-8 source is normalized only CRLF→LF to match canonical Git/Linux bytes. */
export function verifyRuntimeSource(manifest, repo = ROOT) {
  const source = officialGitSource(manifest, repo);
  if (source.head_sha !== source.cached_main_sha || git(repo, ["branch", "--show-current"]).trim() !== "main")
    fail("SLOT_WORKLOAD_MAIN_NOT_CURRENT");
  // Never let a locally edited manifest redefine the expected runtime bytes.
  let officialManifest;
  try { officialManifest = JSON.parse(git(repo, ["show", `${source.cached_main_sha}:${MANIFEST}`])); }
  catch { return fail("SLOT_WORKLOAD_LOCAL_SOURCE_INVALID"); }
  if (canonicalJSON(officialManifest) !== canonicalJSON(manifest)) fail("SLOT_WORKLOAD_LOCAL_SOURCE_INVALID");
  const runtime = discoverRuntimeFiles(path => {
    const file = resolve(repo, path);
    if (!lstatSync(file).isFile() || realpathSync(file).toLowerCase() !== file.toLowerCase())
      fail("SLOT_WORKLOAD_LOCAL_SOURCE_INVALID");
    return Buffer.from(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  });
  if (runtime.runtime_sha256 !== manifest.runtime_sha256) fail("SLOT_WORKLOAD_RUNTIME_FINGERPRINT_MISMATCH");
  const paths = [...runtime.files.map(row => row.path), MANIFEST];
  const tracked = git(repo, ["ls-files", "--stage", "--", ...paths]).trim().split(/\r?\n/);
  if (tracked.length !== paths.length || tracked.some(line => !/^100(?:644|755) [a-f0-9]{40} 0\t/.test(line)))
    fail("SLOT_WORKLOAD_LOCAL_SOURCE_INVALID");
  git(repo, ["diff", "--exit-code", manifest.target_sha, source.cached_main_sha, "--", ...runtime.files.map(row => row.path)]);
  git(repo, ["diff", "--exit-code", "HEAD", "--", ...paths]);
  return { ...source, ...runtime, status: "FLEET_CODE_PASS", target_sha: manifest.target_sha, compared_sha: source.cached_main_sha };
}

const registrySQL = `(select coalesce(jsonb_agg(jsonb_build_object('id',id,'egress_ipv4',egress_ipv4::text,
  'enabled',enabled,'binance_limit_per_min',binance_limit_per_min,'admission_ratio',admission_ratio,
  'incremental_engine_weight',incremental_engine_weight,'created_at',created_at) order by id),'[]'::jsonb) from coinops.executor_shards)`;
const controlsSQL = `jsonb_build_object('registry',${registrySQL},
  'release',(select to_jsonb(r) from coinops.executor_admission_release r where singleton),
  'attestations',(select coalesce(jsonb_agg(to_jsonb(a) order by shard_id),'[]'::jsonb) from coinops.executor_admission_attestations a),
  'policy',coinops.executor_capacity_policy())`;
export const SNAPSHOT_SQL = `BEGIN READ ONLY;
SELECT jsonb_build_object('product','CoinOps','project_ref','${REF}','schema','coinops',
 'schema_exists',to_regnamespace('coinops') is not null,'read_only',current_setting('transaction_read_only'),
 'observed_at',clock_timestamp(),'controls',${controlsSQL},
 'certification_evidence',(select jsonb_agg(jsonb_build_object('shard_id',s.id,'executor_version',m.executor_version,
   'registry_match',m.registry_match,'observed_at',m.observed_at,'heartbeat_at',m.heartbeat_at,
   'weight_observed_at',m.weight_observed_at,'binance_weight_samples',m.binance_weight_samples,
   'watchdog_checked_at',(select max(w.checked_at) from coinops.watchdog_checks w where w.shard_id=s.id)) order by s.id)
   from coinops.executor_shards s left join coinops.executor_capacity_samples m on m.shard_id=s.id where s.enabled)) as snapshot;
COMMIT;`;
function validateSnapshot(snapshot, manifest, now) {
  if (!object(snapshot) || snapshot.product !== "CoinOps" || snapshot.project_ref !== REF || snapshot.schema !== "coinops"
    || snapshot.schema_exists !== true || snapshot.read_only !== "on" || !object(snapshot.controls)) fail("SLOT_WORKLOAD_SNAPSHOT_INVALID");
  const { registry, release, attestations, policy } = snapshot.controls;
  if (!Array.isArray(registry) || !registry.length || !Array.isArray(attestations) || !object(release) || !object(policy)
    || policy.incremental_weight !== 900 || !registry.some(row => row.enabled)
    || new Set(registry.map(row => row.id)).size !== registry.length
    || new Set(attestations.map(row => row.shard_id)).size !== attestations.length
    || registry.some(row => !SHARD.test(row.id ?? "") || isIP(String(row.egress_ipv4).replace(/\/32$/, "")) !== 4)
    || release.target_sha !== manifest.target_sha || release.runtime_sha256 !== manifest.runtime_sha256
    || release.node_version !== manifest.node_version || release.policy_version !== policy.version)
    fail("SLOT_WORKLOAD_RELEASE_SCOPE_MISMATCH");
  const fresh = value => typeof value === "string" && Number.isFinite(Date.parse(value))
    && now - Date.parse(value) >= -10_000 && now - Date.parse(value) <= 120_000;
  const enabled = registry.filter(row => row.enabled);
  if (!Array.isArray(snapshot.certification_evidence) || snapshot.certification_evidence.length !== enabled.length
    || enabled.some(shard => {
      const rows = snapshot.certification_evidence.filter(row => row.shard_id === shard.id);
      return rows.length !== 1 || rows[0].executor_version !== manifest.target_sha || rows[0].registry_match !== true
        || !Number.isSafeInteger(rows[0].binance_weight_samples) || rows[0].binance_weight_samples < 2
        || ["observed_at", "heartbeat_at", "weight_observed_at", "watchdog_checked_at"].some(key => !fresh(rows[0][key]));
    })) fail("SLOT_WORKLOAD_CERTIFICATION_EVIDENCE_STALE");
  return snapshot.controls;
}
function scopeMatches(proof, artifact) {
  return proof?.contract === "SLOT_WORKLOAD_V1" && proof.environment === artifact.environment
    && proof.target_sha === artifact.target_sha && proof.runtime_sha256 === artifact.runtime_sha256
    && proof.policy_version === artifact.policy_version;
}
export function mergeCertificate(certificate, controls, artifact) {
  const old = new Map(controls.attestations.map(row => [row.shard_id, row]));
  const evidence = certificate.p_evidence.map(fresh => {
    const previous = old.get(fresh.shard_id);
    if (previous && (previous.target_sha !== certificate.p_target_sha || previous.runtime_sha256 !== certificate.p_runtime_sha256
      || previous.node_version !== certificate.p_node_version || previous.policy_version !== certificate.p_policy_version))
      fail("SLOT_WORKLOAD_EXISTING_ATTESTATION_SCOPE_MISMATCH");
    const merged = { ...(previous?.evidence ?? {}), ...fresh };
    if (fresh.shard_id === artifact.shard_id) {
      const prior = previous?.evidence?.slot_workload;
      if (prior && (!object(prior) || !Array.isArray(prior.profiles) || prior.profiles.some(row => !object(row))))
        fail("SLOT_WORKLOAD_EXISTING_PROFILE_INVALID");
      const preserved = (prior?.profiles ?? []).filter(row => row.slot_count !== artifact.slot_count);
      if (preserved.length && !scopeMatches(prior, artifact)) fail("SLOT_WORKLOAD_EXISTING_PROFILE_SCOPE_MISMATCH");
      merged.slot_workload = { ...(prior ?? {}), contract: "SLOT_WORKLOAD_V1", environment: "REAL",
        target_sha: artifact.target_sha, runtime_sha256: artifact.runtime_sha256, policy_version: artifact.policy_version,
        node_version: artifact.node_version, web_sha: artifact.web_sha,
        profiles: [...preserved, { slot_count: artifact.slot_count, status: "PASS", capacity_units: artifact.capacity_units,
          upper_bound_weight_per_minute: artifact.upper_bound_weight_per_minute,
          evidence_sha256: artifact.evidence_sha256, web_sha: artifact.web_sha, observed_at: artifact.observed_at,
          scenarios: artifact.scenarios }].sort((a, b) => a.slot_count - b.slot_count) };
    }
    return merged;
  });
  if (evidence.filter(row => row.shard_id === artifact.shard_id).length !== 1) fail("SLOT_WORKLOAD_TARGET_SHARD_DENIED");
  return { ...certificate, p_evidence: evidence };
}
const sqlJSON = (value) => `'${canonicalJSON(value).replaceAll("'", "''")}'::jsonb`;
/** One transaction: same advisory fence as the official RPC, table locks for
 * registry/attestation changes, full JSONB compare-and-set, official RPC ONCE,
 * and exact readback. No financial table, lease or order is changed here. */
export function buildRecordSQL(controls, certificate, artifact) {
  return `BEGIN;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s';
DO $slot_workload_record$
DECLARE expected jsonb:=${sqlJSON(controls)}; cert jsonb:=${sqlJSON(certificate)};
 actual jsonb; outcome text; profile jsonb;
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coinops-admission-certification',0));
 LOCK TABLE coinops.executor_shards IN SHARE MODE;
 LOCK TABLE coinops.executor_admission_attestations,coinops.executor_admission_release IN SHARE ROW EXCLUSIVE MODE;
 SELECT ${controlsSQL} INTO actual;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'SLOT_WORKLOAD_CERTIFICATION_CONCURRENT_CHANGE'; END IF;
 outcome:=coinops.certify_executor_admission(cert->>'p_target_sha',cert->>'p_runtime_sha256',
   cert->>'p_node_version',cert->>'p_policy_version',cert->'p_evidence');
 IF outcome IS DISTINCT FROM 'ADMISSION_PREFLIGHT_PASS' OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(cert->'p_evidence') e LEFT JOIN coinops.executor_admission_attestations a ON a.shard_id=e->>'shard_id'
  WHERE a.evidence IS DISTINCT FROM e OR a.target_sha IS DISTINCT FROM cert->>'p_target_sha'
   OR a.runtime_sha256 IS DISTINCT FROM cert->>'p_runtime_sha256' OR a.node_version IS DISTINCT FROM cert->>'p_node_version'
   OR a.policy_version IS DISTINCT FROM cert->>'p_policy_version') THEN RAISE EXCEPTION 'SLOT_WORKLOAD_RECORD_READBACK_FAILED'; END IF;
 profile:=private.coinops_slot_workload_profile('${artifact.shard_id}','REAL',${artifact.slot_count});
 IF profile->>'code' IS DISTINCT FROM 'SLOT_WORKLOAD_CERTIFIED'
  OR profile->'capacity_units' IS DISTINCT FROM '${artifact.capacity_units}'::jsonb
  OR profile->'upper_bound_weight_per_minute' IS DISTINCT FROM '${artifact.upper_bound_weight_per_minute}'::jsonb
  OR profile->>'evidence_sha256' IS DISTINCT FROM '${artifact.evidence_sha256}'
  THEN RAISE EXCEPTION 'SLOT_WORKLOAD_RECORD_READBACK_FAILED'; END IF;
END $slot_workload_record$;
SELECT jsonb_build_object('status','SLOT_WORKLOAD_PROFILE_RECORDED','shard_id','${artifact.shard_id}',
 'slot_count',${artifact.slot_count},'evidence_sha256','${artifact.evidence_sha256}') as receipt;
COMMIT;`;
}

export async function certifySlotWorkload({ artifact, record = false, repo = ROOT,
  manifest = readManifest(join(repo, MANIFEST)), cli = createCLI(), keyPath, sshUser = "root", now = Date.now,
  sourceVerifier = verifyRuntimeSource, probe = sshEvidence } = {}) {
  validateArtifact(artifact, now());
  const source = sourceVerifier(manifest, repo);
  if (source.status !== "FLEET_CODE_PASS" || artifact.web_sha !== source.cached_main_sha
    || artifact.target_sha !== manifest.target_sha || artifact.runtime_sha256 !== manifest.runtime_sha256
    || artifact.node_version !== manifest.node_version) fail("SLOT_WORKLOAD_EVIDENCE_SOURCE_MISMATCH");
  cli.verifyProject();
  const controls = validateSnapshot(cli.query(SNAPSHOT_SQL, "snapshot"), manifest, now());
  if (artifact.policy_version !== controls.policy.version) fail("SLOT_WORKLOAD_EVIDENCE_SOURCE_MISMATCH");
  const enabled = controls.registry.filter(row => row.enabled);
  if (!enabled.some(row => row.id === artifact.shard_id)) fail("SLOT_WORKLOAD_TARGET_SHARD_DENIED");
  const evidence = [];
  for (const row of enabled) evidence.push(await probe({ id: row.id, ip: row.egress_ipv4.replace(/\/32$/, "") }, source, { keyPath, sshUser }));
  const after = validateSnapshot(cli.query(SNAPSHOT_SQL, "snapshot"), manifest, now());
  if (canonicalJSON(after) !== canonicalJSON(controls)) fail("SLOT_WORKLOAD_CERTIFICATION_CONCURRENT_CHANGE");
  const fleet = { ...evaluateFleetParity(manifest, after.registry, evidence, now()), evidence };
  const certificate = mergeCertificate(certificateForFleet(fleet, manifest, after.policy), after, artifact);
  // SQL's evidence window is stricter than the generic fleet kernel's future allowance.
  if (certificate.p_evidence.some(row => { const age = now() - Date.parse(row.observed_at); return age < -10_000 || age > 120_000; }))
    fail("SLOT_WORKLOAD_FLEET_EVIDENCE_EXPIRED");
  const summary = { product: "CoinOps", project_ref: REF, schema: "coinops", shard_id: artifact.shard_id,
    slot_count: artifact.slot_count, capacity_units: artifact.capacity_units,
    upper_bound_weight_per_minute: artifact.upper_bound_weight_per_minute, evidence_sha256: artifact.evidence_sha256,
    web_sha: artifact.web_sha, target_sha: manifest.target_sha, runtime_sha256: manifest.runtime_sha256,
    fleet: fleet.status, runtime_source: source.status, runtime_file_count: source.files.length,
    enabled_shards: enabled.length, changes_trading: false, admission_or_activation: false,
    sql_has_automatic_web_sha_gate: false, recertify_after_relevant_web_change: true };
  if (!record) return { status: "SLOT_WORKLOAD_VERIFIED_NOT_RECORDED", ...summary };
  // Recheck current main/runtime after the SSH observations, before the only write.
  const finalSource = sourceVerifier(manifest, repo);
  if (finalSource.status !== "FLEET_CODE_PASS" || finalSource.cached_main_sha !== source.cached_main_sha)
    fail("SLOT_WORKLOAD_EVIDENCE_SOURCE_MISMATCH");
  let receipt;
  try { receipt = cli.query(buildRecordSQL(after, certificate, artifact), "receipt"); }
  catch (error) {
    if (["SLOT_WORKLOAD_CLI_COMMAND_FAILED", "SLOT_WORKLOAD_CLI_ROWS_INVALID", "SLOT_WORKLOAD_CLI_JSON_INVALID"].includes(error?.message))
      fail("SLOT_WORKLOAD_RECORD_OUTCOME_UNKNOWN_READ_BACK");
    throw error;
  }
  if (receipt?.status !== "SLOT_WORKLOAD_PROFILE_RECORDED" || receipt.shard_id !== artifact.shard_id
    || receipt.slot_count !== artifact.slot_count || receipt.evidence_sha256 !== artifact.evidence_sha256)
    fail("SLOT_WORKLOAD_RECORD_OUTCOME_UNKNOWN_READ_BACK");
  return { status: receipt.status, ...summary };
}

export function parseArguments(args) {
  const options = { record: false }; let mode = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--verify" || key === "--record") {
      if (mode) fail("SLOT_WORKLOAD_USAGE_INVALID"); mode = true; options.record = key === "--record";
    } else {
      const name = { "--evidence": "evidencePath", "--cli": "cliPath", "--ssh-key": "keyPath", "--ssh-user": "sshUser" }[key];
      if (!name || options[name] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) fail("SLOT_WORKLOAD_USAGE_INVALID");
      options[name] = args[++index];
    }
  }
  if (!options.evidencePath || !options.keyPath) fail("SLOT_WORKLOAD_USAGE_INVALID");
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args), file = resolve(options.evidencePath);
  let artifact;
  try { if (!lstatSync(file).isFile() || lstatSync(file).size > 2 * 1024 * 1024) fail("SLOT_WORKLOAD_EVIDENCE_INVALID");
    artifact = JSON.parse(readFileSync(file, "utf8")); } catch { return fail("SLOT_WORKLOAD_EVIDENCE_INVALID"); }
  return certifySlotWorkload({ ...options, artifact, cli: createCLI({ path: options.cliPath }) });
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    const code = /^(?:SLOT_WORKLOAD|CAPACITY|FLEET|COINOPS_ADMISSION)_[A-Z0-9_]+$/.test(error?.message ?? "")
      ? error.message : "SLOT_WORKLOAD_CERTIFICATION_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "FAIL", code })}\n`); process.exitCode = 1;
  });
}

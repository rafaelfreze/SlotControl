import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { readManifest } from "../../apps/live-executor/deploy/fleet-parity.mjs";
import { artifactDigest, buildRecordSQL, canonicalJSON, certifySlotWorkload, createCLI, mergeCertificate,
  parseArguments, parseCLIJSON, REQUIRED_SCENARIOS, SNAPSHOT_SQL, validateArtifact } from "./certify-slot-workload.mjs";

// All PASS values below are synthetic unit/SQL fixtures, never a workload or
// Production certificate. No authenticated CLI, SSH, env, vault or network runs.
const manifest = readManifest();
const webSha = "a".repeat(40), workloadHash = "e".repeat(64), policy = "capacity-v3-20260930";
const now = Date.parse("2026-10-16T20:00:00.000Z");
function artifact(changes = {}) {
  const result = { contract: "SLOT_WORKLOAD_EVIDENCE_V1", environment: "REAL", shard_id: "executor-03",
    slot_count: 50, capacity_units: 4, upper_bound_weight_per_minute: 3400,
    scenarios: Object.fromEntries(REQUIRED_SCENARIOS.map(key => [key, "PASS"])),
    target_sha: manifest.target_sha, runtime_sha256: manifest.runtime_sha256, node_version: manifest.node_version,
    web_sha: webSha, web_workload_sha256: workloadHash, policy_version: policy, observed_at: new Date(now).toISOString(),
    results: { fixture: "SYNTHETIC_NOT_FOR_RECORDING", tests: 7 }, ...changes };
  result.evidence_sha256 = artifactDigest(result); return result;
}
function controls() {
  const release = { singleton: true, target_sha: manifest.target_sha, runtime_sha256: manifest.runtime_sha256,
    node_version: manifest.node_version, policy_version: policy, verified_at: new Date(now - 10_000).toISOString() };
  return { registry: [1, 2, 3, 4].map(n => ({ id: `executor-0${n}`, egress_ipv4: `192.0.2.${n}/32`,
    enabled: n < 4, binance_limit_per_min: 6000, admission_ratio: .65, incremental_engine_weight: 900,
    created_at: new Date(now - 100_000).toISOString() })), release,
    policy: { version: policy, incremental_weight: 900, binance_limit: 6000, admission_ratio: .65 },
    attestations: [1, 2, 3, 4].map(n => ({ shard_id: `executor-0${n}`, egress_ipv4: `192.0.2.${n}/32`,
      ...Object.fromEntries(Object.entries(release).filter(([key]) => key !== "singleton")),
      evidence: { retained_field: { shard: n }, config_status: "PASS", slot_workload: {
        contract: "SLOT_WORKLOAD_V1", environment: "REAL", target_sha: manifest.target_sha,
        runtime_sha256: manifest.runtime_sha256, policy_version: policy,
        profiles: [{ slot_count: 75, status: "PASS", capacity_units: 4, upper_bound_weight_per_minute: 3500,
          evidence_sha256: "c".repeat(64), scenarios: Object.fromEntries(REQUIRED_SCENARIOS.map(key => [key, "PASS"])) }] } } })) };
}
function snapshot(value = controls()) {
  return { product: "CoinOps", project_ref: "otdfpmsegjxpqrzisfmi", schema: "coinops", schema_exists: true,
    read_only: "on", observed_at: new Date(now).toISOString(), controls: value,
    certification_evidence: value.registry.filter(row => row.enabled).map(row => ({ shard_id: row.id,
      executor_version: manifest.target_sha, registry_match: true, binance_weight_samples: 15,
      ...Object.fromEntries(["observed_at", "heartbeat_at", "weight_observed_at", "watchdog_checked_at"].map(key => [key, new Date(now).toISOString()])) })) };
}
function proof(shard) {
  return { shard_id: shard.id, ip: shard.ip, observed_at: new Date(now).toISOString(), probe_contract_version: 1,
    node_version: manifest.node_version, runtime_sha256: manifest.runtime_sha256,
    process_identity_verified: true, code_loaded_evidence: "DISK_UNCHANGED_SINCE_PROCESS_START",
    service: { active_state: "active", sub_state: "running", pid: 123, user: "coinops", uid: 1000,
      protect_system: "strict", no_new_privileges: "yes", private_tmp: "yes" },
    health: { healthy: true, executor_shard_id: shard.id, egress_ipv4: shard.ip, egress_ipv4_verified: true,
      clock: new Date(now).toISOString(), actual_executor_version: manifest.target_sha } };
}
function fakeCLI(first = snapshot(), second = structuredClone(first)) {
  const reads = [], writes = []; let count = 0;
  return { reads, writes, verifyProject() { reads.push("PROJECT"); }, query(sql, field) {
    if (field === "snapshot") { reads.push(sql); return structuredClone(count++ ? second : first); }
    writes.push(sql); return { status: "SLOT_WORKLOAD_PROFILE_RECORDED", shard_id: "executor-03", slot_count: 50,
      evidence_sha256: artifact().evidence_sha256, web_workload_sha256: workloadHash };
  } };
}
const sourceVerifier = () => ({ status: "FLEET_CODE_PASS", cached_main_sha: webSha, head_sha: webSha,
  web_workload_sha256: workloadHash,
  files: [{ path: "apps/live-executor/src/server.mjs", sha256: "d".repeat(64) }] });
const options = cli => ({ artifact: artifact(), manifest, cli, sourceVerifier, probe: proof,
  keyPath: "fixture-key-path-never-read", now: () => now });

test("artifact hash covers every attached result; exact count, all7scenarios and conservative units required", () => {
  assert.equal(validateArtifact(artifact(), now).slot_count, 50);
  assert.equal(canonicalJSON({ z: [2, 1], a: { b: true, a: null } }), '{"a":{"a":null,"b":true},"z":[2,1]}');
  for (const changes of [{ slot_count: 25 }, { slot_count: 101 }, { capacity_units: 3 }, { capacity_units: 4.5 },
    { upper_bound_weight_per_minute: 3601 }, { scenarios: {} }, { environment: "TESTNET" },
    { web_workload_sha256: undefined }, { observed_at: new Date(now + 10_001).toISOString() }]) {
    if (changes.web_workload_sha256 === undefined && Object.hasOwn(changes, "web_workload_sha256")) {
      const missing = artifact(); delete missing.web_workload_sha256; missing.evidence_sha256 = artifactDigest(missing);
      assert.throws(() => validateArtifact(missing, now), /EVIDENCE_INVALID/);
    } else assert.throws(() => validateArtifact(artifact(changes), now), /EVIDENCE_INVALID/);
  }
  const tampered = artifact(); tampered.results.tests++;
  assert.throws(() => validateArtifact(tampered, now), /EVIDENCE_INVALID/);
  for (const key of REQUIRED_SCENARIOS) {
    const incomplete = artifact(); incomplete.scenarios[key] = "NOT_TESTED"; incomplete.evidence_sha256 = artifactDigest(incomplete);
    assert.throws(() => validateArtifact(incomplete, now), /EVIDENCE_INVALID/);
  }
});
test("CLI2.121 single JSON boundary handles notices and braces in strings; ambiguous/truncated output fails", () => {
  const expected = { rows: [{ snapshot: { message: 'a } and [ escaped " value', children: [1, 2] } }] };
  assert.deepEqual(parseCLIJSON(`Connecting to remote database...\n${JSON.stringify(expected, null, 2)}\n`), expected);
  assert.deepEqual(parseCLIJSON('\uFEFF[ {"id":"project"} ]'), [{ id: "project" }]);
  for (const output of ['{"rows":[]', '{}\n{}', 'not JSON', '{notjson}\n']) assert.throws(() => parseCLIJSON(output), /CLI_JSON_INVALID/);
});
test("CLI wrapper enforces exact project/organization and explicit project-ref without reading secrets", () => {
  const calls = [];
  const cli = createCLI({ path: "fixture-supabase", runner(_file, args) {
    calls.push(args); if (args[0] === "--version") return "2.121.0\n";
    if (args[0] === "projects") return JSON.stringify([{ id: "otdfpmsegjxpqrzisfmi", name: "OnPlay Platform", organization_id: "pzgqtvaitaawqgaabxve" }]);
    return JSON.stringify({ rows: [{ snapshot: { correct: true } }] });
  } });
  cli.verifyProject(); assert.deepEqual(cli.query("BEGIN READ ONLY; SELECT 1; COMMIT;", "snapshot"), { correct: true });
  assert.deepEqual(calls[2].slice(0, 7), ["db", "query", "--linked", "--project-ref", "otdfpmsegjxpqrzisfmi", "--output", "json"]);
  assert.throws(() => createCLI({ path: "fixture", runner: () => "2.120.0" }), /VERSION_UNSUPPORTED/);
  const wrong = createCLI({ path: "fixture", runner: (_file, args) => args[0] === "--version" ? "2.121.0" : '[{"id":"other"}]' });
  assert.throws(() => wrong.verifyProject(), /PROJECT_IDENTITY_DENIED/);
});
test("VERIFY is the default, discovers full fleet twice, and performs zero writes", async () => {
  const cli = fakeCLI(), result = await certifySlotWorkload(options(cli));
  assert.equal(result.status, "SLOT_WORKLOAD_VERIFIED_NOT_RECORDED"); assert.equal(result.enabled_shards, 3);
  assert.equal(cli.reads.length, 3); assert.equal(cli.writes.length, 0);
  assert.equal(result.admission_or_activation, false);
  assert.equal(parseArguments(["--evidence", "fixture.json", "--ssh-key", "fixture-key"]).record, false);
  assert.throws(() => parseArguments(["--record", "--verify", "--evidence", "x", "--ssh-key", "k"]), /USAGE_INVALID/);
});
test("absent or incomplete real evidence cannot start remote verification or recording", async () => {
  const cli = fakeCLI();
  await assert.rejects(certifySlotWorkload({ ...options(cli), artifact: undefined, record: true }), /EVIDENCE_INVALID/);
  const incomplete = artifact({ scenarios: { STEADY: "PASS" } });
  await assert.rejects(certifySlotWorkload({ ...options(cli), artifact: incomplete, record: true }), /EVIDENCE_INVALID/);
  assert.equal(cli.reads.length, 0); assert.equal(cli.writes.length, 0);
});
test("same-release merge replaces only the exact count, retaining every other profile/evidence and disabled shard", async () => {
  const first = snapshot(), cli = fakeCLI(first);
  const result = await certifySlotWorkload({ ...options(cli), record: true });
  assert.equal(result.status, "SLOT_WORKLOAD_PROFILE_RECORDED"); assert.equal(cli.writes.length, 1);
  const sql = cli.writes[0];
  assert.equal((sql.match(/outcome:=coinops\.certify_executor_admission\(/g) ?? []).length, 1);
  assert.match(sql, /actual IS DISTINCT FROM expected/); assert.match(sql, /SHARE ROW EXCLUSIVE MODE/);
  assert.match(sql, /private\.coinops_slot_workload_profile\('executor-03','REAL',50\)/);
  assert.match(sql, /set_config\('request.headers'/);
  assert.match(sql, /profile->>'web_workload_sha256' IS DISTINCT FROM/);
  assert.doesNotMatch(sql, /UPDATE coinops\.(?:trading_engines|robot_v1)|DELETE FROM|INSERT INTO coinops\.robot_v1/i);
  const fresh = { p_target_sha: manifest.target_sha, p_runtime_sha256: manifest.runtime_sha256,
    p_node_version: manifest.node_version, p_policy_version: policy,
    p_evidence: [1, 2, 3].map(n => ({ shard_id: `executor-0${n}`, status: "PASS", config_status: "PASS" })) };
  const merged = mergeCertificate(fresh, first.controls, artifact());
  for (const n of [0, 1]) assert.deepEqual(merged.p_evidence[n].slot_workload, first.controls.attestations[n].evidence.slot_workload);
  assert.deepEqual(merged.p_evidence[2].retained_field, { shard: 3 });
  assert.deepEqual(merged.p_evidence[2].slot_workload.profiles.find(row => row.slot_count === 75), first.controls.attestations[2].evidence.slot_workload.profiles[0]);
  assert.equal(merged.p_evidence[2].slot_workload.profiles.filter(row => row.slot_count === 50).length, 1);
  assert.equal(first.controls.attestations[3].evidence.retained_field.shard, 4);
});
test("registry/release/evidence races, stale telemetry and incompatible old proofs fail before any write", async () => {
  for (const mutate of [value => { value.controls.registry[3].enabled = true; },
    value => { value.controls.attestations[1].evidence.concurrent = true; },
    value => { value.controls.release.verified_at = new Date(now).toISOString(); },
    value => { value.certification_evidence[2].heartbeat_at = new Date(now - 120_001).toISOString(); }]) {
    const second = snapshot(); mutate(second); const cli = fakeCLI(snapshot(), second);
    await assert.rejects(certifySlotWorkload({ ...options(cli), record: true }), /CONCURRENT_CHANGE|EVIDENCE_STALE/);
    assert.equal(cli.writes.length, 0);
  }
  const first = snapshot(); first.controls.attestations[2].evidence.slot_workload.runtime_sha256 = "e".repeat(64);
  const cli = fakeCLI(first); await assert.rejects(certifySlotWorkload({ ...options(cli), record: true }), /PROFILE_SCOPE_MISMATCH/);
  assert.equal(cli.writes.length, 0);
});
test("unverified fleet/current-main mismatch/unknown write response never retry or enable an engine", async () => {
  const cli = fakeCLI(); await assert.rejects(certifySlotWorkload({ ...options(cli), record: true,
    probe: shard => ({ ...proof(shard), code_loaded_evidence: "UNKNOWN" }) }), /FLEET_UNVERIFIED/);
  assert.equal(cli.writes.length, 0);
  await assert.rejects(certifySlotWorkload({ ...options(fakeCLI()), sourceVerifier: () => ({ ...sourceVerifier(), cached_main_sha: "f".repeat(40) }) }), /SOURCE_MISMATCH/);
  await assert.rejects(certifySlotWorkload({ ...options(fakeCLI()), sourceVerifier: () => ({ ...sourceVerifier(), web_workload_sha256: "f".repeat(64) }) }), /SOURCE_MISMATCH/);
  const uncertain = fakeCLI(), original = uncertain.query;
  uncertain.query = (sql, field) => { if (field === "receipt") { uncertain.writes.push(sql); throw new Error("SLOT_WORKLOAD_CLI_JSON_INVALID"); } return original(sql, field); };
  await assert.rejects(certifySlotWorkload({ ...options(uncertain), record: true }), /OUTCOME_UNKNOWN_READ_BACK/);
  assert.equal(uncertain.writes.length, 1);
});

test("actual PostgreSQL transaction uses official RPC once, retains profiles, CAS rejects races and readback failure rolls back", async () => {
  const load = createRequire(new URL("../testing/account-pause-sql/package.json", import.meta.url));
  const { PGlite } = load("@electric-sql/pglite"); const db = new PGlite();
  try {
    await db.exec(`create schema coinops; create schema private;
      create table coinops.executor_shards(id text primary key,egress_ipv4 inet,enabled boolean,binance_limit_per_min int,
        admission_ratio numeric,incremental_engine_weight int,created_at timestamptz default now());
      create table coinops.executor_admission_release(singleton boolean primary key,target_sha text,runtime_sha256 text,
        node_version text,policy_version text,verified_at timestamptz);
      create table coinops.executor_admission_attestations(shard_id text primary key,egress_ipv4 inet,target_sha text,
        runtime_sha256 text,node_version text,policy_version text,verified_at timestamptz,evidence jsonb);
      create table coinops.executor_capacity_samples(shard_id text primary key,executor_version text,registry_match boolean,
        observed_at timestamptz,heartbeat_at timestamptz,weight_observed_at timestamptz,binance_weight_samples int);
      create table coinops.watchdog_checks(shard_id text,checked_at timestamptz);
      create function coinops.executor_capacity_policy() returns jsonb language sql as $$select '{"version":"${policy}","incremental_weight":900,"binance_limit":6000,"admission_ratio":0.65}'::jsonb$$;`);
    const original = readFileSync(new URL("../../supabase/migrations/20260929212150_coinops_canonical_admission_policy.sql", import.meta.url), "utf8");
    await db.exec(original.slice(original.indexOf("create function coinops.certify_executor_admission("), original.indexOf("revoke all on function coinops.certify_executor_admission(")));
    const variable = readFileSync(new URL("../../supabase/migrations/20261016192533_bind_slot_workload_web_fingerprint.sql", import.meta.url), "utf8");
    await db.exec("create role anon; create role authenticated; create role service_role;");
    await db.exec(variable);
    for (const [role, allowed] of [["anon", false], ["authenticated", false], ["service_role", true]])
      assert.equal((await db.query("select has_function_privilege($1,'private.coinops_slot_workload_profile(text,text,integer)','EXECUTE') allowed", [role])).rows[0].allowed, allowed);
    const value = controls();
    const literal = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
    for (const row of value.registry) await db.query(`insert into coinops.executor_shards values($1,$2,$3,6000,.65,900,now())`, [row.id, row.egress_ipv4, row.enabled]);
    await db.exec(`insert into coinops.executor_admission_release values(true,'${manifest.target_sha}','${manifest.runtime_sha256}','${manifest.node_version}','${policy}',now());`);
    for (const row of value.attestations) await db.query(`insert into coinops.executor_admission_attestations values($1,$2,$3,$4,$5,$6,now(),$7)`,
      [row.shard_id, row.egress_ipv4, manifest.target_sha, manifest.runtime_sha256, manifest.node_version, policy, row.evidence]);
    await db.exec(`insert into coinops.executor_capacity_samples select id,'${manifest.target_sha}',true,now(),now(),now(),15 from coinops.executor_shards;
      insert into coinops.watchdog_checks select id,now() from coinops.executor_shards;`);
    const read = async () => (await db.exec(SNAPSHOT_SQL)).find(result => result.rows?.[0]?.snapshot).rows[0].snapshot.controls;
    const before = await read();
    const cert = { p_target_sha: manifest.target_sha, p_runtime_sha256: manifest.runtime_sha256,
      p_node_version: manifest.node_version, p_policy_version: policy,
      p_evidence: before.registry.filter(row => row.enabled).map(row => ({ shard_id: row.id,
        ip: row.egress_ipv4.replace(/\/32$/, ""), status: "PASS", config_status: "PASS", actual_sha: manifest.target_sha,
        runtime_sha256: manifest.runtime_sha256, node_version: manifest.node_version, observed_at: new Date().toISOString() })) };
    const merged = mergeCertificate(cert, before, artifact());
    await db.exec(buildRecordSQL(before, merged, artifact()));
    // CLI's request-local header must not leak to later sessions. These reads
    // emulate actual PostgREST headers; legacy25 remains header-independent.
    const profile = async (count, headers) => {
      await db.query("select set_config('request.headers',$1,false)", [headers]);
      return (await db.query("select private.coinops_slot_workload_profile('executor-03','REAL',$1) v", [count])).rows[0].v;
    };
    assert.equal((await profile(50, JSON.stringify({ "x-coinops-workload-sha256": workloadHash }))).code, "SLOT_WORKLOAD_CERTIFIED");
    for (const headers of ["", "{}", "not-json", JSON.stringify({ "x-coinops-workload-sha256": "f".repeat(64) })])
      assert.equal((await profile(50, headers)).code, "SLOT_WORKLOAD_UNCERTIFIED");
    assert.equal((await profile(25, "not-json")).basis, "LEGACY_25_SLOT_PROFILE");
    const saved = await read();
    for (const row of saved.attestations) {
      const previous = before.attestations.find(old => old.shard_id === row.shard_id);
      assert.deepEqual(row.evidence.retained_field, previous.evidence.retained_field);
      if (row.shard_id !== "executor-03") assert.deepEqual(row.evidence.slot_workload, previous.evidence.slot_workload);
    }
    assert.equal(saved.attestations[2].evidence.slot_workload.profiles.find(row => row.slot_count === 50).evidence_sha256, artifact().evidence_sha256);
    assert.deepEqual(saved.attestations[3], before.attestations[3]);
    await db.exec(`update coinops.executor_admission_attestations set evidence=evidence||'{"concurrent":true}' where shard_id='executor-02'`);
    await assert.rejects(db.exec(buildRecordSQL(saved, merged, artifact())), /CONCURRENT_CHANGE/); await db.exec("rollback");
    const raced = await read(); assert.equal(raced.attestations[1].evidence.concurrent, true);
    const bad = structuredClone(merged); bad.p_evidence[2].slot_workload.profiles = [];
    await assert.rejects(db.exec(buildRecordSQL(raced, bad, artifact())), /READBACK_FAILED/); await db.exec("rollback");
    assert.deepEqual(await read(), raced);
    assert.match(literal({ apostrophe: "safe's" }), /safe''s/);
  } finally { await db.close(); }
});

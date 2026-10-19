import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyNonceMaintenance } from "../deploy/nonce-maintenance.mjs";

const asset = (name) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), "utf8");
const metrics = { files: 1_000_000, ffree: 600_000 };
const pass = { stopped: "COMPLETE", deleted: 123 };

test("maintenance distinguishes whole sweep, bounded progress, starvation, clock faults and inode pressure", () => {
  assert.equal(classifyNonceMaintenance(pass, metrics).code, "NONCE_MAINTENANCE_COMPLETE");
  for (const stopped of ["SCAN_LIMIT", "TIME_LIMIT", "DELETE_LIMIT"]) {
    const progress = classifyNonceMaintenance({ stopped, deleted: 1 }, metrics);
    assert.equal(progress.code, "NONCE_MAINTENANCE_INCOMPLETE");
    assert.equal(progress.complete_sweep, false);
    assert.equal(progress.requires_attention, false);
    assert.equal(classifyNonceMaintenance({ stopped, deleted: 0 }, metrics).code, "NONCE_MAINTENANCE_SCAN_STALLED");
    const pressured = classifyNonceMaintenance({ stopped, deleted: 1 }, { ...metrics, ffree: 1 });
    assert.equal(pressured.code, "NONCE_MAINTENANCE_INODE_PRESSURE");
    assert.equal(pressured.requires_attention, true);
  }
  assert.equal(classifyNonceMaintenance(pass, { ...metrics, ffree: 0 }).code, "NONCE_MAINTENANCE_INODE_PRESSURE");
  assert.equal(classifyNonceMaintenance({ ...pass, stopped: "CLOCK_ROLLBACK" }, metrics).code, "NONCE_MAINTENANCE_CLOCK_UNSAFE");
  for (const patch of [{ files: 0 }, { files: NaN }, { ffree: -1 }, { ffree: 1_000_001 }, { ffree: 0.5 }])
    assert.throws(() => classifyNonceMaintenance(pass, { ...metrics, ...patch }), /EVIDENCE_INVALID/);
  assert.throws(() => classifyNonceMaintenance({ stopped: "ASSUMED_COMPLETE", deleted: 0 }, metrics), /EVIDENCE_INVALID/);
});

test("maintenance unit has separate nonroot sandbox, no secrets/network and only nonce/lock write access", () => {
  const unit = asset("coinops-nonce-retention.service");
  for (const expected of ["User=coinops-executor", "Group=coinops-executor", "ProtectSystem=strict", "PrivateNetwork=true",
    "NoNewPrivileges=true", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=yes", "InaccessiblePaths=/etc/coinops",
    "ReadOnlyPaths=/var/lib/coinops-live-executor", "Nice=10", "IOSchedulingClass=idle", "TimeoutStartSec=1d"])
    assert.ok(unit.includes(expected), expected);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/coinops-live-executor\/nonces \/run\/coinops-nonce-retention$/m);
  assert.doesNotMatch(unit, /EnvironmentFile|PartOf|Requires=coinops-live-executor|Restart=|AF_INET/);
  assert.match(asset("coinops-nonce-retention.timer"), /OnUnitInactiveSec=1min/);
  assert.doesNotMatch(asset("coinops-nonce-retention.timer"), /coinops-live-executor\.service|Persistent=true/);
});

test("singleton wrapper uses one fixed private flock inode and only a reviewed immutable maintenance release", () => {
  const code = asset("run-nonce-retention.sh");
  assert.match(code, /exec 9>"\$lock_file"/);
  assert.match(code, /flock --exclusive --nonblock 9/);
  assert.match(code, /stat -c %h.*== 1/);
  assert.match(code, /\/opt\/coinops\/maintenance\/releases\/\[a-f0-9\]\{40\}/);
  assert.match(code, /node "\$script_directory\/nonce-maintenance\.mjs" --apply/);
  assert.doesNotMatch(code, /EnvironmentFile|source |live-executor\.env|curl |wget |rm |find .*delete/);
});

test("installer verifies official Git blobs and service identity before installing a public maintenance-only release", () => {
  const code = asset("install-nonce-retention.sh");
  for (const expected of ["https://github.com/rafaelfreze/SlotControl.git", "SHA_NOT_IN_MAIN", "PUBLIC_MAINTENANCE_BLOB_REQUIRED",
    "MAINTENANCE_PUBLIC_FILE_HASH_MISMATCH", 'hash-object "$candidate"', 'rev-parse "$revision:$file"',
    "runuser -u", "--dry-run", "systemd-analyze verify", "ExecMainStartTimestampMonotonic", "executor_restart=NO",
    "MAINTENANCE_FINGERPRINT_INVALID", "MAINTENANCE_PUBLIC_DIRECTORY_INVALID", "MAINTENANCE_EXISTING_UNIT_NOT_PUBLIC_ROOT_FILE"])
    assert.ok(code.includes(expected), expected);
  assert.ok(code.indexOf("SHA_NOT_IN_MAIN") < code.indexOf('install -d -o root'));
  assert.ok(code.indexOf("MAINTENANCE_DRY_RUN_FAILED") < code.indexOf("systemctl enable --now"));
  assert.ok(code.indexOf("systemd-analyze verify") < code.indexOf("systemctl enable --now"));
  assert.doesNotMatch(code, /systemctl (?:restart|stop|start) coinops-live-executor|set_version|COINOPS_EXECUTOR_VERSION=|reset --hard|rm -rf|SUPABASE|fleet-parity\.mjs/);
  assert.match(code, /systemctl enable --now coinops-nonce-retention\.timer/);
});

test("future deploys install maintenance after health, including already-deployed no-restart branches", () => {
  for (const file of ["deploy-legacy.sh", "deploy-shard.sh"]) {
    const code = asset(file);
    assert.match(code, /MAINTENANCE_MAIN_SHA/);
    const calls = [...code.matchAll(/bash "\$script_directory\/install-nonce-retention\.sh" "\$maintenance_revision"/g)];
    assert.equal(calls.length, 2, file);
    assert.ok(calls[0].index < code.indexOf("printf 'ALREADY_DEPLOYED"));
    assert.ok(calls[1].index < code.indexOf("printf 'DEPLOY_HEALTHY"));
  }
  const bootstrap = asset("bootstrap-new-shard.sh");
  assert.match(bootstrap, /install -m 644.*coinops-nonce-retention\.service/);
  assert.match(bootstrap, /NONCE_MAINTENANCE_NOT_STARTED/);
  assert.doesNotMatch(bootstrap, /enable --now coinops-nonce-retention/);
});

test("maintenance runner is a separate import graph, never a financial runtime dependency", () => {
  const runner = asset("nonce-maintenance.mjs");
  assert.match(runner, /for await \(const result of sweepExpiredNonces\(options\)\)/);
  assert.match(runner, /nonce-retention\.mjs/);
  assert.doesNotMatch(runner, /server\.mjs|security\.mjs|process\.env|fetch\(|node:https|setTimeout/);
  const server = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(server, /nonce-retention\.mjs|nonce-maintenance\.mjs/);
});

test("maintenance CLI rejects arbitrary path or bypass arguments without leaking them", () => {
  const file = fileURLToPath(new URL("../deploy/nonce-maintenance.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [file, "--state-directory", "/private/not-the-cache"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), { error: "NONCE_MAINTENANCE_ARGUMENT_INVALID" });
  assert.equal(result.stdout, "");
});

test("shell maintenance and integration assets parse without executing host operations", (t) => {
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
  if (!existsSync(bash)) { t.skip("Bash syntax check requires an existing local Bash"); return; }
  for (const file of ["install-nonce-retention.sh", "run-nonce-retention.sh", "bootstrap-new-shard.sh", "deploy-legacy.sh", "deploy-shard.sh"]) {
    const result = spawnSync(bash, ["-n"], { input: asset(file), encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, opendir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MIN_NONCE_RETENTION_MS, parseNonceRetentionArgs,
  pruneExpiredNonces, runNonceRetentionSweep, sweepExpiredNonces } from "../src/nonce-retention.mjs";
import { requestSignature, sha256, verifySignedRequest } from "../src/security.mjs";

const NOW = 1_792_412_800_000;
const OLD = NOW - 2 * MIN_NONCE_RETENTION_MS;
const modulePath = fileURLToPath(new URL("../src/nonce-retention.mjs", import.meta.url));
const moduleURL = new URL("../src/nonce-retention.mjs", import.meta.url).href;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const linuxOnly = process.platform !== "linux" ? "Kernel flock apply is deliberately Linux-only; run fixtures on Linux too" : false;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "coinops-nonce-retention-test-"));
  const stateDirectory = join(root, "state"), nonceDirectory = join(stateDirectory, "nonces");
  const lockDirectory = join(root, "maintenance"), lockPath = join(lockDirectory, "maintenance.lock");
  await mkdir(nonceDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700); await chmod(nonceDirectory, 0o700);
  await mkdir(lockDirectory, { mode: 0o700 });
  await writeFile(lockPath, "", { mode: 0o600 });
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.match(basename(root), /^coinops-nonce-retention-test-/);
    await rm(root, { recursive: true, force: true });
  });
  return { root, stateDirectory, nonceDirectory, lockPath };
}

async function nonce(f, name, timestamp = OLD, modified = timestamp, content = String(timestamp)) {
  const path = join(f.nonceDirectory, name);
  await writeFile(path, content, { mode: 0o600 });
  await utimes(path, new Date(modified), new Date(modified));
  return path;
}

function underFlock(f, patch = {}, hold = false) {
  const options = { stateDirectory: f.stateDirectory, lockPath: f.lockPath, lockFd: 9, apply: true, ...patch };
  const input = `import {pruneExpiredNonces,runNonceRetentionSweep} from ${JSON.stringify(moduleURL)};
    const options = ${JSON.stringify(options)};
    const result = await (options.sweep ? runNonceRetentionSweep : pruneExpiredNonces)({...options, now:()=>${NOW}});
    console.log(JSON.stringify(result));`;
  const script = `exec 9>"$1"; flock --exclusive --nonblock 9 || exit 73; ${hold ? "printf HELD; exec sleep 30" : 'exec "$2" --input-type=module -'}`;
  return { script, options, input, args: ["-c", script, "nonce-fixture", f.lockPath, process.execPath] };
}

function applyFixture(f, patch) {
  const { args, input } = underFlock(f, patch);
  const child = spawnSync("bash", args, { input, encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("default is a nonmutating, bounded, one-hour dry-run of exact nonce files", async (t) => {
  const f = await fixture(t), old = await nonce(f, hash("old"));
  await nonce(f, hash("fresh"), NOW - 10_000);
  const result = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, now: () => NOW });
  assert.deepEqual({ ...result, elapsed_ms: 0 }, { mode: "DRY_RUN", retention_ms: 3_600_000,
    scanned: 2, candidates: 1, deleted: 0, preserved: 1, raced: 0, stopped: "COMPLETE", elapsed_ms: 0 });
  assert.equal(await readFile(old, "utf8"), String(OLD));
});

test("malformed, future, newly touched, nested and non-SHA entries are preserved", async (t) => {
  const f = await fixture(t);
  await nonce(f, hash("future-content"), NOW + 1, OLD);
  await nonce(f, hash("future-mtime"), OLD, NOW + 1);
  await nonce(f, hash("new-mtime"), OLD, NOW - 5_000);
  await nonce(f, hash("malformed"), OLD, OLD, "xxxxxxxxxxxxx");
  await nonce(f, hash("zero"), OLD, OLD, "0000000000000");
  await nonce(f, hash("long"), OLD, OLD, `${OLD}\n`);
  await nonce(f, hash("short"), OLD, OLD, "123");
  await nonce(f, hash("high-bit"), OLD, OLD, Buffer.from(String(OLD), "ascii").map((value) => value | 0x80));
  await nonce(f, hash("capital-claim") + ".pending");
  await nonce(f, hash("financial-result") + ".json");
  await nonce(f, "not-a-nonce");
  await mkdir(join(f.nonceDirectory, hash("directory")), { mode: 0o700 });
  const result = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, now: () => NOW });
  assert.equal(result.scanned, 12); assert.equal(result.preserved, 12);
  assert.equal(result.candidates, 0); assert.equal(result.deleted, 0);
});

test("single-link-only rule preserves even expired SHA-shaped hardlinks", async (t) => {
  const f = await fixture(t), original = await nonce(f, hash("linked-original"));
  await link(original, join(f.nonceDirectory, hash("linked-alias")));
  const result = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, now: () => NOW });
  assert.equal(result.scanned, 2); assert.equal(result.candidates, 0); assert.equal(result.preserved, 2);
});

test("scan limit bounds streaming work independently of directory size", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 130; index++) await nonce(f, hash(index));
  const result = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, maxScanned: 7, now: () => NOW });
  assert.equal(result.scanned, 7); assert.equal(result.candidates, 7); assert.equal(result.stopped, "SCAN_LIMIT");
  const source = await readFile(modulePath, "utf8");
  assert.match(source, /opendir\(anchored, \{ bufferSize: 32 \}\)/);
  assert.doesNotMatch(source, /readdir\(|\.sort\(|Promise\.all\(.*map/);
});

test("candidate and monotonic-time limits stop dry-runs without changing files", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 4; index++) await nonce(f, hash(index));
  const deletionBound = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, maxDeleted: 2, now: () => NOW });
  assert.equal(deletionBound.candidates, 2); assert.equal(deletionBound.stopped, "DELETE_LIMIT");
  let ticks = 0;
  const timed = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, maxDurationMs: 1,
    now: () => NOW, monotonicNow: () => ticks++ * 2 });
  assert.equal(timed.scanned, 0); assert.equal(timed.stopped, "TIME_LIMIT");
});

test("clock rollback stops the pass before processing another nonce", async (t) => {
  const f = await fixture(t); await nonce(f, hash("old"));
  let calls = 0;
  const result = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, now: () => NOW - calls++ });
  assert.equal(result.stopped, "CLOCK_ROLLBACK"); assert.equal(result.scanned, 0); assert.equal(result.deleted, 0);
});

test("full sweep keeps one iterator across bounded batches; a fresh prefix cannot starve an old tail", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 6; index++) await nonce(f, hash(index), NOW - 10_000);
  let last;
  for await (const entry of await opendir(f.nonceDirectory)) last = entry.name;
  await nonce(f, last, OLD);
  const batches = [];
  const result = await runNonceRetentionSweep({ stateDirectory: f.stateDirectory, maxScanned: 1,
    pauseMs: 0, now: () => NOW, onBatch: (batch) => batches.push(batch) });
  assert.equal(result.batches, 6); assert.equal(result.scanned, 6); assert.equal(result.candidates, 1);
  assert.equal(result.stopped, "COMPLETE");
  assert.ok(batches.slice(0, -1).every((batch) => batch.preserved === 1 && batch.candidates === 0
    && batch.scanned === 1 && batch.stopped === "SCAN_LIMIT"));
  assert.equal(batches.at(-1).candidates, 1); assert.equal(batches.at(-1).stopped, "COMPLETE");
});

test("full sweep can be closed early and clock rollback between batches never resumes deletion", async (t) => {
  const f = await fixture(t); await nonce(f, hash(1)); await nonce(f, hash(2));
  const sweep = sweepExpiredNonces({ stateDirectory: f.stateDirectory, maxScanned: 1, pauseMs: 0, now: () => NOW });
  assert.equal((await sweep.next()).value.scanned, 1);
  await sweep.return(); assert.equal((await sweep.next()).done, true);
  let current = NOW;
  const result = await runNonceRetentionSweep({ stateDirectory: f.stateDirectory, maxScanned: 1,
    pauseMs: 0, now: () => current, onBatch: (batch) => { if (batch.scanned === 1) current--; } });
  assert.equal(result.scanned, 1); assert.equal(result.candidates, 1); assert.equal(result.stopped, "CLOCK_ROLLBACK");
});

test("sub-hour retention and unsafe scan, deletion, clock or time budgets fail closed", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ retentionMs: 30_001 }, { maxScanned: 0 }, { maxDeleted: 0 },
    { maxDurationMs: 60_001 }, { maxScanned: 1_000_001 }, { apply: "yes" }, { now: () => NaN }]) {
    await assert.rejects(pruneExpiredNonces({ stateDirectory: f.stateDirectory, now: () => NOW, ...patch }), /NONCE_RETENTION_/);
  }
  await assert.rejects(pruneExpiredNonces({ stateDirectory: "." }), /EXPLICIT_STATE_DIRECTORY/);
  await assert.rejects(pruneExpiredNonces({ stateDirectory: parseRoot(f.root) }), /STATE_DIRECTORY_DENIED/);
  await assert.rejects(pruneExpiredNonces({ stateDirectory: f.nonceDirectory }), /STATE_DIRECTORY_DENIED/);
});
function parseRoot(path) { return resolve(path, "/").slice(0, process.platform === "win32" ? 3 : 1); }

test("live-window nonce replay remains rejected after maintenance dry-run", async (t) => {
  const f = await fixture(t), body = "{}", rawNonce = "fixture_replay_nonce_1234", secret = "offline-only-nonce-fixture-secret-long-enough";
  const headers = new Headers({ "x-coinops-timestamp": String(NOW), "x-coinops-nonce": rawNonce,
    "x-coinops-body-sha256": sha256(body), "x-coinops-signature": requestSignature(secret, "GET", "/fixture", NOW, rawNonce, body) });
  const verify = () => verifySignedRequest({ headers, method: "GET", path: "/fixture", body, secret,
    nonceDirectory: f.nonceDirectory, now: NOW });
  await verify();
  const result = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, now: () => NOW });
  assert.equal(result.candidates, 0); await assert.rejects(verify(), /EXECUTOR_NONCE_REPLAY/);
});

test("CLI parser is explicit, rejects duplicate/unknown options and has no bypass flag", () => {
  assert.deepEqual(parseNonceRetentionArgs(["--state-directory", "/private/state"]), { stateDirectory: "/private/state" });
  assert.deepEqual(parseNonceRetentionArgs(["--apply", "--sweep", "--lock-fd", "9", "--max-deleted", "2"]),
    { apply: true, sweep: true, lockFd: 9, maxDeleted: 2 });
  for (const args of [["--apply", "--apply"], ["--skip-lock"], ["--state-directory"],
    ["--max-deleted", "2", "--max-deleted", "3"], ["--force"]]) assert.throws(() => parseNonceRetentionArgs(args), /ARGUMENT_INVALID/);
});

test("core apply fails closed without a proven exclusive Linux flock", async (t) => {
  const f = await fixture(t); await nonce(f, hash("old"));
  await assert.rejects(pruneExpiredNonces({ stateDirectory: f.stateDirectory, apply: true, now: () => NOW }),
    process.platform === "linux" ? /LOCK_REQUIRED/ : /APPLY_REQUIRES_LINUX_FLOCK/);
  const result = await pruneExpiredNonces({ stateDirectory: f.stateDirectory, now: () => NOW });
  assert.equal(result.candidates, 1);
});

test("Linux apply deletes only expired private single-link nonces; replay and financial claims survive", { skip: linuxOnly }, async (t) => {
  const f = await fixture(t), old = await nonce(f, hash("old"));
  const fresh = await nonce(f, hash("fresh"), NOW - 10_000), malformed = await nonce(f, hash("bad"), OLD, OLD, "xxxxxxxxxxxxx");
  const pending = await nonce(f, hash("claim") + ".pending");
  await mkdir(join(f.stateDirectory, "live-write"), { mode: 0o700 });
  const financial = join(f.stateDirectory, "live-write", hash("order") + ".pending");
  await writeFile(financial, "uncertain-financial-dispatch", { mode: 0o600 });
  const rawNonce = "fixture_apply_replay_nonce", body = "{}", secret = "offline-only-apply-replay-secret-long-enough";
  const headers = new Headers({ "x-coinops-timestamp": String(NOW), "x-coinops-nonce": rawNonce,
    "x-coinops-body-sha256": sha256(body), "x-coinops-signature": requestSignature(secret, "GET", "/fixture", NOW, rawNonce, body) });
  const verify = () => verifySignedRequest({ headers, method: "GET", path: "/fixture", body, secret,
    nonceDirectory: f.nonceDirectory, now: NOW });
  await verify();
  const result = applyFixture(f);
  assert.equal(result.deleted, 1); assert.equal(result.candidates, 1); assert.equal(result.preserved, 4);
  await assert.rejects(lstat(old), { code: "ENOENT" });
  assert.equal(await readFile(fresh, "utf8"), String(NOW - 10_000));
  assert.equal(await readFile(malformed, "utf8"), "xxxxxxxxxxxxx");
  assert.equal(await readFile(pending, "utf8"), String(OLD));
  assert.equal(await readFile(financial, "utf8"), "uncertain-financial-dispatch");
  await assert.rejects(verify(), /EXECUTOR_NONCE_REPLAY/);
  assert.equal(applyFixture(f).deleted, 0);
});

test("Linux apply is deletion-bounded and safely resumes after a stopped pass", { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) await nonce(f, hash(index));
  const first = applyFixture(f, { maxDeleted: 2 });
  assert.equal(first.deleted, 2); assert.equal(first.stopped, "DELETE_LIMIT");
  const second = applyFixture(f); assert.equal(second.deleted, 3);
  assert.equal(applyFixture(f).deleted, 0);
});

test("Linux full sweep deletes an old tail after multiple protected-prefix batches without reopening the directory", { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 6; index++) await nonce(f, hash(index), NOW - 10_000);
  let last;
  for await (const entry of await opendir(f.nonceDirectory)) last = entry.name;
  await nonce(f, last, OLD);
  const result = applyFixture(f, { sweep: true, maxScanned: 1, pauseMs: 0 });
  assert.equal(result.batches, 6); assert.equal(result.scanned, 6); assert.equal(result.deleted, 1);
  assert.equal(result.preserved, 5); assert.equal(result.stopped, "COMPLETE");
  await assert.rejects(lstat(join(f.nonceDirectory, last)), { code: "ENOENT" });
});

test("Linux refuses nonprivate roots/cache/files, symlink paths and linked lock files", { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  const old = await nonce(f, hash("old")); await chmod(old, 0o644);
  assert.equal(applyFixture(f).deleted, 0);
  await chmod(f.nonceDirectory, 0o755);
  await assert.rejects(pruneExpiredNonces({ stateDirectory: f.stateDirectory }), /DIRECTORY_NOT_PRIVATE/);
  await chmod(f.nonceDirectory, 0o700); await chmod(f.stateDirectory, 0o755);
  await assert.rejects(pruneExpiredNonces({ stateDirectory: f.stateDirectory }), /DIRECTORY_NOT_PRIVATE/);
  await chmod(f.stateDirectory, 0o700);
  const alias = join(f.root, "state-link"); await symlink(f.stateDirectory, alias, "dir");
  await assert.rejects(pruneExpiredNonces({ stateDirectory: alias }), /SYMLINK_PATH_DENIED/);
  await link(f.lockPath, join(dirname(f.lockPath), "lock-alias"));
  const { args, input } = underFlock(f);
  const child = spawnSync("bash", args, { input, encoding: "utf8" });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /NONCE_RETENTION_LOCK_REQUIRED/);
});

test("Linux skips symlink candidates rather than following or deleting their target", { skip: linuxOnly }, async (t) => {
  const f = await fixture(t), target = join(f.stateDirectory, "financial-claim");
  await writeFile(target, String(OLD), { mode: 0o600 }); await utimes(target, new Date(OLD), new Date(OLD));
  const alias = join(f.nonceDirectory, hash("link")); await symlink(target, alias);
  const result = applyFixture(f); assert.equal(result.deleted, 0); assert.equal(result.preserved, 1);
  assert.equal((await lstat(alias)).isSymbolicLink(), true); assert.equal(await readFile(target, "utf8"), String(OLD));
});

test("Linux singleton kernel flock denies a concurrent cleaner before it reaches deletion", { skip: linuxOnly }, async (t) => {
  const f = await fixture(t); await nonce(f, hash("old"));
  const held = underFlock(f, {}, true), holder = spawn("bash", held.args, { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((done) => holder.once("exit", done));
  t.after(async () => { if (holder.exitCode === null) holder.kill("SIGTERM"); await exited; });
  await new Promise((done, reject) => { holder.stdout.once("data", done); holder.once("error", reject); holder.once("exit", (code) => code && reject(new Error(`holder exit ${code}`))); });
  const next = underFlock(f), child = spawnSync("bash", next.args, { input: next.input, encoding: "utf8", timeout: 5_000 });
  assert.equal(child.status, 73); assert.equal(child.stdout, "");
  assert.equal((await pruneExpiredNonces({ stateDirectory: f.stateDirectory, now: () => NOW })).candidates, 1);
  holder.kill("SIGTERM"); await exited;
});

test("CLI emits sanitized errors, does not read environment or start network/server code", () => {
  const child = spawnSync(process.execPath, [modulePath, "--state-directory", "relative-secret-path"], { encoding: "utf8" });
  assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.deepEqual(JSON.parse(child.stderr), { error: "NONCE_RETENTION_EXPLICIT_STATE_DIRECTORY_REQUIRED" });
  assert.doesNotMatch(child.stderr, /relative-secret-path/);
});

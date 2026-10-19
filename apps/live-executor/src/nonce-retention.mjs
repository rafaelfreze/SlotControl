import { constants } from "node:fs";
import { lstat, open, opendir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Authentication accepts timestamps only within 30 seconds. Keep at least one
// hour, including filesystem age, so maintenance never clears a valid replay.
export const MIN_NONCE_RETENTION_MS = 3_600_000;
export const NONCE_RETENTION_DEFAULTS = Object.freeze({
  retentionMs: MIN_NONCE_RETENTION_MS, maxScanned: 100_000,
  maxDeleted: 50_000, maxDurationMs: 20_000,
});
const NAME = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^[0-9]{13}$/;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const error = (code) => Object.assign(new Error(code), { code });
const privateMode = (entry, mask) => process.platform === "win32"
  || ((entry.mode & 0o777) === mask && entry.uid === process.geteuid());

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw error(code);
  return value;
}

async function noSymlinkComponents(path) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw error("NONCE_RETENTION_SYMLINK_PATH_DENIED");
    if (!entry.isDirectory() && current !== path) throw error("NONCE_RETENTION_PATH_DENIED");
  }
  const actual = await realpath(path);
  const normalized = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalized(actual) !== normalized(path)) throw error("NONCE_RETENTION_PATH_DENIED");
}

async function privateDirectory(path) {
  await noSymlinkComponents(path);
  const entry = await lstat(path);
  if (!entry.isDirectory() || !privateMode(entry, 0o700))
    throw error("NONCE_RETENTION_DIRECTORY_NOT_PRIVATE");
  return entry;
}

/** Verify the inherited descriptor against the kernel, not an environment flag.
 * The caller must hold `flock -n -x 9` on a private lock file outside nonces.
 * Both core and CLI enforce this for apply; there is no unlock/test bypass. */
export async function assertNonceRetentionLock({ lockFd, lockPath, nonceDirectory }) {
  if (process.platform !== "linux") throw error("NONCE_RETENTION_APPLY_REQUIRES_LINUX_FLOCK");
  integer(lockFd, 3, 1024, "NONCE_RETENTION_LOCK_REQUIRED");
  if (typeof lockPath !== "string" || !isAbsolute(lockPath)) throw error("NONCE_RETENTION_LOCK_REQUIRED");
  const exact = resolve(lockPath);
  if (exact === nonceDirectory || exact.startsWith(`${nonceDirectory}/`))
    throw error("NONCE_RETENTION_LOCK_MUST_BE_OUTSIDE_NONCES");
  await noSymlinkComponents(exact);
  await privateDirectory(dirname(exact));
  const [entry, descriptor, info] = await Promise.all([
    lstat(exact), stat(`/proc/self/fd/${lockFd}`), readFile(`/proc/self/fdinfo/${lockFd}`, "utf8"),
  ]);
  if (!entry.isFile() || entry.nlink !== 1 || !privateMode(entry, 0o600)
    || entry.dev !== descriptor.dev || entry.ino !== descriptor.ino)
    throw error("NONCE_RETENTION_LOCK_REQUIRED");
  const locks = info.split("\n").filter((line) => line.startsWith("lock:"));
  if (!locks.some((line) => /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s+0\s+EOF\s*$/i
    .exec(line)?.[1] === String(entry.ino))) throw error("NONCE_RETENTION_EXCLUSIVE_FLOCK_REQUIRED");
}

/** Bounded streaming maintenance of exactly <private state>/nonces. This never
 * visits financial claims, vaults, registry, env, child directories or network.
 * Directory enumeration is intentionally unsorted: no array of millions of files.
 * Stop limits bound work, not a promise that one pass has scanned the whole cache. */
async function* nonceRetentionBatches({ stateDirectory, apply = false, lockFd, lockPath,
  retentionMs = NONCE_RETENTION_DEFAULTS.retentionMs,
  maxScanned = NONCE_RETENTION_DEFAULTS.maxScanned,
  maxDeleted = NONCE_RETENTION_DEFAULTS.maxDeleted,
  maxDurationMs = NONCE_RETENTION_DEFAULTS.maxDurationMs,
  pauseMs = 60_000,
  now = Date.now, monotonicNow = () => performance.now(),
} = {}, sweep = false) {
  if (typeof stateDirectory !== "string" || !isAbsolute(stateDirectory))
    throw error("NONCE_RETENTION_EXPLICIT_STATE_DIRECTORY_REQUIRED");
  const root = resolve(stateDirectory), directory = join(root, "nonces");
  if (root === parse(root).root || basename(root) === "nonces") throw error("NONCE_RETENTION_STATE_DIRECTORY_DENIED");
  integer(retentionMs, MIN_NONCE_RETENTION_MS, 30 * 86_400_000, "NONCE_RETENTION_UNSAFE_RETENTION");
  integer(maxScanned, 1, 1_000_000, "NONCE_RETENTION_SCAN_LIMIT_INVALID");
  integer(maxDeleted, 1, 1_000_000, "NONCE_RETENTION_DELETE_LIMIT_INVALID");
  integer(maxDurationMs, 1, 60_000, "NONCE_RETENTION_TIME_LIMIT_INVALID");
  integer(pauseMs, 0, 3_600_000, "NONCE_RETENTION_PAUSE_INVALID");
  if (typeof apply !== "boolean" || typeof now !== "function" || typeof monotonicNow !== "function")
    throw error("NONCE_RETENTION_OPTIONS_INVALID");
  const startedAt = integer(now(), 1_000_000_000_000, Number.MAX_SAFE_INTEGER, "NONCE_RETENTION_CLOCK_INVALID");
  let startedMono = monotonicNow();
  if (!Number.isFinite(startedMono)) throw error("NONCE_RETENTION_CLOCK_INVALID");
  await privateDirectory(root);
  const initialDirectory = await privateDirectory(directory);
  if (apply) await assertNonceRetentionLock({ lockFd, lockPath, nonceDirectory: directory });
  const batch = () => ({ mode: apply ? "APPLY" : "DRY_RUN", retention_ms: retentionMs,
    scanned: 0, candidates: 0, deleted: 0, preserved: 0, raced: 0,
    stopped: "COMPLETE", elapsed_ms: 0 });
  let result = batch();
  const finish = () => ({ ...result, elapsed_ms: Math.max(0, Math.ceil(monotonicNow() - startedMono)) });
  let pinned, stream;
  try {
    // Pin the Linux parent inode. /proc/self/fd is kernel-controlled; child
    // O_NOFOLLOW and identity checks still reject symlinks/hardlinks/replacement.
    if (process.platform === "linux") {
      pinned = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const openedDirectory = await pinned.stat();
      if (initialDirectory.dev !== openedDirectory.dev || initialDirectory.ino !== openedDirectory.ino)
        throw error("NONCE_RETENTION_DIRECTORY_CHANGED");
    }
    const anchored = pinned ? `/proc/self/fd/${pinned.fd}` : directory;
    stream = await opendir(anchored, { bufferSize: 32 });
    let lastNow = startedAt;
    for await (const entry of stream) {
      const currentNow = now(), elapsed = monotonicNow() - startedMono;
      if (!Number.isSafeInteger(currentNow) || currentNow < lastNow || !Number.isFinite(elapsed) || elapsed < 0) {
        result.stopped = "CLOCK_ROLLBACK"; break;
      }
      lastNow = currentNow;
      const limit = elapsed >= maxDurationMs ? "TIME_LIMIT"
        : result.scanned >= maxScanned ? "SCAN_LIMIT"
          : (apply ? result.deleted : result.candidates) >= maxDeleted ? "DELETE_LIMIT" : null;
      if (limit) {
        result.stopped = limit;
        if (!sweep) break;
        // Suspend at the current entry, not at a numeric directory index. Keep
        // this same open iterator alive while yielding and resting. Fresh or
        // malformed prefixes cannot starve old files further into the cache.
        yield finish();
        await delay(pauseMs);
        const resumedNow = now();
        if (!Number.isSafeInteger(resumedNow) || resumedNow < lastNow) {
          result = batch(); result.stopped = "CLOCK_ROLLBACK";
          startedMono = monotonicNow(); break;
        }
        lastNow = resumedNow;
        if (apply) await assertNonceRetentionLock({ lockFd, lockPath, nonceDirectory: directory });
        if (pinned) {
          const currentDirectory = await pinned.stat();
          if (!currentDirectory.isDirectory() || !privateMode(currentDirectory, 0o700)
            || currentDirectory.dev !== initialDirectory.dev || currentDirectory.ino !== initialDirectory.ino)
            throw error("NONCE_RETENTION_DIRECTORY_CHANGED");
        }
        result = batch(); startedMono = monotonicNow();
        if (!Number.isFinite(startedMono)) throw error("NONCE_RETENTION_CLOCK_INVALID");
      }
      result.scanned++;
      if (!NAME.test(entry.name) || !entry.isFile()) { result.preserved++; continue; }
      const path = join(anchored, entry.name);
      let handle;
      try {
        const before = await lstat(path);
        if (!before.isFile() || before.nlink !== 1 || before.size !== 13 || !privateMode(before, 0o600)
          || !Number.isFinite(before.mtimeMs) || before.mtimeMs > startedAt - retentionMs) {
          result.preserved++; continue;
        }
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat();
        if (!same(before, opened) || opened.nlink !== 1) { result.raced++; continue; }
        const bytes = Buffer.alloc(14), { bytesRead } = await handle.read(bytes, 0, 14, 0);
        // latin1 preserves high bits. ASCII decoding would mask them and could
        // incorrectly reinterpret corrupt bytes as an accepted digit string.
        const content = bytes.subarray(0, bytesRead).toString("latin1");
        const timestamp = Number(content);
        if (bytesRead !== 13 || !TIMESTAMP.test(content) || !Number.isSafeInteger(timestamp)
          || timestamp > startedAt - retentionMs || timestamp < 1_000_000_000_000) {
          result.preserved++; continue;
        }
        const after = await lstat(path);
        if (!same(opened, after) || !after.isFile() || after.nlink !== 1 || !privateMode(after, 0o600)) {
          result.raced++; continue;
        }
        result.candidates++;
        if (apply) {
          // Time can move backwards during I/O. Never unlink after that event.
          const deletingAt = now();
          if (!Number.isSafeInteger(deletingAt) || deletingAt < lastNow) {
            result.stopped = "CLOCK_ROLLBACK"; break;
          }
          lastNow = deletingAt;
          // A filesystem call cannot be preempted by this clock budget. In a
          // full sweep finish only this already-validated unlink, then yield
          // before processing another entry; never abandon/restart the iterator.
          if (!sweep && monotonicNow() - startedMono >= maxDurationMs) { result.stopped = "TIME_LIMIT"; break; }
          await unlink(path);
          result.deleted++;
        }
      } catch (failure) {
        if (failure?.code === "ENOENT" || failure?.code === "ELOOP") { result.raced++; continue; }
        throw failure;
      } finally { await handle?.close(); }
    }
    yield finish();
  } finally {
    // for-await normally closes the stream, including break; close explicitly
    // only when iteration never started or failed before that normal close.
    await stream?.close().catch((failure) => { if (failure?.code !== "ERR_DIR_CLOSED") throw failure; });
    await pinned?.close();
  }
}

/** One finite pass, dry-run unless apply was explicitly requested. */
export async function pruneExpiredNonces(options = {}) {
  const batches = nonceRetentionBatches(options, false);
  try { return (await batches.next()).value; }
  finally { await batches.return(); }
}

/** Full sweep in bounded batches with one pinned directory iterator and one
 * inherited lock. Between batches the default rest is 60 seconds. A crash
 * closes the iterator/lock; a restart safely starts a new sweep from the cache.
 * No cursor or other state is written anywhere, including financial storage. */
export function sweepExpiredNonces(options = {}) {
  return nonceRetentionBatches(options, true);
}

export async function runNonceRetentionSweep(options = {}) {
  const summary = { mode: options.apply === true ? "APPLY" : "DRY_RUN", retention_ms: options.retentionMs
    ?? NONCE_RETENTION_DEFAULTS.retentionMs, batches: 0, scanned: 0, candidates: 0, deleted: 0,
    preserved: 0, raced: 0, elapsed_ms: 0, stopped: "COMPLETE" };
  for await (const result of sweepExpiredNonces(options)) {
    summary.batches++;
    for (const key of ["scanned", "candidates", "deleted", "preserved", "raced", "elapsed_ms"]) summary[key] += result[key];
    summary.stopped = result.stopped;
    if (options.onBatch) await options.onBatch(result);
  }
  return summary;
}

export function parseNonceRetentionArgs(args) {
  const options = {};
  const names = new Map([["--state-directory", "stateDirectory"], ["--lock-fd", "lockFd"],
    ["--lock-path", "lockPath"], ["--retention-ms", "retentionMs"], ["--max-scanned", "maxScanned"],
    ["--max-deleted", "maxDeleted"], ["--max-duration-ms", "maxDurationMs"]]);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--apply" && options.apply === undefined) { options.apply = true; continue; }
    if (args[index] === "--sweep" && options.sweep === undefined) { options.sweep = true; continue; }
    const name = names.get(args[index]), value = args[++index];
    if (!name || options[name] !== undefined || !value || value.startsWith("--"))
      throw error("NONCE_RETENTION_ARGUMENT_INVALID");
    options[name] = name.endsWith("Directory") || name.endsWith("Path") ? value : Number(value);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseNonceRetentionArgs(process.argv.slice(2));
    const result = options.sweep ? await runNonceRetentionSweep({ ...options,
      onBatch: (batch) => console.log(JSON.stringify({ event: "NONCE_RETENTION_BATCH", ...batch })) })
      : await pruneExpiredNonces(options);
    console.log(JSON.stringify(options.sweep ? { event: "NONCE_RETENTION_SWEEP", ...result } : result));
  }
  catch (failure) {
    // Do not echo paths, filename hashes, payloads or arbitrary OS messages.
    console.error(JSON.stringify({ error: /^NONCE_RETENTION_[A-Z_]+$/.test(failure?.code ?? "")
      ? failure.code : "NONCE_RETENTION_IO_FAILED" }));
    process.exitCode = 1;
  }
}

import { statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pruneExpiredNonces, sweepExpiredNonces } from "../src/nonce-retention.mjs";

const STATE = "/var/lib/coinops-live-executor";
const LOCK = "/run/coinops-nonce-retention/maintenance.lock";

/** A bounded pass is not a complete sweep. Pressure/stalled enumeration must
 * remain observable, rather than declaring an unknown tail of the cache safe. */
export function classifyNonceMaintenance(result, filesystem) {
  if (!result || !["COMPLETE", "SCAN_LIMIT", "DELETE_LIMIT", "TIME_LIMIT", "CLOCK_ROLLBACK"].includes(result.stopped)
    || !Number.isSafeInteger(result.deleted) || result.deleted < 0
    || !Number.isSafeInteger(filesystem?.files) || filesystem.files <= 0
    || !Number.isSafeInteger(filesystem?.ffree) || filesystem.ffree < 0 || filesystem.ffree > filesystem.files)
    throw Object.assign(new Error("NONCE_MAINTENANCE_EVIDENCE_INVALID"), { code: "NONCE_MAINTENANCE_EVIDENCE_INVALID" });
  const ratio = filesystem.ffree / filesystem.files;
  const inodePressure = ratio <= 0.10;
  const code = result.stopped === "CLOCK_ROLLBACK" ? "NONCE_MAINTENANCE_CLOCK_UNSAFE"
    : inodePressure ? "NONCE_MAINTENANCE_INODE_PRESSURE"
      : result.stopped !== "COMPLETE" && result.deleted === 0 ? "NONCE_MAINTENANCE_SCAN_STALLED"
        : result.stopped === "COMPLETE" ? "NONCE_MAINTENANCE_COMPLETE" : "NONCE_MAINTENANCE_INCOMPLETE";
  return { code, requires_attention: !["NONCE_MAINTENANCE_COMPLETE", "NONCE_MAINTENANCE_INCOMPLETE"].includes(code),
    complete_sweep: result.stopped === "COMPLETE", inode_total: filesystem.files,
    inode_free: filesystem.ffree, inode_free_percent: Math.round(ratio * 10_000) / 100 };
}

export async function runNonceMaintenance(args, { onBatch = () => {} } = {}) {
  if (args.length !== 1 || !["--apply", "--dry-run"].includes(args[0]))
    throw Object.assign(new Error("NONCE_MAINTENANCE_ARGUMENT_INVALID"), { code: "NONCE_MAINTENANCE_ARGUMENT_INVALID" });
  const apply = args[0] === "--apply";
  const options = { stateDirectory: STATE, apply, lockFd: 9, lockPath: LOCK };
  if (!apply) {
    const result = await pruneExpiredNonces({ ...options, maxScanned: 256, maxDeleted: 128, maxDurationMs: 2_000 });
    return { ...classifyNonceMaintenance(result, await statfs(STATE)), ...result };
  }
  let last, batches = 0, totalScanned = 0, totalDeleted = 0;
  // One opendir remains pinned for the whole sweep, including the default
  // 60-second pauses. A protected prefix cannot starve the rest of the cache.
  for await (const result of sweepExpiredNonces(options)) {
    const verdict = classifyNonceMaintenance(result, await statfs(STATE));
    last = { ...verdict, ...result };
    batches++; totalScanned += result.scanned; totalDeleted += result.deleted;
    await onBatch({ event: "NONCE_MAINTENANCE_BATCH", ...last });
  }
  if (!last) throw Object.assign(new Error("NONCE_MAINTENANCE_EVIDENCE_INVALID"), { code: "NONCE_MAINTENANCE_EVIDENCE_INVALID" });
  return { event: "NONCE_MAINTENANCE_SWEEP_FINISHED", ...last, batches,
    total_scanned: totalScanned, total_deleted: totalDeleted };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runNonceMaintenance(process.argv.slice(2), { onBatch: (batch) => console.log(JSON.stringify(batch)) });
    console.log(JSON.stringify(result));
    // Dry-run is a bounded permissions/import proof, not a capacity verdict.
    if (result.mode === "APPLY" && result.requires_attention) process.exitCode = 1;
  } catch (failure) {
    console.error(JSON.stringify({ error: /^(?:NONCE_RETENTION|NONCE_MAINTENANCE)_[A-Z_]+$/.test(failure?.code ?? "")
      ? failure.code : "NONCE_MAINTENANCE_IO_FAILED" }));
    process.exitCode = 1;
  }
}

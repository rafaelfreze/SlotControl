import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertPrivateDirectory, ExecutorRejection, ExecutorPreDispatchRejection, sha256 } from "./security.mjs";
import { verifiedHistoricalRejection } from "./pre-dispatch-evidence.mjs";

function read(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
const stem = (directory, key) => join(directory, sha256(key));

/** Persistent, order-scoped fence. Checked synchronously at the final POST gate. */
export function assertUnsentFence(directory, key, requestTimestamp) {
  const fence = read(`${stem(directory, key)}.fence`);
  if (fence !== null && (!Number.isSafeInteger(Number(fence)) || requestTimestamp <= Number(fence)))
    throw new ExecutorPreDispatchRejection("EXECUTOR_OLD_DISPATCH_FENCED", 409);
}

/** No existing claim is ever removed. Absent exchange order alone is NOT proof.
 * Fence all pre-existing requests first, inspect durable claims before/after
 * an exact GET, and fail closed on pending, completed, corrupt or IO failure. */
export async function attestNeverDispatched({ directory, key, dispatchedAt, query, now = Date.now, historical }) {
  const dispatched = Date.parse(dispatchedAt);
  if (!Number.isFinite(dispatched) || now() - dispatched < 90_000)
    throw new ExecutorRejection("EXECUTOR_UNSENT_RECOVERY_TOO_RECENT", 409);
  await assertPrivateDirectory(directory);
  const base = stem(directory, key);
  const rejection = historical ? verifiedHistoricalRejection(base, historical.secret, historical.scope, key, dispatchedAt) : null;
  const absent = () => {
    if (read(`${base}.json`) !== null || read(`${base}.pending`) !== null && !rejection)
      throw new ExecutorRejection("EXECUTOR_UNSENT_RECOVERY_CLAIM_EXISTS", 409);
    if (rejection) verifiedHistoricalRejection(base, historical.secret, historical.scope, key, dispatchedAt);
  };
  absent();
  const temporary = `${base}.${randomUUID()}.fence-tmp`;
  const previous = read(`${base}.fence`);
  if (previous !== null && !Number.isSafeInteger(Number(previous)))
    throw new ExecutorRejection("EXECUTOR_UNSENT_RECOVERY_INVALID_FENCE", 409);
  writeFileSync(temporary, String(Math.max(now(), Number(previous ?? 0))), { flag: "wx", mode: 0o600 });
  renameSync(temporary, `${base}.fence`);
  absent();
  if (await query()) throw new ExecutorRejection("EXECUTOR_UNSENT_RECOVERY_ORDER_EXISTS", 409);
  absent();
  // Preserve, never delete, the proven rejected claim. Fence blocks every old
  // request at beforeClaim and at the final POST gate, including legacy engines.
  if (rejection && read(`${base}.pending`) !== null)
    renameSync(`${base}.pending`, `${base}.${rejection.archiveHash}.rejected`);
  return true;
}

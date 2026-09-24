import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export const REPLAY_WINDOW_MS = 30_000;
const NONCE_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
const KEY_PATTERN = /^[a-zA-Z0-9:_-]{8,160}$/;

export class ExecutorRejection extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function requestSignature(secret, method, path, timestamp, nonce, body) {
  const bodyHash = sha256(body);
  const canonical = [method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

function equalHex(received, expected) {
  if (!/^[0-9a-f]{64}$/.test(received ?? "")) return false;
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

export async function verifySignedRequest({ headers, method, path, body, secret, nonceDirectory, now = Date.now() }) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32)
    throw new ExecutorRejection("EXECUTOR_AUTH_NOT_CONFIGURED", 503);
  const timestamp = headers.get("x-coinops-timestamp");
  const nonce = headers.get("x-coinops-nonce");
  const bodyHash = headers.get("x-coinops-body-sha256");
  const signature = headers.get("x-coinops-signature");
  const milliseconds = Number(timestamp);
  if (!/^[0-9]{13}$/.test(timestamp ?? "") || !Number.isSafeInteger(milliseconds)
    || Math.abs(milliseconds - now) > REPLAY_WINDOW_MS)
    throw new ExecutorRejection("EXECUTOR_TIMESTAMP_STALE", 401);
  if (!NONCE_PATTERN.test(nonce ?? "")) throw new ExecutorRejection("EXECUTOR_NONCE_INVALID", 401);
  if (!equalHex(bodyHash, sha256(body))
    || !equalHex(signature, requestSignature(secret, method, path, timestamp, nonce, body)))
    throw new ExecutorRejection("EXECUTOR_SIGNATURE_INVALID", 401);

  await assertPrivateDirectory(nonceDirectory);
  const nonceFile = join(nonceDirectory, sha256(nonce));
  try {
    const handle = await open(nonceFile, "wx", 0o600);
    try { await handle.writeFile(timestamp); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code === "EEXIST") throw new ExecutorRejection("EXECUTOR_NONCE_REPLAY", 409);
    throw error;
  }
  return { nonce, timestamp: milliseconds, bodyHash };
}

/** Atomic claim. An incomplete claim remains blocked after a crash, never silently replayed. */
export async function withDryRunIdempotency({ directory, key, bodyHash, execute }) {
  if (!KEY_PATTERN.test(key ?? "")) throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_KEY_INVALID");
  await assertPrivateDirectory(directory);
  const stem = join(directory, sha256(key));
  const completed = `${stem}.json`;
  const pending = `${stem}.pending`;
  const previous = await readFile(completed, "utf8").then(JSON.parse).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (previous) {
    if (previous.bodyHash !== bodyHash) throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_CONFLICT", 409);
    return { result: previous.result, replayed: true };
  }
  try {
    const handle = await open(pending, "wx", 0o600);
    try { await handle.writeFile(bodyHash); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code === "EEXIST") throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_IN_PROGRESS", 409);
    throw error;
  }
  try {
    const result = await execute();
    const temporary = `${stem}.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ bodyHash, result })); } finally { await handle.close(); }
    await rename(temporary, completed);
    await unlink(pending);
    return { result, replayed: false };
  } catch (error) {
    // This release has no exchange write transport. A known failed dry-run can be retried.
    await unlink(pending).catch(() => {});
    throw error;
  }
}

/** Unlike dry-runs, an uncertain financial dispatch is never released for a
 * second POST. Only exact Binance ownership evidence may complete the claim. */
export async function withWriteIdempotency({ directory, key, bodyHash, recover, execute }) {
  if (!KEY_PATTERN.test(key ?? "")) throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_KEY_INVALID");
  await assertPrivateDirectory(directory);
  const stem = join(directory, sha256(key));
  const completed = `${stem}.json`, pending = `${stem}.pending`;
  const previous = await readFile(completed, "utf8").then(JSON.parse).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (previous) {
    if (previous.bodyHash !== bodyHash) throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_CONFLICT", 409);
    return { result: previous.result, replayed: true };
  }
  const observed = await readFile(pending, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (observed !== null) {
    if (observed !== bodyHash) throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_CONFLICT", 409);
    const recovered = await recover();
    if (!recovered) throw new ExecutorRejection("EXECUTOR_WRITE_OUTCOME_UNKNOWN", 503);
    const handle = await open(completed, "wx", 0o600).catch((error) => {
      if (error?.code === "EEXIST") return null;
      throw error;
    });
    if (handle) { try { await handle.writeFile(JSON.stringify({ bodyHash, result: recovered })); } finally { await handle.close(); } }
    await unlink(pending).catch(() => {});
    return { result: recovered, replayed: true };
  }
  try {
    const handle = await open(pending, "wx", 0o600);
    try { await handle.writeFile(bodyHash); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code === "EEXIST") throw new ExecutorRejection("EXECUTOR_WRITE_IN_PROGRESS", 409);
    throw error;
  }
  try {
    const result = await execute();
    const handle = await open(completed, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ bodyHash, result })); } finally { await handle.close(); }
    await unlink(pending).catch(() => {});
    return { result, replayed: false };
  } catch (error) {
    // Never unlink pending: Binance may have accepted the order despite a
    // timeout, or persistence may have failed after its successful response.
    throw error;
  }
}

export async function assertPrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await stat(directory);
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0)
    throw new Error("EXECUTOR_STATE_DIRECTORY_NOT_PRIVATE");
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { ExecutorRejection, sha256 } from "./security.mjs";

// Compatibility evidence only for the exact published runtime/rejection pairs
// reviewed below. Never infer non-submission from GET or a textual error.
export const HISTORICAL_REJECTION_RUNTIME = "65f2e382a441d5c51509d06a17e6ddfe74cef60c";
export const HISTORICAL_REJECTION_FINGERPRINT = "a1ad68e6892405409f145d5035557b3959ecb3859cc5458bca83073697f623c8";
export const HISTORICAL_BNB_REJECTION_RUNTIME = "bc43636bfd96cbb3618a7380c86e0d7f61f8b9fd";
export const HISTORICAL_BNB_REJECTION_FINGERPRINT = "9ac54825d53da6ed250c904a1c232e07b64643460c4aa99308dba4b16b2dd963";
const pins = Object.freeze([
  Object.freeze({ runtimeSha: HISTORICAL_REJECTION_RUNTIME, runtimeFingerprint: HISTORICAL_REJECTION_FINGERPRINT,
    rejectionCode: "EXECUTOR_QUOTE_BALANCE_INSUFFICIENT", httpStatus: 403 }),
  Object.freeze({ runtimeSha: HISTORICAL_BNB_REJECTION_RUNTIME, runtimeFingerprint: HISTORICAL_BNB_REJECTION_FINGERPRINT,
    rejectionCode: "EXECUTOR_BNB_FEE_RESERVE_MISSING", httpStatus: 503 }),
]);
export function historicalPreDispatchRuntimePin(runtimeSha, runtimeFingerprint) {
  return pins.find(pin => pin.runtimeSha === runtimeSha && pin.runtimeFingerprint === runtimeFingerprint) ?? null;
}
const sign = (secret, proof) => createHmac("sha256", secret).update(`COINOPS_PRE_POST_JOURNAL_V1\n${JSON.stringify(proof)}`).digest("hex");

/** Root maintenance imports only an exact, scoped pre-POST journal rejection
 * from pinned public code. The original pending claim is NOT modified here. */
export function historicalPreDispatchProof({ secret, engine, clientOrderId, decisionId, dispatchedAt,
  claimKey, pendingHash, pendingMtime, records, runtimeSha, runtimeFingerprint }) {
  const denied = () => { throw new ExecutorRejection("EXECUTOR_PRE_DISPATCH_EVIDENCE_UNPROVEN", 409); };
  const pin = historicalPreDispatchRuntimePin(runtimeSha, runtimeFingerprint);
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32
    || !pin || !Array.isArray(records)
    || !/^[a-f0-9]{64}$/.test(pendingHash) || !/^[a-f0-9]{64}$/.test(decisionId)
    || !Number.isFinite(pendingMtime) || !Number.isFinite(Date.parse(dispatchedAt))) denied();
  const keyHash = sha256(clientOrderId).slice(0, 12);
  // A duplicate/mismatched attempt with either identity invalidates proof;
  // filtering foreign ownership out would falsely prove a unique dispatch.
  const attempts = records.filter(row => row?.action === "CREATE_ORDER"
    && (row.decision_id === decisionId || row.idempotency_key_hash === keyHash));
  const rejection = attempts.length === 1 ? attempts[0] : null;
  if (!rejection || rejection.result !== pin.rejectionCode || rejection.http_status !== pin.httpStatus
    || rejection.decision_id !== decisionId || rejection.idempotency_key_hash !== keyHash
    || rejection.trading_engine_id !== engine.trading_engine_id || rejection.exchange_account_id !== engine.exchange_account_id
    || rejection.operator_id !== engine.operator_id || rejection.executor_shard_id !== engine.executor_shard_id
    || rejection.environment !== "REAL" || rejection.symbol !== engine.symbol
    || !/^[a-f0-9-]{36}$/.test(rejection.request_id ?? "") || !Number.isFinite(Date.parse(rejection.timestamp))
    || Date.parse(rejection.timestamp) < Date.parse(dispatchedAt)
    || Date.parse(rejection.timestamp) - Date.parse(dispatchedAt) > 35_000
    || pendingMtime < Date.parse(dispatchedAt) - 2_000
    || pendingMtime > Date.parse(rejection.timestamp)) denied();
  const proof = { protocol: 1, source: "PINNED_EXECUTOR_JOURNAL", runtimeSha, runtimeFingerprint,
    operator_id: engine.operator_id, exchange_account_id: engine.exchange_account_id,
    trading_engine_id: engine.trading_engine_id, executor_shard_id: engine.executor_shard_id,
    symbol: engine.symbol, clientOrderId, decisionId, dispatchedAt, claimKey,
    pendingHash, pendingMtime, request_id: rejection.request_id, rejectedAt: rejection.timestamp,
    rejection_code: rejection.result,
    // Preserve byte-for-byte compatibility of the original quote proof.
    ...(runtimeSha === HISTORICAL_BNB_REJECTION_RUNTIME ? { rejection_http_status: rejection.http_status } : {}) };
  return { proof, signature: sign(secret, proof) };
}

/** No caller-provided flag can turn a pending claim into an unsent order. */
export function verifiedHistoricalRejection(base, secret, scope, claimKey, dispatchedAt) {
  let value;
  try { value = JSON.parse(readFileSync(`${base}.pre-post-evidence`, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new ExecutorRejection("EXECUTOR_PRE_DISPATCH_EVIDENCE_INVALID", 409); }
  const proof = value?.proof;
  const pin = historicalPreDispatchRuntimePin(proof?.runtimeSha, proof?.runtimeFingerprint);
  const denied = () => { throw new ExecutorRejection("EXECUTOR_PRE_DISPATCH_EVIDENCE_INVALID", 409); };
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32
    || !proof || typeof value.signature !== "string" || !/^[a-f0-9]{64}$/.test(value.signature)
    || !timingSafeEqual(Buffer.from(sign(secret, proof), "hex"), Buffer.from(value.signature, "hex"))
    || proof.protocol !== 1 || proof.source !== "PINNED_EXECUTOR_JOURNAL"
    || !pin || proof.rejection_code !== pin.rejectionCode
    || (pin.runtimeSha === HISTORICAL_BNB_REJECTION_RUNTIME
      && proof.rejection_http_status !== pin.httpStatus)
    || (proof.rejection_http_status !== undefined && proof.rejection_http_status !== pin.httpStatus)
    || proof.claimKey !== claimKey || !Number.isFinite(Date.parse(proof.dispatchedAt))
    || Date.parse(proof.dispatchedAt) !== Date.parse(dispatchedAt)
    || Object.entries(scope).some(([key, value]) => proof[key] !== value)) denied();
  let pending;
  try { pending = readFileSync(`${base}.pending`, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { proof, archiveHash: sha256(JSON.stringify(value)) }; throw error; }
  if (pending !== proof.pendingHash || statSync(`${base}.pending`).mtimeMs !== proof.pendingMtime) denied();
  return { proof, archiveHash: sha256(JSON.stringify(value)) };
}

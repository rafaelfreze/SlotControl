import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type Scope = { operator_id: string; exchange_account_id: string; trading_engine_id: string;
  executor_shard_id: string; environment: string; symbol: string; clientOrderId: string; decision_id: string; request_nonce: string };
type Receipt = Scope & { protocol: 1; outcome: "NOT_SUBMITTED"; bodyHash: string; observedAt: number };
export type UnsentProof = { receipt: string; signature: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sign = (secret: string, encoded: string) => createHmac("sha256", secret)
  .update(`COINOPS_ORDER_NOT_SUBMITTED_V1\n${encoded}`).digest("hex");
function valid(receipt: Receipt, scope: Scope, hash: string, now: number) {
  return receipt?.protocol === 1 && receipt.outcome === "NOT_SUBMITTED" && receipt.environment === "REAL"
    && scope.environment === "REAL" && receipt.bodyHash === hash && /^[a-f0-9]{64}$/.test(hash)
    && Object.entries(scope).every(([key, value]) => receipt[key as keyof Scope] === value)
    && [receipt.operator_id, receipt.exchange_account_id, receipt.trading_engine_id].every((id) => UUID.test(id))
    && /^executor-[0-9]{2,4}$/.test(receipt.executor_shard_id) && /^(BTC|SOL)(BRL|USDT)$/.test(receipt.symbol)
    && /^[a-zA-Z0-9_-]{1,36}$/.test(receipt.clientOrderId)
    && /^[a-zA-Z0-9:_-]{8,160}$/.test(receipt.decision_id)
    && /^[a-zA-Z0-9_-]{16,128}$/.test(receipt.request_nonce)
    && Number.isSafeInteger(receipt.observedAt) && receipt.observedAt <= now + 2000
    && now - receipt.observedAt < 60_000;
}
/** Only a synchronous no-fetch gate or the executor's durable fenced no-POST
 * attestation may issue this receipt. A
 * timeout, absent order, exchange rejection or string error is never proof. */
export function signAccountOrderUnsentProof(secret: string, scope: Scope, bodyHash: string, now = Date.now()): UnsentProof {
  const receipt: Receipt = { ...scope, protocol: 1, outcome: "NOT_SUBMITTED", bodyHash, observedAt: now };
  if (Buffer.byteLength(secret) < 32 || !valid(receipt, scope, bodyHash, now)) throw new Error("EXECUTOR_UNSENT_PROOF_INVALID");
  const encoded = Buffer.from(JSON.stringify(receipt)).toString("base64url");
  return { receipt: encoded, signature: sign(secret, encoded) };
}
export function verifyAccountOrderUnsentProof(secret: string, proof: unknown, scope: Scope, body: string,
  now = Date.now()): Receipt {
  const denied = (): never => { throw new Error("EXECUTOR_UNSENT_PROOF_INVALID"); };
  if (Buffer.byteLength(secret) < 32 || !proof || typeof proof !== "object") return denied();
  const value = proof as UnsentProof;
  if (typeof value.receipt !== "string" || value.receipt.length > 2048 || !/^[a-zA-Z0-9_-]+$/.test(value.receipt)
    || typeof value.signature !== "string" || !/^[a-f0-9]{64}$/.test(value.signature)
    || !timingSafeEqual(Buffer.from(sign(secret, value.receipt), "hex"), Buffer.from(value.signature, "hex"))) return denied();
  let receipt: Receipt;
  try { receipt = JSON.parse(Buffer.from(value.receipt, "base64url").toString("utf8")) as Receipt; } catch { return denied(); }
  if (!valid(receipt, scope, createHash("sha256").update(body).digest("hex"), now)) return denied();
  return receipt;
}
export class AccountOrderNotSubmitted extends Error {
  readonly receipt: Receipt;
  constructor(receipt: Receipt) { super("COINOPS_ACCOUNT_ORDER_NOT_SUBMITTED"); this.receipt = receipt; }
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type AccountBudgetReservation = { code: string; operatorId: string; accountId: string; engineId: string;
  shardId: string; clientOrderId: string; expiresAt: number };
type PermitScope = { operator_id: string; exchange_account_id: string; trading_engine_id: string;
  environment: string; symbol: string; executor_shard_id: string; clientOrderId: string; side: string };
type Permit = AccountBudgetReservation & { protocol: 1; bodyHash: string; issuedAt: number; side: string; symbol: string; environment: "REAL" };
const deny = (): never => { throw new Error("EXECUTOR_ACCOUNT_ORDER_BUDGET_PERMIT_DENIED"); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function valid(permit: Permit, scope: PermitScope, bodyHash: string, now: number) {
  return permit?.protocol === 1 && permit.code === "PASS" && permit.environment === "REAL" && scope.environment === "REAL"
    && permit.operatorId === scope.operator_id && permit.accountId === scope.exchange_account_id
    && permit.engineId === scope.trading_engine_id && permit.shardId === scope.executor_shard_id
    && permit.clientOrderId === scope.clientOrderId && permit.symbol === scope.symbol && permit.side === scope.side
    && [permit.operatorId, permit.accountId, permit.engineId].every((id) => UUID.test(id))
    && /^executor-[0-9]{2,4}$/.test(permit.shardId) && /^(BTC|SOL)(BRL|USDT)$/.test(permit.symbol)
    && ["BUY", "SELL"].includes(permit.side) && typeof permit.clientOrderId === "string"
    && /^[a-zA-Z0-9_-]{1,36}$/.test(permit.clientOrderId) && /^[a-f0-9]{64}$/.test(bodyHash)
    && permit.bodyHash === bodyHash && Number.isSafeInteger(permit.issuedAt) && Number.isSafeInteger(permit.expiresAt)
    && Number.isFinite(now) && permit.issuedAt <= now + 2000 && permit.expiresAt > now
    && permit.expiresAt > permit.issuedAt && permit.expiresAt <= permit.issuedAt + 30_000;
}
const signature = (secret: string, encoded: string) => createHmac("sha256", secret)
  .update(`COINOPS_ACCOUNT_ORDERS_V1\n${encoded}`).digest("hex");

/** Separate signed headers preserve the byte-identical financial request body
 * and every prior durable idempotency hash. No caller-side PASS is authority. */
export function accountBudgetPermitHeaders(secret: string, reservation: AccountBudgetReservation,
  scope: PermitScope, body: string, now = Date.now()) {
  if (Buffer.byteLength(secret) < 32) return deny();
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const permit: Permit = { code: reservation.code, operatorId: reservation.operatorId, accountId: reservation.accountId,
    engineId: reservation.engineId, shardId: reservation.shardId, clientOrderId: reservation.clientOrderId,
    expiresAt: reservation.expiresAt, protocol: 1, bodyHash, issuedAt: now,
    side: scope.side, symbol: scope.symbol, environment: "REAL" };
  if (!valid(permit, scope, bodyHash, now)) return deny();
  const encoded = Buffer.from(JSON.stringify(permit)).toString("base64url");
  return { "x-coinops-account-order-budget": encoded, "x-coinops-account-order-budget-signature": signature(secret, encoded) };
}

export function verifyAccountBudgetPermit(secret: string, encoded: unknown, suppliedSignature: unknown,
  scope: PermitScope, bodyHash: string, now = Date.now()): void {
  if (Buffer.byteLength(secret) < 32 || typeof encoded !== "string" || encoded.length > 2048
    || !/^[a-zA-Z0-9_-]+$/.test(encoded) || typeof suppliedSignature !== "string"
    || !/^[a-f0-9]{64}$/.test(suppliedSignature)
    || !timingSafeEqual(Buffer.from(signature(secret, encoded), "hex"), Buffer.from(suppliedSignature, "hex"))) return deny();
  let permit: Permit;
  try { permit = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Permit; } catch { return deny(); }
  if (!valid(permit, scope, bodyHash, now)) return deny();
}

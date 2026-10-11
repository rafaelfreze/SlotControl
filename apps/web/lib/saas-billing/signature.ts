import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BILLING_PRODUCT, BillingError, UUID } from "./contract";
export function signBillingRequest(secret: string, pathname: string, timestamp: string, nonce: string, body: string) {
  const canonical = ["onplay-billing-v1", "POST", pathname, timestamp, nonce, createHash("sha256").update(body).digest("hex")].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}
export function verifyBillingRequest(request: Request, body: string, now = Date.now(), env: Record<string, string | undefined> = process.env) {
  const timestamp = request.headers.get("x-onplay-timestamp") ?? "";
  const nonce = request.headers.get("x-onplay-nonce") ?? "";
  const signature = request.headers.get("x-onplay-signature") ?? "";
  if (request.headers.get("x-onplay-product") !== BILLING_PRODUCT || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp)) || Math.abs(now - Date.parse(timestamp)) > 300_000
    || !UUID.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new BillingError("billing_invalid_signature", 401);
  const keys = [env.ONPLAY_BILLING_SECRET];
  if (Date.parse(env.ONPLAY_BILLING_PREVIOUS_VALID_UNTIL ?? "") > now) keys.push(env.ONPLAY_BILLING_PREVIOUS_SECRET);
  if (!keys.some(key => {
    if (!key || key.length < 32) return false;
    const expected = Buffer.from(signBillingRequest(key, new URL(request.url).pathname, timestamp, nonce, body));
    const supplied = Buffer.from(signature);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  })) throw new BillingError("billing_invalid_signature", 401);
  return nonce;
}
export async function readBillingBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 65536) throw new BillingError("billing_body_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BillingError("billing_invalid_body", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new BillingError("billing_body_too_large", 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

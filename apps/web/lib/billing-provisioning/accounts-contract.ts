import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ACCOUNTS_PATH = "/api/integrations/onplay-billing/accounts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type AccountPlan = { code: string; name: string; amount_cents: number; trial_days: number; capabilities: Record<string, unknown> };
export type AccountInput = { operation: "create"; request_id: string; product_key: string; company_name: string; owner_name: string; email: string; password: string; whatsapp: string; plan: AccountPlan; consent: boolean; actor_id?: string };
export type ProvisionMarker = { request_id: string; product_key: string; fingerprint: string };
function canonical(value: unknown): string { if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"; if (record(value)) return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}"; return JSON.stringify(value); }
export class AccountError extends Error {
  status: number;
  constructor(code: string, status = 503) { super(code); this.status = status; }
}
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function text(v: unknown, min: number, max: number) { if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) throw new AccountError("invalid_account", 400); return v.trim(); }
export function parseAccountInput(body: string, product: string): AccountInput | { operation: "catalog" } {
  let v: unknown; try { v = JSON.parse(body); } catch { throw new AccountError("invalid_account", 400); }
  if (!record(v) || v.product_key !== product) throw new AccountError("invalid_account", 400);
  if (v.operation === "catalog") {
    if (Object.keys(v).some(k => !["operation", "product_key"].includes(k))) throw new AccountError("invalid_account", 400);
    return { operation: "catalog" };
  }
  if (v.operation !== undefined && v.operation !== "create" || Object.keys(v).some(k => !["operation", "request_id", "product_key", "actor_id", "company_name", "owner_name", "email", "password", "whatsapp", "plan", "consent"].includes(k))) throw new AccountError("invalid_account", 400);
  const email = text(v.email, 3, 254).toLowerCase(), phoneDigits = text(v.whatsapp, 8, 80).replace(/\D/g, "");
  const whatsapp = "+" + ((phoneDigits.length === 12 || phoneDigits.length === 13) && phoneDigits.startsWith("55") ? phoneDigits : "55" + phoneDigits);
  if (!UUID.test(String(v.request_id)) || v.actor_id !== undefined && !UUID.test(String(v.actor_id)) || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email) || !/^\+55[1-9][0-9](9[0-9]{8}|[2-9][0-9]{7})$/.test(whatsapp) || typeof v.password !== "string" || v.password.length < 8 || v.password.length > 1024 || typeof v.consent !== "boolean") throw new AccountError("invalid_account", 400);
  if (!record(v.plan) || !Number.isSafeInteger(v.plan.amount_cents) || Number(v.plan.amount_cents) < 0 || Number(v.plan.amount_cents) > 999999999 || v.plan.trial_days !== 30 || !record(v.plan.capabilities) || Object.keys(v.plan).some(k => !["code", "name", "amount_cents", "trial_days", "capabilities"].includes(k))) throw new AccountError("invalid_plan", 400);
  return { operation: "create", request_id: String(v.request_id).toLowerCase(), product_key: product, company_name: text(v.company_name, 2, 120), owner_name: text(v.owner_name, 2, 120), email, password: v.password, whatsapp, consent: v.consent, ...(v.actor_id ? { actor_id: String(v.actor_id).toLowerCase() } : {}), plan: { code: text(v.plan.code, 1, 160), name: text(v.plan.name, 1, 200), amount_cents: Number(v.plan.amount_cents), trial_days: 30, capabilities: v.plan.capabilities } };
}
/** Password and actor credentials never enter the replay marker or a persistent request. */
export function accountMarker(input: AccountInput): ProvisionMarker {
  return { request_id: input.request_id, product_key: input.product_key, fingerprint: createHash("sha256").update(canonical([input.product_key, input.request_id, input.email, input.company_name, input.owner_name, input.whatsapp, input.plan, input.consent])).digest("hex") };
}
export function assertAccountMarker(value: unknown, expected: ProvisionMarker) {
  if (!record(value) || value.request_id !== expected.request_id || value.product_key !== expected.product_key || value.fingerprint !== expected.fingerprint) throw new AccountError("account_request_conflict", 409);
}
export function accountSignature(secret: string, product: string, body: string, timestamp: string, nonce: string) {
  void product;
  return createHmac("sha256", secret).update(["onplay-billing-v1", "POST", ACCOUNTS_PATH, timestamp, nonce, createHash("sha256").update(body).digest("hex")].join("\n")).digest("base64url");
}
export function verifyAccountRequest(request: Request, body: string, product: string, secret: string | undefined, now = Date.now()) {
  const url = new URL(request.url), timestamp = request.headers.get("x-onplay-timestamp") ?? "", nonce = request.headers.get("x-onplay-nonce") ?? "", signature = request.headers.get("x-onplay-signature") ?? "";
  if (!secret || secret.length < 32) throw new AccountError("provisioning_not_configured");
  if (request.method !== "POST" || url.pathname !== ACCOUNTS_PATH || url.search || !request.headers.get("content-type")?.startsWith("application/json") || request.headers.get("x-onplay-product") !== product || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || Math.abs(now - Date.parse(timestamp)) > 300000 || !UUID.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new AccountError("invalid_signature", 401);
  const expected = accountSignature(secret, product, body, timestamp, nonce);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new AccountError("invalid_signature", 401);
  return nonce;
}
export async function receiveAccountRequest(request: Request, product: string, source: { consume(nonce: string): PromiseLike<{ data: boolean; error: { code?: string } | null }>; catalog(): Promise<AccountPlan[]>; create(input: AccountInput): Promise<unknown> }, secret = process.env.ONPLAY_BILLING_PROVISIONING_SECRET, now = Date.now()) {
  const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 65536) throw new AccountError("body_too_large", 413);
    const reader = request.body?.getReader(); if (!reader) throw new AccountError("invalid_account", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) { await reader.cancel(); throw new AccountError("body_too_large", 413); } chunks.push(part.value); } } finally { reader.releaseLock(); }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const nonce = verifyAccountRequest(request, body, product, secret, now), input = parseAccountInput(body, product);
    const claimed = await source.consume(nonce); if (claimed.error || claimed.data !== true) throw new AccountError(claimed.error?.code === "23505" || !claimed.error ? "billing_replay" : "provisioning_unavailable", claimed.error?.code === "23505" || !claimed.error ? 409 : 503);
    const result = input.operation === "catalog" ? { plans: await source.catalog() } : await source.create(input);
    return Response.json({ ok: true, product_key: product, ...result as Record<string, unknown> }, { headers });
  } catch (error) {
    const weakPassword = error instanceof Error && error.message === "COINOPS_VIEWER_PASSWORD_INVALID" && "code" in error && error.code === "weak_password";
    const safe = error instanceof AccountError ? error : weakPassword ? new AccountError("weak_password", 422) : new AccountError(/email.*exists|email.*registered|request.*conflict/i.test(error instanceof Error ? error.message : "") ? "account_request_conflict" : "provisioning_unavailable", /email.*exists|email.*registered|request.*conflict/i.test(error instanceof Error ? error.message : "") ? 409 : 503);
    return Response.json({ ok: false, error: safe.message }, { status: safe.status, headers });
  }
}

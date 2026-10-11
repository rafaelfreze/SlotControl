/** Commercial subscription only. No exchange, order, balance or engine entitlement. */
export const BILLING_PRODUCT = "coinops" as const;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = ["trial", "active", "pending", "overdue", "grace", "paused", "canceled"] as const;
export type BillingProjection = {
  billing_subscription_id: string; product_key: "coinops"; external_tenant_id: string;
  tenant_name: string; tenant_slug: string; plan_code: string; plan_name: string;
  amount_cents: number | null; status: typeof statuses[number]; version: number;
  trial_ends_at: string | null; billing_start_on: string; due_day: number;
  next_due_date: string | null; grace_until: string | null; last_paid_at: string | null;
  paused_at: string | null; canceled_at: string | null; manual_pause: boolean;
  registration_pending: boolean; capabilities: Record<string, unknown>;
  installment_id: string | null; balance_cents: number | null; contract_id: string | null;
  updated_at: string;
};
export class BillingError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 503) { super(code); this.code = code; this.status = status; }
}
const date = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const iso = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const nullable = (v: unknown, predicate: (v: unknown) => boolean) => v === null || predicate(v);
const cents = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 100_000_000_000;
export function parseProjection(value: unknown): BillingProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BillingError("billing_invalid_projection");
  const v = value as Record<string, unknown>;
  if (v.product_key !== BILLING_PRODUCT || !UUID.test(String(v.external_tenant_id))
    || !UUID.test(String(v.billing_subscription_id)) || !Number.isSafeInteger(v.version) || Number(v.version) < 1
    || !statuses.includes(v.status as BillingProjection["status"]) || !date(v.billing_start_on)
    || !Number.isInteger(v.due_day) || Number(v.due_day) < 1 || Number(v.due_day) > 31
    || !nullable(v.amount_cents, cents) || !nullable(v.balance_cents, cents)
    || !iso(v.updated_at) || typeof v.manual_pause !== "boolean" || typeof v.registration_pending !== "boolean"
    || !v.capabilities || typeof v.capabilities !== "object" || Array.isArray(v.capabilities)) throw new BillingError("billing_invalid_projection");
  for (const k of ["tenant_name", "tenant_slug", "plan_code", "plan_name"])
    if (typeof v[k] !== "string" || String(v[k]).length > 200) throw new BillingError("billing_invalid_projection");
  for (const k of ["trial_ends_at", "last_paid_at", "paused_at", "canceled_at"])
    if (!nullable(v[k], iso)) throw new BillingError("billing_invalid_projection");
  for (const k of ["next_due_date", "grace_until"])
    if (!nullable(v[k], date)) throw new BillingError("billing_invalid_projection");
  for (const k of ["installment_id", "contract_id"])
    if (!nullable(v[k], x => typeof x === "string" && UUID.test(x))) throw new BillingError("billing_invalid_projection");
  // Explicit whitelist strips payment links, contacts and arbitrary provider diagnostics.
  const keys = ["billing_subscription_id", "product_key", "external_tenant_id", "tenant_name", "tenant_slug", "plan_code", "plan_name", "amount_cents", "status", "version", "trial_ends_at", "billing_start_on", "due_day", "next_due_date", "grace_until", "last_paid_at", "paused_at", "canceled_at", "manual_pause", "registration_pending", "capabilities", "installment_id", "balance_cents", "contract_id", "updated_at"];
  return Object.fromEntries(keys.map(k => [k, v[k]])) as BillingProjection;
}
export function statusLabel(status: BillingProjection["status"]) {
  return { trial: "Em teste", active: "Ativa", pending: "Aguardando pagamento", overdue: "Em atraso", grace: "Prazo para regularizar", paused: "Pausada", canceled: "Cancelada" }[status];
}

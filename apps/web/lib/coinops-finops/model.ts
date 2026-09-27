import type { CostCurrency, FinancialOrigin, FinopsScope, FinopsService, FxQuote } from "./types";

export function requireFinopsOwnership(user: { id: string; role?: unknown } | null,
  operator: { id: string; tenant_id: string; user_id: string; status: string } | null, tenantId: string): FinopsScope {
  if (!user) throw new Error("AUTH_REQUIRED");
  if (user.role === "VIEWER" || !operator || operator.status !== "ACTIVE"
    || operator.user_id !== user.id || operator.tenant_id !== tenantId) throw new Error("ADMIN_REQUIRED");
  return { operatorId: operator.id, tenantId, userId: user.id };
}

export const FINOPS_SOURCE_NOTES = [
  "Capital das contas Binance e resultado das estratégias não são receita da plataforma.",
  "Custos compartilhados só entram no total após atribuição explícita ao CoinOps.",
  "Projeção combina tarifa recorrente com extrapolação linear do consumo variável conhecido; não é cobrança confirmada.",
  "Snapshots são imutáveis: cada observação conserva a cotação e o estado financeiro daquele momento.",
];
export const periodAt = (at: Date) => `${at.toISOString().slice(0, 7)}-01`;
export const FINOPS_SYNC_INTERVAL_MS = 6 * 60 * 60_000;
export function nextFinopsExternalSync(lastSyncedAt: string | null, now: Date): string | null {
  if (!lastSyncedAt) return null;
  const observed = Date.parse(lastSyncedAt);
  if (!Number.isFinite(observed) || observed > now.getTime() + 60_000) throw new Error("COINOPS_FINOPS_SYNC_TIME_INVALID");
  const next = observed + FINOPS_SYNC_INTERVAL_MS;
  return next > now.getTime() ? new Date(next).toISOString() : null;
}
export const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export function knownNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function convertBrl(amount: number | null, currency: string, fx: FxQuote[]): number | null {
  if (amount === null) return null;
  if (currency === "BRL") return money(amount);
  const rate = fx.find((quote) => quote.base === currency && quote.quote === "BRL");
  return rate && Number.isFinite(rate.rate) && rate.rate > 0 ? money(amount * rate.rate) : null;
}
export function sumKnown(values: Array<number | null>) {
  const cents = values.reduce<number>((sum, value) => sum + (value === null ? 0 : Math.round(value * 100)), 0);
  return { known: cents / 100, complete: values.every((value) => value !== null),
    total: values.every((value) => value !== null) ? cents / 100 : null };
}
export function projectedCost(recurring: number | null, variable: number | null, actual: number | null,
  now: Date, billingPeriod?: { start: string; end: string } | null): number | null {
  // Exact project-attributed usage remains a known subtotal even without a known
  // fixed plan. It is not a prediction of unknown future usage or shared fees.
  if (recurring === null) return actual === null ? null : money(actual);
  const start = billingPeriod ? Date.parse(billingPeriod.start) : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = billingPeriod ? Date.parse(billingPeriod.end) : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const current = now.getTime() >= start && now.getTime() < end;
  const elapsed = Math.max(86_400_000, now.getTime() - start);
  const projection = recurring + (!current || variable === null ? 0 : variable * (end - start) / elapsed);
  return money(Math.max(projection, actual ?? 0));
}
export function enrichService(row: Record<string, unknown>, fx: FxQuote[], now: Date): FinopsService {
  const billingPeriod = typeof row.billing_period_start === "string" && typeof row.billing_period_end === "string"
    ? { start: row.billing_period_start, end: row.billing_period_end } : null;
  const current = billingPeriod ? now.getTime() >= Date.parse(billingPeriod.start) && now.getTime() < Date.parse(billingPeriod.end)
    : String(row.cost_period) === periodAt(now);
  const currency: CostCurrency = row.currency === "BRL" ? "BRL" : "USD";
  const allocation = knownNumber(row.allocation_percent);
  const recurring = knownNumber(row.recurring_monthly);
  const evidenceOrigin = financialOrigin(row.origin);
  const apiUnavailable = row.source_mode === "API" && row.sync_status !== "OK";
  const actual = current && evidenceOrigin === "REAL" && !apiUnavailable ? knownNumber(row.actual_month_cost) : null;
  const origin = evidenceOrigin === "REAL" && actual === null ? recurring === null ? "INDISPONIVEL" : "ESTIMADO" : evidenceOrigin;
  const variable = current && !apiUnavailable ? knownNumber(row.variable_month_to_date) : null;
  const observed = typeof row.synced_at === "string" ? Date.parse(row.synced_at) : NaN;
  const projectionAt = Number.isFinite(observed) && observed <= now.getTime() + 60_000
    && (!billingPeriod || observed >= Date.parse(billingPeriod.start) && observed < Date.parse(billingPeriod.end))
    ? new Date(observed) : now;
  const projected = origin === "INDISPONIVEL" ? null : projectedCost(recurring, variable, actual, projectionAt, billingPeriod);
  const allocated = (n: number | null) => n === null || allocation === null ? null : n * allocation / 100;
  const shared = allocation !== null && allocation < 100 || origin === "RATEIO_ESTIMADO";
  const projectedBrl = convertBrl(allocated(projected), currency, fx);
  const actualBrl = shared ? null : convertBrl(allocated(actual), currency, fx);
  return { id: String(row.id), provider: String(row.provider), name: String(row.name),
    shardId: row.shard_id ? String(row.shard_id) : null, plan: row.plan ? String(row.plan) : null,
    region: row.region ? String(row.region) : null, resourceId: row.resource_id ? String(row.resource_id) : null,
    currency, recurringMonthly: recurring, actualMonthCost: actual, variableMonthToDate: variable,
    allocationPercent: allocation, costPeriod: String(row.cost_period),
    billingPeriodStart: billingPeriod?.start ?? null, billingPeriodEnd: billingPeriod?.end ?? null,
    origin: shared && projected !== null ? "RATEIO_ESTIMADO" : origin,
    sourceMode: row.source_mode === "API" || row.source_mode === "DOCUMENTED" ? row.source_mode : "MANUAL",
    sourceNote: String(row.source_note ?? ""), pricingDate: row.pricing_date ? String(row.pricing_date) : null,
    unitPrice: knownNumber(row.unit_price), quantity: knownNumber(row.quantity),
    sourceUrl: row.source_url ? String(row.source_url) : null,
    syncedAt: row.synced_at ? String(row.synced_at) : null, syncStatus: row.sync_status as FinopsService["syncStatus"],
    usage: Array.isArray(row.usage) ? row.usage as FinopsService["usage"] : [],
    projectedOriginal: projected, actualBrl,
    projectedBrl, estimatedBrl: shared || projectedBrl === null ? null
      : actualBrl === null ? projectedBrl : money(Math.max(0, projectedBrl - actualBrl)),
    allocatedBrl: shared ? projectedBrl : null,
    recurringBrl: convertBrl(allocated(recurring), currency, fx), enabled: row.enabled === true };
}
export function financialOrigin(value: unknown): FinancialOrigin {
  if (value === "REAL" || value === "ESTIMADO" || value === "RATEIO_ESTIMADO") return value;
  if (value === "MANUAL" || value === "PROJETADO") return "ESTIMADO";
  return "INDISPONIVEL";
}
export function validateManualService(input: Record<string, unknown>) {
  const fields = ["recurringMonthly", "actualMonthCost", "variableMonthToDate", "allocationPercent"] as const;
  const result: Record<typeof fields[number], number | null> = { recurringMonthly: null,
    actualMonthCost: null, variableMonthToDate: null, allocationPercent: null };
  for (const field of fields) {
    const value = input[field];
    if (value === null || value === "" || value === undefined) continue;
    const n = knownNumber(value);
    if (n === null || n < (field === "actualMonthCost" ? -1_000_000 : 0) || n > (field === "allocationPercent" ? 100 : 1_000_000)
      || (field !== "allocationPercent" && Math.abs(n * 100 - Math.round(n * 100)) > 0.000001))
      throw new Error("COINOPS_FINOPS_INVALID_AMOUNT");
    result[field] = n;
  }
  if (!["USD", "BRL"].includes(String(input.currency))) throw new Error("COINOPS_FINOPS_INVALID_CURRENCY");
  if (typeof input.sourceNote !== "string" || input.sourceNote.trim().length < 3 || input.sourceNote.length > 1000)
    throw new Error("COINOPS_FINOPS_SOURCE_REQUIRED");
  if (typeof input.serviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.serviceId))
    throw new Error("COINOPS_FINOPS_INVALID_SERVICE");
  const origin = financialOrigin(input.origin ?? "ESTIMADO");
  if (result.actualMonthCost !== null && origin !== "REAL") throw new Error("COINOPS_FINOPS_REAL_EVIDENCE_REQUIRED");
  if (origin === "REAL" && result.actualMonthCost === null) throw new Error("COINOPS_FINOPS_REAL_AMOUNT_REQUIRED");
  if (origin === "RATEIO_ESTIMADO" && result.allocationPercent === null) throw new Error("COINOPS_FINOPS_ALLOCATION_REQUIRED");
  const periodProvided = "billingPeriodStart" in input || "billingPeriodEnd" in input;
  const billingPeriodStart = input.billingPeriodStart ? String(input.billingPeriodStart) : null;
  const billingPeriodEnd = input.billingPeriodEnd ? String(input.billingPeriodEnd) : null;
  if (periodProvided && ((billingPeriodStart === null) !== (billingPeriodEnd === null)
    || billingPeriodStart !== null && (!Number.isFinite(Date.parse(billingPeriodStart)) || !Number.isFinite(Date.parse(billingPeriodEnd!))
      || Date.parse(billingPeriodEnd!) <= Date.parse(billingPeriodStart)))) throw new Error("COINOPS_FINOPS_BILLING_PERIOD_INVALID");
  return { ...result, serviceId: input.serviceId, currency: input.currency as CostCurrency,
    ...(periodProvided ? { billingPeriodStart, billingPeriodEnd } : {}),
    sourceNote: input.sourceNote.trim(), origin, sourceMode: "MANUAL" as const,
    plan: typeof input.plan === "string" ? input.plan.trim().slice(0,150) : null };
}

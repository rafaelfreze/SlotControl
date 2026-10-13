import type { BillingProjection } from "./contract";

export type RenewalNotice = { title: string; description: string; blocked: boolean };
const day = (value: string | null | undefined) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};
export function billingToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Campo_Grande", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return value("year") + "-" + value("month") + "-" + value("day");
}
const label = (date: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Campo_Grande" }).format(date);

/** Commercial web access only. This function has no engine or exchange side effects. */
export function billingViewerAccessAllowed(projection: BillingProjection | null, today = billingToday()) {
  if (!projection || projection.registration_pending || (projection.balance_cents ?? 0) <= 0) return true;
  const due = day(projection.next_due_date), limit = day(projection.grace_until), current = day(today);
  // A missing deadline is not a new local grace period or proof of expiration.
  return !due || !limit || !current || current <= due || current <= limit;
}

/** The renewal deadline is the persisted Central date, never seven days from the visit. */
export function buildRenewalNotice(projection: BillingProjection | null, today = billingToday()): RenewalNotice | null {
  if (!projection || projection.registration_pending || projection.manual_pause || !projection.last_paid_at
    || !["active", "grace", "overdue", "paused"].includes(projection.status)
    || (projection.balance_cents ?? 0) <= 0) return null;
  const due = day(projection.next_due_date), limit = day(projection.grace_until), current = day(today);
  if (projection.status === "active" && (!due || !current || current <= due)) return null;
  if (!limit || !current) return { title: "Renovação pendente", description: "Consulte a cobrança da sua assinatura para regularizar seu acesso.", blocked: false };
  const blockOn = new Date(limit.getTime() + 86_400_000);
  const graceDays = due ? Math.round((limit.getTime() - due.getTime()) / 86_400_000) : null;
  const blocked = !billingViewerAccessAllowed(projection, today);
  return { title: blocked ? "Renovação vencida" : "Renovação pendente", blocked,
    description: blocked
      ? "O prazo terminou em " + label(limit) + ". Pague a cobrança para regularizar o acesso ao painel."
      : (graceDays === 7 ? "Você tem até 7 dias após o vencimento para regularizar. " : "") + "Pague até " + label(limit) + ". O bloqueio do painel do cliente está previsto a partir de " + label(blockOn) + "." };
}

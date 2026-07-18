function calendarDay(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
}

export function getAccountAgeDays(createdAt: string | null | undefined, now = new Date(), timeZone = "UTC") {
  if (!createdAt) return 0;

  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime()) || Number.isNaN(now.getTime())) return 0;

  return Math.max(0, Math.floor((calendarDay(now, timeZone) - calendarDay(created, timeZone)) / 86_400_000));
}

export function formatAccountCreatedDate(createdAt: string | null | undefined, timeZone = "UTC") {
  if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) return "Data de criacao indisponivel";

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(createdAt));
}

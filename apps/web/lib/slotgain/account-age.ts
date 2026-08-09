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

function dateOnlyCalendarDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return timestamp;
}

export function getAccountAgeDays(createdAt: string | null | undefined, now = new Date(), timeZone = "UTC") {
  if (!createdAt) return 0;

  const dateOnlyDay = dateOnlyCalendarDay(createdAt);
  const created = dateOnlyDay === null ? new Date(createdAt) : null;
  if ((created && Number.isNaN(created.getTime())) || Number.isNaN(now.getTime())) return 0;

  const createdDay = dateOnlyDay ?? calendarDay(created as Date, timeZone);
  return Math.max(0, Math.floor((calendarDay(now, timeZone) - createdDay) / 86_400_000));
}

export function formatAccountCreatedDate(createdAt: string | null | undefined, timeZone = "UTC") {
  if (!createdAt) return "Data de criacao indisponivel";
  const dateOnlyDay = dateOnlyCalendarDay(createdAt);
  if (dateOnlyDay !== null) {
    const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(createdAt) as RegExpExecArray;
    return `${day}/${month}/${year}`;
  }
  if (Number.isNaN(new Date(createdAt).getTime())) return "Data de criacao indisponivel";

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(createdAt));
}

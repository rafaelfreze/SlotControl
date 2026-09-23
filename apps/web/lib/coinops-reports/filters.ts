import type { ReportFilters } from "./source-contract.ts";

export const REPORT_TIMEZONE = "America/Campo_Grande";
export const REPORT_VERSION = 1;
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function localDay(now: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function validDay(value: string) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!DATE.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new Error("REPORT_DATE_INVALID");
  return value;
}
function shift(day: string, amount: number) { return new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY).toISOString().slice(0, 10); }

/** Date-only inputs are inclusive local calendar dates. End in the data contract is exclusive UTC. */
export function parseReportFilters(params: URLSearchParams, now = new Date()): ReportFilters {
  for (const key of ["tenant", "tenant_id", "tenantId", "user", "user_id", "userId", "scope"]) {
    if (params.has(key)) throw new Error("REPORT_SCOPE_NOT_ACCEPTED");
  }
  const today = localDay(now), preset = params.get("preset") || "30d";
  if (!["today", "7d", "30d", "month", "custom"].includes(preset)) throw new Error("REPORT_PRESET_INVALID");
  let start = preset === "today" ? today : preset === "7d" ? shift(today, -6) : preset === "month" ? `${today.slice(0, 7)}-01` : shift(today, -29);
  let end = today;
  if (preset === "custom" || params.has("start") || params.has("end")) {
    if (!params.get("start") || !params.get("end")) throw new Error("REPORT_PERIOD_REQUIRED");
    start = validDay(params.get("start")!); end = validDay(params.get("end")!);
  }
  if (start > end || end > today || Date.parse(end) - Date.parse(start) >= 366 * DAY || start < "2020-01-01") throw new Error("REPORT_PERIOD_INVALID");
  const asset = params.get("asset") || "ALL", environment = params.get("environment") || "ALL";
  if (!["ALL", "BTC", "SOL"].includes(asset)) throw new Error("REPORT_ASSET_INVALID");
  if (!["ALL", "SHADOW", "TESTNET", "REAL"].includes(environment)) throw new Error("REPORT_ENVIRONMENT_INVALID");
  // Campo Grande has UTC-04 throughout the supported reporting period (2020+).
  return { start: new Date(`${start}T00:00:00-04:00`).toISOString(), end: new Date(`${shift(end, 1)}T00:00:00-04:00`).toISOString(), assets: asset === "ALL" ? ["BTC", "SOL"] : [asset as "BTC" | "SOL"], environments: environment === "ALL" ? ["SHADOW", "TESTNET", "REAL"] : [environment as "SHADOW" | "TESTNET" | "REAL"] };
}

export function reportDates(filters: ReportFilters) { return { start: localDay(new Date(filters.start)), end: localDay(new Date(Date.parse(filters.end) - 1)) }; }

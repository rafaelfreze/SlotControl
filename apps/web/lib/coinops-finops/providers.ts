// Billing credentials are accepted only by server callers; this module never reads
// browser storage or client environment variables and must not be imported by UI.
import type { CostCurrency, FxQuote } from "./types.ts";

type JsonObject = Record<string, unknown>;
type Fetcher = typeof fetch;
type Usage = Array<{ label: string; used: number | null; limit: number | null; unit: string }>;
export type DigitalOceanCost = {
  shardId: string; resourceId: string; ip: string; plan: string; region: string;
  monthlyUsd: number; sourceUrl: string; observedAt: string; usage: Usage; notes: string[];
  pricingUrl: string; unitPrice: number; quantity: number; pricingDate: string; evidence: string;
};
export type VercelProjectCost = {
  currency: CostCurrency; monthToDate: number | null; usage: Usage; sourceUrl: string;
  observedAt: string; matchedRows: number; excludedRows: number; notes: string[];
};
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_ROWS = 25_000;
const DAY = 86_400_000;
const fail = (code: string): never => { throw new Error(code); };
const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as JsonObject : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
function decimal(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1e15 ? parsed : null;
}
function serverOnly() {
  if (typeof window !== "undefined") fail("FINOPS_SERVER_ONLY");
}
function credential(token: string) {
  serverOnly();
  if (!token || /[\r\n]/.test(token)) fail("FINOPS_PROVIDER_CREDENTIAL_UNAVAILABLE");
}

async function readLimited(response: Response, code: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) fail(`${code}_TOO_LARGE`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let result = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        fail(`${code}_TOO_LARGE`);
      }
      result += decoder.decode(part.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function get(url: URL, code: string, fetchImpl: Fetcher, token?: string): Promise<string> {
  serverOnly();
  try {
    const response = await fetchImpl(url, {
      method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000),
      headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" },
    });
    if (!response.ok) fail(`${code}_HTTP_${response.status}`);
    return await readLimited(response, code);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (new RegExp(`^${code}_(?:HTTP_\\d{3}|TOO_LARGE)$`).test(message)) throw error;
    return fail(`${code}_UNAVAILABLE`);
  }
}
function json(raw: string, code: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return fail(`${code}_SCHEMA_INVALID`); }
}

export function parsePtaxQuote(payload: unknown, now: Date): FxQuote {
  const data = object(payload);
  if (!Array.isArray(data?.value)) return fail("FINOPS_FX_PTAX_SCHEMA_INVALID");
  const cutoff = now.getTime() - 7 * DAY;
  const quotes = data.value.flatMap((row: unknown) => {
    const item = object(row);
    const rate = decimal(item?.cotacaoVenda);
    const stamp = text(item?.dataHoraCotacao);
    // PTAX timestamps without offset are Brazilian civil time (UTC-03 in 2026).
    const normalized = stamp?.replace(" ", "T");
    const time = normalized ? Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}-03:00`) : NaN;
    if (rate === null || rate <= 0 || !Number.isFinite(time) || time < cutoff || time > now.getTime()) return [];
    return [{ base: "USD", quote: "BRL" as const, rate, source: "BCB PTAX venda",
      observedAt: new Date(time).toISOString(), fetchedAt: now.toISOString() }];
  });
  quotes.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  return quotes[0] ?? fail("FINOPS_FX_PTAX_STALE_OR_MISSING");
}

export function parseUsdtBrlQuote(payload: unknown, now: Date): FxQuote {
  const data = object(payload);
  const rate = decimal(data?.lastPrice);
  const observed = decimal(data?.closeTime);
  if (data?.symbol !== "USDTBRL" || rate === null || rate <= 0 || observed === null ||
      observed > now.getTime() + 60_000 || observed < now.getTime() - 15 * 60_000) {
    return fail("FINOPS_FX_USDTBRL_SCHEMA_OR_AGE_INVALID");
  }
  return { base: "USDT", quote: "BRL", rate, source: "Binance Spot USDTBRL",
    observedAt: new Date(observed).toISOString(), fetchedAt: now.toISOString() };
}

export async function fetchFinopsFx(now = new Date(), fetchImpl: Fetcher = fetch): Promise<FxQuote[]> {
  serverOnly();
  if (!Number.isFinite(now.getTime())) return fail("FINOPS_FX_DATE_INVALID");
  const format = (date: Date) => `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}-${date.getUTCFullYear()}`;
  const ptax = new URL("https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)");
  ptax.searchParams.set("@dataInicial", `'${format(new Date(now.getTime() - 7 * DAY))}'`);
  ptax.searchParams.set("@dataFinalCotacao", `'${format(now)}'`);
  ptax.searchParams.set("$format", "json");
  ptax.searchParams.set("$top", "10");
  ptax.searchParams.set("$orderby", "dataHoraCotacao desc");
  // BCB's OData parser does not decode form-style '+' into spaces. Keep
  // RFC3986 %20 in the serialized query (not only in the decoded parameter).
  const ptaxRequest = new URL(ptax.href.replace(/\+/g, "%20"));
  const results = await Promise.allSettled([
    get(ptaxRequest, "FINOPS_FX_PTAX", fetchImpl).then(raw => parsePtaxQuote(json(raw, "FINOPS_FX_PTAX"), now)),
    get(new URL("https://data-api.binance.vision/api/v3/ticker/24hr?symbol=USDTBRL&type=MINI"), "FINOPS_FX_USDTBRL", fetchImpl)
      .then(raw => parseUsdtBrlQuote(json(raw, "FINOPS_FX_USDTBRL"), now)),
  ]);
  const quotes = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  return quotes.length ? quotes : fail("FINOPS_FX_UNAVAILABLE");
}

export async function fetchDigitalOceanCosts(token: string, shards: { id: string; ip: string }[], fetchImpl: Fetcher = fetch): Promise<DigitalOceanCost[]> {
  credential(token);
  const shardIps = new Map<string, string>();
  for (const shard of shards) {
    if (!shard.id || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(shard.ip) || shard.ip.split(".").some(part => Number(part) > 255) || shardIps.has(shard.ip)) {
      return fail("FINOPS_DO_SHARD_MAPPING_INVALID");
    }
    shardIps.set(shard.ip, shard.id);
  }
  if (!shards.length) return [];
  const rows: DigitalOceanCost[] = [];
  const matched = new Set<string>();
  const observedAt = new Date().toISOString();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = object(json(await get(new URL(`https://api.digitalocean.com/v2/droplets?per_page=200&page=${page}`), "FINOPS_DO", fetchImpl, token), "FINOPS_DO"));
    if (!Array.isArray(payload?.droplets)) return fail("FINOPS_DO_SCHEMA_INVALID");
    for (const value of payload.droplets) {
      const droplet = object(value);
      const networks = object(droplet?.networks);
      if (!Array.isArray(networks?.v4)) return fail("FINOPS_DO_SCHEMA_INVALID");
      const publicIps = networks.v4.flatMap((network: unknown) => {
        const item = object(network);
        return item?.type === "public" && typeof item.ip_address === "string" ? [item.ip_address] : [];
      });
      const match = publicIps.filter((ip: string) => shardIps.has(ip));
      if (!match.length) continue;
      if (match.length !== 1) return fail("FINOPS_DO_AMBIGUOUS_RESOURCE");
      const ip = match[0];
      const shardId = shardIps.get(ip)!;
      const resource = decimal(droplet?.id);
      const size = object(droplet?.size);
      const monthly = decimal(size?.price_monthly);
      const plan = text(size?.slug);
      const region = text(object(droplet?.region)?.slug);
      if (matched.has(shardId) || resource === null || resource <= 0 || !Number.isInteger(resource) || monthly === null || monthly < 0 || !plan || !region) {
        return fail("FINOPS_DO_SCHEMA_OR_OWNERSHIP_INVALID");
      }
      matched.add(shardId);
      rows.push({ shardId, resourceId: String(resource), ip, plan, region, monthlyUsd: monthly,
        sourceUrl: `https://api.digitalocean.com/v2/droplets/${resource}`, observedAt,
        pricingUrl: "https://www.digitalocean.com/pricing/droplets", unitPrice: monthly, quantity: 1,
        pricingDate: observedAt, evidence: "API DigitalOcean: size.price_monthly do recurso associado ao IP primário do shard.",
        usage: [{ label: "Memória contratada", used: null, limit: decimal(size?.memory), unit: "MB" },
          { label: "Disco contratado", used: null, limit: decimal(size?.disk), unit: "GB" },
          { label: "Transferência incluída", used: null, limit: decimal(size?.transfer), unit: "TB" }],
        notes: ["ESTIMADO: tarifa-base mensal; cobrança realizada, backups, storage e excedentes não incluídos."] });
    }
    const pages = object(object(payload.links)?.pages);
    if (!pages?.next) return rows;
    // Never follow a provider-supplied URL with our bearer token.
    if (page === MAX_PAGES) return fail("FINOPS_DO_PAGINATION_LIMIT");
  }
  return rows;
}

export function parseVercelProjectCosts(raw: string, options: { projectId: string; from: string; to: string }, now = new Date()): VercelProjectCost {
  const lines = raw.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > MAX_ROWS) return fail("FINOPS_VERCEL_TOO_MANY_ROWS");
  const from = Date.parse(options.from), to = Date.parse(options.to);
  if (!options.projectId || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 366 * DAY) return fail("FINOPS_VERCEL_PERIOD_INVALID");
  let currency: CostCurrency | null = null;
  let total = 0, matchedRows = 0, excludedRows = 0;
  const usage = new Map<string, { label: string; used: number | null; limit: null; unit: string }>();
  for (const line of lines) {
    const row = object(json(line, "FINOPS_VERCEL"));
    if (!row) return fail("FINOPS_VERCEL_SCHEMA_INVALID");
    const tags = object(row.Tags);
    if (tags?.ProjectId !== options.projectId) { excludedRows += 1; continue; }
    const amount = decimal(row.BilledCost);
    const rowCurrency = row.BillingCurrency;
    const start = Date.parse(String(row.ChargePeriodStart ?? "")), end = Date.parse(String(row.ChargePeriodEnd ?? ""));
    if (amount === null || (rowCurrency !== "USD" && rowCurrency !== "BRL") ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < from || end > to || end <= start) {
      return fail("FINOPS_VERCEL_SCHEMA_OR_PERIOD_INVALID");
    }
    if (currency && currency !== rowCurrency) return fail("FINOPS_VERCEL_MIXED_CURRENCY");
    currency = rowCurrency;
    total += amount;
    matchedRows += 1;
    const service = text(row.ServiceName), unit = text(row.ConsumedUnit), quantity = decimal(row.ConsumedQuantity);
    if (service && unit && quantity !== null) {
      const key = `${service}\u0000${unit}`;
      const previous = usage.get(key);
      usage.set(key, { label: service, used: (previous?.used ?? 0) + quantity, limit: null, unit });
    }
  }
  if (!Number.isFinite(total) || Math.abs(total) > 1e12) return fail("FINOPS_VERCEL_AMOUNT_INVALID");
  return { currency: currency ?? "USD", monthToDate: matchedRows ? Math.round(total * 1e8) / 1e8 : null,
    usage: [...usage.values()], sourceUrl: "https://api.vercel.com/v1/billing/charges",
    observedAt: now.toISOString(), matchedRows, excludedRows,
    notes: ["Somente cobranças com ProjectId exato do CoinOps. Plano/seats/linhas compartilhadas sem projeto exigem rateio MANUAL.",
      ...(matchedRows ? ["BilledCost é base de faturamento do período; não comprova pagamento."] : ["Nenhuma cobrança atribuível retornada; custo permanece INDISPONÍVEL, não zero."])] };
}

export async function fetchVercelProjectCosts(token: string, options: { teamId: string; projectId: string; from: string; to: string }, fetchImpl: Fetcher = fetch): Promise<VercelProjectCost> {
  credential(token);
  if (!/^team_[a-zA-Z0-9]+$/.test(options.teamId) || !/^prj_[a-zA-Z0-9]+$/.test(options.projectId)) return fail("FINOPS_VERCEL_SCOPE_INVALID");
  parseVercelProjectCosts("", options); // Validate dates before sending the credential.
  const url = new URL("https://api.vercel.com/v1/billing/charges");
  url.searchParams.set("teamId", options.teamId);
  url.searchParams.set("from", options.from);
  url.searchParams.set("to", options.to);
  return parseVercelProjectCosts(await get(url, "FINOPS_VERCEL", fetchImpl, token), options);
}

import { createHash } from "node:crypto";
import type { ReportScope } from "./source-contract.ts";
import { validateReportScope } from "./source-contract.ts";

type JsonRow = Record<string, unknown>;
export type RuntimeObservation = {
  scope: ReportScope;
  source: "SHADOW_ENGINE" | "TESTNET_DIAGNOSTIC";
  environment: "SHADOW" | "TESTNET";
  asset?: "BTC" | "SOL";
  symbol?: string;
  reference: string;
  startedAt: string;
  finishedAt: string;
  status: "COMPLETED" | "FAILED" | "SKIPPED";
  error?: unknown;
  metrics: JsonRow;
  appCommitSha?: string;
  operatorId?: string;
  exchangeAccountId?: string;
  tradingEngineId?: string;
  quoteAsset?: string;
};
const object = (value: unknown): JsonRow => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRow : {};
const finite = (value: unknown) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const bool = (value: unknown) => typeof value === "boolean" ? value : null;
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value) ? value : null;
const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const assets = new Set(["BTC", "SOL", "USDT", "USDC", "BRL"]);
const symbols = new Set(["BTCUSDC", "SOLUSDC", "BTCUSDT", "SOLUSDT", "BTCBRL", "SOLBRL"]);

export function safeObservationError(error: unknown): string | null {
  if (!error) return null;
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^(COINOPS_|TESTNET_|BINANCE_TEST_ORDER_HTTP_)[A-Z0-9_-]{1,140}$/.test(code) ? code : "COINOPS_RUNTIME_OBSERVATION_ERROR";
}

/** Rebuild allowlisted fields instead of serializing adapter responses. */
export function testnetSnapshotMetrics(input: unknown): JsonRow {
  const diagnostic = object(input); const account = object(diagnostic.account);
  const balances = (Array.isArray(diagnostic.balances) ? diagnostic.balances : []).map(object).filter((row) => assets.has(String(row.asset))).slice(0, 4).map((row) => ({
    asset: row.asset, free: finite(row.free), locked: finite(row.locked), total: finite(row.total),
  }));
  const probes = (Array.isArray(diagnostic.probes) ? diagnostic.probes : []).map(object).filter((row) => symbols.has(String(row.symbol))).slice(0, 4).map((row) => {
    const filters = object(row.filters); const market = object(row.market);
    return { symbol: row.symbol, available: bool(row.available), error: safeObservationError(row.error),
      filters: row.available ? { minQuantity: finite(filters.minQuantity), maxQuantity: finite(filters.maxQuantity), minNotional: finite(filters.minNotional), quantityStep: finite(filters.quantityStep), priceTick: finite(filters.priceTick) } : null,
      market: row.available ? { price: finite(market.price), observedAt: iso(market.observedAt) } : null,
      open_order_count: finite(row.openOrderCount), owned_open_order_count: finite(row.ownedOpenOrderCount),
    };
  });
  return {
    account: { can_trade: bool(account.canTrade), can_withdraw: bool(account.canWithdraw), can_deposit: bool(account.canDeposit), updated_at: iso(account.updateTime) },
    balances, probes,
    permissions: { USER_DATA: diagnostic.ok === false ? false : typeof account.canTrade === "boolean", TRADE: bool(object(diagnostic.tradePermission).ok), USER_STREAM: bool(object(diagnostic.userStreamPermission).ok) },
    stream_observation_kind: "SUBSCRIPTION_PERMISSION_PROBE",
    fictitious_funds: true,
  };
}

function shadowMetrics(input: JsonRow): JsonRow {
  return {
    config_id: uuid(input.config_id), cycle_id: uuid(input.cycle_id), expected_interval_seconds: 300,
    cycles_started: finite(input.cycles_started), slots_updated: finite(input.slots_updated), candles_processed: finite(input.candles_processed),
    gain_rate: finite(input.gain_rate), entry_spacing: finite(input.entry_spacing), capital_usdc: finite(input.capital_usdc),
    kill_switch: bool(input.kill_switch), pause_new_entries: bool(input.pause_new_entries), slot_count: 25,
    single_active_entry: true, compounding: true,
  };
}

export function buildRuntimeObservation(input: RuntimeObservation) {
  const scope = validateReportScope(input.scope);
  const startedAt = iso(input.startedAt); const finishedAt = iso(input.finishedAt);
  if (!startedAt || !finishedAt || finishedAt < startedAt) throw new Error("COINOPS_OBSERVATION_TIME_INVALID");
  if ((input.source === "SHADOW_ENGINE" && (input.environment !== "SHADOW" || !input.asset))
    || (input.source === "TESTNET_DIAGNOSTIC" && input.environment !== "TESTNET")) throw new Error("COINOPS_OBSERVATION_ENVIRONMENT_INVALID");
  const eventKey = createHash("sha256").update(JSON.stringify([input.source, scope.productId, scope.tenantId, scope.userId, ...(input.exchangeAccountId ? [input.exchangeAccountId, input.tradingEngineId ?? null] : []), input.reference])).digest("hex");
  return {
    product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId,
    ...(input.operatorId ? { operator_id: input.operatorId } : {}),
    ...(input.exchangeAccountId ? { exchange_account_id: input.exchangeAccountId } : {}),
    ...(input.tradingEngineId ? { trading_engine_id: input.tradingEngineId } : {}),
    ...(input.quoteAsset ? { quote_asset: input.quoteAsset } : {}),
    observation_version: 1, event_key: eventKey, environment: input.environment, asset: input.asset ?? null,
    symbol: input.symbol && symbols.has(input.symbol) ? input.symbol : null, source: input.source,
    observed_at: finishedAt, started_at: startedAt, finished_at: finishedAt, status: input.status,
    error_code: safeObservationError(input.error),
    metrics: input.source === "SHADOW_ENGINE" ? shadowMetrics(input.metrics) : testnetSnapshotMetrics(input.metrics),
    app_commit_sha: input.appCommitSha && /^[a-f0-9]{7,64}$/.test(input.appCommitSha) ? input.appCommitSha : null,
  };
}

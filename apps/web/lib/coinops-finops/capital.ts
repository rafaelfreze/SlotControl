import type { FinopsCapitalRow, FinopsMarketRow } from "./types";

/** These are native-currency observations, never platform revenue or hard caps. */
export type CapitalAccount = { id: string; operator_id: string; display_name: string; status: string;
  executor_shard_id: string | null; onboarding_environment: string | null; credential_ref?: string | null };
export type CapitalEngine = { id: string; operator_id: string; exchange_account_id: string; environment: string;
  symbol: string; base_asset: string; quote_asset: string; status: string; kill_switch: boolean; executor_shard_id?: string | null };
export type CapitalRun = { id: string; operator_id: string; exchange_account_id: string; trading_engine_id: string;
  status: string; last_reconciled_at: string | null };
type NativeValue = string | number | null;
export type CapitalSlotAccount = { operator_id: string; exchange_account_id: string; trading_engine_id: string;
  slot_number: number; balance_quote: NativeValue; market_pnl_quote: NativeValue; fees_quote: NativeValue; gain_count: number };
export type CapitalSlot = { operator_id: string; exchange_account_id: string; trading_engine_id: string; run_id: string;
  slot_number: number; position_quantity: NativeValue; position_committed_quote: NativeValue };
export type CapitalOrder = { operator_id: string; exchange_account_id: string; trading_engine_id: string; run_id: string;
  side: string; status: string; reserved_notional_quote: NativeValue; requested_quote: NativeValue;
  requested_quantity: NativeValue; price: NativeValue; cumulative_quote: NativeValue; client_order_id?: string };
export type CapitalWallet = { accountId: string; observedAt: string | null; source: string;
  balances: Array<{ asset: string; free: NativeValue; locked: NativeValue }>; error?: string; consistent?: boolean };
export type CapitalPrice = { symbol: string; price: NativeValue; observedAt: string; accountId?: string };
export type FinopsNativeCapital = { currency: string; ledgerCapital: string | null; ledgerFree: string | null;
  reserved: string | null; positionCost: string | null; positionValue: string | null;
  realizedPnl: string | null; openPnl: string | null; gains: number | null };
export type FinopsCapitalMarket = FinopsNativeCapital & { accountId: string; accountName: string; engineId: string;
  shardId: string; symbol: string; baseAsset: string; positionQuantity: string | null; status: string; active: boolean;
  reconciledAt: string | null; priceAt: string | null };
export type FinopsCapitalAccount = { id: string; name: string; shardId: string; shardIds: string[]; status: string;
  wallet: CapitalWallet & { status: "CURRENT" | "STALE" | "UNAVAILABLE" };
  currencies: Array<FinopsNativeCapital & { monitored: string | null; walletFree: string | null;
    walletLocked: string | null; complete: boolean; observedAt: string | null }>;
  excludedWalletAssets: string[] };
export type FinopsCapital = { observedAt: string;
  counts: { accounts: number; activeAccounts: number; engines: number; activeEngines: number; shards: number };
  accounts: FinopsCapitalAccount[]; markets: FinopsCapitalMarket[];
  currencies: FinopsNativeCapital[]; shards: Array<{ shardId: string; currencies: FinopsNativeCapital[] }>;
  sources: string[]; warnings: string[] };
export type CapitalInput = { operatorId: string; accounts: CapitalAccount[]; engines: CapitalEngine[];
  runs: CapitalRun[]; slotAccounts: CapitalSlotAccount[]; slots: CapitalSlot[]; orders: CapitalOrder[];
  wallets?: CapitalWallet[]; prices?: CapitalPrice[]; now?: number };

const ZERO = BigInt(0);
const SCALE = BigInt("1000000000000");
const ACTIVE_ORDER = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
const OPEN_RUN = new Set(["PREPARING", "ACTIVE", "PAUSED"]);
const moneyFields = ["ledgerCapital", "ledgerFree", "reserved", "positionCost", "positionValue", "realizedPnl", "openPnl"] as const;

/** Fixed decimal arithmetic at ledger precision; bigint never leaves the JSON result. */
function decimal(value: NativeValue | undefined): bigint | null {
  if (value === null || value === undefined || value === "" || typeof value === "number" && !Number.isFinite(value)) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) return null;
  const exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 100) return null;
  const shift = 12 + exponent - (match[3]?.length ?? 0);
  const digits = BigInt(match[2] + (match[3] ?? ""));
  const absolute = shift >= 0 ? digits * BigInt(10) ** BigInt(shift) : digits / BigInt(10) ** BigInt(-shift);
  return match[1] === "-" ? -absolute : absolute;
}
function formatted(value: bigint | null): string | null {
  if (value === null) return null;
  const absolute = value < ZERO ? -value : value;
  return `${value < ZERO ? "-" : ""}${absolute / SCALE}.${String(absolute % SCALE).padStart(12, "0")}`;
}
function total(values: Array<NativeValue | undefined>): string | null {
  const parsed = values.map(decimal);
  return parsed.some((value) => value === null) ? null : formatted(parsed.reduce<bigint>((sum, value) => sum + (value ?? ZERO), ZERO));
}
function subtract(left: NativeValue, right: NativeValue): string | null {
  const a = decimal(left), b = decimal(right);
  return formatted(a === null || b === null ? null : a - b);
}
function multiply(left: NativeValue, right: NativeValue): string | null {
  const a = decimal(left), b = decimal(right);
  return formatted(a === null || b === null ? null : a * b / SCALE);
}
const fresh = (at: string | null, now: number, maximum = 15 * 60_000) => at !== null
  && Number.isFinite(Date.parse(at)) && now - Date.parse(at) >= -60_000 && now - Date.parse(at) <= maximum;

function aggregate(rows: FinopsNativeCapital[]): FinopsNativeCapital[] {
  return [...new Set(rows.map((row) => row.currency))].sort().map((currency) => {
    const group = rows.filter((row) => row.currency === currency);
    return { currency, ...Object.fromEntries(moneyFields.map((key) => [key, total(group.map((row) => row[key]))])),
      gains: group.some((row) => row.gains === null) ? null : group.reduce((sum, row) => sum + (row.gains ?? 0), 0) } as FinopsNativeCapital;
  });
}

/** Portfolio scope = account quote cash (free + exchange locked) plus marked
 * CoinOps-owned base positions. Neither slot allocation nor base wallet assets
 * are added again. Unmanaged wallet assets are disclosed, not silently valued. */
export function buildFinopsCapital(input: CapitalInput): FinopsCapital {
  const now = input.now ?? Date.now(), warnings: string[] = [];
  for (const row of [...input.accounts, ...input.engines, ...input.runs, ...input.slotAccounts, ...input.slots, ...input.orders])
    if (row.operator_id !== input.operatorId) throw new Error("COINOPS_FINOPS_CAPITAL_SCOPE_MISMATCH");
  const accounts = input.accounts.filter((row) => !["DISABLED", "REVOKED"].includes(row.status)
    && (row.onboarding_environment === "REAL" || input.engines.some((engine) => engine.exchange_account_id === row.id && engine.environment === "REAL")));
  const accountIds = new Set(accounts.map((row) => row.id));
  const engines = input.engines.filter((row) => row.environment === "REAL" && accountIds.has(row.exchange_account_id));
  for (const row of [...input.runs, ...input.slotAccounts, ...input.slots, ...input.orders]) {
    const engine = engines.find((item) => item.id === row.trading_engine_id);
    if (engine && engine.exchange_account_id !== row.exchange_account_id) throw new Error("COINOPS_FINOPS_CAPITAL_ENGINE_MISMATCH");
  }
  const markets: FinopsCapitalMarket[] = engines.map((engine) => {
    const account = accounts.find((row) => row.id === engine.exchange_account_id)!;
    const runRows = input.runs.filter((row) => row.trading_engine_id === engine.id && OPEN_RUN.has(row.status));
    const run = runRows.length === 1 ? runRows[0] : null;
    const slots = input.slots.filter((row) => row.trading_engine_id === engine.id && row.run_id === run?.id);
    const ledger = input.slotAccounts.filter((row) => row.trading_engine_id === engine.id);
    const orders = input.orders.filter((row) => row.trading_engine_id === engine.id && row.run_id === run?.id
      && row.side === "BUY" && ACTIVE_ORDER.has(row.status));
    const latestPrice = (input.prices ?? []).filter((row) => row.symbol === engine.symbol
      && (!row.accountId || row.accountId === account.id)).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    const price = latestPrice && fresh(latestPrice.observedAt, now) && (decimal(latestPrice.price) ?? ZERO) > ZERO ? latestPrice : null;
    const validSlots = (rows: Array<{ slot_number: number }>) => rows.length === 25
      && new Set(rows.map((row) => row.slot_number)).size === 25 && rows.every((row) => row.slot_number >= 1 && row.slot_number <= 25);
    const ledgerValid = validSlots(ledger);
    const positionValid = validSlots(slots) && runRows.length === 1 && fresh(run?.last_reconciled_at ?? null, now);
    if (!ledgerValid || !positionValid) warnings.push(`LEDGER_INCOMPLETE:${engine.id}`);
    if (!engine.executor_shard_id) warnings.push(`SHARD_UNAVAILABLE:${engine.id}`);
    const ledgerCapital = ledgerValid ? total(ledger.map((row) => row.balance_quote)) : null;
    const positionCost = positionValid ? total(slots.map((row) => row.position_committed_quote)) : null;
    const quantity = positionValid ? total(slots.map((row) => row.position_quantity)) : null;
    const positionValue = decimal(quantity) === ZERO ? formatted(ZERO) : price ? multiply(quantity, price.price) : null;
    const reserved = positionValid ? total(orders.map((row) => {
      const intended = row.reserved_notional_quote ?? row.requested_quote ?? multiply(row.requested_quantity, row.price);
      const remaining = decimal(subtract(intended, row.cumulative_quote));
      return formatted(remaining === null ? null : remaining < ZERO ? ZERO : remaining);
    })) : null;
    return { accountId: account.id, accountName: account.display_name, engineId: engine.id,
      shardId: engine.executor_shard_id ?? "UNASSIGNED", symbol: engine.symbol, baseAsset: engine.base_asset,
      positionQuantity: quantity, currency: engine.quote_asset,
      status: engine.status, active: engine.status === "ACTIVE" && !engine.kill_switch && run?.status === "ACTIVE",
      reconciledAt: run?.last_reconciled_at ?? null, priceAt: price?.observedAt ?? null,
      ledgerCapital, ledgerFree: subtract(ledgerCapital, total([positionCost, reserved])), positionCost, positionValue,
      reserved, realizedPnl: ledgerValid ? total(ledger.map((row) => subtract(row.market_pnl_quote, row.fees_quote))) : null,
      openPnl: subtract(positionValue, positionCost), gains: ledgerValid ? ledger.reduce((sum, row) => sum + row.gain_count, 0) : null };
  });
  const accountRows: FinopsCapitalAccount[] = accounts.map((account) => {
    const ownMarkets = markets.filter((row) => row.accountId === account.id);
    const rawWallet = (input.wallets ?? []).filter((row) => row.accountId === account.id)
      .sort((a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? ""))[0]
      ?? { accountId: account.id, observedAt: null, source: "INDISPONÍVEL", balances: [] };
    const status = rawWallet.observedAt ? fresh(rawWallet.observedAt, now) ? "CURRENT" : "STALE" : "UNAVAILABLE";
    if (status !== "CURRENT") warnings.push(`WALLET_${status}:${account.id}`);
    if (rawWallet.error) warnings.push(`WALLET_SYNC_FAILED:${account.id}`);
    const wallet = { ...rawWallet, status } as FinopsCapitalAccount["wallet"];
    const ownEngines = engines.filter((row) => row.exchange_account_id === account.id);
    const overlappingBaseQuote = ownEngines.some((engine) => ownEngines.some((other) => other.quote_asset === engine.base_asset));
    if (overlappingBaseQuote) warnings.push(`WALLET_BASE_QUOTE_OVERLAP:${account.id}`);
    const walletCoversOwnedPositions = [...new Set(ownMarkets.map((market) => market.baseAsset))].every((base) => {
      const owned = decimal(total(ownMarkets.filter((market) => market.baseAsset === base).map((market) => market.positionQuantity)));
      const observed = wallet.balances.filter((balance) => balance.asset === base);
      const available = observed.length <= 1 ? decimal(total(observed.map((balance) => total([balance.free, balance.locked])))) : null;
      return owned !== null && available !== null && owned <= available;
    });
    const observationConsistent = !rawWallet.error && rawWallet.consistent !== false && walletCoversOwnedPositions;
    if (status === "CURRENT" && !observationConsistent) warnings.push(`WALLET_LEDGER_OBSERVATION_MISMATCH:${account.id}`);
    const currencies = aggregate(ownMarkets).map((group) => {
      const candidates = wallet.balances.filter((row) => row.asset === group.currency);
      // A valid Binance snapshot is complete; absent zero-balance assets are zero.
      const balance = candidates.length <= 1 && status === "CURRENT" ? candidates[0] ?? { free: 0, locked: 0 } : null;
      const walletFree = balance ? formatted(decimal(balance.free)) : null;
      const walletLocked = balance ? formatted(decimal(balance.locked)) : null;
      const monitored = overlappingBaseQuote || !observationConsistent || ownEngines.some((engine) => !engine.executor_shard_id)
        ? null : total([walletFree, walletLocked, group.positionValue]);
      return { ...group, monitored, walletFree, walletLocked, complete: monitored !== null,
        observedAt: status === "CURRENT" ? wallet.observedAt : null };
    });
    const managedBases = new Set(engines.filter((row) => row.exchange_account_id === account.id).map((row) => row.base_asset));
    const quoteAssets = new Set(currencies.map((row) => row.currency));
    const excludedWalletAssets = wallet.balances.filter((row) => !quoteAssets.has(row.asset)
      && (decimal(total([row.free, row.locked])) ?? ZERO) > ZERO).map((row) => row.asset);
    if (excludedWalletAssets.some((asset) => !managedBases.has(asset))) warnings.push(`UNMANAGED_WALLET_ASSETS:${account.id}`);
    if (!currencies.length) warnings.push(`NO_REAL_MARKET:${account.id}`);
    const shardIds = [...new Set(ownEngines.map((engine) => engine.executor_shard_id).filter((id): id is string => Boolean(id)))].sort();
    return { id: account.id, name: account.display_name, shardIds,
      shardId: shardIds.length > 1 ? "MULTI_SHARD" : shardIds[0] ?? "UNASSIGNED",
      status: account.status, wallet, currencies, excludedWalletAssets };
  });
  return { observedAt: new Date(now).toISOString(), counts: { accounts: accounts.length,
    activeAccounts: accounts.filter((account) => account.status === "ACTIVE").length, engines: engines.length,
    activeEngines: markets.filter((market) => market.active).length,
    shards: new Set(engines.map((engine) => engine.executor_shard_id).filter(Boolean)).size }, accounts: accountRows, markets,
    currencies: aggregate(markets), shards: [...new Set(markets.map((row) => row.shardId))].map((shardId) => ({ shardId,
      currencies: aggregate(markets.filter((row) => row.shardId === shardId)) })),
    sources: ["coinops.exchange_accounts / trading_engines", "coinops.robot_v1_live_slot_accounts.balance_quote (alocação, não patrimônio adicional)",
      "coinops.robot_v1_live_slots.position_quantity / position_committed_quote (ciclo vigente)",
      "coinops.robot_v1_live_orders (reserva BUY remanescente)", "Snapshot Binance via executor atribuído (somente leitura, na sincronização)"],
    warnings: [...new Set(warnings)] };
}

const asNumber = (value: string | null) => value === null ? null : Number(value);
export function finopsCapitalRows(capital: FinopsCapital): { accounts: FinopsCapitalRow[]; markets: FinopsMarketRow[]; notes: string[] } {
  return { accounts: capital.accounts.flatMap((account) => account.currencies.map((row) => ({
    accountId: account.id, accountName: account.name, shardId: account.shardId, currency: row.currency,
    monitored: asNumber(row.monitored), free: asNumber(row.walletFree), reserved: asNumber(row.reserved),
    positions: asNumber(row.positionValue), realizedPnl: asNumber(row.realizedPnl), openPnl: asNumber(row.openPnl),
    observedAt: row.observedAt, source: account.wallet.source, complete: row.complete,
  }))), markets: capital.markets.map((row) => ({ accountId: row.accountId, accountName: row.accountName,
    shardId: row.shardId, market: row.symbol, currency: row.currency, positions: asNumber(row.positionValue),
    reserved: asNumber(row.reserved), realizedPnl: asNumber(row.realizedPnl), openPnl: asNumber(row.openPnl) })),
    notes: ["Capital monitorado = caixa livre + caixa bloqueado na Binance nas moedas das estratégias + posições pertencentes ao CoinOps marcadas a mercado.",
      "Saldo/alocação dos slots, hard caps e P&L não são somados novamente ao patrimônio. Capital dos usuários não é receita CoinOps.",
      "Outros ativos da carteira Binance não são valorizados nesta soma. Quantidades base da carteira não são somadas novamente às posições do ledger.",
      "P&L realizado usa market_pnl_quote menos fees_quote; ajustes administrativos não viram resultado de trading. Valores nativos nunca são somados entre moedas.",
      ...capital.warnings] };
}

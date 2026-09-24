/** Public, immutable routing identity. This contract never carries credentials. */
export type EngineEnvironment = "REAL" | "SHADOW" | "TESTNET";
export type OperatorScope = { product_id: string; tenant_id: string; user_id: string };
export type OperatorRow = OperatorScope & { id: string; status: string; kill_switch: boolean };
export type ExchangeAccountRow = {
  id: string; operator_id: string; display_name: string; status: string;
  is_legacy_default: boolean; kill_switch: boolean;
};
export type TradingEngineRow = {
  id: string; operator_id: string; exchange_account_id: string; environment: EngineEnvironment;
  symbol: string; base_asset: string; quote_asset: string; status: string;
  kill_switch: boolean; hard_cap_quote: number | string; legacy_compatible: boolean;
  ath_reference_symbol?: string;
};
export type DomainRegistry = {
  operator: OperatorRow; accounts: ExchangeAccountRow[]; engines: TradingEngineRow[];
};
export type EngineContext = {
  operator_id: string; exchange_account_id: string; trading_engine_id: string;
  account_display_name: string; environment: EngineEnvironment; symbol: string;
  base_asset: string; quote_asset: string; is_legacy_default: boolean;
  global_kill_switch: boolean; account_kill_switch: boolean; engine_kill_switch: boolean;
  status: string; hard_cap_quote: number | string; legacy_compatible: boolean;
  ath_reference_symbol: string;
};
export type EngineSelection = {
  environment: EngineEnvironment; asset?: string; symbol?: string;
  operator_id?: string; exchange_account_id?: string; trading_engine_id?: string;
};
export const isIdentity = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function assertNativeMarket(base: string, quote: string, symbol: string) {
  if (!/^[A-Z0-9]{2,20}$/.test(base) || !/^[A-Z0-9]{2,20}$/.test(quote)
    || base === quote || symbol !== `${base}${quote}`) throw new Error("COINOPS_ENGINE_MARKET_INVALID");
}

export function assertDomainRegistry(registry: DomainRegistry, scope: OperatorScope) {
  const operator = registry.operator;
  if (!operator || !isIdentity(operator.id) || operator.product_id !== scope.product_id
    || operator.tenant_id !== scope.tenant_id || operator.user_id !== scope.user_id
    || operator.status !== "ACTIVE") throw new Error("COINOPS_OPERATOR_SCOPE_DENIED");
  const accounts = new Map<string, ExchangeAccountRow>();
  for (const account of registry.accounts) {
    if (!isIdentity(account.id) || account.operator_id !== operator.id || accounts.has(account.id)
      || !account.display_name || typeof account.kill_switch !== "boolean"
      || typeof account.is_legacy_default !== "boolean") throw new Error("COINOPS_ACCOUNT_SCOPE_DENIED");
    accounts.set(account.id, account);
  }
  if (registry.accounts.filter((account) => account.is_legacy_default).length > 1)
    throw new Error("COINOPS_LEGACY_ACCOUNT_AMBIGUOUS");
  const engines = new Set<string>(), markets = new Set<string>();
  for (const engine of registry.engines) {
    const marketKey = `${engine.exchange_account_id}:${engine.environment}:${engine.symbol}`;
    if (!isIdentity(engine.id) || engine.operator_id !== operator.id || !accounts.has(engine.exchange_account_id)
      || engines.has(engine.id) || markets.has(marketKey) || !["REAL", "SHADOW", "TESTNET"].includes(engine.environment)
      || typeof engine.kill_switch !== "boolean" || !Number.isFinite(Number(engine.hard_cap_quote))
      || Number(engine.hard_cap_quote) < 0) throw new Error("COINOPS_ENGINE_SCOPE_DENIED");
    assertNativeMarket(engine.base_asset, engine.quote_asset, engine.symbol);
    engines.add(engine.id); markets.add(marketKey);
  }
}

/** Legacy callers resolve only an explicitly designated account, never the
 * first account nor a fallback when a supplied ID is missing or inconsistent. */
export function resolveEngineContext(registry: DomainRegistry, selection: EngineSelection): EngineContext {
  assertDomainRegistry(registry, registry.operator);
  for (const id of [selection.operator_id, selection.exchange_account_id, selection.trading_engine_id])
    if (id !== undefined && !isIdentity(id)) throw new Error("COINOPS_ENGINE_SELECTION_INVALID");
  if (selection.operator_id && selection.operator_id !== registry.operator.id)
    throw new Error("COINOPS_OPERATOR_SCOPE_DENIED");
  const explicit = selection.exchange_account_id !== undefined || selection.trading_engine_id !== undefined;
  if (explicit && (!selection.exchange_account_id || !selection.trading_engine_id))
    throw new Error("COINOPS_ENGINE_SELECTION_INCOMPLETE");
  const matches = registry.engines.filter((engine) => engine.environment === selection.environment
    && (!selection.asset || engine.base_asset === selection.asset)
    && (!selection.symbol || engine.symbol === selection.symbol)
    && (explicit ? engine.id === selection.trading_engine_id && engine.exchange_account_id === selection.exchange_account_id
      : engine.legacy_compatible && registry.accounts.some((account) => account.id === engine.exchange_account_id && account.is_legacy_default)));
  if (matches.length !== 1) throw new Error("COINOPS_ENGINE_SCOPE_DENIED");
  const engine = matches[0]!, account = registry.accounts.find((item) => item.id === engine.exchange_account_id)!;
  if (account.status === "DISABLED" || account.status === "REVOKED") throw new Error("COINOPS_ACCOUNT_DISABLED");
  return { operator_id: registry.operator.id, exchange_account_id: account.id, trading_engine_id: engine.id,
    account_display_name: account.display_name, environment: engine.environment, symbol: engine.symbol,
    base_asset: engine.base_asset, quote_asset: engine.quote_asset, is_legacy_default: account.is_legacy_default,
    global_kill_switch: registry.operator.kill_switch, account_kill_switch: account.kill_switch || account.status !== "ACTIVE",
    engine_kill_switch: engine.kill_switch, status: engine.status, hard_cap_quote: engine.hard_cap_quote,
    legacy_compatible: engine.legacy_compatible,
    ath_reference_symbol: engine.ath_reference_symbol ?? (engine.legacy_compatible ? `${engine.base_asset}USDC` : engine.symbol) };
}

export function assertRowEngine(row: { operator_id?: unknown; exchange_account_id?: unknown; trading_engine_id?: unknown;
  environment?: unknown; symbol?: unknown; quote_asset?: unknown }, context: EngineContext) {
  if (row.operator_id !== context.operator_id || row.exchange_account_id !== context.exchange_account_id
    || row.trading_engine_id !== context.trading_engine_id
    || row.environment !== undefined && row.environment !== context.environment
    || row.symbol !== undefined && row.symbol !== context.symbol
    || row.quote_asset !== undefined && row.quote_asset !== context.quote_asset)
    throw new Error("COINOPS_ENGINE_ROW_MISMATCH");
}

/** Integer decimal aggregation: native quote amounts only, no implicit FX. */
export function sumNativeAmounts(rows: readonly { exchange_account_id: string; environment: EngineEnvironment;
  quote_asset: string; amount: string | null }[]) {
  const groups = new Map<string, { exchange_account_id: string; environment: EngineEnvironment;
    quote_asset: string; total: bigint; missing: boolean }>();
  for (const row of rows) {
    if (!isIdentity(row.exchange_account_id) || !/^[A-Z0-9]{2,20}$/.test(row.quote_asset)
      || !["REAL", "SHADOW", "TESTNET"].includes(row.environment)) throw new Error("COINOPS_NATIVE_AMOUNT_SCOPE_INVALID");
    const key = `${row.exchange_account_id}:${row.environment}:${row.quote_asset}`;
    const group = groups.get(key) ?? { ...row, total: BigInt(0), missing: false };
    if (row.amount === null) group.missing = true;
    else {
      const parsed = /^(-?)(\d+)(?:\.(\d{1,8}))?$/.exec(row.amount);
      if (!parsed) throw new Error("COINOPS_NATIVE_AMOUNT_INVALID");
      group.total += (BigInt(parsed[2]!) * BigInt(100000000) + BigInt((parsed[3] ?? "").padEnd(8, "0")))
        * (parsed[1] ? BigInt(-1) : BigInt(1));
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const value = group.total < 0 ? -group.total : group.total;
    return { exchange_account_id: group.exchange_account_id, environment: group.environment, quote_asset: group.quote_asset,
      amount: group.missing ? null : `${group.total < 0 ? "-" : ""}${value / BigInt(100000000)}.${String(value % BigInt(100000000)).padStart(8, "0")}` };
  });
}

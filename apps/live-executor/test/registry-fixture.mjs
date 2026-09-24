export const OPERATOR = "00000000-0000-4000-8000-000000000001";
export const ACCOUNT_A = "00000000-0000-4000-8000-000000000002";
export const ACCOUNT_B = "00000000-0000-4000-8000-000000000003";
export function engineFixture(symbol = "BTCBRL", account = ACCOUNT_A, index = 1, legacy = true) {
  const base = symbol.startsWith("BTC") ? "BTC" : "SOL", quote = symbol.slice(3);
  return { operator_id: OPERATOR, exchange_account_id: account,
    trading_engine_id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    environment: "REAL", symbol, base_asset: base, quote_asset: quote, status: "ACTIVE",
    is_legacy_default: account === ACCOUNT_A, legacy_ownership: legacy, execution_allowed: false,
    kill_switch: false, account_kill_switch: false, global_kill_switch: false,
    credential_ref: account === ACCOUNT_A ? "legacy-binance-production" : `fixture-${account}`,
    executor_profile: "coinops-fixed-ip", hard_cap_quote: base === "BTC" ? 450 : 275,
    account_cap_quote: 725, max_order_quote: base === "BTC" ? 18 : 11 };
}
export function registryFixture(engines = [engineFixture(), engineFixture("SOLBRL", ACCOUNT_A, 2)]) {
  return { version: 1, engines, credentials: Object.fromEntries(engines.map((engine) => [engine.credential_ref,
    { api_key_env: engine.exchange_account_id === ACCOUNT_A ? "FIXTURE_A_KEY" : "FIXTURE_B_KEY",
      api_secret_env: engine.exchange_account_id === ACCOUNT_A ? "FIXTURE_A_SECRET" : "FIXTURE_B_SECRET" }])) };
}
export const credentialEnvironment = { FIXTURE_A_KEY: "fictional-key-A", FIXTURE_A_SECRET: "fictional-secret-A",
  FIXTURE_B_KEY: "fictional-key-B", FIXTURE_B_SECRET: "fictional-secret-B" };
export function intentContext(engine, key = "fixture-read-key-1") {
  return { operator_id: engine.operator_id, exchange_account_id: engine.exchange_account_id,
    trading_engine_id: engine.trading_engine_id, environment: "REAL", symbol: engine.symbol,
    quote_asset: engine.quote_asset, decision_id: key, idempotency_key: key };
}

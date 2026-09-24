import type { EngineContext } from "./operator-context.ts";

type SecretEntry = { operator_id: string; exchange_account_id: string; environment: "TESTNET";
  engines: Array<{ trading_engine_id: string; symbol: string }>; apiKey: string; apiSecret: string };

/** Called only server-side. A missing or mismatched registry entry never falls
 * back to the current account. Legacy keys are pinned to the proven legacy
 * TESTNET engines; Production keys are never inspected here. */
export function resolveTestnetCredentials(engine: EngineContext, env: Record<string, string | undefined>) {
  if (engine.environment !== "TESTNET") throw new Error("COINOPS_TESTNET_ACCOUNT_ENVIRONMENT_DENIED");
  const registryText = env.COINOPS_TESTNET_ACCOUNTS_JSON;
  if (registryText) {
    let entries: SecretEntry[];
    try { entries = JSON.parse(registryText) as SecretEntry[]; } catch { throw new Error("COINOPS_TESTNET_ACCOUNT_REGISTRY_INVALID"); }
    if (!Array.isArray(entries)) throw new Error("COINOPS_TESTNET_ACCOUNT_REGISTRY_INVALID");
    if (entries.some((entry) => !entry || typeof entry !== "object")) throw new Error("COINOPS_TESTNET_ACCOUNT_REGISTRY_INVALID");
    const matches = entries.filter((entry) => entry.exchange_account_id === engine.exchange_account_id);
    if (matches.length !== 1) throw new Error("COINOPS_TESTNET_ACCOUNT_CREDENTIAL_DENIED");
    const selected = matches[0]!;
    if (selected.operator_id !== engine.operator_id || selected.environment !== "TESTNET"
      || !Array.isArray(selected.engines) || selected.engines.filter((item) => item && item.trading_engine_id === engine.trading_engine_id && item.symbol === engine.symbol).length !== 1
      || typeof selected.apiKey !== "string" || !selected.apiKey || typeof selected.apiSecret !== "string" || !selected.apiSecret)
      throw new Error("COINOPS_TESTNET_ACCOUNT_CREDENTIAL_DENIED");
    return { apiKey: selected.apiKey, apiSecret: selected.apiSecret };
  }
  if (!engine.is_legacy_default || !engine.legacy_compatible || !["BTCUSDC", "SOLUSDC"].includes(engine.symbol))
    throw new Error("COINOPS_TESTNET_ACCOUNT_CREDENTIAL_DENIED");
  const apiKey = env.BINANCE_TESTNET_API_KEY?.trim(), apiSecret = env.BINANCE_TESTNET_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("COINOPS_TESTNET_CREDENTIALS_MISSING");
  return { apiKey, apiSecret };
}

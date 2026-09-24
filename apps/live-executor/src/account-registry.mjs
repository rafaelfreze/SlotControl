import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ExecutorRejection, sha256 } from "./security.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-zA-Z0-9:_-]{8,160}$/;
export const CONTEXT_FIELDS = ["operator_id", "exchange_account_id", "trading_engine_id", "environment", "quote_asset", "idempotency_key"];
const deny = (code = "EXECUTOR_ENGINE_SCOPE_DENIED") => { throw new ExecutorRejection(code, 403); };

/** The file is installed by the operator, never accepted from a web request.
 * It contains references to environment secrets, not credential values. */
export async function loadExecutorRegistry(path) {
  if (!path || !isAbsolute(path)) deny("EXECUTOR_REGISTRY_REQUIRED");
  const metadata = await stat(path);
  // root owns the file; the dedicated service group may read, never write it.
  if (process.platform !== "win32" && (metadata.uid !== 0 || (metadata.mode & 0o027) !== 0))
    deny("EXECUTOR_REGISTRY_NOT_PRIVATE");
  return validateExecutorRegistry(JSON.parse(await readFile(path, "utf8")));
}

export function validateExecutorRegistry(registry) {
  if (registry?.version !== 1 || !Array.isArray(registry.engines) || !registry.credentials
    || !registry.engines.length) deny("EXECUTOR_REGISTRY_INVALID");
  const ids = new Set(), markets = new Set(), accounts = new Map(), credentials = new Map();
  for (const row of registry.engines) {
    const market = `${row.exchange_account_id}:${row.environment}:${row.symbol}`;
    if (![row.operator_id, row.exchange_account_id, row.trading_engine_id].every((id) => UUID.test(id ?? ""))
      || ids.has(row.trading_engine_id) || markets.has(market) || row.environment !== "REAL"
      || !/^[A-Z0-9]{2,20}$/.test(row.base_asset ?? "") || !/^[A-Z0-9]{2,20}$/.test(row.quote_asset ?? "")
      || row.symbol !== row.base_asset + row.quote_asset || row.base_asset === row.quote_asset
      || ![row.kill_switch, row.account_kill_switch, row.global_kill_switch, row.execution_allowed,
        row.is_legacy_default, row.legacy_ownership].every((flag) => typeof flag === "boolean")
      || ![row.hard_cap_quote, row.account_cap_quote, row.max_order_quote].every((v) => Number.isFinite(v) && v > 0)
      || row.hard_cap_quote > row.account_cap_quote || row.max_order_quote > row.hard_cap_quote
      || row.executor_profile !== "coinops-fixed-ip"
      || !registry.credentials[row.credential_ref]) deny("EXECUTOR_REGISTRY_INVALID");
    if (row.legacy_ownership && (!row.is_legacy_default || !["BTCBRL", "SOLBRL"].includes(row.symbol)
      || row.credential_ref !== "legacy-binance-production")) deny("EXECUTOR_LEGACY_SCOPE_DENIED");
    if (row.is_legacy_default && (row.execution_allowed || row.legacy_ownership) && (!["BTCBRL", "SOLBRL"].includes(row.symbol)
      || row.hard_cap_quote > (row.base_asset === "BTC" ? 450 : 275) || row.account_cap_quote > 725
      || row.max_order_quote > (row.base_asset === "BTC" ? 18 : 11))) deny("EXECUTOR_HARD_CAP_DENIED");
    const reference = registry.credentials[row.credential_ref];
    if (![reference.api_key_env, reference.api_secret_env].every((v) => /^[A-Z][A-Z0-9_]{2,100}$/.test(v ?? "")))
      deny("EXECUTOR_CREDENTIAL_REFERENCE_INVALID");
    const accountIdentity = `${row.operator_id}|${row.credential_ref}|${row.is_legacy_default}`;
    if (accounts.has(row.exchange_account_id) && accounts.get(row.exchange_account_id) !== accountIdentity
      || credentials.has(row.credential_ref) && credentials.get(row.credential_ref) !== row.exchange_account_id
      || row.credential_ref === "legacy-binance-production" && !row.is_legacy_default)
      deny("EXECUTOR_CREDENTIAL_ACCOUNT_MISMATCH");
    accounts.set(row.exchange_account_id, accountIdentity);
    credentials.set(row.credential_ref, row.exchange_account_id);
    ids.add(row.trading_engine_id); markets.add(market);
  }
  if (registry.legacy_account_id !== undefined && (!UUID.test(registry.legacy_account_id)
    || !registry.engines.some((row) => row.exchange_account_id === registry.legacy_account_id
      && row.is_legacy_default && row.legacy_ownership))) deny("EXECUTOR_LEGACY_SCOPE_DENIED");
  return registry;
}

export function resolveExecutorContext(registry, input, key, env = process.env,
  { allowLegacy = false, path = "" } = {}) {
  if (!registry) deny("EXECUTOR_REGISTRY_REQUIRED");
  if (!input || typeof input !== "object" || Array.isArray(input)) deny("EXECUTOR_BODY_INVALID");
  let legacyClient = false;
  // Rolling deployment bridge, explicitly pinned to the installed legacy
  // account. An explicit but invalid/incomplete envelope NEVER falls back.
  const hasRoutingField = ["operator_id", "exchange_account_id", "trading_engine_id", "quote_asset", "idempotency_key"]
    .some((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (allowLegacy && !hasRoutingField) {
    if (!registry.legacy_account_id || input.environment !== undefined && input.environment !== "REAL")
      deny("EXECUTOR_LEGACY_SCOPE_DENIED");
    const symbol = path === "/v1/reconciliation" && input.scope === "COINOPS_SHADOW_READ_ONLY" ? "BTCBRL" : input.symbol;
    const matches = registry.engines.filter((engine) => engine.exchange_account_id === registry.legacy_account_id
      && engine.is_legacy_default && engine.legacy_ownership && engine.symbol === symbol && engine.environment === "REAL");
    if (matches.length !== 1 || path === "/v1/health") deny("EXECUTOR_LEGACY_SCOPE_DENIED");
    const engine = matches[0];
    input = { ...input, ...responseContext(engine), decision_id: input.decision_id ?? key, idempotency_key: key };
    legacyClient = true;
  }
  if (![input.operator_id, input.exchange_account_id, input.trading_engine_id].every((id) => UUID.test(id ?? ""))
    || !KEY.test(input.decision_id ?? "") || !KEY.test(input.idempotency_key ?? "")
    || input.idempotency_key !== key) deny("EXECUTOR_CONTEXT_REQUIRED");
  const row = registry.engines.find((entry) => entry.trading_engine_id === input.trading_engine_id);
  if (!row || ["operator_id", "exchange_account_id", "environment", "symbol", "quote_asset"]
    .some((field) => row[field] !== input[field])) deny();
  if ("credential_ref" in input || "apiKey" in input || "apiSecret" in input)
    deny("EXECUTOR_CREDENTIAL_INPUT_DENIED");
  if (row.status !== "ACTIVE") deny("EXECUTOR_ENGINE_INACTIVE");
  const reference = registry.credentials[row.credential_ref];
  const apiKey = env[reference.api_key_env], apiSecret = env[reference.api_secret_env];
  if (!apiKey || !apiSecret) deny("EXECUTOR_BINANCE_CREDENTIALS_MISSING");
  return { engine: row, apiKey, apiSecret, input, legacyClient };
}

export function responseContext(engine) {
  return Object.fromEntries(["operator_id", "exchange_account_id", "trading_engine_id", "environment", "symbol", "quote_asset"]
    .map((field) => [field, engine[field]]));
}

export function engineOrderPrefix(engine) {
  return engine.legacy_ownership ? `COR1-${engine.base_asset}-`
    : `C2-${sha256(`${engine.exchange_account_id}|${engine.trading_engine_id}`).slice(0, 10)}-`;
}

export function assertEngineOrder(engine, symbol, id, side) {
  if (engine.symbol !== symbol || typeof id !== "string" || id.length > 36 || !id.startsWith(engineOrderPrefix(engine)))
    deny("EXECUTOR_ORDER_NOT_OWNED");
  const match = engine.legacy_ownership
    ? /^COR1-(BTC|SOL)-([1-9]|1[0-9]|2[0-5])-([1-9][0-9]*)-(BUY|SELL)-[a-f0-9]{14}$/.exec(id)
    : /^C2-[a-f0-9]{10}-([1-9]|1[0-9]|2[0-5])-(B|S)-[a-f0-9]{14}$/.exec(id);
  const actualSide = engine.legacy_ownership ? match?.[4] : match?.[2] === "B" ? "BUY" : "SELL";
  if (!match || side && actualSide !== side) deny("EXECUTOR_ORDER_NOT_OWNED");
  return { slot: engine.legacy_ownership ? match[2] : match[1], side: actualSide };
}

/** Existing COR1 claims keep exactly their original key and original payload
 * digest. Added routing fields must not invalidate a crash-recovery claim. */
export function durableIntent(engine, input, key, bodyHash, action) {
  if (!engine.legacy_ownership) return { key: `ENGINE:${sha256(`${engine.exchange_account_id}|${engine.trading_engine_id}|${key}`)}`, bodyHash };
  const legacy = Object.fromEntries(Object.entries(input).filter(([name]) => !CONTEXT_FIELDS.includes(name)
    && name !== "decision_id"));
  return { key, bodyHash: sha256(JSON.stringify(legacy)) };
}

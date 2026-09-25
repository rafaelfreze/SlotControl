import { chown, chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
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
  const quoteCaps = new Map();
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
    if (reference.vault === true ? row.credential_ref !== `account_${row.exchange_account_id.replaceAll("-", "")}`
      : ![reference.api_key_env, reference.api_secret_env].every((v) => /^[A-Z][A-Z0-9_]{2,100}$/.test(v ?? "")))
      deny("EXECUTOR_CREDENTIAL_REFERENCE_INVALID");
    const accountIdentity = `${row.operator_id}|${row.credential_ref}|${row.is_legacy_default}`;
    if (accounts.has(row.exchange_account_id) && accounts.get(row.exchange_account_id) !== accountIdentity
      || credentials.has(row.credential_ref) && credentials.get(row.credential_ref) !== row.exchange_account_id
      || row.credential_ref === "legacy-binance-production" && !row.is_legacy_default)
      deny("EXECUTOR_CREDENTIAL_ACCOUNT_MISMATCH");
    accounts.set(row.exchange_account_id, accountIdentity);
    credentials.set(row.credential_ref, row.exchange_account_id);
    const quoteKey = `${row.exchange_account_id}:${row.quote_asset}`;
    const quote = quoteCaps.get(quoteKey) ?? { cap: row.account_cap_quote, used: 0 };
    if (quote.cap !== row.account_cap_quote) deny("EXECUTOR_ACCOUNT_CAP_MISMATCH");
    quote.used += row.hard_cap_quote;
    quoteCaps.set(quoteKey, quote);
    ids.add(row.trading_engine_id); markets.add(market);
  }
  if ([...quoteCaps.values()].some((row) => row.used > row.cap + 1e-8))
    deny("EXECUTOR_ACCOUNT_CAP_EXCEEDED");
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
  // An inactive, killed engine may be inspected while its 25-slot cycle is
  // prepared. Exchange writes remain inaccessible until explicit promotion.
  const preparationRead = row.status === "INACTIVE"
    && ["/v1/health", "/v1/state", "/v1/dry-run"].includes(path)
    && !row.execution_allowed && row.kill_switch && row.account_kill_switch
    && row.global_kill_switch;
  if (row.status !== "ACTIVE" && !preparationRead) deny("EXECUTOR_ENGINE_INACTIVE");
  const reference = registry.credentials[row.credential_ref];
  const apiKey = reference.vault ? null : env[reference.api_key_env];
  const apiSecret = reference.vault ? null : env[reference.api_secret_env];
  if (!reference.vault && (!apiKey || !apiSecret)) deny("EXECUTOR_BINANCE_CREDENTIALS_MISSING");
  return { engine: row, apiKey, apiSecret, vault: reference.vault === true, input, legacyClient };
}

export function canReadDynamicRegistry(metadata, readerUid = process.getuid?.(), readerGid = process.getgid?.()) {
  const permissions = metadata.mode & 0o777;
  return (permissions & 0o077) === 0
    || metadata.uid === 0 && permissions === 0o640
      && (readerUid === 0 || metadata.gid === readerGid);
}

async function readDynamic(directory) {
  const path = join(directory, "dynamic-registry.json");
  const metadata = await stat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return { version: 1, engines: [], credentials: {} };
  if (process.platform !== "win32" && !canReadDynamicRegistry(metadata))
    deny("EXECUTOR_REGISTRY_NOT_PRIVATE");
  const content = await readFile(path, "utf8");
  const dynamic = JSON.parse(content);
  if (dynamic.version !== 1 || !Array.isArray(dynamic.engines) || !dynamic.credentials)
    deny("EXECUTOR_REGISTRY_INVALID");
  return dynamic;
}

export async function loadCombinedRegistry(staticRegistry, directory, onFailure = () => {}) {
  if (!staticRegistry) deny("EXECUTOR_REGISTRY_REQUIRED");
  try {
    const dynamic = await readDynamic(directory);
    return validateExecutorRegistry({ ...staticRegistry,
      engines: [...staticRegistry.engines, ...dynamic.engines],
      credentials: { ...staticRegistry.credentials, ...dynamic.credentials } });
  } catch (error) {
    // A damaged dynamic registry must fail closed for new accounts, never stop
    // Rafael's separately owned/static LIVE engines.
    onFailure(error instanceof ExecutorRejection ? error.code : "EXECUTOR_DYNAMIC_REGISTRY_UNAVAILABLE");
    return staticRegistry;
  }
}

/** Admin sync is preparation-only. It can never activate trading or mutate a legacy row. */
export async function saveInactiveRegistryAccount(staticRegistry, directory, scope, rows) {
  if (![scope.operator_id, scope.exchange_account_id].every((id) => UUID.test(id ?? ""))
    || scope.credential_ref !== `account_${scope.exchange_account_id.replaceAll("-", "")}`
    || !Array.isArray(rows) || rows.length > 8
    || rows.some((row) => row.operator_id !== scope.operator_id
      || row.exchange_account_id !== scope.exchange_account_id || row.credential_ref !== scope.credential_ref
      || row.status !== "INACTIVE" || row.execution_allowed !== false || row.kill_switch !== true
      || row.account_kill_switch !== true || row.global_kill_switch !== true
      || row.is_legacy_default !== false || row.legacy_ownership !== false))
    deny("EXECUTOR_REGISTRY_SYNC_DENIED");
  const lock = await open(join(directory, "dynamic-registry.lock"), "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") deny("EXECUTOR_REGISTRY_SYNC_IN_PROGRESS");
    throw error;
  });
  try {
    const dynamic = await readDynamic(directory);
    const existing = dynamic.engines.filter((row) => row.exchange_account_id === scope.exchange_account_id);
    if (existing.some((row) => row.operator_id !== scope.operator_id || row.status !== "INACTIVE"
      || row.execution_allowed || !row.kill_switch)) deny("EXECUTOR_REGISTRY_SYNC_DENIED");
    const next = { version: 1,
      engines: [...dynamic.engines.filter((row) => row.exchange_account_id !== scope.exchange_account_id), ...rows],
      credentials: { ...dynamic.credentials, [scope.credential_ref]: { vault: true } } };
    validateExecutorRegistry({ ...staticRegistry, engines: [...staticRegistry.engines, ...next.engines],
      credentials: { ...staticRegistry.credentials, ...next.credentials } });
    const target = join(directory, "dynamic-registry.json"), temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(next)); } finally { await handle.close(); }
    try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return { registered_engines: rows.length, status: "INACTIVE", trading_enabled: false };
  } finally { await lock.close(); await unlink(join(directory, "dynamic-registry.lock")).catch(() => {}); }
}

/** Promote one pre-registered nonlegacy engine after the web ledger has staged
 * its 25 slots and verified a fresh Binance snapshot. Never touch siblings. */
export async function promoteRegistryEngine(staticRegistry, directory, scope) {
  if (![scope.operator_id, scope.exchange_account_id, scope.trading_engine_id]
    .every((id) => UUID.test(id ?? ""))
    || scope.environment !== "REAL"
    || scope.credential_ref !== `account_${scope.exchange_account_id.replaceAll("-", "")}`
    || !/^(BTC|SOL)(BRL|USDT)$/.test(scope.symbol ?? ""))
    deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
  const lockPath = join(directory, "dynamic-registry.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") deny("EXECUTOR_REGISTRY_SYNC_IN_PROGRESS");
    throw error;
  });
  try {
    const dynamic = await readDynamic(directory);
    const row = dynamic.engines.find((item) => item.trading_engine_id === scope.trading_engine_id);
    if (!row || row.operator_id !== scope.operator_id || row.exchange_account_id !== scope.exchange_account_id
      || row.credential_ref !== scope.credential_ref || row.environment !== scope.environment
      || row.symbol !== scope.symbol || row.is_legacy_default || row.legacy_ownership
      || row.hard_cap_quote !== scope.hard_cap_quote || row.account_cap_quote !== scope.account_cap_quote
      || row.max_order_quote !== scope.max_order_quote
      || staticRegistry.engines.some((item) => item.trading_engine_id === row.trading_engine_id))
      deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
    if (row.status === "ACTIVE" && row.execution_allowed && !row.kill_switch
      && !row.account_kill_switch && !row.global_kill_switch)
      return { status: "ACTIVE", trading_engine_id: row.trading_engine_id, replayed: true };
    if (row.status !== "INACTIVE" || row.execution_allowed || !row.kill_switch
      || !row.account_kill_switch || !row.global_kill_switch)
      deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
    const next = { ...dynamic, engines: dynamic.engines.map((item) =>
      item.trading_engine_id !== row.trading_engine_id ? item : {
        ...item, status: "ACTIVE", execution_allowed: true, kill_switch: false,
        account_kill_switch: false, global_kill_switch: false }) };
    validateExecutorRegistry({ ...staticRegistry,
      engines: [...staticRegistry.engines, ...next.engines],
      credentials: { ...staticRegistry.credentials, ...next.credentials } });
    const target = join(directory, "dynamic-registry.json"), temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(next)); } finally { await handle.close(); }
    try {
      if (process.platform !== "win32" && process.getuid?.() === 0) {
        const metadata = await stat(directory);
        if (metadata.uid !== 0) { await chown(temporary, 0, metadata.gid); await chmod(temporary, 0o640); }
      }
      await rename(temporary, target);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return { status: "ACTIVE", trading_engine_id: row.trading_engine_id, replayed: false };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

/** Adjust only a nonlegacy account's native-quote safety caps. This never
 * touches Binance orders, a position or a sibling account. The caller must
 * prove the matching ledger intent and a fresh exchange balance separately. */
export async function changeRegistryCapital(staticRegistry, directory, scope) {
  if (![scope.operator_id, scope.exchange_account_id].every((id) => UUID.test(id ?? ""))
    || scope.environment !== "REAL" || !["BRL", "USDT"].includes(scope.quote_asset)
    || scope.credential_ref !== `account_${scope.exchange_account_id.replaceAll("-", "")}`
    || !Array.isArray(scope.engines) || scope.engines.length < 1 || scope.engines.length > 2
    || new Set(scope.engines.map((item) => item.trading_engine_id)).size !== scope.engines.length
    || ![scope.expected_account_cap_quote, scope.target_account_cap_quote].every((value) =>
      Number.isFinite(value) && value > 0 && value <= 1_000_000))
    deny("EXECUTOR_CAP_CHANGE_DENIED");
  const lockPath = join(directory, "dynamic-registry.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") deny("EXECUTOR_REGISTRY_SYNC_IN_PROGRESS");
    throw error;
  });
  try {
    const dynamic = await readDynamic(directory);
    const rows = dynamic.engines.filter((row) => row.exchange_account_id === scope.exchange_account_id
      && row.quote_asset === scope.quote_asset);
    if (rows.length !== scope.engines.length || staticRegistry.engines.some((row) =>
      row.exchange_account_id === scope.exchange_account_id)
      || rows.some((row) => row.operator_id !== scope.operator_id || row.environment !== "REAL"
        || row.credential_ref !== scope.credential_ref || row.status !== "ACTIVE"
        || row.is_legacy_default || row.legacy_ownership
        || !scope.engines.some((item) => item.trading_engine_id === row.trading_engine_id
          && item.symbol === row.symbol
          && Number.isFinite(item.expected_hard_cap_quote) && Number.isFinite(item.target_hard_cap_quote)
          && item.expected_hard_cap_quote > 0 && item.target_hard_cap_quote > 0
          && item.target_hard_cap_quote <= scope.target_account_cap_quote)))
      deny("EXECUTOR_CAP_CHANGE_DENIED");
    const alreadyTarget = rows.every((row) => row.account_cap_quote === scope.target_account_cap_quote
      && row.hard_cap_quote === scope.engines.find((item) => item.trading_engine_id === row.trading_engine_id)?.target_hard_cap_quote);
    if (alreadyTarget) return { status: "UPDATED", replayed: true };
    if (rows.some((row) => row.account_cap_quote !== scope.expected_account_cap_quote
      || row.hard_cap_quote !== scope.engines.find((item) => item.trading_engine_id === row.trading_engine_id)?.expected_hard_cap_quote)
      || Math.abs(scope.engines.reduce((sum, item) => sum + item.target_hard_cap_quote, 0)
        - scope.target_account_cap_quote) > 1e-8)
      deny("EXECUTOR_CAP_CHANGE_STALE");
    const next = { ...dynamic, engines: dynamic.engines.map((row) => {
      if (row.exchange_account_id !== scope.exchange_account_id || row.quote_asset !== scope.quote_asset) return row;
      const item = scope.engines.find((candidate) => candidate.trading_engine_id === row.trading_engine_id);
      return { ...row, account_cap_quote: scope.target_account_cap_quote,
        hard_cap_quote: item.target_hard_cap_quote,
        max_order_quote: Math.min(item.target_hard_cap_quote,
          row.max_order_quote + item.target_hard_cap_quote - item.expected_hard_cap_quote) };
    }) };
    validateExecutorRegistry({ ...staticRegistry,
      engines: [...staticRegistry.engines, ...next.engines],
      credentials: { ...staticRegistry.credentials, ...next.credentials } });
    const target = join(directory, "dynamic-registry.json"), temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(next)); } finally { await handle.close(); }
    try { await rename(temporary, target); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return { status: "UPDATED", replayed: false };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

/** Root-only release step after the account's exchange snapshot, ledger and
 * database gates have been checked. Never called from the HTTP handler. */
export async function promotePreparedRegistryAccount(staticRegistry, directory, scope, expected) {
  if (![scope.operator_id, scope.exchange_account_id].every((id) => UUID.test(id ?? ""))
    || scope.credential_ref !== `account_${scope.exchange_account_id.replaceAll("-", "")}`
    || !Array.isArray(expected) || expected.length !== 2
    || expected.some((item) => !UUID.test(item.trading_engine_id ?? "")
      || !["BTCUSDT", "SOLUSDT"].includes(item.symbol)
      || item.hard_cap_quote !== 419 || item.max_order_quote !== 419)
    || new Set(expected.map((item) => item.symbol)).size !== 2
    || staticRegistry.engines.some((row) => row.exchange_account_id === scope.exchange_account_id))
    deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
  const lockPath = join(directory, "dynamic-registry.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") deny("EXECUTOR_REGISTRY_SYNC_IN_PROGRESS");
    throw error;
  });
  try {
    const dynamic = await readDynamic(directory);
    const rows = dynamic.engines.filter((row) => row.exchange_account_id === scope.exchange_account_id);
    if (rows.length !== 2 || rows.some((row) => row.operator_id !== scope.operator_id
      || row.credential_ref !== scope.credential_ref || row.quote_asset !== "USDT"
      || row.environment !== "REAL" || row.is_legacy_default || row.legacy_ownership
      || row.account_cap_quote !== 838 || row.hard_cap_quote !== 419
      || row.max_order_quote !== 419 || !expected.some((item) => item.trading_engine_id === row.trading_engine_id
        && item.symbol === row.symbol))) deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
    if (rows.every((row) => row.status === "ACTIVE" && row.execution_allowed
      && !row.kill_switch && !row.account_kill_switch && !row.global_kill_switch))
      return { status: "ACTIVE", promoted_engines: 2, replayed: true };
    if (rows.some((row) => row.status !== "INACTIVE" || row.execution_allowed
      || !row.kill_switch || !row.account_kill_switch || !row.global_kill_switch))
      deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
    const next = { ...dynamic, engines: dynamic.engines.map((row) =>
      row.exchange_account_id !== scope.exchange_account_id ? row : {
        ...row, status: "ACTIVE", kill_switch: false, account_kill_switch: false,
        global_kill_switch: false, execution_allowed: true }) };
    validateExecutorRegistry({ ...staticRegistry,
      engines: [...staticRegistry.engines, ...next.engines],
      credentials: { ...staticRegistry.credentials, ...next.credentials } });
    const target = join(directory, "dynamic-registry.json"), temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(next)); } finally { await handle.close(); }
    // Promotion is performed by root, while the unprivileged executor must
    // read (never write) the resulting registry on each request.
    try {
      if (process.platform !== "win32" && process.getuid?.() === 0) {
        const directoryMetadata = await stat(directory);
        if (directoryMetadata.uid !== 0) {
          await chown(temporary, 0, directoryMetadata.gid);
          await chmod(temporary, 0o640);
        }
      }
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return { status: "ACTIVE", promoted_engines: 2, replayed: false };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
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

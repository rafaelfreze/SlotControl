import { chown, chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutorRejection, sha256 } from "./security.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-zA-Z0-9:_-]{8,160}$/;
export const CONTEXT_FIELDS = ["operator_id", "exchange_account_id", "trading_engine_id", "environment", "quote_asset", "idempotency_key", "executor_shard_id"];
const deny = (code = "EXECUTOR_ENGINE_SCOPE_DENIED") => { throw new ExecutorRejection(code, 403); };
const SHARD = /^executor-[0-9]{2,4}$/;

/** The installed identity is authoritative; signed routing metadata must agree.
 * Only executor-01 accepts omitted metadata during the non-disruptive rollout. */
export function assertExecutorShardContext(shardId, input) {
  if (!SHARD.test(shardId ?? "") || !input || typeof input !== "object" || Array.isArray(input)
    || (input.executor_shard_id ?? (shardId === "executor-01" ? "executor-01" : null)) !== shardId)
    deny("EXECUTOR_SHARD_SCOPE_DENIED");
}

export function assertRegistryShard(registry, shardId) {
  if (!SHARD.test(shardId ?? "") || !registry
    || (registry.executor_shard_id ?? "executor-01") !== shardId)
    deny("EXECUTOR_REGISTRY_SHARD_MISMATCH");
  validateExecutorRegistry(registry);
}

/** Read-only access to the already installed legacy credential. Never creates
 * a vault reference, changes the key or authorizes a different account/shard. */
export function installedLegacyCredentialForRead(registry, input, env, shardId) {
  const reference = registry?.credentials?.["legacy-binance-production"];
  const rows = registry?.engines?.filter((row) => row.operator_id === input?.operator_id
    && row.exchange_account_id === input.exchange_account_id && row.environment === "REAL"
    && row.credential_ref === "legacy-binance-production" && row.is_legacy_default
    && row.legacy_ownership) ?? [];
  if (shardId !== "executor-01" || input?.environment !== "REAL"
    || input.credential_ref !== "legacy-binance-production"
    || registry?.legacy_account_id !== input.exchange_account_id || !rows.length
    || !reference?.api_key_env || !reference.api_secret_env
    || !env?.[reference.api_key_env] || !env[reference.api_secret_env]
    || input.apiKey !== undefined || input.apiSecret !== undefined)
    deny("EXECUTOR_LEGACY_CREDENTIAL_READ_DENIED");
  return { apiKey: env[reference.api_key_env], apiSecret: env[reference.api_secret_env] };
}

function installedCredentialReference(registry, scope) {
  return scope.credential_ref === `account_${scope.exchange_account_id.replaceAll("-", "")}`
    || (registry.executor_shard_id ?? "executor-01") === "executor-01"
      && scope.environment === "REAL" && scope.credential_ref === "legacy-binance-production"
      && registry.legacy_account_id === scope.exchange_account_id
      && registry.engines.some((row) => row.operator_id === scope.operator_id
        && row.exchange_account_id === scope.exchange_account_id && row.legacy_ownership
        && row.credential_ref === scope.credential_ref);
}

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
    || typeof registry.credentials !== "object" || Array.isArray(registry.credentials))
    deny("EXECUTOR_REGISTRY_INVALID");
  const shardId = registry.executor_shard_id ?? "executor-01";
  if (!SHARD.test(shardId) || (!registry.engines.length && (!registry.executor_shard_id
    || shardId === "executor-01" || registry.legacy_account_id
    || Object.keys(registry.credentials).length))) deny("EXECUTOR_REGISTRY_INVALID");
  const ids = new Set(), prefixes = new Set(), accounts = new Map(), credentials = new Map();
  const quoteCaps = new Map();
  for (const row of registry.engines) {
    if ((row.executor_shard_id ?? shardId) !== shardId
      || shardId !== "executor-01" && (row.is_legacy_default || row.legacy_ownership))
      deny("EXECUTOR_REGISTRY_SHARD_MISMATCH");
    const ownerPrefix = `${row.environment}:${engineOrderPrefix(row)}`;
    if (![row.operator_id, row.exchange_account_id, row.trading_engine_id].every((id) => UUID.test(id ?? ""))
      || ids.has(row.trading_engine_id) || prefixes.has(ownerPrefix) || row.environment !== "REAL"
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
    if (row.is_legacy_default && (row.execution_allowed || row.legacy_ownership)
      && !["BTCBRL", "SOLBRL"].includes(row.symbol)) deny("EXECUTOR_HARD_CAP_DENIED");
    const reference = registry.credentials[row.credential_ref];
    if (reference.vault === true ? row.credential_ref !== `account_${row.exchange_account_id.replaceAll("-", "")}`
      : ![reference.api_key_env, reference.api_secret_env].every((v) => /^[A-Z][A-Z0-9_]{2,100}$/.test(v ?? "")))
      deny("EXECUTOR_CREDENTIAL_REFERENCE_INVALID");
    // A physical account may validate a dedicated vault reference while its
    // legacy engine keeps its installed environment reference. Credentials
    // still cannot be bound to a different account/operator.
    const accountIdentity = row.operator_id;
    if (accounts.has(row.exchange_account_id) && accounts.get(row.exchange_account_id) !== accountIdentity
      || credentials.has(row.credential_ref) && credentials.get(row.credential_ref) !== row.exchange_account_id
      || row.credential_ref === "legacy-binance-production" && (row.is_legacy_default
        ? registry.legacy_account_id !== undefined && registry.legacy_account_id !== row.exchange_account_id
        : registry.legacy_account_id !== row.exchange_account_id))
      deny("EXECUTOR_CREDENTIAL_ACCOUNT_MISMATCH");
    accounts.set(row.exchange_account_id, accountIdentity);
    credentials.set(row.credential_ref, row.exchange_account_id);
    const quoteKey = `${row.exchange_account_id}:${row.quote_asset}`;
    const quote = quoteCaps.get(quoteKey) ?? { cap: row.account_cap_quote, used: 0 };
    if (quote.cap !== row.account_cap_quote) deny("EXECUTOR_ACCOUNT_CAP_MISMATCH");
    quote.used += row.hard_cap_quote;
    quoteCaps.set(quoteKey, quote);
    ids.add(row.trading_engine_id); prefixes.add(ownerPrefix);
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
  assertExecutorShardContext(registry.executor_shard_id ?? "executor-01", input);
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
  return (permissions & 0o077) === 0 && (readerUid === 0 || metadata.uid === readerUid)
    || metadata.uid === 0 && permissions === 0o640
      && (readerUid === 0 || metadata.gid === readerGid);
}

/** Resolve the read-only ownership required after a root-operated atomic write.
 * Non-root writers keep their naturally owned 0600 file. Root preserves the
 * existing service group, or derives it from the service-owned data directory. */
export function dynamicRegistryRootAccess(directoryMetadata, currentMetadata, writerUid = process.getuid?.()) {
  if (writerUid !== 0) return null;
  const currentPermissions = currentMetadata ? currentMetadata.mode & 0o777 : null;
  const serviceGid = currentMetadata && (currentMetadata.uid !== 0 || currentPermissions === 0o640)
    ? currentMetadata.gid
    : directoryMetadata?.uid !== 0 ? directoryMetadata?.gid : null;
  return Number.isInteger(serviceGid) ? { uid: 0, gid: serviceGid, mode: 0o640 } : null;
}

async function writeDynamicRegistry(directory, next) {
  const target = join(directory, "dynamic-registry.json"), temporary = `${target}.${randomUUID()}.tmp`;
  const currentMetadata = await stat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(next)); } finally { await handle.close(); }
  try {
    if (process.platform !== "win32") {
      const access = dynamicRegistryRootAccess(await stat(directory), currentMetadata);
      if (access) {
        await chown(temporary, access.uid, access.gid);
        await chmod(temporary, access.mode);
      }
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
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
  if (dynamic.version !== 1 || !Array.isArray(dynamic.engines) || !dynamic.credentials
    || dynamic.capital_overrides !== undefined && !Array.isArray(dynamic.capital_overrides)
    || dynamic.account_cap_overrides !== undefined && !Array.isArray(dynamic.account_cap_overrides))
    deny("EXECUTOR_REGISTRY_INVALID");
  return dynamic;
}

export async function loadCombinedRegistry(staticRegistry, directory, onFailure = () => {}) {
  if (!staticRegistry) deny("EXECUTOR_REGISTRY_REQUIRED");
  try {
    const dynamic = await readDynamic(directory);
    return mergeDynamicRegistry(staticRegistry, dynamic, onFailure);
  } catch (error) {
    // An unreadable file still fails closed. A single invalid account should
    // not remove healthy siblings from the active routing table.
    onFailure(error instanceof ExecutorRejection ? error.code : "EXECUTOR_DYNAMIC_REGISTRY_UNAVAILABLE");
    return staticRegistry;
  }
}

/** Validate dynamic entries account by account, preserving healthy siblings. */
export function mergeDynamicRegistry(staticRegistry, dynamic, onFailure = () => {}) {
  if (dynamic.executor_shard_id !== undefined
    && dynamic.executor_shard_id !== (staticRegistry.executor_shard_id ?? "executor-01")) {
    onFailure("EXECUTOR_DYNAMIC_SHARD_MISMATCH");
    return staticRegistry;
  }
  const groups = new Map();
  for (const row of dynamic.engines) {
    if (!UUID.test(row?.exchange_account_id ?? "")) {
      onFailure("EXECUTOR_DYNAMIC_ACCOUNT_INVALID");
      continue;
    }
    const rows = groups.get(row.exchange_account_id) ?? [];
    rows.push(row);
    groups.set(row.exchange_account_id, rows);
  }
  let staticEngines = [...staticRegistry.engines];
  for (const override of dynamic.capital_overrides ?? []) {
    try {
      const rows = staticEngines.filter((row) => row.exchange_account_id === override?.exchange_account_id
        && row.quote_asset === override?.quote_asset);
      if (!UUID.test(override?.operator_id ?? "") || override.exchange_account_id !== staticRegistry.legacy_account_id
        || !["BRL", "USDT"].includes(override.quote_asset) || !Number.isFinite(override.account_cap_quote)
        || override.account_cap_quote <= 0 || override.account_cap_quote > 1_000_000
        || !Array.isArray(override.engines) || !rows.length || rows.length !== override.engines.length
        || rows.some((row) => row.operator_id !== override.operator_id || !row.is_legacy_default || !row.legacy_ownership
          || row.credential_ref !== "legacy-binance-production")
        || override.engines.some((item) => !rows.some((row) => row.trading_engine_id === item.trading_engine_id
          && row.symbol === item.symbol) || !Number.isFinite(item.hard_cap_quote) || item.hard_cap_quote <= 0
          || !Number.isFinite(item.max_order_quote) || item.max_order_quote <= 0
          || item.max_order_quote > item.hard_cap_quote)
        || override.engines.reduce((sum, item) => sum + item.hard_cap_quote, 0)
          > override.account_cap_quote + 1e-8)
        deny("EXECUTOR_LEGACY_CAP_OVERRIDE_INVALID");
      const patched = staticEngines.map((row) => row.exchange_account_id !== override.exchange_account_id
        || row.quote_asset !== override.quote_asset ? row : {
          ...row, account_cap_quote: override.account_cap_quote,
          hard_cap_quote: override.engines.find((item) => item.trading_engine_id === row.trading_engine_id).hard_cap_quote,
          max_order_quote: override.engines.find((item) => item.trading_engine_id === row.trading_engine_id).max_order_quote,
        });
      validateExecutorRegistry({ ...staticRegistry, engines: patched });
      staticEngines = patched;
    } catch {
      onFailure("EXECUTOR_LEGACY_CAP_OVERRIDE_REJECTED");
    }
  }
  // Shared-account metadata never changes any engine cap, strategy or flags.
  for (const override of dynamic.account_cap_overrides ?? []) {
    if (!UUID.test(override?.operator_id ?? "") || !UUID.test(override?.exchange_account_id ?? "")
      || !["BRL", "USDT"].includes(override?.quote_asset)
      || !Number.isFinite(override?.account_cap_quote) || override.account_cap_quote <= 0
      || override.account_cap_quote > 1_000_000) {
      onFailure("EXECUTOR_SHARED_ACCOUNT_CAP_REJECTED"); continue;
    }
    const matches = (row) => row.exchange_account_id === override.exchange_account_id && row.quote_asset === override.quote_asset;
    const own = [...staticEngines, ...(groups.get(override.exchange_account_id) ?? [])].filter(matches);
    if (own.some((row) => row.operator_id !== override.operator_id || row.environment !== "REAL"
      || row.account_cap_quote > override.account_cap_quote)) {
      onFailure("EXECUTOR_SHARED_ACCOUNT_CAP_REJECTED"); continue;
    }
    staticEngines = staticEngines.map((row) => matches(row) ? { ...row, account_cap_quote: override.account_cap_quote } : row);
    if (groups.has(override.exchange_account_id)) groups.set(override.exchange_account_id,
      groups.get(override.exchange_account_id).map((row) => matches(row) ? { ...row, account_cap_quote: override.account_cap_quote } : row));
  }
  const combined = { ...staticRegistry, engines: [...staticEngines],
    credentials: { ...staticRegistry.credentials } };
  const ids = new Set(staticEngines.map((row) => row.trading_engine_id));
  for (const [accountId, rows] of groups) {
    const reference = rows[0]?.credential_ref;
    const installed = reference === "legacy-binance-production" && installedCredentialReference(staticRegistry, rows[0]);
    if (!reference || (installed ? Object.hasOwn(dynamic.credentials, reference)
      : reference !== `account_${accountId.replaceAll("-", "")}` || staticRegistry.credentials[reference]
        || dynamic.credentials?.[reference]?.vault !== true)
      || rows.some((row) => row.credential_ref !== reference || ids.has(row.trading_engine_id))) {
      onFailure("EXECUTOR_DYNAMIC_ACCOUNT_REJECTED");
      continue;
    }
    try {
      // Validate only this account against the fixed static registry. Rechecking
      // every previously accepted account per request would grow cubically.
      validateExecutorRegistry({ ...staticRegistry,
        engines: [...staticEngines, ...rows],
        credentials: { ...staticRegistry.credentials, [reference]: installed ? staticRegistry.credentials[reference] : dynamic.credentials[reference] } });
      combined.engines.push(...rows);
      combined.credentials[reference] = installed ? staticRegistry.credentials[reference] : dynamic.credentials[reference];
      for (const row of rows) ids.add(row.trading_engine_id);
    } catch {
      onFailure("EXECUTOR_DYNAMIC_ACCOUNT_REJECTED");
    }
  }
  return validateExecutorRegistry(combined);
}

/** Admin sync is preparation-only. It can never activate trading or mutate a legacy row. */
export async function saveInactiveRegistryAccount(staticRegistry, directory, scope, rows) {
  assertExecutorShardContext(staticRegistry.executor_shard_id ?? "executor-01", scope);
  if (![scope.operator_id, scope.exchange_account_id].every((id) => UUID.test(id ?? ""))
    || scope.credential_ref !== `account_${scope.exchange_account_id.replaceAll("-", "")}`
    || !Array.isArray(rows)
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
    const next = { version: 1, ...(staticRegistry.executor_shard_id
      ? { executor_shard_id: staticRegistry.executor_shard_id } : {}),
      ...(dynamic.capital_overrides ? { capital_overrides: dynamic.capital_overrides } : {}),
      ...(dynamic.account_cap_overrides ? { account_cap_overrides: dynamic.account_cap_overrides } : {}),
      engines: [...dynamic.engines.filter((row) => row.exchange_account_id !== scope.exchange_account_id), ...rows],
      credentials: { ...dynamic.credentials, [scope.credential_ref]: { vault: true } } };
    validateExecutorRegistry({ ...staticRegistry, engines: [...staticRegistry.engines, ...next.engines],
      credentials: { ...staticRegistry.credentials, ...next.credentials } });
    await writeDynamicRegistry(directory, next);
    return { registered_engines: rows.length, status: "INACTIVE", trading_enabled: false };
  } finally { await lock.close(); await unlink(join(directory, "dynamic-registry.lock")).catch(() => {}); }
}

/** Register new killed engines without replacing, demoting or reconfiguring
 * any existing engine. Retries compare immutable identity and numeric limits,
 * including when the engine has since been promoted. No exchange calls. */
export async function appendInactiveRegistryEngines(staticRegistry, directory, scope, rows) {
  assertExecutorShardContext(staticRegistry.executor_shard_id ?? "executor-01", scope);
  if (![scope.operator_id, scope.exchange_account_id].every((id) => UUID.test(id ?? ""))
    || scope.environment !== "REAL" || !installedCredentialReference(staticRegistry, scope)
    || !Array.isArray(rows) || rows.length < 1 || new Set(rows.map((row) => row.trading_engine_id)).size !== rows.length
    || rows.some((row) => row.operator_id !== scope.operator_id || row.exchange_account_id !== scope.exchange_account_id
      || row.credential_ref !== scope.credential_ref || row.environment !== "REAL"
      || row.status !== "INACTIVE" || row.execution_allowed !== false || row.kill_switch !== true
      || row.account_kill_switch !== true || row.global_kill_switch !== true
      || row.is_legacy_default !== false || row.legacy_ownership !== false)) deny("EXECUTOR_REGISTRY_APPEND_DENIED");
  const lockPath = join(directory, "dynamic-registry.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") deny("EXECUTOR_REGISTRY_SYNC_IN_PROGRESS");
    throw error;
  });
  try {
    const dynamic = await readDynamic(directory);
    const current = mergeDynamicRegistry(staticRegistry, dynamic);
    const additions = [];
    for (const row of rows) {
      const existing = current.engines.find((entry) => entry.trading_engine_id === row.trading_engine_id);
      if (existing) {
        if (["operator_id", "exchange_account_id", "environment", "symbol", "base_asset", "quote_asset",
          "credential_ref", "hard_cap_quote", "max_order_quote", "legacy_ownership", "executor_profile"]
          .some((field) => existing[field] !== row[field])) deny("EXECUTOR_REGISTRY_APPEND_REPLAY_MISMATCH");
      } else additions.push(row);
    }
    if (!additions.length) return { registered_engines: rows.length, status: "INACTIVE", trading_enabled: false, replayed: true };
    const next = { ...dynamic, ...(staticRegistry.executor_shard_id ? { executor_shard_id: staticRegistry.executor_shard_id } : {}),
      engines: [...dynamic.engines, ...additions],
      credentials: { ...dynamic.credentials,
        ...(scope.credential_ref === "legacy-binance-production" ? {} : { [scope.credential_ref]: { vault: true } }) } };
    // Account caps must already have been synchronized before append. Never
    // silently change another engine's cap or strategy to fit a new engine.
    const failures = [];
    const checked = mergeDynamicRegistry(staticRegistry, next, (code) => failures.push(code));
    if (failures.length || rows.some((row) => !checked.engines.some((entry) => entry.trading_engine_id === row.trading_engine_id)))
      deny("EXECUTOR_REGISTRY_APPEND_DENIED");
    await writeDynamicRegistry(directory, next);
    return { registered_engines: rows.length, status: "INACTIVE", trading_enabled: false, replayed: false };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

/** Monotonic account-global cap metadata. A control-plane confirmed allocation
 * may add a new engine without reconfiguring any installed engine. No exchange
 * I/O, credentials, engine caps, positions, orders or flags are modified. */
export async function increaseRegistryAccountCap(staticRegistry, directory, scope) {
  assertExecutorShardContext(staticRegistry.executor_shard_id ?? "executor-01", scope);
  if (![scope.operator_id, scope.exchange_account_id].every((id) => UUID.test(id ?? ""))
    || scope.environment !== "REAL" || !["BRL", "USDT"].includes(scope.quote_asset)
    || !Number.isFinite(scope.account_cap_quote) || scope.account_cap_quote <= 0 || scope.account_cap_quote > 1_000_000)
    deny("EXECUTOR_SHARED_ACCOUNT_CAP_DENIED");
  const lockPath = join(directory, "dynamic-registry.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") deny("EXECUTOR_REGISTRY_SYNC_IN_PROGRESS"); throw error;
  });
  try {
    const dynamic = await readDynamic(directory), failures = [];
    const current = mergeDynamicRegistry(staticRegistry, dynamic, (code) => failures.push(code));
    const rows = current.engines.filter((row) => row.exchange_account_id === scope.exchange_account_id && row.quote_asset === scope.quote_asset);
    const previous = (dynamic.account_cap_overrides ?? []).find((row) => row.exchange_account_id === scope.exchange_account_id && row.quote_asset === scope.quote_asset);
    if (failures.length || previous && (previous.operator_id !== scope.operator_id || previous.account_cap_quote > scope.account_cap_quote)
      || rows.some((row) => row.operator_id !== scope.operator_id || row.environment !== "REAL" || row.account_cap_quote > scope.account_cap_quote))
      deny("EXECUTOR_SHARED_ACCOUNT_CAP_DENIED");
    if (previous?.account_cap_quote === scope.account_cap_quote) return { status: "SYNCED", account_cap_quote: scope.account_cap_quote, replayed: true };
    const next = { ...dynamic, account_cap_overrides: [
      ...(dynamic.account_cap_overrides ?? []).filter((row) => row.exchange_account_id !== scope.exchange_account_id || row.quote_asset !== scope.quote_asset),
      { operator_id: scope.operator_id, exchange_account_id: scope.exchange_account_id, quote_asset: scope.quote_asset, account_cap_quote: scope.account_cap_quote },
    ] };
    mergeDynamicRegistry(staticRegistry, next, (code) => failures.push(code));
    if (failures.length) deny("EXECUTOR_SHARED_ACCOUNT_CAP_DENIED");
    await writeDynamicRegistry(directory, next);
    return { status: "SYNCED", account_cap_quote: scope.account_cap_quote, replayed: false };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

/** Promote one pre-registered nonlegacy engine after the web ledger has staged
 * its 25 slots and verified a fresh Binance snapshot. Never touch siblings. */
export async function promoteRegistryEngine(staticRegistry, directory, scope) {
  assertExecutorShardContext(staticRegistry.executor_shard_id ?? "executor-01", scope);
  if (![scope.operator_id, scope.exchange_account_id, scope.trading_engine_id]
    .every((id) => UUID.test(id ?? ""))
    || scope.environment !== "REAL"
    || !installedCredentialReference(staticRegistry, scope)
    || !/^(BTC|SOL)(BRL|USDT)$/.test(scope.symbol ?? ""))
    deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
  const lockPath = join(directory, "dynamic-registry.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") deny("EXECUTOR_REGISTRY_SYNC_IN_PROGRESS");
    throw error;
  });
  try {
    const dynamic = await readDynamic(directory);
    const failures = [];
    const current = mergeDynamicRegistry(staticRegistry, dynamic, (code) => failures.push(code));
    const row = current.engines.find((item) => item.trading_engine_id === scope.trading_engine_id);
    if (failures.length) deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
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
    mergeDynamicRegistry(staticRegistry, next, (code) => failures.push(code));
    if (failures.length) deny("EXECUTOR_REGISTRY_PROMOTION_DENIED");
    await writeDynamicRegistry(directory, next);
    return { status: "ACTIVE", trading_engine_id: row.trading_engine_id, replayed: false };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

/** Adjust one account's native-quote safety caps. Legacy rows remain installed
 * in the root-owned registry, so their numeric caps are persisted as a strict
 * identity-bound override. This never touches Binance orders or positions. */
export async function changeRegistryCapital(staticRegistry, directory, scope) {
  assertExecutorShardContext(staticRegistry.executor_shard_id ?? "executor-01", scope);
  const legacy = scope.exchange_account_id === staticRegistry.legacy_account_id;
  if (![scope.operator_id, scope.exchange_account_id].every((id) => UUID.test(id ?? ""))
    || scope.environment !== "REAL" || !["BRL", "USDT"].includes(scope.quote_asset)
    || !installedCredentialReference(staticRegistry, scope)
    || !Array.isArray(scope.engines) || scope.engines.length < 1
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
    const current = mergeDynamicRegistry(staticRegistry, dynamic);
    const rows = current.engines.filter((row) => row.exchange_account_id === scope.exchange_account_id
      && row.quote_asset === scope.quote_asset);
    const local = scope.engines.filter((item) => rows.some((row) => row.trading_engine_id === item.trading_engine_id));
    // Every global allocation carries its immutable engine shard. Unknown IDs
    // on this shard are denied, not adopted. Legacy single-shard calls remain
    // compatible; an explicit cross-shard inventory is never inferred.
    const partitioned = scope.engines.every((item) => /^executor-[0-9]{2,4}$/.test(item.executor_shard_id ?? ""));
    if ((!partitioned && rows.length !== scope.engines.length)
      || (partitioned && scope.engines.some((item) =>
        (item.executor_shard_id === (staticRegistry.executor_shard_id ?? "executor-01"))
          !== rows.some((row) => row.trading_engine_id === item.trading_engine_id)))
      || rows.length !== local.length
      || rows.some((row) => row.operator_id !== scope.operator_id || row.environment !== "REAL"
        || row.credential_ref !== scope.credential_ref || row.status !== "ACTIVE"
        || row.is_legacy_default && !legacy
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
    const targets = rows.map((row) => {
      const item = scope.engines.find((candidate) => candidate.trading_engine_id === row.trading_engine_id);
      return { trading_engine_id: row.trading_engine_id, symbol: row.symbol,
        hard_cap_quote: item.target_hard_cap_quote,
        max_order_quote: Math.min(item.target_hard_cap_quote,
          row.max_order_quote + item.target_hard_cap_quote - item.expected_hard_cap_quote) };
    });
    const staticTargets = targets.filter((item) => staticRegistry.engines.some((row) => row.trading_engine_id === item.trading_engine_id));
    const next = { ...dynamic, ...(staticTargets.length ? { capital_overrides: [
      ...(dynamic.capital_overrides ?? []).filter((item) => item.exchange_account_id !== scope.exchange_account_id
        || item.quote_asset !== scope.quote_asset),
      { operator_id: scope.operator_id, exchange_account_id: scope.exchange_account_id,
        quote_asset: scope.quote_asset, account_cap_quote: scope.target_account_cap_quote, engines: staticTargets },
    ] } : {}), account_cap_overrides: [
      ...(dynamic.account_cap_overrides ?? []).filter((item) => item.exchange_account_id !== scope.exchange_account_id
        || item.quote_asset !== scope.quote_asset),
      { operator_id: scope.operator_id, exchange_account_id: scope.exchange_account_id,
        quote_asset: scope.quote_asset, account_cap_quote: scope.target_account_cap_quote },
    ], engines: dynamic.engines.map((row) => {
      if (row.exchange_account_id !== scope.exchange_account_id || row.quote_asset !== scope.quote_asset) return row;
      const target = targets.find((item) => item.trading_engine_id === row.trading_engine_id);
      return { ...row, account_cap_quote: scope.target_account_cap_quote,
        hard_cap_quote: target.hard_cap_quote, max_order_quote: target.max_order_quote };
    }) };
    const failures = [];
    const validated = mergeDynamicRegistry(staticRegistry, next, (code) => failures.push(code));
    if (failures.length || validated.engines.filter((row) => row.exchange_account_id === scope.exchange_account_id
      && row.quote_asset === scope.quote_asset).some((row) => row.account_cap_quote !== scope.target_account_cap_quote
        || row.hard_cap_quote !== targets.find((item) => item.trading_engine_id === row.trading_engine_id)?.hard_cap_quote))
      deny("EXECUTOR_CAP_CHANGE_DENIED");
    await writeDynamicRegistry(directory, next);
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
    await writeDynamicRegistry(directory, next);
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
  // Adding a transport route must not invalidate a claim already persisted
  // before sharding. Order identity and all financial fields remain unchanged.
  const routedHash = Object.prototype.hasOwnProperty.call(input, "executor_shard_id")
    ? sha256(JSON.stringify(Object.fromEntries(Object.entries(input).filter(([name]) => name !== "executor_shard_id"))))
    : bodyHash;
  if (!engine.legacy_ownership) return { key: `ENGINE:${sha256(`${engine.exchange_account_id}|${engine.trading_engine_id}|${key}`)}`, bodyHash: routedHash };
  const legacy = Object.fromEntries(Object.entries(input).filter(([name]) => !CONTEXT_FIELDS.includes(name)
    && name !== "decision_id"));
  return { key, bodyHash: sha256(JSON.stringify(legacy)) };
}

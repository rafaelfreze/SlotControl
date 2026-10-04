import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPrivateDirectory, ExecutorRejection, ExecutorPreDispatchRejection, sha256, verifySignedRequest,
  withDryRunIdempotency, withWriteIdempotency } from "./security.mjs";
import { getProductionRestrictedSpotStatus, getPublicMarket, observeEgressIp } from "./binance-readonly.mjs";
import { buildExecutorDryRun, EXECUTOR_CAPS } from "./preparation.mjs";
import { BinanceLiveTransport, unfilledCancelResolved } from "./binance-live.mjs";
import { durableOrderOwnership } from "./order-identity.mjs";
import { loadExecutorRegistry, resolveExecutorContext, responseContext, durableIntent,
  assertExecutorShardContext, assertRegistryShard, installedLegacyCredentialForRead } from "./account-registry.mjs";
import { assertCredentialScope, assertNoExchangeOpenOrders, inspectBinanceCredential, loadCredential, refreshCredential,
  removeCredential, saveCredential } from "./credential-vault.mjs";
import { loadCombinedRegistry, saveInactiveRegistryAccount, appendInactiveRegistryEngines, increaseRegistryAccountCap } from "./account-registry.mjs";
import { changeRegistryCapital, promoteRegistryEngine } from "./account-registry.mjs";
import { BinanceReadOnlyError, BinanceSpotAdapter } from "../../web/lib/execution/binance-spot-adapter.ts";
import { forwardTestnetRequest } from "./testnet-transport.mjs";
import { createCapacityTelemetry } from "./capacity-telemetry.mjs";
import { isTestnetEnabled } from "../../web/lib/execution/testnet-policy.ts";
import { createAccountOrderBudgetReader } from "./account-order-budget.mjs";
import { accountOrderPolicyEnabled, enableAccountOrderPolicy, ACCOUNT_ORDER_POLICY } from "./account-order-policy.mjs";
import { verifyAccountBudgetPermit } from "../../web/lib/execution/account-order-budget-permit.ts";
import { signAccountOrderUnsentProof } from "../../web/lib/execution/account-order-unsent-proof.ts";
import { assertUnsentFence, attestNeverDispatched } from "./unsent-recovery.mjs";

const BODY_LIMIT_BYTES = 16_384;
const healthCacheMs = 20_000;

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > BODY_LIMIT_BYTES) throw new ExecutorRejection("EXECUTOR_BODY_TOO_LARGE", 413);
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

function safeLog(event) {
  console.info(JSON.stringify(event));
}

export function createExecutorHandler({ secret, stateDirectory, expectedEgressIp,
  apiKey = null, apiSecret = null, fetcher: rawFetcher = fetch, now = Date.now,
  version = "unversioned", region = "UNSPECIFIED", logger = safeLog,
  tradingEnabled = false, killSwitch = true, registry = null, credentialEnvironment = process.env,
  allowLegacyClients = false, legacyVersion = null,
  shardId = process.env.COINOPS_EXECUTOR_SHARD_ID || "executor-01" }) {
  if (registry || shardId !== "executor-01") assertRegistryShard(registry, shardId);
  // Testnet is retired by the shared versioned policy, not a stale env flag.
  // LIVE tracking keeps the same transport, per-IP budget and recovery policy.
  const capacity = createCapacityTelemetry({ fetcher: rawFetcher, now, shardId });
  const fetcher = capacity.trackedFetch;
  const readOrderBudget = createAccountOrderBudgetReader({ now });
  let cachedHealth = null;
  const engineHealthCache = new Map();
  async function health() {
    if (cachedHealth && now() - cachedHealth.at < healthCacheMs) return cachedHealth.value;
    const started = now();
    const infrastructureHealth = shardId !== "executor-01";
    const [market, permission, egress] = await Promise.allSettled([
      getPublicMarket(fetcher, now),
      infrastructureHealth ? Promise.resolve("ENGINE_SCOPED")
        : getProductionRestrictedSpotStatus({ apiKey, apiSecret, fetcher }),
      observeEgressIp(fetcher),
    ]);
    const activeRegistry = infrastructureHealth
      ? await loadCombinedRegistry(registry, stateDirectory, (code) => logger({ action: "DYNAMIC_REGISTRY_FAIL_CLOSED", code })) : registry;
    const connected = market.status === "fulfilled";
    const permissionStatus = infrastructureHealth && !activeRegistry.engines.length ? "NOT_ASSIGNED"
      : permission.status === "fulfilled" ? permission.value : "UNVERIFIED";
    const observedIp = egress.status === "fulfilled" ? egress.value : null;
    const egressVerified = Boolean(expectedEgressIp && observedIp && expectedEgressIp === observedIp);
    const value = { healthy: connected && (infrastructureHealth || permissionStatus === "SPOT_RESTRICTED") && egressVerified,
      executor_shard_id: shardId, health_scope: infrastructureHealth ? "SHARD_INFRASTRUCTURE" : "LEGACY_ACCOUNT",
      version: allowLegacyClients && legacyVersion ? legacyVersion : version,
      actual_executor_version: version, legacy_contract_version: allowLegacyClients ? legacyVersion : null,
      legacy_compatibility_enabled: allowLegacyClients,
      region, environment: "BINANCE_PRODUCTION_PREPARED", clock: new Date(now()).toISOString(),
      clock_drift_ms: connected ? market.value.driftMs : null,
      binance_connectivity: connected ? "OK" : "UNAVAILABLE",
      symbols: connected ? market.value.markets.map((item) => item.raw.symbol) : [],
      account_permission: permissionStatus, egress_ipv4: observedIp,
      egress_ipv4_verified: egressVerified, trading_enabled: tradingEnabled, kill_switch: killSwitch,
      caps: EXECUTOR_CAPS, latency_ms: now() - started };
    value.isolation_contract = ACCOUNT_ORDER_POLICY;
    value.account_order_budget_protocol = 1;
    cachedHealth = { at: now(), value };
    return value;
  }
  return async function handler(request, response) {
    const started = now();
    const requestId = randomUUID();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const action = path === "/health" ? "HEALTH" : path === "/v1/dry-run" ? "DRY_RUN"
      : path === "/v1/capacity" ? "CAPACITY_READ"
      : path === "/v1/admin/credentials" ? "CREDENTIAL_ADMIN"
      : path === "/v1/admin/registry" ? "REGISTRY_ADMIN"
      : path === "/v1/admin/snapshot" ? "ACCOUNT_SNAPSHOT"
      : path === "/v1/admin/order-budget" ? "ACCOUNT_ORDER_BUDGET_READ"
      : path === "/v1/admin/account-policy" ? "ACCOUNT_ORDER_POLICY_ENABLE"
      : path === "/v1/admin/promote" ? "REGISTRY_PROMOTION"
      : path === "/v1/admin/capital" ? "REGISTRY_CAPITAL"
      : path === "/v1/admin/account-cap" ? "SHARED_ACCOUNT_CAP_METADATA"
      : path === "/v1/admin/registry-append" ? "REGISTRY_APPEND"
      : path === "/v1/testnet/transport" ? "TESTNET_TRANSPORT"
      : path === "/v1/create-order" ? "CREATE_ORDER" : path === "/v1/cancel-order" ? "CANCEL_ORDER"
      : path === "/v1/state" ? "READ_STATE" : path === "/v1/query-order" ? "QUERY_ORDER"
      : path === "/v1/trades" ? "READ_TRADES"
      : path === "/v1/prove-unsent-order" ? "UNSENT_ORDER_ATTESTATION"
      : path === "/v1/reconciliation" ? "READ_RECONCILIATION" : "DENIED";
    let outcome = "DENIED", status = 403, decisionId = null, symbol = null, keyHash = null, scope = null, legacyClient = false;
    try {
      // No write can reach Binance under the default deployed flags.
      if (path === "/v1/cancel-all-orders"
        || (path === "/v1/create-order" || path === "/v1/cancel-order") && !tradingEnabled)
        throw new ExecutorRejection("EXECUTOR_TRADING_DISABLED", 403);
      if (request.method === "GET" && path === "/health") {
        const result = await health();
        status = result.healthy ? 200 : 503;
        outcome = result.healthy ? "HEALTHY" : "ATTENTION";
        writeJson(response, status, result);
        return;
      }
      if (request.method !== "POST" || !["/v1/health", "/v1/capacity", "/v1/dry-run", "/v1/state", "/v1/query-order",
        "/v1/trades", "/v1/prove-unsent-order", "/v1/reconciliation", "/v1/create-order", "/v1/cancel-order",
        "/v1/admin/credentials", "/v1/admin/registry", "/v1/admin/snapshot", "/v1/admin/order-budget", "/v1/admin/account-policy", "/v1/admin/promote",
        "/v1/admin/capital", "/v1/admin/account-cap", "/v1/admin/registry-append", "/v1/testnet/transport"].includes(path))
        throw new ExecutorRejection("EXECUTOR_ROUTE_DENIED", 404);
      if (!request.headers["content-type"]?.startsWith("application/json"))
        throw new ExecutorRejection("EXECUTOR_CONTENT_TYPE_INVALID", 415);
      const body = await readBody(request);
      const verified = await verifySignedRequest({ headers: new Headers(request.headers),
        method: request.method, path, body, secret,
        nonceDirectory: join(stateDirectory, "nonces"), now: now() });
      let input;
      try { input = JSON.parse(body); } catch { throw new ExecutorRejection("EXECUTOR_BODY_INVALID"); }
      assertExecutorShardContext(shardId, input);
      if (!isTestnetEnabled() && (input.environment === "TESTNET" || path === "/v1/testnet/transport"))
        throw new ExecutorRejection("COINOPS_TESTNET_DISABLED", 410);
      decisionId = typeof input.decision_id === "string" && /^[a-zA-Z0-9:_-]{8,160}$/.test(input.decision_id)
        ? input.decision_id : null;
      symbol = typeof input.symbol === "string" && /^[A-Z0-9]{4,40}$/.test(input.symbol) ? input.symbol : null;
      const key = request.headers["x-coinops-idempotency-key"];
      keyHash = typeof key === "string" ? sha256(key).slice(0, 12) : null;
      if (path === "/v1/capacity") {
        if (!/^[0-9a-f-]{36}$/i.test(input.request_id ?? "")
          || key !== `CAPACITY:${input.request_id}`)
          throw new ExecutorRejection("EXECUTOR_CAPACITY_SCOPE_DENIED", 403);
        const active = await loadCombinedRegistry(registry, stateDirectory,
          (code) => logger({ action: "DYNAMIC_REGISTRY_FAIL_CLOSED", code }));
        const live = active.engines.filter((row) => row.environment === "REAL" && row.status === "ACTIVE");
        // Server-side collection remains truthful even before the first account.
        const probes = await Promise.allSettled([capacity.sampleIfIdle()]);
        for (const probe of probes)
          if (probe.status === "rejected") logger({ action: "CAPACITY_PUBLIC_PROBE_UNAVAILABLE",
            executor_shard_id: shardId, environment: "REAL" });
        const sample = capacity.snapshot();
        status = 200; outcome = "READ_ONLY_CAPACITY";
        writeJson(response, 200, { ...sample, executor_shard_id: shardId, egress_ipv4: expectedEgressIp,
          account_count: new Set(live.map((row) => row.exchange_account_id)).size,
          account_ids: [...new Set(live.map((row) => row.exchange_account_id))].sort(),
          engine_ids: live.map((row) => row.trading_engine_id).sort(),
          engine_count: live.length, executor_version: version,
          environments: { TESTNET: { status: "DISABLED", retired: true, executor_shard_id: shardId, shard_id: shardId,
            egress_ipv4: expectedEgressIp, executor_version: version,
            binance_weight_current: null, binance_weight_samples: 0, weight_observed_at: null,
            request_errors_last_5m: 0, registry_scope: "RETIRED" } } });
        return;
      }
      if (path === "/v1/testnet/transport") {
        assertCredentialScope(input);
        if (key !== `TESTNET:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? "")
          || input.environment !== "TESTNET" || !/^[0-9a-f-]{36}$/i.test(input.trading_engine_id ?? ""))
          throw new ExecutorRejection("EXECUTOR_TESTNET_SCOPE_DENIED", 403);
        // Public/read-only diagnostics remain available while financial Testnet
        // writes obey this executor's explicit operator-controlled safety flags.
        if (input.path === "/api/v3/order" && ["POST", "DELETE"].includes(input.method)
          && (!tradingEnabled || killSwitch))
          throw new ExecutorRejection("EXECUTOR_TRADING_DISABLED", 403);
        const credential = await loadCredential(join(stateDirectory, "credentials"), secret, input);
        const result = await forwardTestnetRequest(input, credential, fetcher);
        status = 200; outcome = result.binance_status < 400 ? "TESTNET_FORWARDED" : "TESTNET_BINANCE_REJECTED";
        scope = { executor_shard_id: shardId, operator_id: input.operator_id, exchange_account_id: input.exchange_account_id,
          trading_engine_id: input.trading_engine_id, environment: "TESTNET" };
        writeJson(response, 200, { ...scope, ...result });
        return;
      }
      if (path === "/v1/admin/account-policy") {
        if (key !== `ACCOUNT_POLICY:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? "")
          || input.environment !== "REAL" || input.contract !== ACCOUNT_ORDER_POLICY || input.executor_version !== version
          || input.apiKey !== undefined || input.apiSecret !== undefined)
          throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_POLICY_SCOPE_DENIED", 403);
        if (input.credential_ref === "legacy-binance-production")
          installedLegacyCredentialForRead(registry, input, credentialEnvironment, shardId);
        else {
          assertCredentialScope(input);
          await loadCredential(join(stateDirectory, "credentials"), secret, input);
        }
        const result = await enableAccountOrderPolicy(stateDirectory, input, shardId);
        for (const [engineId, cached] of engineHealthCache)
          if (cached.value.exchange_account_id === input.exchange_account_id) engineHealthCache.delete(engineId);
        status = 200; outcome = "ACCOUNT_ORDER_POLICY_ENABLED";
        writeJson(response, 200, { ...result, executor_version: version, executor_ip: expectedEgressIp });
        return;
      }
      if (path === "/v1/admin/order-budget") {
        if (key !== `ORDER_BUDGET:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? "")
          || input.environment !== "REAL" || !Array.isArray(input.symbols) || !input.symbols.length
          || input.symbols.length > 4 || new Set(input.symbols).size !== input.symbols.length
          || input.symbols.some((item) => !/^(BTC|SOL)(BRL|USDT)$/.test(item))
          || input.apiKey !== undefined || input.apiSecret !== undefined)
          throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED", 403);
        let credential;
        if (input.credential_ref === "legacy-binance-production")
          credential = installedLegacyCredentialForRead(registry, input, credentialEnvironment, shardId);
        else {
          assertCredentialScope(input);
          credential = await loadCredential(join(stateDirectory, "credentials"), secret, input);
        }
        if (!expectedEgressIp || await observeEgressIp(fetcher) !== expectedEgressIp)
          throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED", 503);
        const snapshot = await readOrderBudget(input, new BinanceLiveTransport({ ...credential, fetcher, now }), input.symbols);
        scope = { operator_id: input.operator_id, exchange_account_id: input.exchange_account_id,
          environment: "REAL", executor_shard_id: shardId };
        status = 200; outcome = "READ_ONLY_ACCOUNT_ORDER_BUDGET";
        writeJson(response, 200, { ...snapshot, ...scope, executor_ip: expectedEgressIp,
          credential_ref: input.credential_ref, executor_version: version });
        return;
      }
      if (path === "/v1/admin/snapshot") {
        let credential;
        if (input.credential_ref === "legacy-binance-production") {
          credential = installedLegacyCredentialForRead(registry, input, credentialEnvironment, shardId);
        } else {
          assertCredentialScope(input);
          credential = await loadCredential(join(stateDirectory, "credentials"), secret, input);
        }
        if (key !== `SNAPSHOT:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? "")
          || !["REAL", "TESTNET"].includes(input.environment) || !Array.isArray(input.symbols)
          || input.symbols.length < 1 || input.symbols.length > 2
          || new Set(input.symbols).size !== input.symbols.length
          || !["BRL", "USDT", "USDC"].includes(input.quote_asset)
          || input.symbols.some((item) => !/^(BTC|SOL)(BRL|USDT|USDC)$/.test(item)
            || !item.endsWith(input.quote_asset)))
          throw new ExecutorRejection("EXECUTOR_SNAPSHOT_SCOPE_DENIED", 403);
        if (input.environment === "REAL" && input.quote_asset === "USDC"
          || input.environment === "TESTNET" && input.quote_asset === "BRL"
          || input.credential_ref === "legacy-binance-production" && input.environment !== "REAL")
          throw new ExecutorRejection("EXECUTOR_SNAPSHOT_SCOPE_DENIED", 403);
        const host = input.environment === "TESTNET" ? "https://testnet.binance.vision" : undefined;
        const [observation, market] = await Promise.all([
          inspectBinanceCredential({ ...credential, environment: input.environment, expectedEgressIp, fetcher, now }),
          getPublicMarket(fetcher, now, input.symbols, host),
        ]);
        if (observation.status !== "PASS")
          throw new ExecutorRejection("EXECUTOR_SNAPSHOT_PERMISSION_DENIED", 403);
        const adapter = new BinanceSpotAdapter(credential, { fetcher, now, maxReadRetries: 0,
          ...(host ? { baseUrl: host, marketDataBaseUrl: host } : {}) });
        const orders = await Promise.all(input.symbols.map((item) => adapter.getOpenOrders(item)));
        const result = { executor_shard_id: shardId, operator_id: input.operator_id, exchange_account_id: input.exchange_account_id,
          environment: input.environment, quote_asset: input.quote_asset,
          observed_at: observation.validatedAt, executor_ip: observation.executorIp,
          permission: observation.permission, whitelist_accepted: observation.whitelistAccepted,
          balances: observation.balances,
          markets: market.markets.map((item, index) => ({ symbol: input.symbols[index],
            price: item.priceBrl, observed_at: item.observedAt, rules: item.raw,
            open_orders: orders[index].map((order) => ({ clientOrderId: order.clientOrderId,
              side: order.side, status: order.status, orderId: order.id,
              origQty: order.originalQuantity, executedQty: order.executedQuantity, price: order.price })) })) };
        status = 200; outcome = "READ_ONLY_SNAPSHOT";
        writeJson(response, 200, result);
        return;
      }
      if (path === "/v1/admin/promote") {
        const installed = input.credential_ref === "legacy-binance-production"
          ? installedLegacyCredentialForRead(registry, input, credentialEnvironment, shardId) : null;
        if (!installed) assertCredentialScope(input);
        if (key !== `PROMOTE:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? "")
          || input.environment !== "REAL")
          throw new ExecutorRejection("EXECUTOR_REGISTRY_PROMOTION_DENIED", 403);
        const credential = installed ?? await loadCredential(join(stateDirectory, "credentials"), secret, input);
        const active = await loadCombinedRegistry(registry, stateDirectory,
          (code) => logger({ action: "DYNAMIC_REGISTRY_FAIL_CLOSED", code }));
        const row = active.engines.find((item) => item.trading_engine_id === input.trading_engine_id);
        if (!row || row.exchange_account_id !== input.exchange_account_id || row.operator_id !== input.operator_id
          || row.symbol !== input.symbol || row.status !== "INACTIVE" && row.status !== "ACTIVE")
          throw new ExecutorRejection("EXECUTOR_REGISTRY_PROMOTION_DENIED", 403);
        if (row.status === "INACTIVE") {
          const transport = new BinanceLiveTransport({ ...credential, fetcher, now, engine: row });
          const exchange = await transport.safetySnapshot(row.symbol);
          if (exchange.openOrders.some((order) => order.clientOrderId?.startsWith(`C2-${sha256(`${row.exchange_account_id}|${row.trading_engine_id}`).slice(0, 10)}-`)))
            throw new ExecutorRejection("EXECUTOR_REGISTRY_EXISTING_OWNED_ORDER", 409);
        }
        const promoted = await promoteRegistryEngine(registry, stateDirectory, input);
        engineHealthCache.delete(input.trading_engine_id);
        status = 200; outcome = promoted.replayed ? "REPLAYED" : "PROMOTED";
        writeJson(response, 200, { ...promoted, executor_shard_id: shardId, operator_id: input.operator_id,
          exchange_account_id: input.exchange_account_id, environment: input.environment });
        return;
      }
      if (path === "/v1/admin/capital") {
        if (input.credential_ref === "legacy-binance-production") {
          installedLegacyCredentialForRead(registry, input, credentialEnvironment, shardId);
        } else {
          assertCredentialScope(input);
          await loadCredential(join(stateDirectory, "credentials"), secret, input);
        }
        if (key !== `CAPITAL:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? "")
          || input.environment !== "REAL")
          throw new ExecutorRejection("EXECUTOR_CAP_CHANGE_DENIED", 403);
        const changed = await changeRegistryCapital(registry, stateDirectory, input);
        for (const engine of input.engines) engineHealthCache.delete(engine.trading_engine_id);
        status = 200; outcome = changed.replayed ? "REPLAYED" : "CAP_CHANGED";
        writeJson(response, 200, { ...changed, executor_shard_id: shardId, operator_id: input.operator_id,
          exchange_account_id: input.exchange_account_id, quote_asset: input.quote_asset });
        return;
      }
      if (path === "/v1/admin/account-cap") {
        if (key !== `SHARED_CAP:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? ""))
          throw new ExecutorRejection("EXECUTOR_SHARED_ACCOUNT_CAP_DENIED", 403);
        if (input.credential_ref === "legacy-binance-production") {
          if (registry.legacy_account_id !== input.exchange_account_id || !registry.engines.some((row) =>
            row.operator_id === input.operator_id && row.exchange_account_id === input.exchange_account_id && row.legacy_ownership))
            throw new ExecutorRejection("EXECUTOR_SHARED_ACCOUNT_CAP_DENIED", 403);
        } else {
          assertCredentialScope(input);
          await loadCredential(join(stateDirectory, "credentials"), secret, input);
        }
        const result = await increaseRegistryAccountCap(registry, stateDirectory, input);
        status = 200; outcome = "ACCOUNT_CAP_METADATA_SYNCED";
        writeJson(response, 200, { ...result, executor_shard_id: shardId, operator_id: input.operator_id,
          exchange_account_id: input.exchange_account_id, environment: input.environment });
        return;
      }
      if (path === "/v1/admin/registry" || path === "/v1/admin/registry-append") {
        const installed = path === "/v1/admin/registry-append" && input.credential_ref === "legacy-binance-production"
          ? installedLegacyCredentialForRead(registry, input, credentialEnvironment, shardId) : null;
        if (!installed) assertCredentialScope(input);
        if (key !== `REGISTRY:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? ""))
          throw new ExecutorRejection("EXECUTOR_REGISTRY_SYNC_DENIED", 403);
        if (!installed) await loadCredential(join(stateDirectory, "credentials"), secret, input);
        const sync = path === "/v1/admin/registry-append" ? appendInactiveRegistryEngines : saveInactiveRegistryAccount;
        const result = await sync(registry, stateDirectory, input,
          Array.isArray(input.engines) ? input.engines.map((row) => ({ ...row,
            executor_shard_id: row.executor_shard_id ?? shardId })) : input.engines);
        status = 200; outcome = "INACTIVE_SYNC";
        scope = { executor_shard_id: shardId, operator_id: input.operator_id, exchange_account_id: input.exchange_account_id,
          environment: input.environment };
        writeJson(response, 200, { ...result, ...scope });
        return;
      }
      if (path === "/v1/admin/credentials") {
        const legacyRead = input.credential_ref === "legacy-binance-production";
        if (legacyRead && input.operation !== "REVALIDATE")
          throw new ExecutorRejection("EXECUTOR_LEGACY_CREDENTIAL_READ_DENIED", 403);
        const legacyCredential = legacyRead
          ? installedLegacyCredentialForRead(registry, input, credentialEnvironment, shardId) : null;
        if (!legacyRead) assertCredentialScope(input);
        if (key !== `CREDENTIAL:${input.request_id}` || !/^[0-9a-f-]{36}$/i.test(input.request_id ?? "")
          || !["CONNECT", "REVALIDATE", "REPLACE", "REMOVE"].includes(input.operation))
          throw new ExecutorRejection("EXECUTOR_CREDENTIAL_INTENT_INVALID", 400);
        const directory = join(stateDirectory, "credentials");
        const safeInput = { operator_id: input.operator_id, exchange_account_id: input.exchange_account_id,
          credential_ref: input.credential_ref, environment: input.environment };
        if (["CONNECT", "REPLACE"].includes(input.operation) && Object.values(registry?.credentials ?? {})
          .some((reference) => credentialEnvironment[reference.api_key_env] === input.apiKey))
          throw new ExecutorRejection("EXECUTOR_CREDENTIAL_ALREADY_BOUND", 409);
        scope = { executor_shard_id: shardId, operator_id: safeInput.operator_id, exchange_account_id: safeInput.exchange_account_id,
          environment: safeInput.environment };
        const { result, replayed } = await withDryRunIdempotency({
          directory: join(stateDirectory, "credential-intents"), key, bodyHash: verified.bodyHash,
          execute: async () => {
            if (legacyCredential) return { ...await inspectBinanceCredential({ ...legacyCredential,
              environment: "REAL", expectedEgressIp, fetcher, now }), credential_ref: safeInput.credential_ref };
            if (input.operation === "REVALIDATE") return refreshCredential({ directory, masterSecret: secret,
              scope: safeInput, expectedEgressIp, fetcher, now });
            if (input.operation === "REMOVE") {
              await assertNoExchangeOpenOrders({ directory, masterSecret: secret, scope: safeInput, fetcher, now });
              return removeCredential(directory, safeInput);
            }
            if (typeof input.apiKey !== "string" || typeof input.apiSecret !== "string")
              throw new ExecutorRejection("EXECUTOR_CREDENTIAL_FORMAT_INVALID", 422);
            const observation = await inspectBinanceCredential({ apiKey: input.apiKey, apiSecret: input.apiSecret,
              environment: input.environment, expectedEgressIp, fetcher, now });
            if (input.operation === "REPLACE") await assertNoExchangeOpenOrders({ directory,
              masterSecret: secret, scope: safeInput, fetcher, now });
            const saved = await saveCredential({ directory, masterSecret: secret, scope: safeInput,
              apiKey: input.apiKey, apiSecret: input.apiSecret, observation,
              replace: input.operation === "REPLACE" });
            return { ...observation, ...saved };
          },
        });
        outcome = replayed ? "REPLAYED" : result.status ?? (result.removed ? "REMOVED" : "NO_CHANGE");
        status = 200;
        writeJson(response, 200, { ...result, ...scope, replayed });
        return;
      }
      const activeRegistry = await loadCombinedRegistry(registry, stateDirectory,
        (code) => logger({ action: "DYNAMIC_REGISTRY_FAIL_CLOSED", code }));
      const resolved = resolveExecutorContext(activeRegistry, input, key, credentialEnvironment,
        { allowLegacy: allowLegacyClients, path });
      if (resolved.vault) {
        const stored = await loadCredential(join(stateDirectory, "credentials"), secret, {
          operator_id: resolved.engine.operator_id, exchange_account_id: resolved.engine.exchange_account_id,
          credential_ref: resolved.engine.credential_ref, environment: resolved.engine.environment });
        resolved.apiKey = stored.apiKey; resolved.apiSecret = stored.apiSecret;
      }
      input = resolved.input;
      legacyClient = resolved.legacyClient;
      const engine = resolved.engine;
      scope = { ...responseContext(engine), executor_shard_id: shardId };
      const accountBudgetEnabled = await accountOrderPolicyEnabled(stateDirectory, engine, shardId);
      const assertBudgetPermit = () => {
        if (path === "/v1/create-order") {
          const claim = durableIntent(engine, input, key, verified.bodyHash, "CREATE_ORDER");
          assertUnsentFence(join(stateDirectory, "orders"), claim.key, verified.timestamp);
        }
        if (!accountBudgetEnabled) return;
        try { verifyAccountBudgetPermit(secret, request.headers["x-coinops-account-order-budget"],
          request.headers["x-coinops-account-order-budget-signature"], { ...scope,
            clientOrderId: input.clientOrderId, side: input.side }, verified.bodyHash, now()); }
        catch {
          const denied = new ExecutorPreDispatchRejection("EXECUTOR_ACCOUNT_ORDER_BUDGET_PERMIT_DENIED", 403);
          denied.unsentProof = signAccountOrderUnsentProof(secret, { ...scope,
            clientOrderId: input.clientOrderId, decision_id: input.decision_id, request_nonce: verified.nonce }, verified.bodyHash, now());
          throw denied;
        }
      };
      const transport = new BinanceLiveTransport({ apiKey: resolved.apiKey, apiSecret: resolved.apiSecret,
        fetcher, now, engine, ownershipEvidence: durableOrderOwnership(stateDirectory, engine),
        requireSelfTradePrevention: accountBudgetEnabled, beforeOrderSubmit: assertBudgetPermit });
      const flags = { tradingEnabled: tradingEnabled && engine.execution_allowed,
        killSwitch: killSwitch || engine.kill_switch || engine.account_kill_switch || engine.global_kill_switch };
      if (path === "/v1/health") {
        const cached = engineHealthCache.get(engine.trading_engine_id);
        if (cached && now() - cached.at < healthCacheMs) {
          status = cached.value.healthy ? 200 : 503;
          outcome = cached.value.healthy ? "HEALTHY" : "ATTENTION";
          writeJson(response, status, cached.value);
          return;
        }
        const [market, permission, ip] = await Promise.all([
          getPublicMarket(fetcher, now, [engine.symbol]),
          getProductionRestrictedSpotStatus({ apiKey: resolved.apiKey, apiSecret: resolved.apiSecret, fetcher }),
          observeEgressIp(fetcher),
        ]);
        const healthy = permission === "SPOT_RESTRICTED" && Boolean(ip && ip === expectedEgressIp);
        outcome = healthy ? "HEALTHY" : "ATTENTION"; status = healthy ? 200 : 503;
        const value = { ...scope, healthy, version, actual_executor_version: version,
          legacy_contract_version: allowLegacyClients ? legacyVersion : null, legacy_compatibility_enabled: allowLegacyClients,
          region, clock: new Date(now()).toISOString(),
          clock_drift_ms: market.driftMs, binance_connectivity: "OK", account_permission: permission,
          egress_ipv4: ip, egress_ipv4_verified: ip === expectedEgressIp,
          isolation_contract: ACCOUNT_ORDER_POLICY, account_order_budget_protocol: 1,
          account_order_budget_enforced: accountBudgetEnabled, unsent_recovery_protocol: 1,
          trading_enabled: flags.tradingEnabled, kill_switch: flags.killSwitch, latency_ms: now() - started };
        engineHealthCache.set(engine.trading_engine_id, { at: now(), value });
        writeJson(response, status, value);
        return;
      }
      if (path === "/v1/reconciliation") {
        if (input.scope !== "COINOPS_SHADOW_READ_ONLY" || !engine.legacy_ownership || !engine.is_legacy_default)
          throw new ExecutorRejection("EXECUTOR_RECONCILIATION_SCOPE_DENIED", 403);
        const snapshot = await transport.legacyReconciliationSnapshot();
        outcome = "READ_ONLY"; status = 200;
        writeJson(response, 200, { ...snapshot, ...scope });
        return;
      }
      if (path !== "/v1/dry-run") {
        const symbol = input.symbol;
        if (path === "/v1/state") {
          const snapshot = await transport.safetySnapshot(symbol);
          const balances = snapshot.account.balances.filter((item) => [engine.quote_asset, engine.base_asset, "BNB"].includes(item.asset));
          outcome = "READ_ONLY"; status = 200;
          writeJson(response, 200, { ...scope, symbol, balances, filters: snapshot.filters,
            price: snapshot.price, bnb_brl_price: snapshot.bnbBrlPrice,
            bnb_quote_price: snapshot.bnbBrlPrice,
            supports_unfilled_buy_cancel: true,
            execution_caps: { engine: engine.hard_cap_quote,
              account: engine.account_cap_quote, max_order: engine.max_order_quote },
            open_orders: snapshot.openOrders, observed_at: new Date(now()).toISOString() });
          return;
        }
        if (path === "/v1/query-order" || path === "/v1/trades") {
          const order = await transport.queryOrder(symbol, input.clientOrderId, input.orderId ?? null);
          const trades = path === "/v1/trades" && order
            ? await transport.ownedTrades(symbol, input.clientOrderId, order.orderId) : null;
          outcome = "READ_ONLY"; status = 200;
          writeJson(response, 200, { ...scope, order, trades });
          return;
        }
        if (path === "/v1/prove-unsent-order") {
          if (key !== input.clientOrderId || input.side !== "BUY" || input.purpose !== "ENTRY" || !accountBudgetEnabled)
            throw new ExecutorRejection("EXECUTOR_UNSENT_RECOVERY_SCOPE_DENIED", 403);
          transport.ownership(symbol, input.clientOrderId, "BUY");
          const claim = durableIntent(engine, input, key, verified.bodyHash, "CREATE_ORDER");
          await attestNeverDispatched({ directory: join(stateDirectory, "orders"), key: claim.key,
            dispatchedAt: input.dispatched_at, now,
            query: () => transport.queryOrder(symbol, input.clientOrderId) });
          const proof = signAccountOrderUnsentProof(secret, { ...scope, clientOrderId: input.clientOrderId,
            decision_id: input.decision_id, request_nonce: verified.nonce }, verified.bodyHash, now());
          outcome = "PROVEN_NOT_SUBMITTED"; status = 200;
          writeJson(response, status, { ...scope, order: null, unsent_proof: proof });
          return;
        }
        if (path === "/v1/create-order") {
          if (key !== input.clientOrderId) throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_KEY_INVALID", 400);
          // Account permission is checked by this engine's complete snapshot;
          // another account's health must never authorize or block this one.
          if (!flags.tradingEnabled) throw new ExecutorRejection("EXECUTOR_TRADING_DISABLED", 403);
          if (!expectedEgressIp || await observeEgressIp(fetcher) !== expectedEgressIp)
            throw new ExecutorRejection("EXECUTOR_SAFETY_GATE_NOT_READY", 503);
          const claim = durableIntent(engine, input, key, verified.bodyHash, action);
          const { result, replayed } = await withWriteIdempotency({ directory: join(stateDirectory, "orders"),
            ...claim,
            beforeClaim: assertBudgetPermit,
            provablyUnsent: () => !transport.orderPostAttempted,
            recover: () => transport.queryOrder(symbol, input.clientOrderId),
            execute: () => transport.createOwnedOrder(input, { allowCreate: true, ...flags }) });
          outcome = replayed ? "REPLAYED" : "CREATED"; status = 200;
          writeJson(response, 200, { ...scope, order: result, replayed });
          return;
        }
        if (path === "/v1/cancel-order") {
          if (input.onlyUnfilled !== undefined && typeof input.onlyUnfilled !== "boolean")
            throw new ExecutorRejection("EXECUTOR_CANCEL_MODE_INVALID", 400);
          const cancelKey = `${input.onlyUnfilled === true ? "CANCEL_UNFILLED" : "CANCEL"}:${input.clientOrderId}`;
          if (key !== cancelKey) throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_KEY_INVALID", 400);
          if (!flags.tradingEnabled) throw new ExecutorRejection("EXECUTOR_TRADING_DISABLED", 403);
          if (!expectedEgressIp || await observeEgressIp(fetcher) !== expectedEgressIp)
            throw new ExecutorRejection("EXECUTOR_SAFETY_GATE_NOT_READY", 503);
          const claim = durableIntent(engine, input, key, verified.bodyHash, action);
          const { result, replayed } = await withWriteIdempotency({ directory: join(stateDirectory, "cancels"),
            ...claim,
            recover: async () => { const order = await transport.queryOrder(symbol, input.clientOrderId, input.orderId);
              return order?.status === "CANCELED" || input.onlyUnfilled === true && unfilledCancelResolved(order)
                ? order : null; },
            execute: () => transport.cancelOwnedBuy(input, flags) });
          outcome = replayed ? "REPLAYED" : result.status === "CANCELED" ? "CANCELED" : "FILL_PRESERVED"; status = 200;
          writeJson(response, 200, { ...scope, order: result, replayed });
          return;
        }
      }
      const { result, replayed } = await withDryRunIdempotency({
        directory: join(stateDirectory, "dry-run"), key: `ENGINE:${sha256(`${engine.trading_engine_id}|${key}`)}`,
        bodyHash: verified.bodyHash,
        execute: async () => {
          const snapshot = await getPublicMarket(fetcher, now, [engine.symbol]);
          const market = snapshot.markets.find((item) => item.raw.symbol === input.symbol);
          return buildExecutorDryRun(input, market, now(), engine);
        },
      });
      status = 200;
      outcome = replayed ? "REPLAYED" : "NO_WRITE";
      writeJson(response, 200, { ...result, ...scope, request_id: requestId, replayed });
    } catch (error) {
      status = error instanceof ExecutorRejection ? error.status : 503;
      outcome = error instanceof ExecutorRejection ? error.code
        : error instanceof BinanceReadOnlyError && ["BINANCE_RATE_LIMITED", "BINANCE_HTTP_418"].includes(error.code)
          ? "EXECUTOR_BINANCE_RATE_LIMITED"
          : error instanceof BinanceReadOnlyError && error.code === "BINANCE_NETWORK_UNAVAILABLE"
            ? "EXECUTOR_BINANCE_READ_UNAVAILABLE" : "EXECUTOR_UNAVAILABLE";
      writeJson(response, status, { error: outcome, request_id: requestId,
        ...(error instanceof ExecutorPreDispatchRejection && error.unsentProof ? { unsent_proof: error.unsentProof } : {}) });
    } finally {
      logger({ request_id: requestId, decision_id: decisionId, idempotency_key_hash: keyHash,
        ...scope, executor_shard_id: shardId, symbol, action, legacy_client: legacyClient, result: outcome, http_status: status, latency_ms: now() - started,
        trading_enabled: tradingEnabled, kill_switch: killSwitch, timestamp: new Date(now()).toISOString() });
    }
  };
}

export async function startExecutor(env = process.env) {
  if (!["true", "false"].includes(env.TRADING_ENABLED) || !["ON", "OFF"].includes(env.KILL_SWITCH)
    || env.TRADING_ENABLED === "false" && env.KILL_SWITCH !== "ON")
    throw new Error("EXECUTOR_SAFETY_FLAGS_REQUIRED");
  if (!env.COINOPS_EXECUTOR_HMAC_SECRET || Buffer.byteLength(env.COINOPS_EXECUTOR_HMAC_SECRET) < 32)
    throw new Error("EXECUTOR_AUTH_NOT_CONFIGURED");
  if (!env.COINOPS_EXECUTOR_STATE_DIR) throw new Error("EXECUTOR_STATE_DIR_REQUIRED");
  const stateDirectory = resolve(env.COINOPS_EXECUTOR_STATE_DIR);
  await assertPrivateDirectory(stateDirectory);
  const registry = await loadExecutorRegistry(env.COINOPS_EXECUTOR_REGISTRY_PATH);
  if (env.COINOPS_EXECUTOR_LEGACY_COMPAT !== undefined
    && !["true", "false"].includes(env.COINOPS_EXECUTOR_LEGACY_COMPAT)) throw new Error("EXECUTOR_LEGACY_FLAG_INVALID");
  if (env.COINOPS_EXECUTOR_LEGACY_COMPAT === "true" && !registry.legacy_account_id)
    throw new Error("EXECUTOR_LEGACY_ACCOUNT_REQUIRED");
  if (env.COINOPS_EXECUTOR_LEGACY_COMPAT === "true"
    && !/^[a-zA-Z0-9._-]{1,128}$/.test(env.COINOPS_EXECUTOR_LEGACY_VERSION ?? ""))
    throw new Error("EXECUTOR_LEGACY_VERSION_REQUIRED");
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EXECUTOR_PORT_INVALID");
  const server = createServer(createExecutorHandler({ secret: env.COINOPS_EXECUTOR_HMAC_SECRET,
    stateDirectory, expectedEgressIp: env.LIVE_EXECUTOR_EGRESS_IP || null,
    apiKey: env.BINANCE_API_KEY || null, apiSecret: env.BINANCE_API_SECRET || null,
    registry, credentialEnvironment: env,
    allowLegacyClients: env.COINOPS_EXECUTOR_LEGACY_COMPAT === "true",
    legacyVersion: env.COINOPS_EXECUTOR_LEGACY_VERSION ?? null,
    version: env.COINOPS_EXECUTOR_VERSION || "unversioned",
    shardId: env.COINOPS_EXECUTOR_SHARD_ID || "executor-01",
    region: env.COINOPS_EXECUTOR_REGION || "UNSPECIFIED",
    tradingEnabled: env.TRADING_ENABLED === "true", killSwitch: env.KILL_SWITCH === "ON" }));
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  server.listen(port, "127.0.0.1");
  return server;
}

// Node canonicalizes import.meta.url but keeps the /current symlink in argv[1].
// Resolve both to the same release so CLI startup does not silently exit 0.
function isDirectExecution() {
  try {
    return Boolean(process.argv[1])
      && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
  } catch { return false; } // stdin/eval importers need not have a file in argv[1].
}
if (isDirectExecution())
  startExecutor().catch((error) => { console.error(error.message); process.exitCode = 1; });

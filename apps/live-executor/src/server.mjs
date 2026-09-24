import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPrivateDirectory, ExecutorRejection, sha256, verifySignedRequest,
  withDryRunIdempotency, withWriteIdempotency } from "./security.mjs";
import { getProductionRestrictedSpotStatus, getPublicMarket, observeEgressIp } from "./binance-readonly.mjs";
import { buildExecutorDryRun, EXECUTOR_CAPS } from "./preparation.mjs";
import { BinanceLiveTransport } from "./binance-live.mjs";
import { loadExecutorRegistry, resolveExecutorContext, responseContext, durableIntent } from "./account-registry.mjs";

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
  apiKey = null, apiSecret = null, fetcher = fetch, now = Date.now,
  version = "unversioned", region = "UNSPECIFIED", logger = safeLog,
  tradingEnabled = false, killSwitch = true, registry = null, credentialEnvironment = process.env,
  allowLegacyClients = false, legacyVersion = null }) {
  let cachedHealth = null;
  const engineHealthCache = new Map();
  async function health() {
    if (cachedHealth && now() - cachedHealth.at < healthCacheMs) return cachedHealth.value;
    const started = now();
    const [market, permission, egress] = await Promise.allSettled([
      getPublicMarket(fetcher, now),
      getProductionRestrictedSpotStatus({ apiKey, apiSecret, fetcher }),
      observeEgressIp(fetcher),
    ]);
    const connected = market.status === "fulfilled";
    const permissionStatus = permission.status === "fulfilled" ? permission.value : "UNVERIFIED";
    const observedIp = egress.status === "fulfilled" ? egress.value : null;
    const egressVerified = Boolean(expectedEgressIp && observedIp && expectedEgressIp === observedIp);
    const value = { healthy: connected && permissionStatus === "SPOT_RESTRICTED" && egressVerified,
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
    cachedHealth = { at: now(), value };
    return value;
  }
  return async function handler(request, response) {
    const started = now();
    const requestId = randomUUID();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const action = path === "/health" ? "HEALTH" : path === "/v1/dry-run" ? "DRY_RUN"
      : path === "/v1/create-order" ? "CREATE_ORDER" : path === "/v1/cancel-order" ? "CANCEL_ORDER"
      : path === "/v1/state" ? "READ_STATE" : path === "/v1/query-order" ? "QUERY_ORDER"
      : path === "/v1/trades" ? "READ_TRADES"
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
      if (request.method !== "POST" || !["/v1/health", "/v1/dry-run", "/v1/state", "/v1/query-order",
        "/v1/trades", "/v1/reconciliation", "/v1/create-order", "/v1/cancel-order"].includes(path))
        throw new ExecutorRejection("EXECUTOR_ROUTE_DENIED", 404);
      if (!request.headers["content-type"]?.startsWith("application/json"))
        throw new ExecutorRejection("EXECUTOR_CONTENT_TYPE_INVALID", 415);
      const body = await readBody(request);
      const verified = await verifySignedRequest({ headers: new Headers(request.headers),
        method: request.method, path, body, secret,
        nonceDirectory: join(stateDirectory, "nonces"), now: now() });
      let input;
      try { input = JSON.parse(body); } catch { throw new ExecutorRejection("EXECUTOR_BODY_INVALID"); }
      decisionId = typeof input.decision_id === "string" && /^[a-zA-Z0-9:_-]{8,160}$/.test(input.decision_id)
        ? input.decision_id : null;
      symbol = typeof input.symbol === "string" && /^[A-Z0-9]{4,40}$/.test(input.symbol) ? input.symbol : null;
      const key = request.headers["x-coinops-idempotency-key"];
      keyHash = typeof key === "string" ? sha256(key).slice(0, 12) : null;
      const resolved = resolveExecutorContext(registry, input, key, credentialEnvironment,
        { allowLegacy: allowLegacyClients, path });
      input = resolved.input;
      legacyClient = resolved.legacyClient;
      const engine = resolved.engine;
      scope = responseContext(engine);
      const transport = new BinanceLiveTransport({ apiKey: resolved.apiKey, apiSecret: resolved.apiSecret,
        fetcher, now, engine });
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
            recover: () => transport.queryOrder(symbol, input.clientOrderId),
            execute: () => transport.createOwnedOrder(input, { allowCreate: true, ...flags }) });
          outcome = replayed ? "REPLAYED" : "CREATED"; status = 200;
          writeJson(response, 200, { ...scope, order: result, replayed });
          return;
        }
        if (path === "/v1/cancel-order") {
          if (key !== `CANCEL:${input.clientOrderId}`) throw new ExecutorRejection("EXECUTOR_IDEMPOTENCY_KEY_INVALID", 400);
          if (!flags.tradingEnabled) throw new ExecutorRejection("EXECUTOR_TRADING_DISABLED", 403);
          if (!expectedEgressIp || await observeEgressIp(fetcher) !== expectedEgressIp)
            throw new ExecutorRejection("EXECUTOR_SAFETY_GATE_NOT_READY", 503);
          const claim = durableIntent(engine, input, key, verified.bodyHash, action);
          const { result, replayed } = await withWriteIdempotency({ directory: join(stateDirectory, "cancels"),
            ...claim,
            recover: async () => { const order = await transport.queryOrder(symbol, input.clientOrderId, input.orderId);
              return order?.status === "CANCELED" ? order : null; },
            execute: () => transport.cancelOwnedBuy(input, flags) });
          outcome = replayed ? "REPLAYED" : "CANCELED"; status = 200;
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
      outcome = error instanceof ExecutorRejection ? error.code : "EXECUTOR_UNAVAILABLE";
      writeJson(response, status, { error: outcome, request_id: requestId });
    } finally {
      logger({ request_id: requestId, decision_id: decisionId, idempotency_key_hash: keyHash,
        ...scope, symbol, action, legacy_client: legacyClient, result: outcome, http_status: status, latency_ms: now() - started,
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
    region: env.COINOPS_EXECUTOR_REGION || "UNSPECIFIED",
    tradingEnabled: env.TRADING_ENABLED === "true", killSwitch: env.KILL_SWITCH === "ON" }));
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  server.listen(port, "127.0.0.1");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  startExecutor().catch((error) => { console.error(error.message); process.exitCode = 1; });

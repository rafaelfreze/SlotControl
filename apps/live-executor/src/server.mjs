import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPrivateDirectory, ExecutorRejection, sha256, verifySignedRequest,
  withDryRunIdempotency } from "./security.mjs";
import { getProductionReadOnlyStatus, getPublicMarket, observeEgressIp } from "./binance-readonly.mjs";
import { buildExecutorDryRun, EXECUTOR_CAPS } from "./preparation.mjs";

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
  version = "unversioned", region = "UNSPECIFIED", logger = safeLog }) {
  let cachedHealth = null;
  async function health() {
    if (cachedHealth && now() - cachedHealth.at < healthCacheMs) return cachedHealth.value;
    const started = now();
    const [market, permission, egress] = await Promise.allSettled([
      getPublicMarket(fetcher, now),
      getProductionReadOnlyStatus({ apiKey, apiSecret, fetcher }),
      observeEgressIp(fetcher),
    ]);
    const connected = market.status === "fulfilled";
    const permissionStatus = permission.status === "fulfilled" ? permission.value : "UNVERIFIED";
    const observedIp = egress.status === "fulfilled" ? egress.value : null;
    const egressVerified = Boolean(expectedEgressIp && observedIp && expectedEgressIp === observedIp);
    const value = { healthy: connected && permissionStatus === "READ_ONLY" && egressVerified,
      version, region, environment: "BINANCE_PRODUCTION_READ_ONLY", clock: new Date(now()).toISOString(),
      clock_drift_ms: connected ? market.value.driftMs : null,
      binance_connectivity: connected ? "OK" : "UNAVAILABLE",
      symbols: connected ? market.value.markets.map((item) => item.raw.symbol) : [],
      account_permission: permissionStatus, egress_ipv4: observedIp,
      egress_ipv4_verified: egressVerified, trading_enabled: false, kill_switch: true,
      caps: EXECUTOR_CAPS, latency_ms: now() - started };
    cachedHealth = { at: now(), value };
    return value;
  }
  return async function handler(request, response) {
    const started = now();
    const requestId = randomUUID();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const action = path === "/v1/dry-run" ? "DRY_RUN" : path === "/health" ? "HEALTH" : "DENIED";
    let outcome = "DENIED", status = 403, decisionId = null, symbol = null, keyHash = null;
    try {
      // No Production POST/DELETE order transport exists in this phase.
      if (path === "/v1/create-order" || path === "/v1/cancel-order"
        || path === "/v1/cancel-all-orders")
        throw new ExecutorRejection("EXECUTOR_TRADING_DISABLED", 403);
      if (request.method === "GET" && path === "/health") {
        const result = await health();
        status = result.healthy ? 200 : 503;
        outcome = result.healthy ? "HEALTHY" : "ATTENTION";
        writeJson(response, status, result);
        return;
      }
      if (request.method !== "POST" || path !== "/v1/dry-run")
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
      symbol = input.symbol === "BTCBRL" || input.symbol === "SOLBRL" ? input.symbol : null;
      const key = request.headers["x-coinops-idempotency-key"];
      keyHash = typeof key === "string" ? sha256(key).slice(0, 12) : null;
      const { result, replayed } = await withDryRunIdempotency({
        directory: join(stateDirectory, "dry-run"), key,
        bodyHash: verified.bodyHash,
        execute: async () => {
          const snapshot = await getPublicMarket(fetcher, now);
          const market = snapshot.markets.find((item) => item.raw.symbol === input.symbol);
          return buildExecutorDryRun(input, market, now());
        },
      });
      status = 200;
      outcome = replayed ? "REPLAYED" : "NO_WRITE";
      writeJson(response, 200, { ...result, request_id: requestId, replayed });
    } catch (error) {
      status = error instanceof ExecutorRejection ? error.status : 503;
      outcome = error instanceof ExecutorRejection ? error.code : "EXECUTOR_UNAVAILABLE";
      writeJson(response, status, { error: outcome, request_id: requestId });
    } finally {
      logger({ request_id: requestId, decision_id: decisionId, idempotency_key_hash: keyHash,
        symbol, action, result: outcome, http_status: status, latency_ms: now() - started,
        trading_enabled: false, kill_switch: true, timestamp: new Date(now()).toISOString() });
    }
  };
}

export async function startExecutor(env = process.env) {
  if (env.TRADING_ENABLED !== "false" || env.KILL_SWITCH !== "ON")
    throw new Error("EXECUTOR_SAFETY_FLAGS_REQUIRED");
  if (!env.COINOPS_EXECUTOR_HMAC_SECRET || Buffer.byteLength(env.COINOPS_EXECUTOR_HMAC_SECRET) < 32)
    throw new Error("EXECUTOR_AUTH_NOT_CONFIGURED");
  if (!env.COINOPS_EXECUTOR_STATE_DIR) throw new Error("EXECUTOR_STATE_DIR_REQUIRED");
  const stateDirectory = resolve(env.COINOPS_EXECUTOR_STATE_DIR);
  await assertPrivateDirectory(stateDirectory);
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EXECUTOR_PORT_INVALID");
  const server = createServer(createExecutorHandler({ secret: env.COINOPS_EXECUTOR_HMAC_SECRET,
    stateDirectory, expectedEgressIp: env.LIVE_EXECUTOR_EGRESS_IP || null,
    apiKey: env.BINANCE_API_KEY || null, apiSecret: env.BINANCE_API_SECRET || null,
    version: env.COINOPS_EXECUTOR_VERSION || "unversioned",
    region: env.COINOPS_EXECUTOR_REGION || "UNSPECIFIED" }));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(port, "127.0.0.1");
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  startExecutor().catch((error) => { console.error(error.message); process.exitCode = 1; });

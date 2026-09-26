/** Root-only READ-ONLY identity inventory for the initial control-plane binding.
 * Emits hashes, never a UID, API key, secret, encrypted payload or trading data.
 * A legacy env credential requires one authenticated GET /api/v3/account.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [source, envPath] = process.argv.slice(2);
if (!source?.startsWith("/opt/coinops/") || envPath !== "/etc/coinops/live-executor.env")
  throw new Error("IDENTITY_INVENTORY_TARGET_INVALID");
const env = Object.fromEntries((await readFile(envPath, "utf8")).split(/\r?\n/)
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")];
  }));
const module = (name) => import(pathToFileURL(join(source, "apps/live-executor/src", name)));
const { loadExecutorRegistry, loadCombinedRegistry } = await module("account-registry.mjs");
const { BinanceLiveTransport } = await module("binance-live.mjs");
const registry = await loadCombinedRegistry(await loadExecutorRegistry(env.COINOPS_EXECUTOR_REGISTRY_PATH),
  env.COINOPS_EXECUTOR_STATE_DIR, (code) => { throw new Error(code); });
const seen = new Set(), result = [];
for (const engine of registry.engines) {
  if (engine.environment !== "REAL" || engine.status !== "ACTIVE" || seen.has(engine.exchange_account_id)) continue;
  seen.add(engine.exchange_account_id);
  const reference = registry.credentials[engine.credential_ref];
  let identityHash;
  if (reference.vault) {
    const metadata = JSON.parse(await readFile(join(env.COINOPS_EXECUTOR_STATE_DIR, "credentials",
      `${engine.exchange_account_id}.json`), "utf8"));
    if (metadata.exchange_account_id !== engine.exchange_account_id || metadata.operator_id !== engine.operator_id
      || metadata.environment !== "REAL") throw new Error("IDENTITY_METADATA_SCOPE_INVALID");
    identityHash = metadata.uid_hash;
  } else {
    const transport = new BinanceLiveTransport({ engine, apiKey: env[reference.api_key_env],
      apiSecret: env[reference.api_secret_env] });
    const response = await transport.signed("GET", "/api/v3/account", {});
    if (!response.ok || response.body?.uid === undefined || response.body?.uid === null)
      throw new Error("IDENTITY_BINANCE_READ_FAILED");
    identityHash = createHash("sha256").update(`REAL:${String(response.body.uid)}`).digest("hex");
  }
  if (!/^[0-9a-f]{64}$/.test(identityHash ?? "")) throw new Error("IDENTITY_UNPROVEN");
  result.push({ accountId: engine.exchange_account_id, operatorId: engine.operator_id,
    shardId: env.COINOPS_EXECUTOR_SHARD_ID ?? "executor-01", environment: "REAL", identityHash });
}
process.stdout.write(JSON.stringify(result) + "\n");

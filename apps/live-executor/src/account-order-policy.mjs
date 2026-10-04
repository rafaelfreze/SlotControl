import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { assertPrivateDirectory, ExecutorRejection } from "./security.mjs";

export const ACCOUNT_ORDER_POLICY = "ENGINE_ISOLATION_V2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identity(scope, shardId) {
  if (!scope || ![scope.operator_id, scope.exchange_account_id].every((id) => UUID.test(id ?? ""))
    || scope.environment !== "REAL" || !/^executor-[0-9]{2,4}$/.test(shardId))
    throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_POLICY_SCOPE_DENIED", 403);
  return { operator_id: scope.operator_id, exchange_account_id: scope.exchange_account_id,
    environment: "REAL", executor_shard_id: shardId, contract: ACCOUNT_ORDER_POLICY };
}
function path(directory, accountId) { return join(directory, "account-order-policies", `${accountId}.json`); }

/** Independent durable marker, not a dynamic registry fallback. Corrupt policy
 * blocks only this account's new dispatches; other accounts remain unaffected. */
export async function accountOrderPolicyEnabled(directory, scope, shardId) {
  const expected = identity(scope, shardId), file = path(directory, scope.exchange_account_id);
  const metadata = await stat(file).catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
  if (!metadata) return false;
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_POLICY_INVALID", 503);
  let installed;
  try { installed = JSON.parse(await readFile(file, "utf8")); } catch {
    throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_POLICY_INVALID", 503);
  }
  if (!installed || Object.keys(installed).length !== Object.keys(expected).length
    || Object.entries(expected).some(([name, value]) => installed[name] !== value))
    throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_POLICY_INVALID", 503);
  return true;
}

/** Monotonic, private configuration only: no removal/downgrade, keys, registry,
 * engine flags, exchange I/O or financial state. Caller proves the credential. */
export async function enableAccountOrderPolicy(directory, scope, shardId) {
  const marker = identity(scope, shardId);
  if (await accountOrderPolicyEnabled(directory, scope, shardId)) return { ...marker, enabled: true, replayed: true };
  await assertPrivateDirectory(join(directory, "account-order-policies"));
  const handle = await open(path(directory, scope.exchange_account_id), "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") return null; throw error;
  });
  if (handle) { try { await handle.writeFile(JSON.stringify(marker)); } finally { await handle.close(); } }
  if (!await accountOrderPolicyEnabled(directory, scope, shardId))
    throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_POLICY_INVALID", 503);
  return { ...marker, enabled: true, replayed: !handle };
}

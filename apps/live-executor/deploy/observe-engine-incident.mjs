// Read-only incident evidence. Run on the assigned executor via Node stdin.
// Never prints credentials, never submits/cancels an order or changes a gate.
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const [accountId, engineId, symbol, shardId, expectedIp, sourceRoot = '/opt/coinops/current'] = process.argv.slice(2);
if (![accountId, engineId].every((id) => /^[0-9a-f-]{36}$/.test(id ?? ''))
  || !/^[A-Z0-9]{5,16}$/.test(symbol ?? '') || !/^executor-\d+$/.test(shardId ?? '')
  || !/^\d{1,3}(\.\d{1,3}){3}$/.test(expectedIp ?? '')
  || !['/opt/coinops/source', '/opt/coinops/current'].includes(sourceRoot)) throw new Error('INVALID_READ_SCOPE');
const env = Object.fromEntries((await readFile('/etc/coinops/live-executor.env', 'utf8'))
  .split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^(["'])(.*)\1$/, '$2')];
  }));
if ((env.COINOPS_EXECUTOR_SHARD_ID || 'executor-01') !== shardId || env.LIVE_EXECUTOR_EGRESS_IP !== expectedIp)
  throw new Error('EXECUTOR_SCOPE_MISMATCH');
const { loadExecutorRegistry, loadCombinedRegistry } = await import(`${sourceRoot}/apps/live-executor/src/account-registry.mjs`);
const registry = await loadCombinedRegistry(await loadExecutorRegistry(env.COINOPS_EXECUTOR_REGISTRY_PATH),
  env.COINOPS_EXECUTOR_STATE_DIR, () => { throw new Error('REGISTRY_READ_FAILED'); });
const engine = registry.engines?.find((row) => row.trading_engine_id === engineId
  && row.exchange_account_id === accountId && row.symbol === symbol);
if (!engine) throw new Error('ENGINE_NOT_OWNED');
for (const path of ['/v1/health', '/v1/state']) {
  const key = `COINOPS:REAL:READ:${randomUUID()}`;
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const body = JSON.stringify({ operator_id: engine.operator_id, exchange_account_id: accountId,
    trading_engine_id: engineId, environment: 'REAL', symbol, quote_asset: engine.quote_asset,
    executor_shard_id: shardId, decision_id: key, idempotency_key: key });
  const hash = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', env.COINOPS_EXECUTOR_HMAC_SECRET)
    .update(['POST', path, timestamp, nonce, hash].join('\n')).digest('hex');
  const response = await fetch(`http://127.0.0.1:${Number(env.PORT || 8080)}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-coinops-timestamp': timestamp,
      'x-coinops-nonce': nonce, 'x-coinops-body-sha256': hash, 'x-coinops-signature': signature,
      'x-coinops-idempotency-key': key }, body, signal: AbortSignal.timeout(35000) });
  const result = await response.json();
  const output = path === '/v1/health' ? {
    healthy: result.healthy, version: result.version, permission: result.account_permission,
    connectivity: result.binance_connectivity, egress: result.egress_ipv4,
    egressVerified: result.egress_ipv4_verified, driftMs: result.clock_drift_ms,
    tradingEnabled: result.trading_enabled, executorKillSwitch: result.kill_switch,
  } : { observedAt: result.observed_at, price: result.price,
    balances: result.balances, openOrders: result.open_orders };
  console.log(JSON.stringify({ at: new Date().toISOString(), path, status: response.status,
    shardId, accountId, engineId, symbol, ...output,
    error: typeof result.error === 'string' && /^EXECUTOR_[A-Z0-9_]+$/.test(result.error) ? result.error : undefined }));
}

#!/usr/bin/env node
// Explicit operator recovery only. Secret enters via non-echoing stdin and is
// never written to disk, process arguments, logs or the returned evidence.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://cripto-flax.vercel.app/api/cron/live-control';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function resumeOfficialEngine(args, secret, fetcher = fetch) {
  const [account, engine, asset, expectedRun] = args;
  if (args.length !== 4 || ![account, engine, expectedRun].every(value => UUID.test(value ?? ''))
    || !['BTC', 'SOL'].includes(asset) || typeof secret !== 'string'
    || secret.length < 32 || /[\r\n]/.test(secret)) throw new Error('COINOPS_CONTROL_INPUT_INVALID');
  // No automatic retry: an uncertain response requires a fresh ledger lookup.
  const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'RESUME', asset, exchange_account_id: account, trading_engine_id: engine }),
    signal: AbortSignal.timeout(60_000) });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.status !== 'RESUMED' || result.cycle_id !== expectedRun)
    throw new Error(/^COINOPS_[A-Z0-9_]+$/.test(result?.error ?? '')
      ? result.error : 'COINOPS_CONTROL_RESPONSE_UNCONFIRMED');
  return { status: result.status, asset, cycle_id: result.cycle_id,
    account_id: account, engine_id: engine,
    recovered_alert_code: result.recovered_alert_code ?? null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const input = createInterface({ input: process.stdin, terminal: false });
  try {
    const secret = await new Promise((done, reject) => {
      input.once('line', done);
      input.once('close', () => reject(new Error('COINOPS_CONTROL_SECRET_MISSING')));
    });
    input.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    console.log(JSON.stringify(await resumeOfficialEngine(process.argv.slice(2), secret)));
  } catch (error) {
    console.error(JSON.stringify({ status: 'UNCONFIRMED', code:
      /^COINOPS_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COINOPS_CONTROL_RESPONSE_UNKNOWN' }));
    process.exitCode = 1;
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { collectThyelyReadFacts, preflightSshArguments, readOnlyFetcher, remoteReadProgram } from './inspect-thyely-100-preflight.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const uid = '11223344';
function fixture({ missingBalance = false, wrongUid = false, duplicateOrder = false, commissionUnavailable = false } = {}) {
  const calls = [];
  const rows = ['SOLBRL', 'BTCUSDT', 'SOLUSDT'].map(symbol => ({ symbol, status: 'TRADING',
    baseAsset: symbol.startsWith('BTC') ? 'BTC' : 'SOL', quoteAsset: symbol.endsWith('BRL') ? 'BRL' : 'USDT',
    baseAssetPrecision: 8, quoteAssetPrecision: 8, quoteOrderQtyMarketAllowed: true,
    orderTypes: ['MARKET', 'LIMIT'], allowedSelfTradePreventionModes: ['EXPIRE_TAKER'],
    filters: [{ filterType: 'MAX_NUM_ORDERS', maxNumOrders: 200 }] }));
  const order = { symbol: 'BTCUSDT', orderId: 123, clientOrderId: 'C2-0123456789-1-1-BUY-1234567890abcd',
    side: 'BUY', status: 'NEW', price: '65000', origQty: '.001', executedQty: '0', unknown_field: 'NEVER_EMIT_RAW_ORDER' };
  const rates = { maker: '.001', taker: '.001', buyer: '0', seller: '0' };
  const transport = { async signed(method, path, fields = {}) {
    calls.push({ method, path, fields });
    assert.equal(method, 'GET');
    if (path === '/api/v3/account') return { ok: true, body: { uid: wrongUid ? 'different' : uid,
      canTrade: true, secret_test_sentinel: 'NEVER_EMIT_RAW_ACCOUNT', balances: ['BRL', 'BNB', 'SOL', 'USDT']
        .filter(asset => !(missingBalance && asset === 'BNB')).map(asset => ({ asset, free: asset === 'BRL' ? '1100.25' : '.005', locked: '0' })) } };
    if (path === '/api/v3/rateLimit/order') return { ok: true, body: [{ rateLimitType: 'ORDERS', interval: 'SECOND', intervalNum: 10, limit: 100, count: 1, extra: 'NEVER_EMIT_RAW_USAGE' }] };
    if (path === '/api/v3/myFilters') return { ok: true, body: { symbolFilters: [], exchangeFilters: [], assetFilters: [] } };
    if (path === '/api/v3/openOrders') return { ok: true, body: fields.symbol === 'BTCUSDT' ? duplicateOrder ? [order, order] : [order] : [] };
    if (path === '/api/v3/account/commission') return commissionUnavailable
      ? { ok: false, status: 403, code: -2015, body: { msg: 'NEVER_EMIT_PROVIDER_ERROR' } }
      : { ok: true, status: 200, body: { symbol: 'SOLBRL', standardCommission: rates,
        specialCommission: rates, taxCommission: rates, discount: { enabledForAccount: true,
          enabledForSymbol: true, discountAsset: 'BNB', discount: '.25' }, extra: 'NEVER_EMIT_RAW_COMMISSION' } };
    assert.fail(path);
  } };
  const fetcher = readOnlyFetcher(async input => {
    const url = new URL(input); calls.push({ method: 'GET', path: url.pathname });
    if (url.pathname === '/api/v3/exchangeInfo') return Response.json({ symbols: rows,
      rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 6000 }], exchangeFilters: [] });
    if (url.pathname === '/api/v3/ticker/bookTicker') return Response.json({ symbol: 'SOLBRL', askPrice: '500.1', bidPrice: '500', askQty: '2', bidQty: '3' });
    assert.fail(url.pathname);
  });
  return { calls, run: () => collectThyelyReadFacts({ transport, fetcher, expectedUidHash: hash(`REAL:${uid}`),
    hash, size: (raw, price) => [{ symbol: raw.symbol, price, valid_slots: 100 }], now: () => Date.parse('2026-10-16T18:00:00Z') }) };
}

test('read-only fence rejects mutations, bodies, arbitrary routes, credentials on public hosts and redirects', async () => {
  const seen = [], guarded = readOnlyFetcher(async (...args) => { seen.push(args); return Response.json({}); });
  for (const [url, init] of [
    ['https://api.binance.com/api/v3/order', { method: 'GET' }],
    ['https://api.binance.com/api/v3/account', { method: 'POST' }],
    ['https://api.binance.com/api/v3/account', { method: 'DELETE' }],
    ['https://api.binance.com/api/v3/account', { body: '' }],
    ['https://evil.example/api/v3/account', {}],
    ['http://api.binance.com/api/v3/account', {}],
    ['https://x:y@api.binance.com/api/v3/account', {}],
    ['https://data-api.binance.vision/api/v3/exchangeInfo?signature=secret', {}],
    ['https://data-api.binance.vision/api/v3/exchangeInfo', { headers: { 'X-MBX-APIKEY': 'secret' } }],
  ]) await assert.rejects(guarded(url, init), /PREFLIGHT_/);
  assert.equal(seen.length, 0);
  await guarded('https://api.binance.com/api/v3/account', { method: 'GET' });
  assert.equal(seen[0][1].redirect, 'error');
});

test('exact-account observation selects output and leaves external ownership unknown until ledger join', async () => {
  const f = fixture(), result = await f.run(), json = JSON.stringify(result);
  assert.equal(result.financial_writes, 0);
  assert.equal(result.balances.find(row => row.asset === 'BRL').free, 1100.25);
  assert.equal(result.inventory.find(row => row.symbol === 'BTCUSDT').open_order_count, 1);
  assert.equal(result.inventory[0].external_order_count, null);
  assert.equal(result.reservations_checked, false);
  assert.equal(result.account_commission.status, 'OBSERVED');
  assert(!json.includes('NEVER_EMIT'));
  assert(!json.includes(uid));
  assert(f.calls.every(row => row.method === 'GET'));
  assert.equal(f.calls.filter(row => row.path === '/api/v3/openOrders').length, 3);
});

test('missing balance, wrong identity and duplicate order fail closed without false zeros or ownership', async () => {
  await assert.rejects(fixture({ missingBalance: true }).run(), /PREFLIGHT_BALANCE_INCOMPLETE/);
  await assert.rejects(fixture({ wrongUid: true }).run(), /PREFLIGHT_ACCOUNT_IDENTITY_UNPROVEN/);
  await assert.rejects(fixture({ duplicateOrder: true }).run(), /PREFLIGHT_ORDER_DUPLICATE/);
});

test('unsupported commission read remains explicit unavailable without echoing provider message', async () => {
  const result = await fixture({ commissionUnavailable: true }).run();
  assert.deepEqual(result.account_commission, { status: 'UNAVAILABLE', http_status: 403, provider_code: -2015 });
  assert(!JSON.stringify(result).includes('NEVER_EMIT'));
});

test('SSH uses mandatory known host keys and generated program drops privileges before credential load', () => {
  const args = preflightSshArguments(), program = remoteReadProgram();
  assert(args.includes('StrictHostKeyChecking=yes'));
  assert(args.includes('BatchMode=yes'));
  assert(args.includes('root@167.71.37.166'));
  assert.equal(args[args.indexOf('-i') + 1], 'C:\\Users\\rafae\\.ssh\\coinops_executor_notebook_ed25519');
  assert(program.indexOf('process.setuid(service.User)') < program.indexOf('await loadCredential('));
  assert(program.indexOf('process.setgroups([])') < program.indexOf('process.setgid(service.Group)'));
  assert(!program.includes('saveCredential'));
  assert(!program.includes('refreshCredential'));
  assert(!program.includes("signed('POST'"));
  assert(!program.includes("signed('DELETE'"));
  const parsed = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: program, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
});

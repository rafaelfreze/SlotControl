#!/usr/bin/env node
/** One-shot, exact-account preflight. This script cannot write to Binance,
 * registry, vault or database. Credentials are decrypted only on Executor 03
 * after dropping to its actual non-root systemd identity; never exported.
 * Run only after reviewing the generated program and its offline tests.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const THYELY_SCOPE = Object.freeze({
  operator_id: 'd508bb3e-5a1d-4579-bd7a-de171c118d25',
  exchange_account_id: '5580c011-6ff1-44bd-b568-85932b424ceb',
  credential_ref: 'account_5580c0116ff144bdb56885932b424ceb', environment: 'REAL',
});
const IP = '167.71.37.166';

/** Additional deny-by-default transport fence, including reads made by the
 * canonical adapter. Redirects and credential-bearing alternate hosts fail.
 */
export function readOnlyFetcher(fetcher) {
  const allowed = new Map([
    ['api.binance.com', new Set(['/api/v3/time', '/api/v3/account', '/api/v3/account/commission',
      '/api/v3/rateLimit/order', '/api/v3/openOrders', '/api/v3/myFilters'])],
    ['data-api.binance.vision', new Set(['/api/v3/time', '/api/v3/exchangeInfo', '/api/v3/ticker/bookTicker'])],
    ['api.ipify.org', new Set(['/'])],
  ]);
  return async (input, init = {}) => {
    const url = new URL(input);
    if ((init.method ?? 'GET') !== 'GET' || init.body !== undefined || url.protocol !== 'https:'
      || url.username || url.password || url.port || !allowed.get(url.hostname)?.has(url.pathname))
      throw new Error('PREFLIGHT_READ_ONLY_TRANSPORT_DENIED');
    if (url.hostname !== 'api.binance.com' && (new Headers(init.headers).has('X-MBX-APIKEY')
      || url.searchParams.has('signature'))) throw new Error('PREFLIGHT_AUTH_HOST_DENIED');
    return fetcher(url.href, { ...init, method: 'GET', redirect: 'error' });
  };
}

/** Output is explicitly selected; raw account/commission/error payloads, UID,
 * credential metadata and transport objects are never serialized.
 * Account external-order counts require the control-plane ledger join, so this
 * reader intentionally leaves them null rather than guessing by client prefix.
 */
export async function collectThyelyReadFacts({ transport, fetcher, expectedUidHash, hash,
  size, now = Date.now }) {
  const symbols = ['SOLBRL', 'BTCUSDT', 'SOLUSDT'];
  const numeric = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('PREFLIGHT_NUMBER_INVALID');
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('PREFLIGHT_NUMBER_INVALID');
    return number;
  };
  const getPublic = async (path) => {
    const response = await fetcher(`https://data-api.binance.vision${path}`, {
      method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('PREFLIGHT_PUBLIC_READ_FAILED');
    return response.json();
  };
  const account = await transport.signed('GET', '/api/v3/account');
  if (!account.ok || !Array.isArray(account.body?.balances) || !account.body.canTrade
    || account.body.uid === undefined || !/^[a-f0-9]{64}$/.test(expectedUidHash ?? '')
    || hash(`REAL:${String(account.body.uid)}`) !== expectedUidHash)
    throw new Error('PREFLIGHT_ACCOUNT_IDENTITY_UNPROVEN');
  const balances = ['BRL', 'BNB', 'SOL', 'USDT'].map(asset => {
    const rows = account.body.balances.filter(row => row.asset === asset);
    if (rows.length !== 1) throw new Error('PREFLIGHT_BALANCE_INCOMPLETE');
    return { asset, free: numeric(rows[0].free), locked: numeric(rows[0].locked) };
  });
  const exchange = await getPublic(`/api/v3/exchangeInfo?${new URLSearchParams({ symbols: JSON.stringify(symbols) })}`);
  if (!Array.isArray(exchange.symbols) || !Array.isArray(exchange.rateLimits)
    || !Array.isArray(exchange.exchangeFilters)) throw new Error('PREFLIGHT_FILTERS_INCOMPLETE');
  const markets = symbols.map(symbol => {
    const rows = exchange.symbols.filter(row => row.symbol === symbol);
    if (rows.length !== 1 || rows[0].status !== 'TRADING' || !Array.isArray(rows[0].filters))
      throw new Error('PREFLIGHT_MARKET_UNAVAILABLE');
    const row = rows[0];
    return { symbol, status: row.status, baseAsset: row.baseAsset, quoteAsset: row.quoteAsset,
      baseAssetPrecision: row.baseAssetPrecision, quoteAssetPrecision: row.quoteAssetPrecision,
      quoteOrderQtyMarketAllowed: row.quoteOrderQtyMarketAllowed, orderTypes: row.orderTypes,
      allowedSelfTradePreventionModes: row.allowedSelfTradePreventionModes ?? null,
      filters: row.filters };
  });
  const book = await getPublic('/api/v3/ticker/bookTicker?symbol=SOLBRL');
  const ask = numeric(book.askPrice), bid = numeric(book.bidPrice);
  if (book.symbol !== 'SOLBRL' || ask <= 0 || bid <= 0 || ask < bid)
    throw new Error('PREFLIGHT_BOOK_INVALID');
  const observedAt = new Date(now()).toISOString();
  const orderUsage = await transport.signed('GET', '/api/v3/rateLimit/order');
  if (!orderUsage.ok || !Array.isArray(orderUsage.body) || !orderUsage.body.length
    || orderUsage.body.some(row => row.rateLimitType !== 'ORDERS'
      || !['SECOND', 'MINUTE', 'HOUR', 'DAY'].includes(row.interval)
      || !Number.isSafeInteger(row.intervalNum) || row.intervalNum < 1
      || !Number.isSafeInteger(row.limit) || row.limit < 1
      || !Number.isSafeInteger(row.count) || row.count < 0)) throw new Error('PREFLIGHT_ORDER_USAGE_INVALID');
  const inventory = [];
  for (const symbol of symbols) {
    const filters = await transport.signed('GET', '/api/v3/myFilters', { symbol });
    if (!filters.ok || !Array.isArray(filters.body?.symbolFilters) || !Array.isArray(filters.body.assetFilters)
      || !Array.isArray(filters.body.exchangeFilters)) throw new Error('PREFLIGHT_ACCOUNT_FILTERS_UNAVAILABLE');
    const result = await transport.signed('GET', '/api/v3/openOrders', { symbol });
    if (!result.ok || !Array.isArray(result.body)) throw new Error('PREFLIGHT_OPEN_ORDERS_UNAVAILABLE');
    const orders = result.body.map(row => {
      if (row.symbol !== symbol || !/^\d+$/.test(String(row.orderId))
        || typeof row.clientOrderId !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(row.clientOrderId)
        || !['BUY', 'SELL'].includes(row.side) || !['NEW', 'PARTIALLY_FILLED'].includes(row.status))
        throw new Error('PREFLIGHT_ORDER_SCOPE_DENIED');
      const quantity = numeric(row.origQty), executed = numeric(row.executedQty);
      if (executed > quantity) throw new Error('PREFLIGHT_ORDER_QUANTITY_INVALID');
      return { order_id: String(row.orderId), client_order_id: row.clientOrderId,
        side: row.side, status: row.status, price: numeric(row.price), quantity,
        executed_quantity: executed };
    });
    if (new Set(orders.map(row => row.order_id)).size !== orders.length)
      throw new Error('PREFLIGHT_ORDER_DUPLICATE');
    inventory.push({ symbol, open_orders: orders, open_order_count: orders.length,
      external_order_count: null, ownership_status: 'REQUIRES_EXACT_LEDGER_JOIN',
      account_filters: { symbolFilters: filters.body.symbolFilters,
        assetFilters: filters.body.assetFilters, exchangeFilters: filters.body.exchangeFilters } });
  }
  // Official signed GET endpoint, never order/test computeCommissionRates.
  // https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account
  const commission = await transport.signed('GET', '/api/v3/account/commission', { symbol: 'SOLBRL' });
  let fees = { status: 'UNAVAILABLE', http_status: commission.status,
    provider_code: Number.isSafeInteger(commission.code) ? commission.code : null };
  if (commission.ok) {
    if (commission.body?.symbol !== 'SOLBRL') throw new Error('PREFLIGHT_COMMISSION_SCOPE_DENIED');
    const rates = name => {
      const row = commission.body[name];
      if (!row) throw new Error('PREFLIGHT_COMMISSION_INCOMPLETE');
      return Object.fromEntries(['maker', 'taker', 'buyer', 'seller'].map(key => [key, numeric(row[key])]));
    };
    const discount = commission.body.discount;
    if (!discount || typeof discount.enabledForAccount !== 'boolean'
      || typeof discount.enabledForSymbol !== 'boolean' || typeof discount.discountAsset !== 'string')
      throw new Error('PREFLIGHT_COMMISSION_INCOMPLETE');
    fees = { status: 'OBSERVED', symbol: 'SOLBRL', standard: rates('standardCommission'),
      special: rates('specialCommission'), tax: rates('taxCommission'), discount: {
        enabled_for_account: discount.enabledForAccount, enabled_for_symbol: discount.enabledForSymbol,
        asset: discount.discountAsset, rate: numeric(discount.discount) } };
  }
  return { status: 'READ_OBSERVATION_ONLY_NOT_ADMISSION', account: 'Thyely',
    environment: 'REAL', executor_shard_id: 'executor-03', executor_ip: '167.71.37.166',
    observed_at: observedAt, completed_at: new Date(now()).toISOString(), uid_matches_vault: true,
    balances, markets, exchange_filters: exchange.exchangeFilters,
    rate_limits: exchange.rateLimits, account_order_usage: orderUsage.body.map(row => ({
      rateLimitType: row.rateLimitType, interval: row.interval, intervalNum: row.intervalNum,
      limit: row.limit, count: row.count })),
    book: { symbol: 'SOLBRL', ask_price: ask, bid_price: bid,
      ask_quantity: numeric(book.askQty), bid_quantity: numeric(book.bidQty) },
    account_commission: fees, inventory,
    sizing: size(markets[0], ask, observedAt),
    financial_writes: 0, reservations_checked: false,
    limitations: ['Wallet endpoints are not atomic; official append must bracket fresh snapshots.',
      'No ledger inventory or capacity decision is read or modified by this script.',
      'Order observations do not prove ownership until exact control-plane ledger join.',
      'Sizing is current-price evidence, not a future-price or fee guarantee.'] };
}

export function remoteReadProgram() {
  return `import {loadEnvFile} from 'node:process';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
${readOnlyFetcher.toString()}
${collectThyelyReadFacts.toString()}
try {
 const execute=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],maxBuffer:65536}).trim();
 const service=Object.fromEntries(execute('systemctl',['show','coinops-live-executor.service','--property=User','--property=Group','--property=WorkingDirectory','--property=MainPID','--property=ActiveState']).split('\\n').map(line=>{const n=line.indexOf('=');return[line.slice(0,n),line.slice(n+1)];}));
 const pid=Number(service.MainPID);
 if(service.ActiveState!=='active'||!Number.isSafeInteger(pid)||pid<1||!/^coinops[a-z0-9_-]*$/.test(service.User)||!/^coinops[a-z0-9_-]*$/.test(service.Group))throw new Error('PREFLIGHT_SERVICE_IDENTITY_DENIED');
 const cwd=realpathSync('/proc/'+pid+'/cwd'),root=resolve(cwd,'../..');
 if(!/^\\/opt\\/coinops\\/releases\\/[a-f0-9]{40}$/.test(root)||cwd!==root+'/apps/live-executor'||realpathSync(service.WorkingDirectory)!==cwd||realpathSync('/opt/coinops/current')!==root)throw new Error('PREFLIGHT_RUNTIME_ROOT_DENIED');
 const argv=readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').filter(Boolean);
 if(argv.length!==3||argv[1]!=='--experimental-strip-types'||realpathSync(argv[2])!==cwd+'/src/server.mjs')throw new Error('PREFLIGHT_PROCESS_ENTRY_DENIED');
 loadEnvFile('/etc/coinops/live-executor.env');
 if(process.env.COINOPS_EXECUTOR_SHARD_ID!=='executor-03'||process.env.LIVE_EXECUTOR_EGRESS_IP!=='167.71.37.166'||!process.env.COINOPS_EXECUTOR_STATE_DIR?.startsWith('/var/lib/coinops'))throw new Error('PREFLIGHT_HOST_SCOPE_DENIED');
 const expectedUid=Number(execute('id',['-u',service.User]));
 if(!Number.isSafeInteger(expectedUid)||expectedUid===0||Number(readFileSync('/proc/'+pid+'/status','utf8').match(/^Uid:\\s+(\\d+)/m)?.[1])!==expectedUid)throw new Error('PREFLIGHT_SERVICE_USER_DENIED');
 process.setgroups([]);process.setgid(service.Group);process.setuid(service.User);
 if(process.getuid()!==expectedUid||process.getuid()===0)throw new Error('PREFLIGHT_PRIVILEGE_DROP_DENIED');
 const guarded=readOnlyFetcher(fetch);
 const ipResponse=await guarded('https://api.ipify.org/?format=json',{method:'GET',signal:AbortSignal.timeout(8000)});
 if(!ipResponse.ok||(await ipResponse.json()).ip!=='167.71.37.166')throw new Error('PREFLIGHT_EGRESS_IP_DENIED');
 const module=name=>import(pathToFileURL(join(cwd,'src',name)).href);
 const {loadCredential,credentialMetadata}=await module('credential-vault.mjs');
 const {BinanceLiveTransport}=await module('binance-live.mjs');
 const {buildLiveSizing,parseLiveRules}=await import(pathToFileURL(join(root,'apps/web/lib/execution/live-preparation.ts')).href);
 const scope=${JSON.stringify(THYELY_SCOPE)};
 const directory=join(process.env.COINOPS_EXECUTOR_STATE_DIR,'credentials');
 const metadata=await credentialMetadata(directory,scope);
 if(metadata?.status!=='PASS'||!metadata.uidHash)throw new Error('PREFLIGHT_INSTALLED_IDENTITY_UNPROVEN');
 const secret=await loadCredential(directory,process.env.COINOPS_EXECUTOR_HMAC_SECRET,scope);
 try{
  const transport=new BinanceLiveTransport({...secret,fetcher:guarded});
  const size=(raw,price,observedAt)=>['NORMAL','POST_ATH'].map(regime=>{
   const result=buildLiveSizing(parseLiveRules(raw),price,{asset:'SOL',symbol:'SOLBRL',quote_asset:'BRL',slot_count:100,gain_rate:.03,normal_spacing_rate:.01,post_ath_spacing_rate:.02,regime,monthly_target:3,configured_live_capital_brl:1100,max_order_notional_brl:11,max_total_exposure_brl:1100,config_version:1,live_enabled:false,updated_at:observedAt},1100,observedAt,Date.now(),{engineCap:1100,orderCap:11,accountCap:1100,quoteAsset:'BRL'});
   return{regime,slot_count:100,valid_slots:result.validSlots,per_slot_quote:11,minimum_capital_quote:result.minimumCapitalBrl,recommended_per_slot_quote:result.recommendedSlotBrl,fee_policy:'CONSERVATIVE_0.2_PERCENT',failed_slots:result.slots.filter(row=>!row.valid).map(row=>row.physicalSlotNumber)};
  });
  const result=await collectThyelyReadFacts({transport,fetcher:guarded,expectedUidHash:metadata.uidHash,hash:value=>createHash('sha256').update(value).digest('hex'),size});
  result.runtime={target_sha:root.split('/').pop(),node:process.version,service_user:service.User,nonroot:true};
  process.stdout.write(JSON.stringify(result)+'\\n');
 }finally{secret.apiKey='';secret.apiSecret='';}
}catch(error){const code=/^PREFLIGHT_[A-Z_]+$/.test(error?.message??'')?error.message:'PREFLIGHT_READ_NOT_CONFIRMED';process.stderr.write(code+'\\n');process.exitCode=1;}
`;
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function preflightSshArguments() {
  return ['-T', '-i', 'C:\\Users\\rafae\\.ssh\\coinops_executor_notebook_ed25519',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    `root@${IP}`, '/usr/local/bin/node', '--experimental-strip-types', '--input-type=module',
    '-e', quote(remoteReadProgram())];
}
export async function inspectThyelyPreflight() {
  return new Promise((accept, reject) => {
    const child = spawn('ssh.exe', preflightSshArguments(), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', bytes = 0;
    const timer = setTimeout(() => child.kill(), 110000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) child.kill(); else stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; else child.kill(); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('PREFLIGHT_SSH_UNAVAILABLE')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { const error = stderr.trim(); reject(new Error(/^PREFLIGHT_[A-Z_]+$/.test(error)
        ? error : 'PREFLIGHT_REMOTE_READ_NOT_CONFIRMED')); return; }
      try {
        const result = JSON.parse(stdout.trim());
        if (result.status !== 'READ_OBSERVATION_ONLY_NOT_ADMISSION' || result.account !== 'Thyely'
          || result.environment !== 'REAL' || result.executor_shard_id !== 'executor-03'
          || result.executor_ip !== IP || result.financial_writes !== 0) throw new Error();
        accept(result);
      } catch { reject(new Error('PREFLIGHT_OUTPUT_NOT_CONFIRMED')); }
    });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--read-only-thyely-03') {
    console.error('Explicit --read-only-thyely-03 is required. No action taken.'); process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await inspectThyelyPreflight(), null, 2)); }
    catch (error) { console.error(/^PREFLIGHT_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'PREFLIGHT_NOT_CONFIRMED'); process.exitCode = 1; }
  }
}

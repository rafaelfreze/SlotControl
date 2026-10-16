#!/usr/bin/env node
/** Public market GET only. No credential, account balance or order transport.
 * Validates the authorized Thyely proposal without certifying future prices,
 * actual account fees, capital availability, whitelist or executor admission. */
import { buildLiveSizing, parseLiveRules } from '../../apps/web/lib/execution/live-preparation.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkProposedSolBrlMarket(fetcher = fetch) {
  const get = async path => {
    const response = await fetcher(`https://api.binance.com/api/v3/${path}`, {
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) throw new Error('COINOPS_PUBLIC_MARKET_UNAVAILABLE');
    return response.json();
  };
  const [exchange, book] = await Promise.all([
    get('exchangeInfo?symbol=SOLBRL'), get('ticker/bookTicker?symbol=SOLBRL'),
  ]);
  const raw = exchange.symbols?.find(value => value.symbol === 'SOLBRL');
  if (!raw || book.symbol !== 'SOLBRL') throw new Error('COINOPS_PUBLIC_MARKET_SCOPE_DENIED');
  const rules = parseLiveRules(raw), observedAt = new Date().toISOString();
  const price = Number(book.askPrice);
  const regimes = ['NORMAL', 'POST_ATH'].map(regime => {
    const sizing = buildLiveSizing(rules, price, {
      asset: 'SOL', symbol: 'SOLBRL', quote_asset: 'BRL', slot_count: 100,
      gain_rate: .03, normal_spacing_rate: .01, post_ath_spacing_rate: .02,
      regime, monthly_target: 3, configured_live_capital_brl: 1100,
      max_order_notional_brl: 11, max_total_exposure_brl: 1100,
      config_version: 1, live_enabled: false, updated_at: observedAt,
    }, 1100, observedAt, Date.now(), { engineCap: 1100, orderCap: 11, accountCap: 1100, quoteAsset: 'BRL' });
    return { regime, slot_count: 100, valid_slots: sizing.validSlots,
      per_slot_quote: 11, minimum_capital_quote: sizing.minimumCapitalBrl,
      recommended_per_slot_quote: sizing.recommendedSlotBrl,
      first_entry_price: sizing.slots.find(value => value.operationalRank === 1)?.entryPriceBrl,
      last_entry_price: sizing.slots.find(value => value.operationalRank === 100)?.entryPriceBrl,
      failed_slots: sizing.slots.filter(value => !value.valid).map(value => value.physicalSlotNumber) };
  });
  return { scope: 'PUBLIC_FILTERS_ONLY_NO_ACCOUNT_OR_LIVE_WRITE', symbol: 'SOLBRL', observed_at: observedAt,
    status: rules.status, ask_price: price, bid_price: Number(book.bidPrice),
    min_notional: rules.minNotional, quantity_step: rules.quantityStep, price_tick: rules.priceTick,
    max_orders_per_account_symbol: raw.filters.find(value => value.filterType === 'MAX_NUM_ORDERS')?.maxNumOrders,
    fee_reserve_rate: .002, fee_source: 'CONSERVATIVE_EXISTING_POLICY_NOT_ACCOUNT_COMMISSION',
    regimes, result: regimes.every(value => value.valid_slots === 100) ? 'FILTER_SIZING_PASS' : 'FILTER_SIZING_FAIL',
    live_certification: 'NOT_CERTIFIED' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkProposedSolBrlMarket().then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.result !== 'FILTER_SIZING_PASS') process.exitCode = 1;
  }).catch(() => { console.error('COINOPS_PUBLIC_MARKET_PREFLIGHT_FAILED'); process.exitCode = 1; });
}

import { LiveReadUnavailable } from "./live-read-error.ts";

type FeePrice = { symbol: string; price: number; observedAt: string };
type FeeSnapshot = { observed_at: string; balances: Array<{ asset: string; free: number }>;
  bnb_quote_price?: FeePrice | null; bnb_brl_price?: FeePrice | null };

/** The same strict pre-POST reserve as the executor, never a fee estimate or
 * a substitute for Spot cash. Defers BUY only; no resize, claim or TP mutation. */
export const LIVE_BNB_FEE_MINIMUM_EXCLUSIVE = 0.00001;
export function liveBnbFeeBalanceCheck(state: FeeSnapshot, quoteAsset: string, now = Date.now()) {
  const fresh = (timestamp: string) => {
    const observed = Date.parse(timestamp);
    return Number.isFinite(now) && Number.isFinite(observed) && now - observed <= 30_000 && observed - now <= 2_000;
  };
  const rows = state.balances.filter((row) => row.asset === "BNB");
  const free = rows[0]?.free;
  // The old name is compatibility only: its symbol must still be the exact quote.
  const price = state.bnb_quote_price ?? state.bnb_brl_price;
  if (!/^(BRL|USDT)$/.test(quoteAsset) || !fresh(state.observed_at)
    || rows.length !== 1 || !Number.isFinite(free) || free < 0
    || !price || price.symbol !== `BNB${quoteAsset}` || !Number.isFinite(price.price)
    || price.price <= 0 || !fresh(price.observedAt))
    throw new LiveReadUnavailable("COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE", "snapshot/bnb_fee", 1);
  return { sufficient: free > LIVE_BNB_FEE_MINIMUM_EXCLUSIVE, free_bnb: free,
    minimum_bnb_exclusive: LIVE_BNB_FEE_MINIMUM_EXCLUSIVE, quote_asset: quoteAsset,
    balance_observed_at: state.observed_at, bnb_price: price.price,
    bnb_price_symbol: price.symbol, bnb_price_observed_at: price.observedAt };
}

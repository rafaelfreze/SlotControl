type QuoteSnapshot = { observed_at: string; balances: Array<{ asset: string; free: number }> };

/** Physical Spot balance is not the slot's logical capital. This check only
 * defers a new BUY; it never resizes it, releases a claim or authorizes recovery.
 * Reclaimed quote is allowed only for a verified, owned, unfilled resident BUY. */
export function liveQuoteBalanceCheck(state: QuoteSnapshot, quoteAsset: string,
  requiredQuote: number, reclaimedQuote = 0, now = Date.now()) {
  const observed = Date.parse(state.observed_at);
  const rows = state.balances.filter(row => row.asset === quoteAsset);
  const free = rows[0]?.free;
  if (!Number.isFinite(observed) || now - observed > 30_000 || observed - now > 2_000
    || rows.length !== 1 || !Number.isFinite(free) || free < 0
    || !Number.isFinite(requiredQuote) || requiredQuote <= 0
    || !Number.isFinite(reclaimedQuote) || reclaimedQuote < 0)
    throw new Error("COINOPS_LIVE_QUOTE_BALANCE_UNAVAILABLE");
  const availableQuote = free + reclaimedQuote;
  return { sufficient: availableQuote + 1e-8 >= requiredQuote,
    free_quote: free, reclaimed_quote: reclaimedQuote, required_quote: requiredQuote,
    quote_asset: quoteAsset, balance_observed_at: state.observed_at };
}

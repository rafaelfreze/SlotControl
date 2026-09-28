export type RankedSlot = { slot: number; gains: number; monthly: number; realized: number;
  balance: number; contributed: number; pendingContribution: number;
  openPnl: number | null; open: boolean };
export type RankedMarket = { symbol: string; currency: string; slots: RankedSlot[]; realized: number };

export function rankViewerMarkets<T extends RankedMarket>(markets: readonly T[]) {
  return markets.map((market) => ({ ...market,
    gains: market.slots.reduce((sum, slot) => sum + slot.gains, 0),
    monthlyGains: market.slots.reduce((sum, slot) => sum + slot.monthly, 0),
    rankedSlots: [...market.slots].sort((a, b) => b.gains - a.gains || b.realized - a.realized || a.slot - b.slot),
  })).sort((a, b) => b.gains - a.gains || b.realized - a.realized || a.symbol.localeCompare(b.symbol));
}

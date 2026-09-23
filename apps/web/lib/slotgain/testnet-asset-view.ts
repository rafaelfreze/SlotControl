type Asset = "BTC" | "SOL";
type Bundle<Run, Slot, Order, Event> = { run: Run; slots: Slot[]; orders: Order[]; events: Event[]; history?: Array<{ run: Run; slots: Slot[]; orders: Order[] }> };

/** Presentation scope only: never starts or changes an executor. */
export function selectTestnetAssetData<Run extends { symbol: string }, Slot, Order, Event>(source: {
  testnetRun: Run | null;
  testnetSlots: Slot[];
  testnetOrders: Order[];
  testnetEvents: Event[];
  testnetEnabled: boolean;
  testnetAssetData?: Partial<Record<Asset, Bundle<Run, Slot, Order, Event>>>;
}, asset: Asset) {
  const bundle = source.testnetAssetData?.[asset];
  const validBundle = bundle?.run.symbol.startsWith(asset) ? bundle : null;
  const legacyMatches = source.testnetRun?.symbol.startsWith(asset) ?? false;
  return {
    testnetRun: validBundle?.run ?? (legacyMatches ? source.testnetRun : null),
    testnetSlots: validBundle?.slots ?? (legacyMatches ? source.testnetSlots : []),
    testnetOrders: validBundle?.orders ?? (legacyMatches ? source.testnetOrders : []),
    testnetEvents: validBundle?.events ?? (legacyMatches ? source.testnetEvents : []),
    testnetHistory: validBundle?.history ?? [],
    // Current execution support is SOL only. A future BTC ledger does not
    // implicitly authorize starting a BTC executor or a SOL run from its tab.
    testnetEnabled: asset === "SOL" && source.testnetEnabled
  };
}

export type StrategySnapshot = Record<string, unknown>;

/** An existing order carries its decision-time strategy. Later config edits
 * cannot reinterpret a resident TP or an already prepared/filled BUY. */
export function strategyRatesForOrder(order: { config_snapshot?: StrategySnapshot | null },
  run: { config_snapshot: StrategySnapshot; gain_rate: number | string;
    entry_spacing: number | string; anchor_price: number | string }) {
  const snapshot = order.config_snapshot ?? run.config_snapshot;
  const spacing = Number(snapshot.entry_spacing ?? (snapshot.regime === "POST_ATH"
    ? snapshot.post_ath_spacing_rate : snapshot.normal_spacing_rate) ?? run.entry_spacing);
  const gain = Number(snapshot.gain_rate ?? run.gain_rate);
  const anchor = Number(snapshot.ladder_anchor_price ?? run.anchor_price);
  if (![spacing, gain, anchor].every((value) => Number.isFinite(value) && value > 0))
    throw new Error("COINOPS_STRATEGY_ORDER_SNAPSHOT_INVALID");
  return { spacing, gain, anchor };
}

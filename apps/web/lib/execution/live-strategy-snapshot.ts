export type StrategySnapshot = Record<string, unknown>;

export type GridPriceContext = { run_id: string; engine_id: string; price: number;
  anchor: number; spacing: number; slot_count: number };

/** Monthly allocation moves price levels between physical slots. A retained
 * level may belong to the previous grid while newly planned levels belong to
 * the new anchor. Persist provenance by PRICE, independently of slot/rank. */
export function gridContextForPrice(snapshot: StrategySnapshot, scope: { id: string; trading_engine_id: string },
  price: number, slotCount: number): GridPriceContext | undefined {
  const contexts = snapshot.entry_grid_contexts as Record<string, GridPriceContext> | undefined;
  const context = contexts?.[String(price)];
  if (!context) return undefined;
  if (context.run_id !== scope.id || context.engine_id !== scope.trading_engine_id || context.price !== price
    || context.slot_count !== slotCount || !Number.isFinite(context.anchor) || context.anchor <= 0
    || !Number.isFinite(context.spacing) || context.spacing <= 0 || context.spacing >= 1)
    throw new Error("COINOPS_STRATEGY_GRID_CONTEXT_INVALID");
  return context;
}

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

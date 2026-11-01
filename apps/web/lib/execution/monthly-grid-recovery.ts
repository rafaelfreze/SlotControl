import { monthlyPeriodKey, ENTRY_PRIORITY_POLICY } from "./monthly-slot-policy.ts";
import { assertStrategyBuyPrice } from "./strategy-price-invariant.ts";
import { gridContextForPrice, strategyRatesForOrder, type GridPriceContext } from "./live-strategy-snapshot.ts";

type Snapshot = Record<string, unknown>;
type Scope = { id: string; trading_engine_id: string; exchange_account_id: string; operator_id: string };
type GridOrder = { id: string; run_id: string; trading_engine_id: string; exchange_account_id: string;
  operator_id: string; slot_id: string; side: string; purpose: string; status: string;
  price: number | string | null; executed_quantity: number | string; cumulative_quote: number | string;
  exchange_order_id: string | null; submission_guarded_at: string | null; created_at: string;
  trades_reconciled: boolean; config_version: number; config_snapshot: Snapshot };
type GridSlot = { id: string; entry_state: string; position_quantity: number | string;
  target_buy_price: number | string; entry_reference_price: number | string; entry_origin: "GRID" | "REENTRY" };
export type MonthlyGridRepair = { order_id: string; predecessor_order_id: string; period: string;
  previous_anchor: number; corrected_anchor: number; incident_first_seen_at: string };

/** Recover only provenance for an uncommitted retained level. An immutable
 * pre-transition snapshot must contain the same scoped GRID source; merely
 * finding a mathematically convenient anchor is never sufficient. */
export function proveRetainedGridContext(run: Scope & { anchor_price: number | string; gain_rate: number | string;
  entry_spacing: number | string; config_version: number; config_snapshot: Snapshot },
  orders: GridOrder[], price: number, transitionAt: string, tick: number, slotCount: number) {
  const cutoff = Date.parse(transitionAt);
  if (!Number.isFinite(cutoff)) return null;
  for (const order of [...orders].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))) {
    if (order.run_id !== run.id || order.trading_engine_id !== run.trading_engine_id
      || order.operator_id !== run.operator_id || order.exchange_account_id !== run.exchange_account_id
      || order.config_version !== run.config_version || Date.parse(order.created_at) >= cutoff) continue;
    const sources = order.config_snapshot.entry_price_sources as Record<string, Snapshot> | undefined;
    if (!sources || !Object.entries(sources).some(([id,s])=>s.run_id===run.id && s.engine_id===run.trading_engine_id
      && s.slot_id===id && s.source_origin==="GRID" && Number(s.price)===price)) continue;
    const rates = strategyRatesForOrder(order,run);
    if (rates.gain !== Number(run.gain_rate) || rates.spacing !== Number(run.entry_spacing)) continue;
    const known = gridContextForPrice(order.config_snapshot,run,price,slotCount);
    const context: GridPriceContext = known ?? { run_id:run.id,engine_id:run.trading_engine_id,
      price,anchor:rates.anchor,spacing:rates.spacing,slot_count:slotCount };
    try { assertStrategyBuyPrice({price,referencePrice:price,anchorPrice:context.anchor,spacing:context.spacing,
      tick,entryOrigin:"GRID",slotCount}); }
    catch { continue; }
    return { context, source_order_id:order.id };
  }
  return null;
}

/** An exact legacy monthly-only defect, not permission to reinterpret arbitrary
 * prices. The predecessor's immutable order snapshot must prove the SAME price
 * and strategy; the retained level and every newly planned level must have
 * independently valid grid geometry (the run can legitimately contain both).
 * The caller must additionally prove exchange absence, zero dispatch, complete
 * position/TP agreement and persist the repair under the engine's lease. */
export function proveMonthlyGridRepair(run: Scope & { anchor_price: number | string; gain_rate: number | string;
  entry_spacing: number | string; entry_regime: string; ath_period_key: string | null; config_snapshot: Snapshot },
  orders: GridOrder[], slots: GridSlot[], incident: { code: string; first_seen_at?: string;
    details?: { root_code?: unknown; stage?: unknown } | null }, tick: number, slotCount: number,
  started?: MonthlyGridRepair | null): MonthlyGridRepair {
  const fail = (): never => { throw new Error("COINOPS_MONTHLY_GRID_RECOVERY_UNPROVEN"); };
  const first = Date.parse(incident.first_seen_at ?? "");
  if (incident.code !== "COINOPS_STRATEGY_PRICE_INVARIANT_FAILED"
    || incident.details?.root_code !== incident.code || incident.details.stage !== "RECONCILE_ORDERS"
    || run.entry_regime !== "NORMAL" || !Number.isFinite(first)
    || monthlyPeriodKey(new Date(first)) !== run.ath_period_key
    || monthlyPeriodKey(new Date(first - 600_000)) === run.ath_period_key
    || run.config_snapshot.entry_priority_policy !== ENTRY_PRIORITY_POLICY) return fail();
  const sameScope = (o: GridOrder) => o.run_id === run.id && o.trading_engine_id === run.trading_engine_id
    && o.exchange_account_id === run.exchange_account_id && o.operator_id === run.operator_id;
  const candidates = orders.filter(o => sameScope(o) && o.side === "BUY" && o.purpose === "ENTRY"
    && (o.status === "PREPARED" || o.status === "CANCELED" && started?.order_id === o.id)
    && !o.exchange_order_id && !o.submission_guarded_at && Number(o.executed_quantity) === 0
    && Number(o.cumulative_quote) === 0 && Math.abs(Date.parse(o.created_at) - first) < 120_000);
  if (candidates.length !== 1) return fail();
  const order = candidates[0]!, slot = slots.find(s => s.id === order.slot_id);
  if (!slot || !["ARMED", "PLANNED"].includes(slot.entry_state) || Number(slot.position_quantity) !== 0
    || Number(order.price) !== Number(slot.target_buy_price)
    || Number(order.price) !== Number(slot.entry_reference_price)) return fail();
  const source = (order.config_snapshot.entry_price_sources as Record<string, Snapshot> | undefined)?.[slot.id];
  if (order.config_snapshot.entry_priority_policy !== ENTRY_PRIORITY_POLICY || !source
    || source.run_id !== run.id || source.engine_id !== run.trading_engine_id || source.slot_id !== slot.id
    || source.source_origin !== "GRID" || Number(source.price) !== Number(order.price)) return fail();
  const bad = strategyRatesForOrder(order, run);
  try { assertStrategyBuyPrice({ price: Number(order.price), referencePrice: Number(slot.entry_reference_price),
    anchorPrice: bad.anchor, spacing: bad.spacing, tick, entryOrigin: "GRID", slotCount }); return fail(); }
  catch (error) { if (!(error instanceof Error) || error.message !== "COINOPS_STRATEGY_PRICE_INVARIANT_FAILED") throw error; }
  const prior = orders.filter(o => sameScope(o) && o.side === "BUY" && o.purpose === "ENTRY"
    && o.slot_id === slot.id && o.status === "CANCELED" && o.exchange_order_id && o.trades_reconciled
    && Number(o.executed_quantity) === 0 && Number(o.cumulative_quote) === 0
    && Number(o.price) === Number(order.price) && o.config_version === order.config_version
    && Date.parse(o.created_at) < Date.parse(order.created_at))
    .sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!prior) return fail();
  const old = strategyRatesForOrder(prior, run);
  if (old.gain !== bad.gain || old.spacing !== bad.spacing || old.anchor === bad.anchor
    || old.gain !== Number(run.gain_rate) || old.spacing !== Number(run.entry_spacing)
    || prior.config_snapshot.regime !== order.config_snapshot.regime) return fail();
  for (const s of slots.filter(s => ["ARMED", "PLANNED"].includes(s.entry_state))) {
    const src = (run.config_snapshot.entry_price_sources as Record<string, Snapshot> | undefined)?.[s.id];
    const origin = src && Number(src.price) === Number(s.target_buy_price) ? src.source_origin : s.entry_origin;
    if (origin !== "GRID") continue;
    if (src && (src.run_id !== run.id || src.engine_id !== run.trading_engine_id || src.slot_id !== s.id)) return fail();
    const price = Number(s.target_buy_price);
    const known = gridContextForPrice(run.config_snapshot, run, price, slotCount);
    assertStrategyBuyPrice({ price, referencePrice: Number(s.entry_reference_price),
      anchorPrice: price === Number(order.price) ? old.anchor : known?.anchor ?? bad.anchor,
      spacing: price === Number(order.price) ? old.spacing : known?.spacing ?? bad.spacing,
      tick, entryOrigin: "GRID", slotCount });
  }
  const proof = { order_id: order.id, predecessor_order_id: prior.id, period: run.ath_period_key!,
    previous_anchor: bad.anchor, corrected_anchor: old.anchor, incident_first_seen_at: incident.first_seen_at! };
  if (started && (Object.keys(proof) as Array<keyof MonthlyGridRepair>).some(key => started[key] !== proof[key])) return fail();
  return proof;
}

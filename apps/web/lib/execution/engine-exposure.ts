import { LIVE_ACTIVE_ORDER_STATUSES } from "./robot-v1-live-cycle.ts";
import type { V1Asset } from "./robot-v1.ts";

type Engine = { id: string; asset: V1Asset; cap: number };
type Position = { engineId: string; committed: number };
type Order = { engineId: string; side: string; status: string; reserved: number; executedQuote: number };
/** Engine allocation and account allocation are distinct boundaries. Same base
 * asset on another engine/IP never consumes the selected engine's own cap.
 * Existing sibling exposure still consumes the shared native account cap. */
export function liveEngineExposure(selectedEngineId: string, engines: readonly Engine[],
  positions: readonly Position[], orders: readonly Order[], accountCap: number) {
  const fail = () => { throw new Error("COINOPS_LIVE_EXPOSURE_INVALID"); };
  const byId = new Map(engines.map((engine) => [engine.id, engine]));
  const selected = byId.get(selectedEngineId);
  if (!selected || byId.size !== engines.length || !Number.isFinite(accountCap) || accountCap <= 0
    || engines.some((engine) => !engine.id || !["BTC", "SOL"].includes(engine.asset)
      || !Number.isFinite(engine.cap) || engine.cap < 0)) fail();
  const totals = new Map<string, number>();
  for (const row of positions) {
    if (!byId.has(row.engineId) || !Number.isFinite(row.committed) || row.committed < 0) fail();
    totals.set(row.engineId, (totals.get(row.engineId) ?? 0) + row.committed);
  }
  for (const row of orders) {
    if (!byId.has(row.engineId) || !["BUY", "SELL"].includes(row.side)) fail();
    if (row.side !== "BUY" || !LIVE_ACTIVE_ORDER_STATUSES.has(row.status)) continue;
    if (![row.reserved, row.executedQuote].every((value) => Number.isFinite(value) && value >= 0)
      || row.executedQuote > row.reserved + 1e-8) fail();
    totals.set(row.engineId, (totals.get(row.engineId) ?? 0) + Math.max(0, row.reserved - row.executedQuote));
  }
  const own = totals.get(selectedEngineId) ?? 0;
  const global = [...totals.values()].reduce((sum, value) => sum + value, 0);
  // A sibling's local breach is handled by that sibling, not a cross-engine
  // kill switch. A real shared account-cap breach still prevents new buys.
  if (!Number.isFinite(global) || own > selected!.cap + 1e-8 || global > accountCap + 1e-8)
    throw new Error("COINOPS_LIVE_HARD_CAP_BREACHED");
  return { BTC: selected!.asset === "BTC" ? own : 0, SOL: selected!.asset === "SOL" ? own : 0, global };
}

import { createHash } from "node:crypto";
export type AllocatedEngine = { id: string; cap: number; shard: string };
/** Free quote already excludes actual Binance BUY holds. Deduct only the
 * uncommitted part of every installed allocation; never reuse another engine's
 * spare capital or subtract positions/confirmed holds twice. Missing exchange
 * evidence is conservative (no hold credit), not an invented zero allocation. */
export function engineAppendAvailableCapital(free: number, accountCap: number,
  engines: readonly AllocatedEngine[], exposure: readonly { engineId: string; position: number; confirmedBuyHold: number }[]) {
  const fail = () => { throw new Error("COINOPS_ENGINE_APPEND_ALLOCATION_UNKNOWN"); };
  if (![free, accountCap].every((n) => Number.isFinite(n) && n >= 0)
    || new Set(engines.map((engine) => engine.id)).size !== engines.length
    || new Set(exposure.map((row) => row.engineId)).size !== exposure.length
    || engines.some((engine) => !engine.id || !/^executor-[0-9]{2,4}$/.test(engine.shard)
      || !Number.isFinite(engine.cap) || engine.cap <= 0)
    || exposure.some((row) => !engines.some((engine) => engine.id === row.engineId)
      || ![row.position, row.confirmedBuyHold].every((n) => Number.isFinite(n) && n >= 0))) fail();
  const assigned = engines.reduce((sum, engine) => sum + engine.cap, 0);
  if (assigned > accountCap + 1e-8) fail();
  let requiredFree = Math.max(0, accountCap - assigned);
  for (const engine of engines) {
    const row = exposure.find((entry) => entry.engineId === engine.id);
    const used = (row?.position ?? 0) + (row?.confirmedBuyHold ?? 0);
    if (used > engine.cap + 1e-8) fail();
    requiredFree += Math.max(0, engine.cap - used);
  }
  return { allocatedCapital: accountCap, requiredFree, availableCapital: Math.max(0, Math.floor((free - requiredFree + 1e-8) * 100) / 100) };
}
export function engineAppendPreviewHash(input: unknown, accountCap: number, engines: readonly AllocatedEngine[]) {
  const inventory = [...engines].sort((a, b) => a.id.localeCompare(b.id)).map((engine) => ({ id: engine.id, cap: engine.cap, shard: engine.shard }));
  return createHash("sha256").update(JSON.stringify({ input, accountCap, inventory })).digest("hex");
}

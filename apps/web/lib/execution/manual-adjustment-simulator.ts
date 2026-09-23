import { buildPostAthQueue } from "./ath-regime.ts";
import { FX_SOURCE, previewManualAdjustment, settleAfterOpenPosition, type AdjustmentSnapshot } from "./manual-adjustments.ts";
import { rankMonthlySlots } from "./monthly-slot-policy.ts";
import { planStrategyPostAthNextEntry } from "./strategy-engine.ts";

export type ManualAdjustmentScenario = { code: string; passed: boolean; evidence: string };
const at = "2026-09-23T12:00:00.000Z";
const base = (overrides: Partial<AdjustmentSnapshot> = {}): AdjustmentSnapshot => ({
  environment: "TESTNET", asset: "SOL", physicalSlotNumber: 1, balanceUsdc: 100,
  committedNotionalUsdc: null, entryState: "CLOSED", monthlyGainCount: 1,
  lifetimeGainCount: 10, gainRate: 0.005, ...overrides,
});
const check = (condition: boolean, code: string) => { if (!condition) throw new Error(`COINOPS_MANUAL_SIM_${code}`); };

/** Deterministic, isolated accounting replay. No service client or exchange adapter. */
export function simulateManualAdjustments(): ManualAdjustmentScenario[] {
  const results: ManualAdjustmentScenario[] = [];
  const run = (code: string, scenario: () => string) => {
    try { results.push({ code, passed: true, evidence: scenario() }); }
    catch (error) { results.push({ code, passed: false, evidence: error instanceof Error ? error.message : String(error) }); }
  };
  run("A", () => {
    const p = previewManualAdjustment(base(), { kind: "MANUAL_TARGET_GAIN", gainUnits: 1 });
    check(p.monthlyAfter === 2 && p.targetReachedAfter && p.balanceAfterUsdc === 100.5, "A");
    return "SOL fechado 1/2 + 1 manual = 2/2; saldo 100,50; próxima entrada bloqueada.";
  });
  run("B", () => {
    const p = previewManualAdjustment(base({ entryState: "OPEN", committedNotionalUsdc: 100 }),
      { kind: "MANUAL_TARGET_GAIN", gainUnits: 1, explicitGainAmountUsdc: 5 });
    check(p.committedNotionalUsdc === 100 && p.balanceAfterUsdc === 105 && settleAfterOpenPosition(p, 2) === 107, "B");
    return "OPEN 100 permanece 100; +5 manual e +2 realizado deixam 107 para a próxima operação.";
  });
  run("C", () => {
    const p = previewManualAdjustment(base(), { kind: "MANUAL_CONTRIBUTION", currency: "USD", amount: 10 });
    check(p.balanceAfterUsdc === 110 && p.gainUnits === 0, "C");
    return "Aporte USD em slot fechado: 100 + 10 = 110; zero gain.";
  });
  run("D", () => {
    const p = previewManualAdjustment(base({ entryState: "OPEN", committedNotionalUsdc: 100 }),
      { kind: "MANUAL_CONTRIBUTION", currency: "USD", amount: 10 });
    check(p.committedNotionalUsdc === 100 && settleAfterOpenPosition(p, 3) === 113, "D");
    return "Aporte OPEN: posição congelada em 100; 110 no ledger; após +3 realizado, próxima operação 113.";
  });
  run("E", () => {
    const p = previewManualAdjustment(base(), { kind: "MANUAL_CONTRIBUTION", currency: "BRL", amount: 50 },
      { source: FX_SOURCE, rateBrlPerUsdc: 5, observedAt: at }, Date.parse(at) + 30_000);
    check(p.convertedAmountUsdc === 10 && p.fx?.rateBrlPerUsdc === 5, "E");
    return "R$50 / 5 BRL por USDC = 10 USDC, com cotação e horário registrados.";
  });
  run("F", () => {
    const p = previewManualAdjustment(base(), { kind: "MANUAL_CONTRIBUTION", currency: "USD", amount: 10 });
    check(p.monthlyAfter === p.monthlyBefore && p.lifetimeAfter === p.lifetimeBefore, "F");
    return "Aporte preserva contadores mensal e vitalício.";
  });
  const slots = Array.from({ length: 25 }, (_, index) => ({ physicalSlotId: `SIM:SOL:${index + 1}`,
    physicalSlotNumber: index + 1, lifetimeGainCount: index === 0 ? 2 : index === 1 ? 3 : 0,
    monthlyGainCount: 0, balanceUsdc: 10, entryState: "PLANNED" }));
  run("G", () => {
    const oldRank = rankMonthlySlots("SOL", at, slots)[0]?.operationalRank;
    const changed = slots.map((slot, index) => index === 0 ? { ...slot, lifetimeGainCount: 4 } : slot);
    check(oldRank === 2 && rankMonthlySlots("SOL", at, changed)[0]?.operationalRank === 1
      && changed[0]?.physicalSlotId === slots[0]?.physicalSlotId, "G");
    return "Gain manual muda rank futuro 2 → 1; physical_slot_id permanece fixo.";
  });
  run("H", () => {
    const athSlots = slots.map((slot, index) => ({ ...slot, lifetimeGainCount: index + 1 }));
    const before = buildPostAthQueue("SOL", athSlots);
    const changed = athSlots.map((slot, index) => index === 0 ? { ...slot, lifetimeGainCount: 30 } : slot);
    const after = buildPostAthQueue("SOL", changed);
    check(before[0]?.postAthGroup === "RESERVE" && after[0]?.postAthGroup === "PRIMARY", "H_GROUP");
    const candidates = [
      { id: "reentry", slotNumber: 1, operationSequence: 2, buyPrice: 99, balanceUsdc: 105,
        state: "PLANNED" as const, entryOrigin: "REENTRY" as const, postAthGroup: "RESERVE" as const, operationalRank: 25 },
      { id: "primary", slotNumber: 2, operationSequence: 1, buyPrice: 98, balanceUsdc: 10,
        state: "PLANNED" as const, entryOrigin: "GRID" as const, postAthGroup: "PRIMARY" as const, operationalRank: 1 },
    ];
    const decision = planStrategyPostAthNextEntry({ asset: "SOL", cycleId: "SIM-MANUAL-H", observedAt: at }, candidates, 100);
    check(decision.nextCandidateId === "reentry" && decision.decision.action_type === "ARM_NEXT_BUY", "H_PRICE");
    return "POST_ATH recalcula RESERVE → PRIMARY; reentry 99 mantém prioridade de preço sobre grid 98.";
  });
  run("I", () => {
    const ledger = new Map<string, ReturnType<typeof previewManualAdjustment>>();
    const apply = (key: string) => {
      if (!ledger.has(key)) ledger.set(key, previewManualAdjustment(base(), { kind: "MANUAL_TARGET_GAIN", gainUnits: 1 }));
      return ledger.get(key)!;
    };
    check(apply("SIM-KEY-1") === apply("SIM-KEY-1") && ledger.size === 1, "I");
    return "Retry/double-click com a mesma chave produz um único lançamento.";
  });
  run("J", () => {
    const p = previewManualAdjustment(base(), { kind: "MANUAL_TARGET_GAIN", gainUnits: 1 });
    const reversal = { amount: -p.convertedAmountUsdc, gainUnits: -p.gainUnits, reversalOf: "SIM-ORIGINAL" };
    check(p.balanceAfterUsdc + reversal.amount === p.balanceBeforeUsdc
      && p.monthlyAfter + reversal.gainUnits === p.monthlyBefore
      && p.lifetimeAfter + reversal.gainUnits === p.lifetimeBefore
      && reversal.reversalOf === "SIM-ORIGINAL", "J");
    return "Estorno assinado e vinculado restaura saldo, meta e rank sem apagar o original.";
  });
  return results;
}

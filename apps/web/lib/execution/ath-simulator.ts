import { advanceAthState, athSimulationId, buildPostAthQueue, orderedPostAthSlots, validateAthParameters,
  type AthParameters, type AthRegime, type AthSlot, type AthState, type PostAthGroup, type PostAthSlot } from "./ath-regime.ts";
import { MONTHLY_SLOT_TARGET } from "./monthly-slot-policy.ts";
import { planAthLadder } from "./ath-ladder.ts";
import { calculateStrategyTakeProfit, planStrategyInitialEntry, planStrategyNextEntry, planStrategyPostAthNextEntry,
  planStrategyTakeProfit, type StrategyCandidate,
  type StrategyContext } from "./strategy-engine.ts";
import type { ExchangeSymbolInfo } from "./types.ts";
import type { V1Asset } from "./robot-v1.ts";

export type AthSimulationInput = {
  asset: V1Asset;
  initialPrice: number;
  previousAth: number;
  floorReference: number | null;
  parameters: AthParameters;
  lifetimeGains: number[];
  monthlyGains: number[];
  prices: number[];
  priceTick?: number;
};

export type AthSimulationStep = {
  index: number;
  price: number;
  regime: AthRegime;
  athPrice: number | null;
  event: string;
  slot: number | null;
  group: PostAthGroup | null;
  groupRank: number | null;
  decisionId: string | null;
  operationId: string | null;
  targetPrice: number | null;
  balanceUsdc: number | null;
  lifetimeGains: number | null;
  monthlyGains: number | null;
  nextBuy: number | null;
  openCount: number;
};

type SimSlot = PostAthSlot & {
  balanceUsdc: number;
  entryPrice: number | null;
  takeProfit: number | null;
  buyPrice: number;
  operationSequence: number;
  committed: boolean;
  entryOrigin: "GRID" | "REENTRY";
  armedDecisionId: string | null;
};

function checkInput(input: AthSimulationInput) {
  if (!input || !input.parameters || !Array.isArray(input.lifetimeGains) || !Array.isArray(input.monthlyGains))
    throw new Error("COINOPS_ATH_SIMULATION_INPUT_INVALID");
  validateAthParameters(input.parameters);
  if (input.asset !== "BTC" && input.asset !== "SOL"
    || !Number.isFinite(input.initialPrice) || input.initialPrice <= 0
    || !Number.isFinite(input.previousAth) || input.previousAth <= 0
    || input.floorReference !== null && (!Number.isFinite(input.floorReference) || input.floorReference <= 0 || input.floorReference >= input.initialPrice)
    || !Array.isArray(input.prices) || input.prices.length > 2000 || input.prices.some((price) => !Number.isFinite(price) || price <= 0)
    || input.lifetimeGains.length !== 25 || input.monthlyGains.length !== 25
    || input.lifetimeGains.some((gain) => !Number.isInteger(gain) || gain < 0)
    || input.monthlyGains.some((gain, index) => !Number.isInteger(gain) || gain < 0 || gain > input.lifetimeGains[index]!))
    throw new Error("COINOPS_ATH_SIMULATION_INPUT_INVALID");
}

const context = (asset: V1Asset, simulationId: string, index: number): StrategyContext => ({
  asset, cycleId: simulationId, observedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
});
const candidate = (slot: SimSlot): StrategyCandidate => ({ id: slot.physicalSlotId,
  slotNumber: slot.physicalSlotNumber, operationSequence: slot.operationSequence, buyPrice: slot.buyPrice,
  balanceUsdc: slot.balanceUsdc, operationalRank: slot.operationalRank,
  postAthGroup: slot.postAthGroup, entryOrigin: slot.entryOrigin,
  monthlyTargetReached: slot.monthlyTargetReached,
  state: slot.entryState === "OPEN" ? "OPEN" : slot.entryState === "ARMED" ? "ARMED" : "PLANNED" });

/** Pure replay. No service client, adapter, exchange credential or operational
 * table is reachable from this module. All identity lives in SIM- namespace. */
export function simulateAth(input: AthSimulationInput) {
  checkInput(input);
  const simulationId = athSimulationId(input);
  const tick = input.priceTick ?? (input.asset === "BTC" ? 0.01 : 0.01);
  if (!Number.isFinite(tick) || tick <= 0 || tick > 1) throw new Error("COINOPS_ATH_SIMULATION_TICK_INVALID");
  const filters: ExchangeSymbolInfo = { symbol: `${input.asset}USDC`, baseAsset: input.asset, quoteAsset: "USDC",
    priceTick: tick, quantityStep: 0.000001, minQuantity: 0.000001, maxQuantity: 1000000, minNotional: 0.01 };
  let state: AthState = { regime: "NORMAL", athPrice: input.previousAth, previousAth: null,
    athObservedAt: "2025-12-31T23:59:00.000Z", athSource: "SIMULATOR_BASELINE",
    floorReference: input.floorReference, floorSource: input.floorReference === null ? null : "SIMULATOR_INPUT",
    floorDefinedAt: input.floorReference === null ? null : "2025-12-31T23:59:00.000Z", transitionKey: null };
  let slots: SimSlot[] = Array.from({ length: 25 }, (_, index) => ({
    physicalSlotId: `${simulationId}:${input.asset}:${index + 1}`, physicalSlotNumber: index + 1,
    lifetimeGainCount: input.lifetimeGains[index]!, monthlyGainCount: input.monthlyGains[index]!,
    entryState: "PLANNED", eligible: input.monthlyGains[index]! < MONTHLY_SLOT_TARGET[input.asset],
    monthlyTargetReached: input.monthlyGains[index]! >= MONTHLY_SLOT_TARGET[input.asset], postAthGroup: null,
    postAthGroupRank: null, operationalRank: index + 1, balanceUsdc: 10, entryPrice: null,
    takeProfit: null, buyPrice: input.initialPrice * (1 - input.parameters.normalSpacing) ** index,
    operationSequence: 1, committed: false, entryOrigin: "GRID", armedDecisionId: null,
  }));
  const steps: AthSimulationStep[] = [];
  let armed: number | null = null, cycleNumber = 1, missedLevels = 0;
  const strategyContext = (index: number) => context(input.asset, `${simulationId}:CYCLE:${cycleNumber}`, index);
  let primaryExhausted = false, reserveActivated = false;
  const emit = (index: number, price: number, event: string, slot: SimSlot | null = null,
    decisionId: string | null = null, targetPrice: number | null = null, operationId: string | null = null) =>
    steps.push({ index, price, regime: state.regime, athPrice: state.athPrice, event,
      slot: slot?.physicalSlotNumber ?? null, group: slot?.postAthGroup ?? null,
      groupRank: slot?.postAthGroupRank ?? null, decisionId, operationId, targetPrice,
      balanceUsdc: slot?.balanceUsdc ?? null, lifetimeGains: slot?.lifetimeGainCount ?? null,
      monthlyGains: slot?.monthlyGainCount ?? null, nextBuy: armed,
      openCount: slots.filter((item) => item.entryState === "OPEN").length });
  const assignPrices = (anchor: number) => {
    const plans = planAthLadder(input.asset, state.regime, anchor, input.parameters, tick,
      slots.map((slot) => ({ ...slot, status: slot.entryState === "OPEN" ? "TP_ACTIVE" : "PENDING" })));
    for (const plan of plans) {
      const slot = slots[plan.physicalSlotNumber - 1]!;
      // A simulated resident unfilled GRID follows the same cancel/reprice
      // contract as runtime transitions. OPEN and reentry prices stay frozen.
      if (!plan.frozenReason && armed === slot.physicalSlotNumber) {
        armed = null; slot.entryState = "PLANNED"; slot.armedDecisionId = null;
      }
      slot.buyPrice = plan.nextBuyPrice;
      slot.operationalRank = plan.operationalRank;
      slot.postAthGroup = plan.postAthGroup; slot.postAthGroupRank = plan.postAthGroupRank;
      slot.eligible = plan.operationalRank !== null;
    }
  };
  const chooseNext = (index: number, price: number) => {
    const pending = slots.filter((slot) => !slot.committed && slot.eligible && !slot.monthlyTargetReached
      && ["PLANNED", "ARMED"].includes(slot.entryState));
    const primaryAvailable = state.regime === "POST_ATH" && pending.some((slot) => slot.postAthGroup === "PRIMARY");
    if (state.regime === "POST_ATH" && !primaryAvailable && !primaryExhausted) {
      primaryExhausted = true; emit(index, price, "POST_ATH_PRIMARY_EXHAUSTED");
    }
    if (state.regime === "POST_ATH" && !primaryAvailable && !reserveActivated
      && pending.some((slot) => slot.postAthGroup === "RESERVE")) {
      reserveActivated = true; emit(index, price, "POST_ATH_RESERVE_ACTIVATED");
    }
    const resident = armed === null ? null : { candidateId: slots[armed - 1]!.physicalSlotId, executedQuantity: 0 };
    const result = state.regime === "POST_ATH"
      ? planStrategyPostAthNextEntry(strategyContext(index), pending.map(candidate), price, resident)
      : planStrategyNextEntry(strategyContext(index), pending.map(candidate), price, resident);
    missedLevels += result.missedCandidateIds.length;
    const next = result.nextCandidateId ? slots.find((slot) => slot.physicalSlotId === result.nextCandidateId) : null;
    if (next && armed !== next.physicalSlotNumber) {
      if (armed !== null) { slots[armed - 1]!.entryState = "PLANNED"; slots[armed - 1]!.armedDecisionId = null; }
      armed = next.physicalSlotNumber;
      next.entryState = "ARMED";
      next.armedDecisionId = result.decision.decision_id;
      emit(index, price, "NEXT_BUY_ARMED", next, result.decision.decision_id, next.buyPrice, result.decision.operation_id);
    }
    if (!next && armed !== null && !pending.some((slot) => slot.physicalSlotNumber === armed)) {
      slots[armed - 1]!.entryState = "PLANNED"; slots[armed - 1]!.armedDecisionId = null; armed = null;
    }
  };
  const open = (index: number, price: number, slot: SimSlot, initial: boolean) => {
    slot.entryState = "OPEN"; slot.committed = true; slot.entryPrice = price;
    slot.takeProfit = calculateStrategyTakeProfit(price, tick, { gainRate: input.parameters.gainRate, entrySpacing: input.parameters.normalSpacing });
    if (armed === slot.physicalSlotNumber) armed = null;
    const decision = initial ? planStrategyInitialEntry(strategyContext(index),
      { ...candidate(slot), state: "PLANNED", operationalRank: 1 }) : null;
    emit(index, price, initial ? "INITIAL_MARKET_FILLED" : "BUY_FILLED", slot,
      decision?.decision_id ?? slot.armedDecisionId, null, decision?.operation_id ?? null);
    slot.armedDecisionId = null;
    const tpDecision = planStrategyTakeProfit(strategyContext(index), candidate(slot), price,
      filters, { gainRate: input.parameters.gainRate, entrySpacing: input.parameters.normalSpacing });
    if (tpDecision.action_type !== "CREATE_TP" || tpDecision.target_price !== slot.takeProfit)
      throw new Error("COINOPS_ATH_SIMULATION_TP_DECISION_INVALID");
    emit(index, price, "TP_RESIDENT", slot, tpDecision.decision_id, slot.takeProfit, tpDecision.operation_id);
  };
  assignPrices(input.initialPrice);
  emit(-1, input.initialPrice, "ATH_SIMULATION_STARTED");
  for (let index = 0; index < input.prices.length; index++) {
    const price = input.prices[index]!;
    const observedAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    const transition = advanceAthState(state, { price, observedAt, source: "SIMULATOR_CANDLE", fresh: true });
    state = transition.state;
    for (const event of transition.events) emit(index, price, event);
    if (transition.events.includes("POST_ATH_REGIME_ENTERED")) {
      const grouped = buildPostAthQueue(input.asset, slots as AthSlot[]);
      slots = slots.map((slot, position) => ({ ...slot, ...grouped[position] }));
      primaryExhausted = false; reserveActivated = false;
      emit(index, price, "POST_ATH_PRIMARY_GROUP_BUILT");
      emit(index, price, "POST_ATH_RESERVE_GROUP_BUILT");
      assignPrices(price);
    }
    if (transition.events.includes("NEW_ATH_CONFIRMED") && !transition.events.includes("POST_ATH_REGIME_ENTERED")) assignPrices(price);
    if (transition.events.includes("NORMAL_REGIME_RESTORED")) assignPrices(price);
    const hadOpenBefore = slots.some((slot) => slot.entryState === "OPEN");
    for (const slot of slots.filter((item) => item.entryState === "OPEN" && item.takeProfit !== null && price >= item.takeProfit)) {
      const profit = slot.balanceUsdc * (slot.takeProfit! / slot.entryPrice! - 1);
      slot.balanceUsdc = Number((slot.balanceUsdc + profit).toFixed(8));
      slot.lifetimeGainCount++; slot.monthlyGainCount = (slot.monthlyGainCount ?? 0) + 1;
      slot.monthlyTargetReached = slot.monthlyGainCount >= MONTHLY_SLOT_TARGET[input.asset];
      slot.entryState = "PLANNED"; slot.takeProfit = null; slot.operationSequence++;
      slot.committed = slot.monthlyTargetReached;
      slot.entryOrigin = "REENTRY"; slot.buyPrice = slot.entryPrice!;
      slot.eligible = !slot.monthlyTargetReached;
      if (slot.eligible && slot.operationalRank === null) slot.operationalRank = 26 + slot.physicalSlotNumber;
      emit(index, price, "TP_FILLED_COMPOUNDED", slot);
      if (slot.monthlyTargetReached) emit(index, price, "MONTHLY_TARGET_HOLD", slot);
    }
    if (armed !== null) {
      const slot = slots[armed - 1]!;
      if (slot.entryState === "ARMED" && price <= slot.buyPrice) open(index, slot.buyPrice, slot, false);
    }
    if (!slots.some((slot) => slot.entryState === "OPEN")) {
      if (index > 0 && hadOpenBefore && slots.some((slot) => !slot.monthlyTargetReached)) {
        if (armed !== null) { slots[armed - 1]!.entryState = "PLANNED"; armed = null; }
        cycleNumber++; emit(index, price, "GLOBAL_RESET");
        slots = slots.map((slot) => ({ ...slot, operationSequence: 1, entryOrigin: "GRID" as const,
          armedDecisionId: null,
          committed: slot.monthlyTargetReached, entryState: "PLANNED" }));
        if (state.regime === "POST_ATH") {
          const grouped = buildPostAthQueue(input.asset, slots as AthSlot[]);
          slots = slots.map((slot, position) => ({ ...slot, ...grouped[position] }));
          primaryExhausted = false; reserveActivated = false;
        }
        assignPrices(price);
      }
      const next = state.regime === "POST_ATH" ? orderedPostAthSlots(slots).find((slot) => !slot.committed)
        : [...slots].filter((slot) => !slot.committed && !slot.monthlyTargetReached)
          .sort((a, b) => b.lifetimeGainCount - a.lifetimeGainCount || a.physicalSlotNumber - b.physicalSlotNumber)[0];
      if (next) {
        open(index, price, next, true);
      }
    }
    chooseNext(index, price);
  }
  emit(input.prices.length, input.prices.at(-1) ?? input.initialPrice, "ATH_SIMULATION_COMPLETED");
  return { simulationId, state, cycleNumber, missedLevels, configSnapshot: { ...input.parameters }, steps,
    primary: slots.filter((slot) => slot.postAthGroup === "PRIMARY").sort((a, b) => a.postAthGroupRank! - b.postAthGroupRank!).map((slot) => slot.physicalSlotNumber),
    reserve: slots.filter((slot) => slot.postAthGroup === "RESERVE").sort((a, b) => a.postAthGroupRank! - b.postAthGroupRank!).map((slot) => slot.physicalSlotNumber),
    slots: slots.map((slot) => ({ physicalSlotId: slot.physicalSlotId, physicalSlotNumber: slot.physicalSlotNumber,
      lifetimeGainCount: slot.lifetimeGainCount, monthlyGainCount: slot.monthlyGainCount, balanceUsdc: slot.balanceUsdc,
      entryState: slot.entryState, postAthGroup: slot.postAthGroup, postAthGroupRank: slot.postAthGroupRank,
      operationalRank: slot.operationalRank, committed: slot.committed })) };
}

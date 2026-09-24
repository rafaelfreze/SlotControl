import { createHash } from "node:crypto";

import { assertV1ShadowParameters, V1_SLOT_COUNT, type V1Asset, type V1ShadowParameters } from "./robot-v1.ts";
import type { ExchangeSymbolInfo } from "./types.ts";

/** The same decision contract is consumed by the Shadow and Testnet adapters.
 * Transport, exchange credentials and execution environment never enter it. */
export const STRATEGY_VERSION = "4.3.1" as const;

export type StrategyActionType = "OPEN_INITIAL_MARKET" | "CREATE_TP" | "PLAN_LOCAL_REENTRY" | "ARM_NEXT_BUY"
  | "CANCEL_REPLACE_NEXT_BUY" | "COMPLETE_CYCLE" | "REANCHOR" | "WAIT";
export type StrategyContext = { asset: V1Asset; cycleId: string; observedAt: string; transitionKey?: string; quoteAsset?: "USDC" | "BRL" };
export type StrategyCandidate = {
  id: string;
  slotNumber: number;
  operationSequence: number;
  buyPrice: number;
  balanceUsdc?: number;
  balanceQuote?: number;
  operationalRank?: number | null;
  monthlyTargetReached?: boolean;
  postAthGroup?: "PRIMARY" | "RESERVE" | null;
  entryOrigin?: "GRID" | "REENTRY";
  state: "PLANNED" | "ARMED" | "PARTIALLY_FILLED" | "OPEN" | "CLOSED" | "MISSED";
};
export type StrategyResidentBuy = { candidateId: string; executedQuantity: number };
export type StrategyDecision = {
  decision_id: string;
  strategy_version: typeof STRATEGY_VERSION;
  asset: V1Asset;
  cycle_id: string;
  slot_id: string | null;
  operation_id: string | null;
  action_type: StrategyActionType;
  target_price: number | null;
  target_notional: number | null;
  priority: number;
  reason: string;
  expected_next_state: string;
  created_at: string;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function assertContext(context: StrategyContext) {
  if (!["BTC", "SOL"].includes(context.asset) || !context.cycleId || !Number.isFinite(Date.parse(context.observedAt))) {
    throw new Error("COINOPS_STRATEGY_CONTEXT_INVALID");
  }
}

function assertCandidates(candidates: readonly StrategyCandidate[]) {
  const ids = new Set<string>();
  const physicalSlots = new Set<number>();
  for (const candidate of candidates) {
    if (!candidate.id || ids.has(candidate.id) || physicalSlots.has(candidate.slotNumber)
      || !Number.isInteger(candidate.slotNumber) || candidate.slotNumber < 1 || candidate.slotNumber > V1_SLOT_COUNT
      || !Number.isInteger(candidate.operationSequence) || candidate.operationSequence < 1
      || !Number.isFinite(candidate.buyPrice) || candidate.buyPrice <= 0
      || !Number.isFinite(candidate.balanceQuote ?? candidate.balanceUsdc)
      || (candidate.balanceQuote ?? candidate.balanceUsdc ?? 0) <= 0
      || (candidate.balanceQuote !== undefined && candidate.balanceUsdc !== undefined)
      || !["PLANNED", "ARMED", "PARTIALLY_FILLED", "OPEN", "CLOSED", "MISSED"].includes(candidate.state)) {
      throw new Error("COINOPS_STRATEGY_CANDIDATE_INVALID");
    }
    ids.add(candidate.id);
    physicalSlots.add(candidate.slotNumber);
  }
}

function candidateBalance(candidate: StrategyCandidate) { return candidate.balanceQuote ?? candidate.balanceUsdc!; }

export function strategyOperationId(context: StrategyContext, candidate: StrategyCandidate) {
  assertContext(context);
  assertCandidates([candidate]);
  return hash([STRATEGY_VERSION, context.asset, context.cycleId, candidate.slotNumber, candidate.operationSequence]);
}

/** A sampled interval can prove a fill only for orders already resident when
 * that interval began. Invalid/missing evidence never implies residency. */
export function wasStrategyOrderResidentAt(residentAt: string | null, intervalStartedAt: string) {
  const start = Date.parse(intervalStartedAt);
  const resident = residentAt === null ? NaN : Date.parse(residentAt);
  return Number.isFinite(start) && Number.isFinite(resident) && resident <= start;
}

export type StrategyRecoveryEvidence = {
  slot?: { operationSequence: number; state: string; entryState: string; buyPrice: number; executedQuantity: number;
    buyFilledAt: string | null; takeProfitPrice: number | null; sellOrderId: string | null };
  archivedOperation?: { operationSequence: number; entryPrice: number; takeProfitPrice: number; executedQuantity: number };
  cycleCompleted?: boolean;
  successorInitialFilled?: boolean;
};

/** Recovery proves an exact persisted postcondition; it never dispatches an
 * action, guesses an exchange acknowledgment, or changes physical-slot state. */
export function isStrategyDecisionProven(action: StrategyActionType, targetPrice: number | null, operationSequence: number | null,
  evidence: StrategyRecoveryEvidence) {
  const slot = evidence.slot?.operationSequence === operationSequence ? evidence.slot : undefined;
  const archived = evidence.archivedOperation?.operationSequence === operationSequence ? evidence.archivedOperation : undefined;
  const samePrice = (price: number | null | undefined) => price != null && targetPrice != null && Math.abs(price - targetPrice) < 1e-9;
  const filled = Boolean(slot && slot.executedQuantity > 0 && slot.buyFilledAt && Number.isFinite(Date.parse(slot.buyFilledAt)));
  if (action === "OPEN_INITIAL_MARKET") return operationSequence === 1 && (filled || Boolean(archived && archived.executedQuantity > 0));
  if (action === "CREATE_TP") return Boolean((slot && filled && slot.sellOrderId && ["TP_ACTIVE", "CLOSED"].includes(slot.state) && samePrice(slot.takeProfitPrice))
    || (archived && archived.executedQuantity > 0 && samePrice(archived.takeProfitPrice)));
  if (action === "PLAN_LOCAL_REENTRY") return Boolean((slot && samePrice(slot.buyPrice)
    && (["PENDING", "PLANNED"].includes(slot.state) || filled)) || (archived && samePrice(archived.entryPrice)));
  if (action === "ARM_NEXT_BUY" || action === "CANCEL_REPLACE_NEXT_BUY") return Boolean((slot && samePrice(slot.buyPrice)
    && (slot.entryState === "ARMED" || filled)) || (archived && samePrice(archived.entryPrice) && archived.executedQuantity > 0));
  if (action === "COMPLETE_CYCLE") return evidence.cycleCompleted === true;
  if (action === "REANCHOR") return evidence.cycleCompleted === true && evidence.successorInitialFilled === true;
  return false;
}

function decision(context: StrategyContext, candidate: StrategyCandidate | null, action: StrategyActionType,
  targetPrice: number | null, targetNotional: number | null, priority: number, reason: string, expectedNextState: string): StrategyDecision {
  assertContext(context);
  const body = {
    strategy_version: STRATEGY_VERSION,
    asset: context.asset,
    cycle_id: context.cycleId,
    slot_id: candidate?.id ?? null,
    operation_id: candidate ? strategyOperationId(context, candidate) : null,
    action_type: action,
    target_price: targetPrice,
    target_notional: targetNotional,
    priority,
    reason,
    expected_next_state: expectedNextState
  };
  // Retry time must not create a different operation. The observation time is
  // evidence, while identity comes from the immutable cycle/slot/sequence/action.
  return { decision_id: hash([body, context.transitionKey ?? null]), ...body, created_at: new Date(context.observedAt).toISOString() };
}

function wait(context: StrategyContext, candidate: StrategyCandidate | null, reason: string) {
  return decision(context, candidate, "WAIT", candidate?.buyPrice ?? null, candidate ? candidateBalance(candidate) : null, 0, reason, candidate?.state ?? "UNCHANGED");
}

/** MARKET is allowed only for the highest-ranked eligible first operation in
 * a newly anchored cycle. Recycled slots always return to the LIMIT queue. */
export function planStrategyInitialEntry(context: StrategyContext, slot: StrategyCandidate): StrategyDecision {
  assertCandidates([slot]);
  if (slot.operationSequence !== 1 || slot.monthlyTargetReached
    || (slot.operationalRank === undefined ? slot.slotNumber !== 1 : slot.operationalRank !== 1))
    throw new Error("COINOPS_STRATEGY_INITIAL_SLOT_INVALID");
  if (slot.state !== "PLANNED") return wait(context, slot, "INITIAL_ENTRY_ALREADY_STARTED");
  return decision(context, slot, "OPEN_INITIAL_MARKET", slot.buyPrice, candidateBalance(slot), 100, "FIRST_ENTRY_OF_NEW_CYCLE", "OPEN");
}

export function planStrategyTakeProfit(context: StrategyContext, slot: StrategyCandidate, averageFillPrice: number,
  filters: ExchangeSymbolInfo, parameters: V1ShadowParameters, residentTakeProfit = false): StrategyDecision {
  assertCandidates([slot]);
  if (filters.symbol !== `${context.asset}${context.quoteAsset ?? "USDC"}`) throw new Error("COINOPS_STRATEGY_SYMBOL_MISMATCH");
  if (slot.state !== "OPEN") return wait(context, slot, "BUY_FILL_NOT_COMPLETE");
  if (residentTakeProfit) return wait(context, slot, "TAKE_PROFIT_ALREADY_RESIDENT");
  const target = calculateStrategyTakeProfit(averageFillPrice, filters.priceTick, parameters);
  return decision(context, slot, "CREATE_TP", target, candidateBalance(slot), 90, "PROTECT_CONFIRMED_BUY_FILL", "TP_ACTIVE");
}

/** A SELL target rounds up so exchange precision never lowers the frozen gain.
 * Near-integer normalization only neutralizes IEEE-754 representation noise. */
export function calculateStrategyTakeProfit(averageFillPrice: number, priceTick: number, parameters: V1ShadowParameters) {
  const { gainRate } = assertV1ShadowParameters(parameters);
  if (!Number.isFinite(averageFillPrice) || averageFillPrice <= 0 || !Number.isFinite(priceTick) || priceTick <= 0) {
    throw new Error("COINOPS_STRATEGY_FILL_INVALID");
  }
  const rawSteps = averageFillPrice * (1 + gainRate) / priceTick;
  const nearest = Math.round(rawSteps);
  const steps = Math.abs(rawSteps - nearest) < 1e-7 ? nearest : Math.ceil(rawSteps);
  return Number((steps * priceTick).toPrecision(15));
}

/** Choose one resident LIMIT BUY for the complete physical-slot queue.
 * observedFloor is the lowest price observed while these candidates were not
 * resident (or the current price for an instantaneous snapshot). A crossed
 * PLANNED level is missed evidence, never a retroactive or MARKET fill. */
export function planStrategyNextEntry(context: StrategyContext, candidates: readonly StrategyCandidate[], observedFloor: number,
  residentBuy?: StrategyResidentBuy | null): { decision: StrategyDecision; missedCandidateIds: string[]; nextCandidateId: string | null } {
  assertContext(context);
  assertCandidates(candidates);
  if (!Number.isFinite(observedFloor) || observedFloor <= 0) throw new Error("COINOPS_STRATEGY_MARKET_INVALID");
  const armed = candidates.filter((candidate) => candidate.state === "ARMED" || candidate.state === "PARTIALLY_FILLED");
  if (armed.length > 1) throw new Error("COINOPS_STRATEGY_MULTIPLE_ARMED_BUYS");
  const current = residentBuy ? candidates.find((candidate) => candidate.id === residentBuy.candidateId) : armed[0];
  if (residentBuy && (!current || !["ARMED", "PARTIALLY_FILLED"].includes(current.state)
    || !Number.isFinite(residentBuy.executedQuantity) || residentBuy.executedQuantity < 0
    || (armed[0] && armed[0].id !== current.id))) throw new Error("COINOPS_STRATEGY_RESIDENT_BUY_INVALID");
  const ranked = [...candidates].filter((candidate) => !candidate.monthlyTargetReached
    && candidate.operationalRank !== null && (candidate.state === "PLANNED" || candidate.state === "ARMED"))
    .sort((left, right) => right.buyPrice - left.buyPrice
      || (left.operationalRank ?? left.slotNumber) - (right.operationalRank ?? right.slotNumber) || left.slotNumber - right.slotNumber);
  const missedCandidateIds = ranked.filter((candidate) => candidate.state === "PLANNED" && candidate.buyPrice >= observedFloor).map((candidate) => candidate.id);
  if (current && (current.state === "PARTIALLY_FILLED" || (residentBuy?.executedQuantity ?? 0) > 0)) {
    return { decision: wait(context, current, "RESIDENT_BUY_PARTIAL_FILL_PROTECTED"), missedCandidateIds, nextCandidateId: current.id };
  }
  if (current && current.buyPrice >= observedFloor) {
    return { decision: wait(context, current, "RESIDENT_BUY_REQUIRES_RECONCILIATION"), missedCandidateIds, nextCandidateId: current.id };
  }
  const next = ranked.find((candidate) => candidate.buyPrice < observedFloor);
  if (!next) return { decision: wait(context, null, "NO_UNCROSSED_ENTRY_CANDIDATE"), missedCandidateIds, nextCandidateId: null };
  if (current?.id === next.id) return { decision: wait(context, current, "HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT"), missedCandidateIds, nextCandidateId: current.id };
  return {
    decision: decision(context, next, current ? "CANCEL_REPLACE_NEXT_BUY" : "ARM_NEXT_BUY", next.buyPrice, candidateBalance(next), 50,
      current ? "HIGHER_VALID_ENTRY_HAS_PRIORITY" : "HIGHEST_VALID_ENTRY_BELOW_MARKET", "ARMED"),
    missedCandidateIds,
    nextCandidateId: next.id
  };
}

/** The primary gate applies only to new grid entries. A local reentry and an
 * already-resident BUY retain price/fill priority even if classified RESERVE. */
export function planStrategyPostAthNextEntry(context: StrategyContext,
  candidates: readonly StrategyCandidate[], observedFloor: number, residentBuy?: StrategyResidentBuy | null) {
  assertCandidates(candidates);
  const primaryAvailable = candidates.some((candidate) => candidate.postAthGroup === "PRIMARY"
    && !candidate.monthlyTargetReached && candidate.operationalRank !== null
    && ["PLANNED", "ARMED", "PARTIALLY_FILLED"].includes(candidate.state));
  const allowed = primaryAvailable ? candidates.filter((candidate) => candidate.postAthGroup === "PRIMARY"
    || candidate.entryOrigin === "REENTRY" || candidate.id === residentBuy?.candidateId
    || candidate.state === "ARMED" || candidate.state === "PARTIALLY_FILLED") : candidates;
  return planStrategyNextEntry(context, allowed, observedFloor, residentBuy);
}

/** Adapter must persist the realised P&L/compounded balance first, and pass the
 * resulting CLOSED physical slot. The decision never mutates that history. */
export function planStrategyClosedSlot(context: StrategyContext, candidates: readonly StrategyCandidate[], closedCandidateId: string): {
  mode: "LOCAL_REENTRY" | "GLOBAL_RESET" | "MONTHLY_HOLD"; otherOpenPositions: number; decisions: StrategyDecision[];
} {
  assertContext(context);
  assertCandidates(candidates);
  if (candidates.length !== V1_SLOT_COUNT) throw new Error("COINOPS_STRATEGY_SLOT_COUNT_INVALID");
  const closed = candidates.find((candidate) => candidate.id === closedCandidateId);
  if (!closed || closed.state !== "CLOSED") throw new Error("COINOPS_STRATEGY_CLOSED_SLOT_INVALID");
  const otherOpenPositions = candidates.filter((candidate) => candidate.state === "OPEN" || candidate.state === "PARTIALLY_FILLED").length;
  if (otherOpenPositions) {
    if (closed.monthlyTargetReached || closed.operationalRank === null) return {
      mode: "MONTHLY_HOLD", otherOpenPositions, decisions: [wait(context, closed,
        closed.monthlyTargetReached ? "MONTHLY_TARGET_REACHED" : "GAIN_EVIDENCE_INCOMPLETE")]
    };
    const recycled = { ...closed, operationSequence: closed.operationSequence + 1 };
    return { mode: "LOCAL_REENTRY", otherOpenPositions, decisions: [
      decision(context, recycled, "PLAN_LOCAL_REENTRY", closed.buyPrice, candidateBalance(closed), 60, "OTHER_POSITION_REMAINS_OPEN", "PLANNED")
    ] };
  }
  if (!candidates.some((candidate) => !candidate.monthlyTargetReached && candidate.operationalRank !== null)) {
    return { mode: "MONTHLY_HOLD", otherOpenPositions: 0, decisions: [wait(context, closed,
      candidates.every((candidate) => candidate.monthlyTargetReached) ? "ALL_MONTHLY_TARGETS_REACHED" : "GAIN_EVIDENCE_INCOMPLETE")] };
  }
  return { mode: "GLOBAL_RESET", otherOpenPositions: 0, decisions: [
    decision(context, closed, "COMPLETE_CYCLE", null, null, 80, "LAST_OPEN_POSITION_CLOSED", "COMPLETED"),
    decision(context, null, "REANCHOR", null, Number([...candidates].sort((left, right) => left.slotNumber - right.slotNumber)
      .reduce((total, candidate) => total + candidateBalance(candidate), 0).toFixed(12)), 70,
      "REBUILD_AFTER_OWNED_PENDING_BUY_CANCELLATION", "READY_FOR_INITIAL_MARKET")
  ] };
}

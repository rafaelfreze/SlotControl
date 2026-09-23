import { createHash } from "node:crypto";

import { MONTHLY_SLOT_TARGET } from "./monthly-slot-policy.ts";
import type { V1Asset } from "./robot-v1.ts";
import type { HistoricalAth } from "./ath-market-source.ts";

export type AthEnvironment = "SHADOW" | "TESTNET" | "REAL";
export type AthRegime = "NORMAL" | "POST_ATH";
export type PostAthGroup = "PRIMARY" | "RESERVE";

export type AthParameters = {
  gainRate: number;
  normalSpacing: number;
  postAthSpacing: number;
};

/** Defaults are proposals for a new profile, never an implicit rewrite of an
 * existing Shadow/Testnet quick profile or of an already open position. */
export const OFFICIAL_ATH_DEFAULTS: Readonly<Record<V1Asset, AthParameters>> = {
  BTC: { gainRate: 0.012, normalSpacing: 0.02, postAthSpacing: 0.05 },
  SOL: { gainRate: 0.055, normalSpacing: 0.03, postAthSpacing: 0.08 },
};

export function validateAthParameters(value: AthParameters): AthParameters {
  if ([value.gainRate, value.normalSpacing, value.postAthSpacing].some((rate) =>
    !Number.isFinite(rate) || rate < 0.001 || rate > 0.2)) throw new Error("COINOPS_ATH_PARAMETERS_INVALID");
  return value;
}

export function parseAthPercent(raw: string): number {
  const normalized = raw.trim().replace(",", ".");
  if (!/^(?:\d{1,2})(?:\.\d{1,4})?$/.test(normalized)) throw new Error("COINOPS_ATH_PERCENT_INVALID");
  const rate = Number(normalized) / 100;
  if (!Number.isFinite(rate) || rate < 0.001 || rate > 0.2) throw new Error("COINOPS_ATH_PERCENT_INVALID");
  return rate;
}

export type AthState = {
  regime: AthRegime;
  athPrice: number | null;
  previousAth: number | null;
  athObservedAt: string | null;
  athSource: string | null;
  floorReference: number | null;
  floorSource: string | null;
  floorDefinedAt: string | null;
  transitionKey: string | null;
  /** Persisted transition watermark; a floor may be newer than the last ATH. */
  lastTransitionAt?: string | null;
};

export type AthObservation = { price: number; observedAt: string; source: string; fresh: boolean };
export type AthTransition = { state: AthState; events: Array<"NEW_ATH_CONFIRMED" | "POST_ATH_REGIME_ENTERED" |
  "ATH_FLOOR_REACHED" | "NORMAL_REGIME_RESTORED"> };

/** A missing/stale all-time baseline cannot be replaced by a 24h high. A new
 * ATH is strictly above the persisted source-backed high; equality is replay. */
export function advanceAthState(state: AthState, observation: AthObservation): AthTransition {
  if (!Number.isFinite(observation.price) || observation.price <= 0 || !Number.isFinite(Date.parse(observation.observedAt))
    || !observation.source) throw new Error("COINOPS_ATH_OBSERVATION_INVALID");
  if (!observation.fresh) return { state, events: [] };
  if (state.athObservedAt && Date.parse(observation.observedAt) <= Date.parse(state.athObservedAt))
    return { state, events: [] };
  if (state.lastTransitionAt && Date.parse(observation.observedAt) <= Date.parse(state.lastTransitionAt))
    return { state, events: [] };
  if (state.athPrice === null) return { state, events: [] };
  if (observation.price > state.athPrice) {
    const events: AthTransition["events"] = ["NEW_ATH_CONFIRMED"];
    if (state.regime === "NORMAL") events.push("POST_ATH_REGIME_ENTERED");
    return { state: { ...state, regime: "POST_ATH", previousAth: state.athPrice, athPrice: observation.price,
      athObservedAt: observation.observedAt, athSource: observation.source,
      lastTransitionAt: observation.observedAt,
      transitionKey: `${observation.source}:${observation.observedAt}:${observation.price}` }, events };
  }
  if (state.regime === "POST_ATH" && state.floorReference !== null && state.floorReference > 0
    && state.floorReference < state.athPrice && state.floorSource && state.floorDefinedAt
    && observation.price <= state.floorReference) {
    return { state: { ...state, regime: "NORMAL", lastTransitionAt: observation.observedAt,
      transitionKey: `${observation.source}:${observation.observedAt}:FLOOR` },
      events: ["ATH_FLOOR_REACHED", "NORMAL_REGIME_RESTORED"] };
  }
  return { state, events: [] };
}

/** The first complete historical scan establishes a baseline, not a fabricated
 * new-ATH event. Later complete scans can recover a high missed during downtime. */
export function reconcileHistoricalAth(state: AthState, historical: HistoricalAth): AthTransition {
  if (!historical.fresh || !Number.isFinite(historical.price) || historical.price <= 0
    || !Number.isFinite(Date.parse(historical.observedAt)) || !historical.source
    || !historical.source.includes("CONFIRMED_1D_FULL_HISTORY")) return { state, events: [] };
  if (state.athPrice === null) return { state: { ...state, athPrice: historical.price,
    athObservedAt: historical.observedAt, athSource: historical.source }, events: [] };
  if (historical.price <= state.athPrice) return { state, events: [] };
  // A complete late scan can correct the historical high without replaying an
  // old regime transition over a more recent, already observed floor.
  if (state.lastTransitionAt && Date.parse(historical.observedAt) <= Date.parse(state.lastTransitionAt)) {
    return { state: { ...state, previousAth: state.athPrice, athPrice: historical.price,
      athObservedAt: historical.observedAt, athSource: historical.source }, events: [] };
  }
  return advanceAthState(state, { price: historical.price, observedAt: historical.observedAt,
    source: historical.source, fresh: true });
}

export type AthSlot = {
  physicalSlotId: string;
  physicalSlotNumber: number;
  lifetimeGainCount: number;
  monthlyGainCount: number | null;
  entryState: string;
  blocked?: boolean;
};

export type PostAthSlot = AthSlot & {
  eligible: boolean;
  monthlyTargetReached: boolean;
  postAthGroup: PostAthGroup | null;
  postAthGroupRank: number | null;
  operationalRank: number | null;
};

export function buildPostAthQueue(asset: V1Asset, slots: readonly AthSlot[]): PostAthSlot[] {
  if (slots.length !== 25) throw new Error("COINOPS_ATH_SLOT_COUNT_INVALID");
  const ids = new Set<string>(), numbers = new Set<number>();
  for (const slot of slots) {
    if (!slot.physicalSlotId || ids.has(slot.physicalSlotId) || numbers.has(slot.physicalSlotNumber)
      || !Number.isInteger(slot.physicalSlotNumber) || slot.physicalSlotNumber < 1 || slot.physicalSlotNumber > 25
      || !Number.isInteger(slot.lifetimeGainCount) || slot.lifetimeGainCount < 0
      || slot.monthlyGainCount !== null && (!Number.isInteger(slot.monthlyGainCount) || slot.monthlyGainCount < 0
        || slot.monthlyGainCount > slot.lifetimeGainCount)) throw new Error("COINOPS_ATH_SLOT_EVIDENCE_INVALID");
    ids.add(slot.physicalSlotId); numbers.add(slot.physicalSlotNumber);
  }
  const eligibleStates = new Set(["PLANNED", "PENDING", "ARMED", "CLOSED", "NONE"]);
  const eligible = slots.filter((slot) => !slot.blocked && slot.monthlyGainCount !== null
    && slot.monthlyGainCount < MONTHLY_SLOT_TARGET[asset] && eligibleStates.has(slot.entryState));
  const byPhysicalId = (left: AthSlot, right: AthSlot) => left.physicalSlotId.localeCompare(right.physicalSlotId);
  const byHighestGain = (left: AthSlot, right: AthSlot) => right.lifetimeGainCount - left.lifetimeGainCount
    || byPhysicalId(left, right);
  const selected = [...eligible].sort(byHighestGain).slice(0, 15);
  const selectedIds = new Set(selected.map((slot) => slot.physicalSlotId));
  const primary = selected.sort((left, right) => left.lifetimeGainCount - right.lifetimeGainCount
    || byPhysicalId(left, right));
  const reserve = eligible.filter((slot) => !selectedIds.has(slot.physicalSlotId)).sort(byHighestGain);
  const position = new Map<string, { group: PostAthGroup; groupRank: number; rank: number }>();
  primary.forEach((slot, index) => position.set(slot.physicalSlotId, { group: "PRIMARY", groupRank: index + 1, rank: index + 1 }));
  reserve.forEach((slot, index) => position.set(slot.physicalSlotId, { group: "RESERVE", groupRank: index + 1, rank: primary.length + index + 1 }));
  return slots.map((slot) => {
    const rank = position.get(slot.physicalSlotId);
    return { ...slot, eligible: Boolean(rank), monthlyTargetReached: slot.monthlyGainCount !== null
      && slot.monthlyGainCount >= MONTHLY_SLOT_TARGET[asset], postAthGroup: rank?.group ?? null,
      postAthGroupRank: rank?.groupRank ?? null, operationalRank: rank?.rank ?? null };
  });
}

export function orderedPostAthSlots<T extends PostAthSlot>(slots: readonly T[]): T[] {
  return [...slots].filter((slot) => slot.eligible).sort((left, right) =>
    left.operationalRank! - right.operationalRank!);
}

export function athSimulationId(input: unknown) {
  return `SIM-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 20)}`;
}

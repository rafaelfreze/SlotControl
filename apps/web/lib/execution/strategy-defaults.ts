import { MONTHLY_SLOT_TARGET } from "./monthly-slot-policy.ts";
import type { V1Asset } from "./robot-v1.ts";

export type StrategyParameterDefaults = {
  gainRate: number;
  normalSpacing: number;
  postAthSpacing: number;
};

/** Proposals for a new profile only. Existing profiles and OPEN/TP snapshots
 * remain authoritative; these defaults never rewrite an individual strategy. */
export const NEW_ENGINE_STRATEGY_DEFAULTS: Readonly<Record<V1Asset, StrategyParameterDefaults>> = {
  BTC: { gainRate: 0.012, normalSpacing: 0.02, postAthSpacing: 0.02 },
  SOL: { gainRate: 0.055, normalSpacing: 0.03, postAthSpacing: 0.03 },
};

/** Browser-safe form defaults shared by new-account and additional-engine UI.
 * Return a fresh object so editing one proposal cannot affect another engine. */
export function newEngineStrategyPercentDefaults(asset: V1Asset) {
  const defaults = NEW_ENGINE_STRATEGY_DEFAULTS[asset];
  return {
    gainPercent: String(defaults.gainRate * 100),
    spacingPercent: String(defaults.normalSpacing * 100),
    postAthPercent: String(defaults.postAthSpacing * 100),
    monthlyTarget: String(MONTHLY_SLOT_TARGET[asset]),
  };
}

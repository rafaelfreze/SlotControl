import {
  OFFICIAL_TARGETS,
  getEntrySpacing,
  rankDefensiveCandidates,
  rankNormalCandidates,
  type OfficialAsset,
  type OfficialStrategyMode,
  type QueueSlot
} from "../coinops-monitoring/domain.ts";

export type OfficialTriggerSlot = QueueSlot & {
  asset: OfficialAsset;
  status: "zerado" | "aberto" | "gain" | "hold";
  allowReserve: boolean;
};

export type OfficialFutureEntryPlan = {
  dropPercent: number;
  candidateIds: string[];
};

export function buildOfficialFutureEntryPlan(
  asset: OfficialAsset,
  mode: OfficialStrategyMode,
  cycleNumber: number,
  slots: OfficialTriggerSlot[]
): OfficialFutureEntryPlan {
  const assetSlots = slots.filter((slot) => slot.asset === asset);
  const pending = assetSlots.filter((slot) => slot.status === "hold");
  const main = pending.filter((slot) => slot.pool === "MAIN");
  const reserve = pending.filter((slot) => slot.pool === "RESERVE" && slot.allowReserve);

  let ranked: QueueSlot[];
  if (mode === "NORMAL_GROWTH") {
    const mainBelowTarget = rankNormalCandidates(
      assetSlots.filter((slot) => slot.pool === "MAIN"),
      OFFICIAL_TARGETS[asset],
      cycleNumber
    );
    const freeMainBelowTarget = rankNormalCandidates(main, OFFICIAL_TARGETS[asset], cycleNumber);

    ranked = mainBelowTarget.length === 0
      ? []
      : freeMainBelowTarget.length > 0
        ? freeMainBelowTarget
        : rankNormalCandidates(reserve, OFFICIAL_TARGETS[asset], cycleNumber, true);
  } else {
    const rankedMain = rankDefensiveCandidates(main, cycleNumber);
    ranked = rankedMain.length > 0
      ? rankedMain
      : rankDefensiveCandidates(reserve, cycleNumber, true);
  }

  return {
    dropPercent: getEntrySpacing(asset, mode),
    candidateIds: ranked.map((slot) => slot.id)
  };
}

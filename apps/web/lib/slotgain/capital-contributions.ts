export type CapitalContributionView = {
  asset: string;
  slot_id: string;
  amount_usdt: number | string;
  gain_equivalent: number | string;
};

export type CapitalContributionSummary = {
  amountUsdt: number;
  gains: number;
};

export type SlotCapitalFlowView = {
  growth_contribution: number | string;
  redistribution_received_usdt: number | string;
  redistribution_sent_usdt: number | string;
};

export type SlotCapitalFlowSummary = {
  externalContributionUsdt: number;
  redistributionNetUsdt: number;
  additionalCapitalNetUsdt: number;
};

function safeNumber(value: number | string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function summarizeCapitalContributions(
  contributions: CapitalContributionView[],
  filters: { asset?: string; slotId?: string } = {}
): CapitalContributionSummary {
  const asset = filters.asset?.toUpperCase();

  return contributions.reduce<CapitalContributionSummary>((summary, contribution) => {
    if (asset && contribution.asset.toUpperCase() !== asset) return summary;
    if (filters.slotId && contribution.slot_id !== filters.slotId) return summary;

    summary.amountUsdt += safeNumber(contribution.amount_usdt);
    summary.gains += safeNumber(contribution.gain_equivalent);
    return summary;
  }, { amountUsdt: 0, gains: 0 });
}

export function indexCapitalContributionsBySlot(contributions: CapitalContributionView[]) {
  return contributions.reduce<Record<string, CapitalContributionSummary>>((index, contribution) => {
    const current = index[contribution.slot_id] || { amountUsdt: 0, gains: 0 };
    index[contribution.slot_id] = {
      amountUsdt: current.amountUsdt + safeNumber(contribution.amount_usdt),
      gains: current.gains + safeNumber(contribution.gain_equivalent)
    };
    return index;
  }, {});
}

export function summarizeSlotCapitalFlow(slot: SlotCapitalFlowView): SlotCapitalFlowSummary {
  const externalContributionUsdt = safeNumber(slot.growth_contribution);
  const redistributionNetUsdt = safeNumber(slot.redistribution_received_usdt)
    - safeNumber(slot.redistribution_sent_usdt);

  return {
    externalContributionUsdt,
    redistributionNetUsdt,
    additionalCapitalNetUsdt: externalContributionUsdt + redistributionNetUsdt
  };
}

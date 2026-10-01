import { orderOperationalSlots } from "../slotgain/operational-slot-order.ts";

export type SelectiveContributionPreset = {
  id: string;
  name: string;
  totalSlots: number;
  openSlots: number;
  followingSlots: number;
};

export type PresetStrategySlot = {
  slotNumber: number;
  operationalRank: number | null;
  entryState: string;
};

export type PresetRegion = {
  anchorSlotNumber: number;
  anchorOperationalRank: number;
  slotNumbers: number[];
  openAnchorSlotNumbers: number[];
};

function validatePreset(preset: SelectiveContributionPreset) {
  if (!preset.id || preset.name.trim().length < 3
    || !Number.isInteger(preset.totalSlots) || preset.totalSlots < 1 || preset.totalSlots > 25
    || !Number.isInteger(preset.openSlots) || preset.openSlots < 1
    || !Number.isInteger(preset.followingSlots) || preset.followingSlots < 0
    || preset.openSlots + preset.followingSlots !== preset.totalSlots)
    throw new Error("COINOPS_PRESET_CONFIGURATION_INVALID");
}

function officialOrder(slots: PresetStrategySlot[]) {
  if (slots.length !== 25 || new Set(slots.map((slot) => slot.slotNumber)).size !== 25
    || slots.some((slot) => !Number.isInteger(slot.slotNumber) || slot.slotNumber < 1 || slot.slotNumber > 25
      || !Number.isInteger(slot.operationalRank) || Number(slot.operationalRank) < 1))
    throw new Error("COINOPS_PRESET_STRATEGY_ORDER_UNAVAILABLE");
  return orderOperationalSlots(slots, (slot) => ({ ...slot, physicalSlotNumber: slot.slotNumber }));
}

/** Resolves each anchor in the same state + engine-rank order as the UI.
 * Slot numbers are identities/tie-breakers only; they never define "following". */
export function resolveSelectiveContributionPresetRegions(preset: SelectiveContributionPreset,
  slots: PresetStrategySlot[]): PresetRegion[] {
  validatePreset(preset);
  const ordered = officialOrder(slots);
  const regions: PresetRegion[] = [];
  for (let start = 0; start <= ordered.length - preset.totalSlots; start += 1) {
    const window = ordered.slice(start, start + preset.totalSlots);
    const openAnchor = window.slice(0, preset.openSlots);
    if (openAnchor.length !== preset.openSlots
      || openAnchor.some((slot) => slot.entryState !== "OPEN")) continue;
    regions.push({
      anchorSlotNumber: window[0].slotNumber,
      anchorOperationalRank: Number(window[0].operationalRank),
      slotNumbers: window.map((slot) => slot.slotNumber),
      openAnchorSlotNumbers: openAnchor.map((slot) => slot.slotNumber),
    });
  }
  return regions;
}

export function resolveSelectiveContributionPresetRegion(preset: SelectiveContributionPreset,
  slots: PresetStrategySlot[], anchorSlotNumber: number): PresetRegion {
  const region = resolveSelectiveContributionPresetRegions(preset, slots)
    .find((candidate) => candidate.anchorSlotNumber === anchorSlotNumber);
  if (!region) throw new Error("COINOPS_PRESET_REGION_UNAVAILABLE");
  return region;
}

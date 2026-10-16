import { orderOperationalSlots } from "../slotgain/operational-slot-order.ts";
import { DEFAULT_ENGINE_SLOT_COUNT, MAX_ENGINE_SLOT_COUNT, hasCompletePhysicalSlotSet, validateEngineSlotCount } from "./engine-slot-topology.ts";

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
    || !Number.isInteger(preset.totalSlots) || preset.totalSlots < 1 || preset.totalSlots > MAX_ENGINE_SLOT_COUNT
    || !Number.isInteger(preset.openSlots) || preset.openSlots < 1
    || !Number.isInteger(preset.followingSlots) || preset.followingSlots < 0
    || preset.openSlots + preset.followingSlots !== preset.totalSlots)
    throw new Error("COINOPS_PRESET_CONFIGURATION_INVALID");
}

function officialOrder(slots: PresetStrategySlot[], slotCount: number) {
  validateEngineSlotCount(slotCount);
  if (!hasCompletePhysicalSlotSet(slots.map((slot) => slot.slotNumber), slotCount)
    || slots.some((slot) => !Number.isInteger(slot.slotNumber) || slot.slotNumber < 1 || slot.slotNumber > slotCount
      || !Number.isInteger(slot.operationalRank) || Number(slot.operationalRank) < 1))
    throw new Error("COINOPS_PRESET_STRATEGY_ORDER_UNAVAILABLE");
  return orderOperationalSlots(slots, (slot) => ({ ...slot, physicalSlotNumber: slot.slotNumber }));
}

/** Resolves each anchor in the same state + engine-rank order as the UI.
 * Slot numbers are identities/tie-breakers only; they never define "following". */
export function resolveSelectiveContributionPresetRegions(preset: SelectiveContributionPreset,
  slots: PresetStrategySlot[], slotCount = DEFAULT_ENGINE_SLOT_COUNT): PresetRegion[] {
  validatePreset(preset);
  const ordered = officialOrder(slots, slotCount);
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
  slots: PresetStrategySlot[], anchorSlotNumber: number, slotCount = DEFAULT_ENGINE_SLOT_COUNT): PresetRegion {
  const region = resolveSelectiveContributionPresetRegions(preset, slots, slotCount)
    .find((candidate) => candidate.anchorSlotNumber === anchorSlotNumber);
  if (!region) throw new Error("COINOPS_PRESET_REGION_UNAVAILABLE");
  return region;
}

import assert from "node:assert/strict";
import test from "node:test";
import { orderOperationalSlots, ledgerSlotKey } from "./operational-slot-order.ts";
import { projectCurrentLiveSlotRanks } from "./live-slot-read-model.ts";
import { monthlyPeriodKey, nextMonthlyResetAt } from "../execution/monthly-slot-policy.ts";
import { resolveSelectiveContributionPresetRegion } from "../execution/selective-contribution-presets.ts";

const at = "2026-10-01T04:00:00.000Z";
const slots = () => Array.from({ length: 25 }, (_, i) => ({ id: `physical-${i + 1}`, slot_number: i + 1,
  entry_state: i === 1 ? "OPEN" : i === 0 ? "ARMED" : "PLANNED", operational_rank: i < 3 ? i + 1 : i - 2,
  post_ath_group: null as string | null, target_buy_price: 100 - i, tp_price: 120, position_quantity: i === 1 ? 1 : 0 }));
const accounts = () => slots().map((slot) => ({ slot_number: slot.slot_number, gain_count: 0, balance_quote: 10, pnl: 3 }));
const totals = () => slots().map((slot) => ({ slot_number: slot.slot_number,
  lifetime_gain_count: slot.slot_number === 2 ? 4 : slot.slot_number <= 3 ? 3 : 0, monthly_gain_count: 0 }));

for (const asset of ["BTC", "SOL"] as const) test(`${asset}: rollover, current engine rank, OPEN and NEXT first; financial snapshot immutable`, () => {
  const rows = slots(), before = structuredClone(rows), balances = accounts();
  const ranked = projectCurrentLiveSlotRanks(rows, balances, totals(), asset, asset === "BTC" ? 7 : 2, at);
  const ordered = orderOperationalSlots(ranked, ledgerSlotKey);
  assert.deepEqual(ordered.slice(0, 6).map((row) => row.slot_number), [2, 1, 3, 4, 5, 6]);
  assert.deepEqual(ranked.slice(0, 4).map((row) => row.operational_rank), [2, 1, 3, 4]);
  assert.deepEqual(rows, before);
  assert.deepEqual(ranked.map(({ grid_operational_rank: _grid, operational_rank: _rank, ...row }) => row),
    before.map(({ operational_rank: _rank, ...row }) => row));
  assert.deepEqual(balances, accounts());
  const region = resolveSelectiveContributionPresetRegion({ id: "preset", name: "1 OPEN + 4 seguintes",
    totalSlots: 5, openSlots: 1, followingSlots: 4 }, ranked.map((row) => ({ slotNumber: row.slot_number,
    operationalRank: row.operational_rank, entryState: row.entry_state })), 2);
  assert.deepEqual(region.slotNumbers, ordered.slice(0, 5).map((row) => row.slot_number));
});

test("duplicate ranks, input shuffle, eligible state, PLANNED and non-operational states are deterministic", () => {
  const rows = [
    { slot_number: 8, entry_state: "PLANNED", operational_rank: 1 },
    { slot_number: 6, entry_state: "MISSED", operational_rank: 1 },
    { slot_number: 9, entry_state: "CLOSED", operational_rank: 9 },
    { slot_number: 4, entry_state: "NEXT_BUY", operational_rank: null },
    { slot_number: 3, entry_state: "TP_ACTIVE", operational_rank: null },
    { slot_number: 7, entry_state: "PLANNED", operational_rank: 1 },
  ];
  assert.deepEqual(orderOperationalSlots(rows, ledgerSlotKey).map((row) => row.slot_number), [3, 4, 9, 7, 8, 6]);
  assert.deepEqual(orderOperationalSlots([...rows].reverse(), ledgerSlotKey), orderOperationalSlots(rows, ledgerSlotKey));
});

test("POST_ATH preserves engine group rank instead of replacing it with monthly gain rank", () => {
  const rows = slots().map((slot, i) => ({ ...slot, operational_rank: 25 - i, post_ath_group: i < 10 ? "PRIMARY" : "RESERVE" }));
  const ranked = projectCurrentLiveSlotRanks(rows, accounts(), totals(), "BTC", 7, at);
  assert.deepEqual(ranked.map((slot) => slot.operational_rank), rows.map((slot) => slot.operational_rank));
  const ordered = orderOperationalSlots(ranked, ledgerSlotKey);
  assert.deepEqual(ordered.slice(0, 3).map((slot) => slot.slot_number), [2, 1, 25]);
});

test("ineligible reentry and planned slots remain after eligible planned slots; OPEN/NEXT always retain priority", () => {
  const rows = [
    { slot_number: 1, entry_state: "CLOSED", operational_rank: null },
    { slot_number: 2, entry_state: "PLANNED", operational_rank: 1 },
    { slot_number: 3, entry_state: "PLANNED", operational_rank: null },
    { slot_number: 4, entry_state: "OPEN", operational_rank: null },
    { slot_number: 5, entry_state: "ARMED", operational_rank: null },
  ];
  assert.deepEqual(orderOperationalSlots(rows, ledgerSlotKey).map((row) => row.slot_number), [4, 5, 2, 1, 3]);
});

for (const asset of ["BTC", "SOL"] as const) test(`${asset}: all above target still eligible; new month is zero, lifetime preserved`, () => {
  const target = asset === "BTC" ? 7 : 2;
  const reached = totals().map((slot) => ({ ...slot, lifetime_gain_count: 20, monthly_gain_count: target }));
  const old = projectCurrentLiveSlotRanks(slots(), accounts(), reached, asset, target, "2026-10-01T03:59:59.999Z");
  assert.equal(old.filter((slot) => slot.operational_rank !== null).length, 25);
  const next = projectCurrentLiveSlotRanks(slots(), accounts(), reached.map((slot) => ({ ...slot, monthly_gain_count: 0 })), asset, target, at);
  assert.deepEqual(next.map((slot) => slot.id), old.map((slot) => slot.id));
  assert.deepEqual(next.map((slot) => slot.entry_state), old.map((slot) => slot.entry_state));
  assert.equal(reached[0].lifetime_gain_count, 20);
  const partial = reached.map((slot, i) => ({ ...slot, monthly_gain_count: i === 0 ? target : 0 }));
  assert.equal(projectCurrentLiveSlotRanks(slots(), accounts(), partial, asset, target, at)[0].operational_rank, null);
});

test("September/October and December/January calendar boundaries use Campo Grande, not UTC", () => {
  for (const [previous, current, boundary] of [["2026-09", "2026-10", at], ["2026-12", "2027-01", "2027-01-01T04:00:00.000Z"]]) {
    const before = new Date(Date.parse(boundary) - 1);
    assert.equal(monthlyPeriodKey(before), previous);
    assert.equal(monthlyPeriodKey(boundary), current);
    assert.equal(nextMonthlyResetAt(before), boundary);
  }
});

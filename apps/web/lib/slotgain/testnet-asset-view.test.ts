import assert from "node:assert/strict";
import test from "node:test";
import { selectTestnetAssetData } from "./testnet-asset-view.ts";

const source = {
  testnetRun: { id: "sol-run", symbol: "SOLUSDC" },
  testnetSlots: [{ id: "sol-slot" }], testnetOrders: [{ id: "sol-order" }], testnetEvents: [{ id: "sol-event" }], testnetEnabled: true
};
test("Testnet asset selection preserves matching legacy SOL rows", () => {
  const view = selectTestnetAssetData(source, "SOL");
  assert.equal(view.testnetRun, source.testnetRun);
  assert.equal(view.testnetSlots, source.testnetSlots);
  assert.equal(view.testnetEnabled, true);
});
test("Testnet BTC without a run never displays SOL data or offers the SOL executor", () => {
  assert.deepEqual(selectTestnetAssetData(source, "BTC"), { testnetRun: null, testnetSlots: [], testnetOrders: [], testnetEvents: [], testnetEnabled: false });
});
test("Testnet BTC and SOL bundles retain independent rows and execution support", () => {
  const bundle = { run: { id: "btc-run", symbol: "BTCUSDC" }, slots: [{ id: "btc-slot" }], orders: [{ id: "btc-order" }], events: [{ id: "btc-event" }] };
  const both = { ...source, testnetAssetData: { BTC: bundle, SOL: { run: { id: "sol-new", symbol: "SOLUSDC" }, slots: [], orders: [], events: [] } } };
  const btc = selectTestnetAssetData(both, "BTC");
  assert.equal(btc.testnetRun?.id, "btc-run");
  assert.deepEqual(btc.testnetOrders, [{ id: "btc-order" }]);
  assert.equal(btc.testnetEnabled, false);
  const sol = selectTestnetAssetData(both, "SOL");
  assert.equal(sol.testnetRun?.id, "sol-new");
  assert.deepEqual(sol.testnetSlots, []);
  assert.equal(selectTestnetAssetData({ ...source, testnetEnabled: false }, "SOL").testnetEnabled, false);
});
test("Mislabeled asset bundles cannot leak another asset into the view", () => {
  const bad = { ...source, testnetAssetData: { BTC: { run: source.testnetRun, slots: source.testnetSlots, orders: source.testnetOrders, events: source.testnetEvents } } };
  const btc = selectTestnetAssetData(bad, "BTC");
  assert.equal(btc.testnetRun, null);
  assert.deepEqual(btc.testnetSlots, []);
  assert.deepEqual(btc.testnetOrders, []);
  assert.deepEqual(btc.testnetEvents, []);
});

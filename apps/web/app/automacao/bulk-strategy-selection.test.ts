import assert from "node:assert/strict";
import test from "node:test";
import { selectBulkEngineIds } from "./bulk-strategy-selection.ts";

const accounts = Array.from({ length: 1000 }, (_, index) => ({ id: `a-${index}`,
  shardId: `shard-${index % 4}` }));
const engines = accounts.flatMap((account, index) => ["BTC", "SOL"].map((asset) => ({
  engineId: `${account.id}-${asset}`, accountId: account.id, asset,
  executorShardId: account.shardId,
  health: { healthy: index !== 37 }, killSwitch: index === 37,
})));

test("bulk scope scales from one account to 1000 across dynamic shards", () => {
  assert.deepEqual(selectBulkEngineIds(engines, accounts, { kind: "ACCOUNT", value: "a-7" }),
    ["a-7-BTC", "a-7-SOL"]);
  assert.equal(selectBulkEngineIds(engines, accounts, { kind: "ALL" }).length, 2000);
  assert.equal(selectBulkEngineIds(engines, accounts, { kind: "SHARD", value: "shard-2" }).length, 500);
  assert.equal(selectBulkEngineIds(engines, accounts, { kind: "OPERATIONAL" }).length, 1998);
});

test("bulk shard selection follows each engine, never the account bootstrap", () => {
  const sameAccount = [{ id: "shared-account", shardId: "executor-02" }];
  const independent = ["executor-02", "executor-03", null].map((executorShardId, index) => ({
    engineId: `engine-${index}`, accountId: "shared-account", asset: "SOL",
    executorShardId, health: { healthy: true }, killSwitch: false,
  }));
  assert.deepEqual(selectBulkEngineIds(independent, sameAccount, { kind: "SHARD", value: "executor-02" }),
    ["engine-0"]);
  assert.deepEqual(selectBulkEngineIds(independent, sameAccount, { kind: "SHARD", value: "executor-03" }),
    ["engine-1"]);
  assert.deepEqual(selectBulkEngineIds(independent, sameAccount, { kind: "ACCOUNT", value: "shared-account" }),
    ["engine-0", "engine-1", "engine-2"]);
});

test("bulk scope supports BTC, SOL and selected 10 accounts independently", () => {
  assert.equal(selectBulkEngineIds(engines, accounts, { kind: "ASSET", value: "BTC" }).length, 1000);
  assert.equal(selectBulkEngineIds(engines, accounts, { kind: "ASSET", value: "SOL" }).length, 1000);
  const ten = accounts.slice(0, 10).flatMap((account) => selectBulkEngineIds(engines, accounts,
    { kind: "ACCOUNT", value: account.id }));
  assert.equal(new Set(ten).size, 20);
});

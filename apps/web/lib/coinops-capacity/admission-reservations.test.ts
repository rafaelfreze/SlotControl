import assert from "node:assert/strict";
import test from "node:test";
import { shardReservedWeight } from "./admission-reservations.ts";

test("reservations never mix Binance environments or fixed-IP shards", () => {
  const reservations = [
    { shard_id: "executor-01", environment: "REAL", reserved_weight: 900 },
    { shard_id: "executor-01", environment: "TESTNET", reserved_weight: 1800 },
    { shard_id: "executor-02", environment: "REAL", reserved_weight: 2700 },
  ];
  assert.equal(shardReservedWeight("executor-01", "REAL", reservations), 900);
  assert.equal(shardReservedWeight("executor-01", "TESTNET", reservations), 1800);
  assert.equal(shardReservedWeight("executor-02", "REAL", reservations), 2700);
  assert.equal(shardReservedWeight("executor-03", "REAL", reservations), 0);
});

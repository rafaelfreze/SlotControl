import assert from "node:assert/strict";
import test from "node:test";
import { testnetFillEvents } from "./testnet-fill-evidence.ts";

const scope = { productId: "10000000-0000-4000-8000-000000000001", tenantId: "20000000-0000-4000-8000-000000000001", userId: "30000000-0000-4000-8000-000000000001" };
const client = "COV1-SOL-1-1-BUY-0123456789abcdef01";
const observedAt = "2026-09-23T01:00:00.000Z";
test("fills parciais conservam identidade, taxa, horário da exchange e idempotência", () => {
  const trades = [{ id: "1", quantity: .04, quoteQuantity: 4.8, commission: .0048, commissionAsset: "USDC", isBuyer: true, filledAt: "2026-09-23T00:59:10.000Z" }, { id: "2", quantity: .044, quoteQuantity: 5.28, commission: .00528, commissionAsset: "USDC", isBuyer: true, filledAt: "2026-09-23T00:59:11.000Z" }];
  const events = testnetFillEvents(scope, "run", 1, client, "9", trades, observedAt);
  assert.equal(events.length, 2); assert.equal(events[0]!.observed_at, trades[0]!.filledAt); assert.equal(events[0]!.details.price, 120); assert.equal(events[0]!.details.commission, .0048);
  assert.notEqual(events[0]!.event_key, events[1]!.event_key);
  assert.equal(testnetFillEvents(scope, "run", 1, client, "9", trades, observedAt)[0]!.event_key, events[0]!.event_key);
  assert.equal(events[0]!.tenant_id, scope.tenantId); assert.equal(events[0]!.event_type, "TESTNET_FILL_OBSERVED");
});
test("horário não fornecido não vira horário exato de fill e ordem manual é rejeitada", () => {
  const trades = [{ id: "1", quantity: .04, quoteQuantity: 4.8, commission: 0, commissionAsset: "USDC", isBuyer: true }];
  const [event] = testnetFillEvents(scope, "run", 1, client, "9", trades, observedAt);
  assert.equal(event!.details.filledAt, null); assert.equal(event!.details.timestampBasis, "COLLECTION_TIME_EXCHANGE_TIME_UNAVAILABLE");
  assert.throws(() => testnetFillEvents(scope, "run", 1, "manual-order", "9", trades, observedAt), /OWNERSHIP/);
});

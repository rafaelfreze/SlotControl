import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEngineOrder, durableIntent } from "./account-registry.mjs";
import { sha256, withDryRunIdempotency } from "./security.mjs";

/** Durable exchange-verified identity, never caller-supplied ownership. Old
 * create receipts remain valid without rewriting order IDs or financial claims. */
export function durableOrderOwnership(stateDirectory, engine) {
  const owner = { operator_id: engine.operator_id, exchange_account_id: engine.exchange_account_id,
    trading_engine_id: engine.trading_engine_id, environment: engine.environment };
  const identityKey = (id) => `OWNER:${sha256(JSON.stringify({ ...owner, clientOrderId: id }))}`;
  const read = async (directory, key) => {
    try { return JSON.parse(await readFile(join(stateDirectory, directory, `${sha256(key)}.json`), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  };
  const valid = (receipt, order) => Boolean(receipt && receipt.symbol === order.symbol
    && receipt.clientOrderId === order.clientOrderId && receipt.orderId === order.orderId && receipt.side === order.side);
  return {
    async record(order) {
      assertEngineOrder(engine, order.symbol, order.clientOrderId, order.side);
      const proof = { ...owner, symbol: order.symbol, clientOrderId: order.clientOrderId,
        orderId: order.orderId, side: order.side };
      await withDryRunIdempotency({ directory: join(stateDirectory, "order-identities"),
        key: identityKey(order.clientOrderId), bodyHash: sha256(JSON.stringify(proof)), execute: async () => proof });
    },
    async verify(order) {
      assertEngineOrder(engine, order.symbol, order.clientOrderId, order.side);
      const persisted = (await read("order-identities", identityKey(order.clientOrderId)))?.result;
      if (valid(persisted, order) && Object.entries(owner).every(([key, value]) => persisted[key] === value)) return true;
      // CREATE receipts use the unchanged canonical engine-scoped intent key;
      // legacy COR1 receipts stay readable on the established executor only.
      const claim = durableIntent(engine, {}, order.clientOrderId, "", "CREATE_ORDER");
      return valid((await read("orders", claim.key))?.result, order);
    },
  };
}

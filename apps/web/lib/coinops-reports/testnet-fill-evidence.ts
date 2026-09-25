import type { TestnetTrade } from "../execution/binance-spot-testnet-adapter.ts";
import { validateReportScope, type ReportScope } from "./source-contract.ts";

/** Evidence for fills already queried by the executor; never performs an exchange call. */
export function testnetFillEvents(scope: ReportScope, runId: string, slot: number, clientOrderId: string, exchangeOrderId: string, trades: TestnetTrade[], observedAt: string) {
  validateReportScope(scope);
  if (clientOrderId.length > 36 || !/^COV1-(BTC|SOL)-\d+-\d+-(BUY|SELL)-[a-f0-9]{12,18}$/.test(clientOrderId) || !Number.isInteger(slot) || slot < 1 || slot > 25) throw new Error("COINOPS_REPORT_FILL_OWNERSHIP_INVALID");
  return trades.map((trade) => ({
    product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId, run_id: runId, slot_number: slot,
    event_key: `${clientOrderId}:TRADE:${trade.id}`, event_type: "TESTNET_FILL_OBSERVED", observed_at: trade.filledAt || observedAt,
    details: { clientOrderId, exchangeOrderId, tradeId: trade.id, side: trade.isBuyer ? "BUY" : "SELL", quantity: trade.quantity, quoteQuantity: trade.quoteQuantity,
      price: trade.quoteQuantity / trade.quantity, commission: trade.commission, commissionAsset: trade.commissionAsset, filledAt: trade.filledAt ?? null, collectedAt: observedAt,
      timestampBasis: trade.filledAt ? "EXCHANGE_TRADE_TIME" : "COLLECTION_TIME_EXCHANGE_TIME_UNAVAILABLE" }
  }));
}

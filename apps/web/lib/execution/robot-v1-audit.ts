export type V1ShadowCompletedOperation = {
  grossQuotePnl: number | string;
  estimatedQuoteFees: number | string;
  netQuotePnl: number | string;
};

/** Completed operations are immutable history. Never derive realised Shadow
 * gains from the current 25 physical slots because a recycled slot is pending
 * again after it has already closed a profitable operation. */
export function summarizeV1ShadowOperations(operations: V1ShadowCompletedOperation[]) {
  return operations.reduce((summary, operation) => ({
    operations: summary.operations + 1,
    grossProfit: Number((summary.grossProfit + Number(operation.grossQuotePnl)).toFixed(12)),
    estimatedFees: Number((summary.estimatedFees + Number(operation.estimatedQuoteFees)).toFixed(12)),
    netProfit: Number((summary.netProfit + Number(operation.netQuotePnl)).toFixed(12))
  }), { operations: 0, grossProfit: 0, estimatedFees: 0, netProfit: 0 });
}

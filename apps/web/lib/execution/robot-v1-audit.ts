export type V1ShadowCompletedOperation = {
  grossQuotePnl: number | string;
  estimatedQuoteFees: number | string;
  netQuotePnl: number | string;
};

/** Database NUMERIC(28,12) values are summed as scaled integers. The worker
 * converts individual balances to numbers only to obey exchange quantity steps. */
export function sumV1DecimalAmounts(values: Array<number | string>) {
  const total = values.reduce<bigint>((sum, value) => {
    const text = String(value);
    if (!/^-?\d+(?:\.\d{1,12})?$/.test(text)) throw new Error("COINOPS_V1_DECIMAL_INVALID");
    const negative = text.startsWith("-");
    const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
    const scaled = BigInt(whole) * BigInt("1000000000000") + BigInt(fraction.padEnd(12, "0") || "0");
    return sum + (negative ? -scaled : scaled);
  }, BigInt(0));
  const absolute = total < BigInt(0) ? -total : total;
  return `${total < BigInt(0) ? "-" : ""}${absolute / BigInt("1000000000000")}.${String(absolute % BigInt("1000000000000")).padStart(12, "0")}`;
}

export type V1PhysicalSlotAccount = {
  slot_number: number;
  initial_balance_usdc: number | string;
  balance_usdc: number | string;
  gain_count: number;
  gross_profit_usdc: number | string;
  fees_usdc: number | string;
  net_profit_usdc: number | string;
};

export type V1PhysicalSlotOperation = {
  id: string;
  physical_slot_number: number;
  gross_quote_pnl: number | string;
  estimated_quote_fees: number | string;
  net_quote_pnl: number | string;
};

/** Detects a lost or duplicated credit, including a transfer between physical
 * slots that an asset-level sum would hide. */
export function reconcileV1PhysicalSlotAccounts(accounts: V1PhysicalSlotAccount[], operations: V1PhysicalSlotOperation[]) {
  if (accounts.length !== 25 || new Set(accounts.map((account) => account.slot_number)).size !== 25
    || new Set(operations.map((operation) => operation.id)).size !== operations.length) return false;
  for (const account of accounts) {
    if (!Number.isInteger(account.slot_number) || account.slot_number < 1 || account.slot_number > 25) return false;
    const owned = operations.filter((operation) => operation.physical_slot_number === account.slot_number);
    if (account.gain_count !== owned.length
      || sumV1DecimalAmounts([account.initial_balance_usdc, account.net_profit_usdc]) !== sumV1DecimalAmounts([account.balance_usdc])
      || sumV1DecimalAmounts(owned.map((operation) => operation.net_quote_pnl)) !== sumV1DecimalAmounts([account.net_profit_usdc])
      || sumV1DecimalAmounts(owned.map((operation) => operation.gross_quote_pnl)) !== sumV1DecimalAmounts([account.gross_profit_usdc])
      || sumV1DecimalAmounts(owned.map((operation) => operation.estimated_quote_fees)) !== sumV1DecimalAmounts([account.fees_usdc])) return false;
  }
  return operations.every((operation) => accounts.some((account) => account.slot_number === operation.physical_slot_number));
}

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

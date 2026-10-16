/** Persisted progress is unfinished work, not a reconciliation/activation proof.
 * Keep only the public audit contract, excluding lease tokens and arbitrary data. */
const fields = new Set(["contract", "run_id", "operator_id", "exchange_account_id", "trading_engine_id",
  "executor_shard_id", "symbol", "quote_asset", "slot_count", "phase", "started_at", "observed_at",
  "settled_orders", "credited_gains", "operation_total", "quantity_step"]);
export function largeEngineProgressAudit(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => fields.has(key)
    && (typeof item === "number" && Number.isFinite(item) || typeof item === "string"
      && !/bearer\s|(?:secret|password|api[_ -]?key|authorization)\s*[:=]|eyJ[A-Za-z0-9_-]+\./i.test(item))));
}

import { AsyncLocalStorage } from "node:async_hooks";
import { configuredEngineSlotCount } from "./engine-slot-topology.ts";

type Scope = { id?: string; operator_id: string; exchange_account_id: string;
  trading_engine_id: string; symbol: string; quote_asset: string; slot_count?: unknown;
  executor_shard_id?: string | null;
  engine?: { executor_shard_id?: string | null; slot_count?: unknown; config?: unknown } };
type Budget = { scope_key: string; run_id: string | null; shard_id: string | null; remaining: number };
const budgets = new AsyncLocalStorage<Budget | null>();
const keyFor = (scope: Scope) => JSON.stringify([scope.operator_id,
  scope.exchange_account_id, scope.trading_engine_id, scope.symbol, scope.quote_asset]);
const shardFor = (scope: Scope) => scope.engine?.executor_shard_id ?? scope.executor_shard_id ?? null;

/** Only the large engine's observation phase shares retries. Normal first
 * reads are unchanged; no mutation, credential, balance or response is cached. */
export function withLiveObservationRetryBudget<T>(scope: Scope, operation: () => Promise<T>): Promise<T> {
  const count = configuredEngineSlotCount(scope.engine ?? scope);
  return budgets.run(count > 25 ? { scope_key: keyFor(scope), run_id: scope.id ?? null,
    shard_id: shardFor(scope), remaining: 3 } : null, operation);
}

/** Called immediately before another GET-equivalent attempt, never on a POST
 * order or cancel. Exhaustion uses the existing typed observation checkpoint. */
export function reserveLiveObservationRetry(scope: Scope): boolean {
  const budget = budgets.getStore();
  if (!budget) return true;
  // EngineContext transports need not carry a run row/nested engine. Mandatory
  // canonical identities always match; supplied run/shard metadata must agree.
  // The resolver independently verifies the actual immutable shard per request.
  if (budget.scope_key !== keyFor(scope)
    || scope.id !== undefined && budget.run_id !== scope.id
    || shardFor(scope) !== null && budget.shard_id !== shardFor(scope))
    throw new Error("COINOPS_LIVE_OBSERVATION_RETRY_SCOPE_MISMATCH");
  if (budget.remaining === 0) return false;
  budget.remaining--;
  return true;
}

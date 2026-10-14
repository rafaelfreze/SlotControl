import "server-only";

import type { createServiceRoleClient } from "../supabase/service-role";
import { LiveLedgerReadFailed, LiveReadUnavailable } from "./live-read-error";
import { observeLedgerRows } from "./live-ledger-read";
import { assertDomainRegistry, resolveEngineContext, visibleOperatorRegistry, type DomainRegistry, type EngineSelection,
  type OperatorScope } from "./operator-context";

type Client = ReturnType<typeof createServiceRoleClient>;
const REGISTRY_READ_TIMEOUT_MS = 5_000;

function registryFailure(stage: string, startedAt: number, deadline: AbortSignal,
  error: unknown, publicCode: string, attempt: number): never {
  const observed = error instanceof LiveReadUnavailable || error instanceof LiveLedgerReadFailed ? error : null;
  const path = `registry/${stage}`;
  const timeout = error instanceof LiveReadUnavailable && deadline.aborted && !error.providerCode;
  const failure = error instanceof LiveReadUnavailable
    ? new LiveReadUnavailable(timeout ? "COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT"
      : "COINOPS_OPERATOR_REGISTRY_READ_UNAVAILABLE", path, attempt, error.httpStatus, error.providerCode)
    : new LiveLedgerReadFailed(path, attempt, observed?.httpStatus ?? null, observed?.providerCode ?? null);
  // Retain the public scope/registry failure without losing allowlisted read
  // evidence. Unknown errors are not promoted to transient observations.
  if (failure instanceof LiveLedgerReadFailed) failure.message = publicCode;
  console.error("COINOPS_OPERATOR_REGISTRY_READ_FAILED", {
    stage, code: failure.providerCode ?? (timeout ? "TIMEOUT" : "UNKNOWN"),
    root_code: failure.message, read_path: path, read_attempts: attempt,
    http_status: failure.httpStatus, duration_ms: Math.max(0, Date.now() - startedAt),
  });
  throw failure;
}

/** Reuse the ledger's strict GET error classifier, not a financial-step retry.
 * Permission/schema/missing/unknown errors keep their non-transient identity. */
async function registryRows<T>(stage: string, query: PromiseLike<{ data: T[] | null; error: unknown; status?: number }>,
  startedAt: number, deadline: AbortSignal, publicCode: string, attempt: number): Promise<T[]> {
  try { return await observeLedgerRows("operator", query, deadline, attempt); }
  catch (error) { registryFailure(stage, startedAt, deadline, error, publicCode, attempt); }
}

/** Accepts authenticated/RLS or service clients, but never discovers a user or
 * tenant from browser IDs. Callers supply their already authenticated scope. */
export async function loadOperatorRegistry(client: Client, scope: OperatorScope): Promise<DomainRegistry> {
  for (let attempt = 1; ; attempt++) {
    try { return await readRegistryAttempt(client, scope, attempt); }
    catch (error) {
      if (!(error instanceof LiveReadUnavailable)
        || !["COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT", "COINOPS_OPERATOR_REGISTRY_READ_UNAVAILABLE"]
          .includes(error.code) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function readRegistryAttempt(client: Client, scope: OperatorScope, attempt: number): Promise<DomainRegistry> {
  const startedAt = Date.now();
  // One 5s deadline per complete attempt; never reuse a partial registry or a
  // cached permission. Exhaustion remains a typed, bounded read failure.
  const deadline = AbortSignal.timeout(REGISTRY_READ_TIMEOUT_MS);
  const operatorQuery = client.from("operators").select("id,product_id,tenant_id,user_id,status,kill_switch")
    .eq("product_id", scope.product_id).eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id)
    .abortSignal(deadline).single();
  const operatorRows = await registryRows("operators", Promise.resolve(operatorQuery).then(result => ({
    ...result, data: result.data === null ? [] : [result.data],
  })), startedAt, deadline, "COINOPS_OPERATOR_SCOPE_UNAVAILABLE", attempt);
  const operator = operatorRows[0];
  if (operatorRows.length !== 1 || !operator)
    registryFailure("operators", startedAt, deadline, null, "COINOPS_OPERATOR_SCOPE_UNAVAILABLE", attempt);
  const operatorId = operator.id;
  const pageSize = 500;
  async function pages(table: "exchange_accounts" | "trading_engines", columns: string) {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const result = await registryRows(table, client.from(table).select(columns).eq("operator_id", operatorId)
        .order("id").range(offset, offset + pageSize - 1).abortSignal(deadline),
      startedAt, deadline, "COINOPS_OPERATOR_REGISTRY_UNAVAILABLE", attempt);
      rows.push(...result as unknown as Record<string, unknown>[]);
      if (result.length < pageSize) return rows;
    }
  }
  const reads = await Promise.allSettled([
    pages("exchange_accounts", "id,operator_id,display_name,status,is_legacy_default,kill_switch,executor_shard_id"),
    pages("trading_engines", "id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,strategy_config_pending,hard_cap_quote,legacy_compatible,ath_reference_symbol,executor_shard_id"),
  ]);
  // A fast transient sibling cannot hide a permission/scope/malformed read and
  // make a retry look like an authorized complete observation.
  const failures = reads.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const failure = failures.find(result => !(result.reason instanceof LiveReadUnavailable)) ?? failures[0];
  if (failure) throw failure.reason;
  const [accounts, engines] = reads.map(result => (result as PromiseFulfilledResult<Record<string, unknown>[]>).value);
  // Disabled/revoked accounts remain in the ledger for audit, but must not
  // reappear in operational selectors or be resolved through a stale URL.
  const registry = visibleOperatorRegistry({ operator, accounts,
    engines } as unknown as DomainRegistry);
  assertDomainRegistry(registry, scope);
  return registry;
}

export async function resolveOperatorEngine(client: Client, scope: OperatorScope, selection: EngineSelection) {
  return resolveEngineContext(await loadOperatorRegistry(client, scope), selection);
}

import { boundedLedgerRead, observeLedgerRecord } from "./live-ledger-read.ts";
import { LiveLedgerReadFailed, LiveReadUnavailable } from "./live-read-error.ts";

type BindingReadResource = "operator" | "account" | "engine" | "shard";

/** Exact server-side routing GET only. A returned provider outage is not proof
 * of a foreign/missing engine; a real missing row still fails the binding guard.
 * Reuse the canonical read classifier, never a write or whole trading retry. */
export async function observeExecutorBindingRecord<T extends object>(resource: BindingReadResource,
  query: PromiseLike<{ data: T | null; error: unknown; status?: number }>,
  deadline: AbortSignal, attempt: number, validate?: (value: T) => void): Promise<T> {
  const path = `executor_binding/${resource}`;
  try {
    const value = await observeLedgerRecord("operator", query, deadline, attempt, "EXECUTOR_ENGINE_SHARD_DENIED");
    // A successfully returned foreign/disabled fact is still a real denial,
    // and must take precedence over another fact's transient GET failure.
    validate?.(value);
    return value;
  } catch (error) {
    if (error instanceof LiveReadUnavailable)
      // Keep the canonical code until the entire bounded observation completes.
      throw new LiveReadUnavailable(error.code, path, attempt, error.httpStatus, error.providerCode);
    if (error instanceof LiveLedgerReadFailed) {
      const failure = new LiveLedgerReadFailed(path, attempt, error.httpStatus, error.providerCode);
      failure.message = "COINOPS_EXECUTOR_BINDING_READ_FAILED";
      throw failure;
    }
    throw error;
  }
}

/** Two complete GET attempts, each with one fresh 5s deadline and 250ms delay.
 * Failed/partial observations cannot become cached routing or authorize a POST. */
export async function boundedExecutorBindingRead<T>(read: (deadline: AbortSignal, attempt: number) => Promise<T>): Promise<T> {
  try { return await boundedLedgerRead(read); }
  catch (error) {
    if (error instanceof LiveReadUnavailable && error.code === "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE")
      throw new LiveReadUnavailable("COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE", error.path,
        error.attempts, error.httpStatus, error.providerCode);
    throw error;
  }
}

/** All parallel routing facts must settle before selecting the failure. An
 * early transient GET must never hide a later permission/schema/missing row. */
export async function completeExecutorBindingFacts<T extends readonly unknown[]>(
  reads: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(reads);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const failure = failures.find(result => !(result.reason instanceof LiveReadUnavailable)) ?? failures[0];
  if (failure) throw failure.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

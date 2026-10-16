import "server-only";
import type { createServiceRoleClient } from "../supabase/service-role";
import type { DomainRegistry } from "./operator-context";
import { assertDomainRegistry, isIdentity } from "./operator-context";
import { completeLedgerRead } from "./complete-ledger-read";
import { accountPauseProtection, type AccountPauseLedger } from "./account-pause-home-policy";

type Client = ReturnType<typeof createServiceRoleClient>;
/** Complete, scope-bound reads. No exchange call, pause, resume or financial write. */
export async function loadAccountPauseHome(client: Client, registry: DomainRegistry, accountId: string) {
  assertDomainRegistry(registry, registry.operator);
  const account = registry.accounts.find((row) => row.id === accountId);
  if (!isIdentity(accountId) || !account || account.status !== "ACTIVE") throw new Error("COINOPS_ACCOUNT_PAUSE_SCOPE_DENIED");
  const engines = registry.engines.filter((row) => row.exchange_account_id === accountId && row.environment === "REAL" && row.status === "ACTIVE");
  const ids = engines.map((row) => row.id), op = registry.operator;
  const deadline = AbortSignal.timeout(5_000);
  const scoped = (table: string, columns: string) => client.from(table).select(columns, { count: "exact" })
    .eq("operator_id", op.id).eq("exchange_account_id", accountId).eq("product_id", op.product_id)
    .eq("tenant_id", op.tenant_id).eq("user_id", op.user_id);
  const owners = "operator_id,exchange_account_id,trading_engine_id";
  const rows = async <T>(table: string, columns: string, runIds?: string[], status?: string[], unresolved = false) => {
    if (!ids.length || runIds && !runIds.length) return [] as T[];
    let expected: number | null = null;
    return completeLedgerRead<T & { id: string }>(async (start, end) => {
      let query = scoped(table, columns).in("trading_engine_id", ids);
      query = table === "robot_v1_live_slot_accounts" ? query.order("trading_engine_id").order("slot_number") : query.order("id");
      query = query.range(start, end).abortSignal(deadline);
      if (runIds) query = query.in("run_id", runIds);
      if (status) query = query.in("status", status);
      if (unresolved) query = query.is("resolved_at", null);
      const response = await query as unknown as { data: Array<T & { id?: string; trading_engine_id?: string; slot_number?: number }> | null;
        error: unknown; count: number | null };
      if (response.error || !Array.isArray(response.data) || !Number.isSafeInteger(response.count)
        || response.count! < 0 || response.count! > 100_000 || expected !== null && expected !== response.count
        || response.data.length < end - start + 1 && start + response.data.length !== response.count)
        throw new Error("COINOPS_ACCOUNT_PAUSE_READ_UNAVAILABLE");
      expected = response.count;
      return { error: null, data: response.data.map((row) => ({ ...row,
        id: table === "robot_v1_live_slot_accounts" ? `${row.trading_engine_id}:${row.slot_number}` : row.id! })) };
    }, "COINOPS_ACCOUNT_PAUSE_READ_UNAVAILABLE");
  };
  const runs = await rows<AccountPauseLedger["runs"][number]>("robot_v1_live_runs", `id,${owners},status,last_error,last_reconciled_at,slot_count`, undefined,
    ["ACTIVE", "PAUSED", "PREPARING"]);
  const runIds = runs.map((row) => row.id);
  const [slots, accounts, orders, preparations, alerts, preference] = await Promise.all([
    rows<AccountPauseLedger["slots"][number]>("robot_v1_live_slots", `id,run_id,${owners},slot_number,entry_state,position_quantity,position_committed_quote`, runIds),
    rows<AccountPauseLedger["accounts"][number]>("robot_v1_live_slot_accounts", `${owners},slot_number,balance_quote`),
    rows<AccountPauseLedger["orders"][number] & { id: string }>("robot_v1_live_orders", `id,run_id,slot_id,${owners},side,purpose,status,client_order_id,exchange_order_id,requested_quantity,executed_quantity,trades_reconciled`, runIds),
    rows<AccountPauseLedger["preparations"][number] & { id: string }>("robot_v1_live_preparations", `id,${owners},symbol,kill_switch,live_enabled,slot_count`),
    rows<AccountPauseLedger["alerts"][number]>("robot_v1_live_alerts", `id,${owners},code,severity`, undefined, undefined, true),
    client.from("account_home_preferences").select("hidden,updated_at").eq("operator_id", op.id)
      .eq("exchange_account_id", accountId).abortSignal(deadline).maybeSingle(),
  ]);
  if (preference.error) throw new Error("COINOPS_ACCOUNT_PAUSE_PREFERENCE_UNAVAILABLE");
  const proofs = await Promise.all(runs.map(async (run) => {
    const read = await scoped("robot_v1_live_events", `${owners},run_id,observed_at,details`)
      .eq("trading_engine_id", run.trading_engine_id).eq("run_id", run.id)
      .in("event_type", ["LIVE_PAUSED", "RECONCILED"]).order("observed_at", { ascending: false })
      .limit(1).abortSignal(deadline).maybeSingle();
    if (read.error) throw new Error("COINOPS_ACCOUNT_PAUSE_PROOF_UNAVAILABLE");
    return read.data as unknown as AccountPauseLedger["proofs"][number] | null;
  }));
  const ledger: AccountPauseLedger = { operatorId: op.id, accountId, engines: engines.map((engine) => ({ ...engine,
    strategy_config_pending: engine.strategy_config_pending === true })), runs, slots, accounts, orders, preparations, alerts,
    proofs: proofs.filter((proof): proof is NonNullable<typeof proof> => proof !== null), accountGateClosed: account.kill_switch,
    operatorGateClosed: op.kill_switch };
  const now = Date.now();
  const owned = (row: AccountPauseLedger["runs"][number] | AccountPauseLedger["preparations"][number]
    | AccountPauseLedger["alerts"][number], engineId: string) => row.operator_id === op.id
    && row.exchange_account_id === accountId && row.trading_engine_id === engineId;
  return { accountId, hidden: preference.data?.hidden === true, canHide: accountPauseProtection(ledger),
    engines: engines.map((engine) => { const current = runs.filter((run) => run.trading_engine_id === engine.id);
      const prep = preparations.filter((row) => row.trading_engine_id === engine.id);
      const reconciledAt = current.length === 1 ? Date.parse(current[0].last_reconciled_at ?? "") : NaN;
      // ACTIVE alone is not entry permission: a fail-closed ACTIVE sibling must
      // never make an account-wide resume confirmation look successful.
      const entryEnabled = current.length === 1 && owned(current[0], engine.id)
        && current[0].status === "ACTIVE" && current[0].last_error === null
        && Number.isFinite(reconciledAt) && reconciledAt - now <= 1_000 && now - reconciledAt <= 180_000
        && engine.kill_switch === false && engine.strategy_config_pending === false
        && account.kill_switch === false && op.kill_switch === false
        && prep.length === 1 && owned(prep[0], engine.id) && prep[0].symbol === engine.symbol
        && prep[0].live_enabled === true && prep[0].kill_switch === false
        && !alerts.some((row) => row.trading_engine_id === engine.id
          && (!owned(row, engine.id) || row.severity !== "WARNING"));
      return { engineId: engine.id, symbol: engine.symbol, executorShardId: engine.executor_shard_id ?? null,
        runId: current.length === 1 ? current[0].id : null, runStatus: current.length === 1 ? current[0].status : null,
        entryEnabled }; }) };
}

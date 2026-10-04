import "server-only";

import type { createServiceRoleClient } from "../supabase/service-role";
import { operatorAccountSnapshot } from "../execution/operator-executor-admin";
import { isIdentity } from "../execution/operator-context";
import { buildFinopsCapital, type CapitalAccount, type CapitalEngine, type CapitalOrder, type CapitalPrice,
  type CapitalRun, type CapitalSlot, type CapitalSlotAccount, type CapitalWallet } from "./capital";

type Service = ReturnType<typeof createServiceRoleClient>;
const PAGE_SIZE = 500;
const MAX_ROWS = 100_000;
type ReadQuery = PromiseLike<{ data: unknown[] | null; error: unknown }> & { range(from: number, to: number): ReadQuery };

async function readPages<T>(makeQuery: () => ReadQuery): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const result = await makeQuery().range(offset, offset + PAGE_SIZE - 1);
    if (result.error || !result.data) throw new Error("COINOPS_FINOPS_CAPITAL_READ_FAILED");
    rows.push(...result.data as T[]);
    if (result.data.length < PAGE_SIZE) return rows;
  }
  throw new Error("COINOPS_FINOPS_CAPITAL_ROW_LIMIT");
}

/** Called by the authenticated FinOps sync only. Default is DB-only. No
 * exchange writer, strategy worker, reconciliation or health mutation is used. */
export async function loadFinopsCapital(service: Service, scope: { operatorId: string; tenantId: string;
  now?: number; refreshWallets?: boolean }) {
  if (!isIdentity(scope.operatorId) || !isIdentity(scope.tenantId)) throw new Error("COINOPS_FINOPS_CAPITAL_SCOPE_INVALID");
  const operator = await service.from("operators").select("id,tenant_id,status")
    .eq("id", scope.operatorId).eq("tenant_id", scope.tenantId).eq("status", "ACTIVE").maybeSingle();
  if (operator.error || !operator.data) throw new Error("COINOPS_FINOPS_CAPITAL_SCOPE_DENIED");
  const query = (table: string, columns: string, tenantScoped = true) => {
    const builder = service.from(table).select(columns).eq("operator_id", scope.operatorId);
    return tenantScoped ? builder.eq("tenant_id", scope.tenantId) : builder;
  };
  const [accounts, engines, runs, slotAccounts, slots, orders, checks] = await Promise.all([
    readPages<CapitalAccount>(() => query("exchange_accounts", "id,operator_id,display_name,status,executor_shard_id,onboarding_environment,credential_ref", false).order("id")),
    readPages<CapitalEngine>(() => query("trading_engines", "id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,executor_shard_id", false)
      .eq("environment", "REAL").order("id")),
    readPages<CapitalRun>(() => query("robot_v1_live_runs", "id,operator_id,exchange_account_id,trading_engine_id,status,last_reconciled_at")
      .in("status", ["PREPARING", "ACTIVE", "PAUSED"]).order("id")),
    readPages<CapitalSlotAccount>(() => query("robot_v1_live_slot_accounts", "operator_id,exchange_account_id,trading_engine_id,slot_number,balance_quote,market_pnl_quote,fees_quote,gain_count")
      .order("trading_engine_id").order("slot_number")),
    // Fetch only current-run slots/orders below to avoid walking historical fills.
    Promise.resolve([] as CapitalSlot[]), Promise.resolve([] as CapitalOrder[]),
    readPages<{ exchange_account_id: string; status: string; checked_at: string; evidence: { balances?: CapitalWallet["balances"] } }>(() =>
      query("account_onboarding_checks", "id,exchange_account_id,status,checked_at,evidence", false)
        .eq("check_key", "BINANCE_CREDENTIAL").order("id")),
  ]);
  const runIds = runs.map((row) => row.id);
  for (let offset = 0; offset < runIds.length; offset += 100) {
    const ids = runIds.slice(offset, offset + 100);
    const [currentSlots, currentOrders] = await Promise.all([
      readPages<CapitalSlot>(() => query("robot_v1_live_slots", "id,operator_id,exchange_account_id,trading_engine_id,run_id,slot_number,position_quantity,position_committed_quote")
        .in("run_id", ids).order("id")),
      readPages<CapitalOrder>(() => query("robot_v1_live_orders", "id,operator_id,exchange_account_id,trading_engine_id,run_id,client_order_id,side,status,reserved_notional_quote,requested_quote,requested_quantity,price,cumulative_quote")
        .in("run_id", ids).in("status", ["PREPARED", "NEW", "PARTIALLY_FILLED"]).order("id")),
    ]);
    slots.push(...currentSlots); orders.push(...currentOrders);
  }
  const wallets: CapitalWallet[] = accounts.map((account) => {
    const check = checks.filter((row) => row.exchange_account_id === account.id)
      .sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
    return { accountId: account.id, observedAt: check?.status === "PASS" && Array.isArray(check.evidence?.balances) ? check.checked_at : null,
      source: "coinops.account_onboarding_checks (última validação; não é saldo atual)",
      balances: check?.status === "PASS" && Array.isArray(check.evidence?.balances) ? check.evidence.balances : [] };
  });
  const prices: CapitalPrice[] = [];
  if (scope.refreshWallets) {
    const candidates = accounts.filter((account) => !["DISABLED", "REVOKED"].includes(account.status)
      && account.credential_ref && engines.some((engine) => engine.exchange_account_id === account.id));
    // The existing read-only snapshot supports BTC/SOL in one quote. Unsupported
    // newer layouts stay explicitly partial until its contract supports them.
    for (let offset = 0; offset < candidates.length; offset += 2) {
      const observations = await Promise.allSettled(candidates.slice(offset, offset + 2).map(async (account) => {
        const own = engines.filter((engine) => engine.exchange_account_id === account.id && engine.status !== "DISABLED");
        const symbols = [...new Set(own.map((engine) => engine.symbol))];
        const quotes = [...new Set(own.map((engine) => engine.quote_asset))];
        if (quotes.length !== 1 || symbols.length < 1 || symbols.length > 2)
          throw new Error("COINOPS_FINOPS_SNAPSHOT_MARKET_CONTRACT_UNSUPPORTED");
        const source = own.find((engine) => engine.executor_shard_id === account.executor_shard_id) ?? own[0];
        if (!source?.executor_shard_id) throw new Error("COINOPS_FINOPS_SNAPSHOT_SHARD_UNAVAILABLE");
        let credentialRef = account.credential_ref!;
        if (source.executor_shard_id !== account.executor_shard_id) {
          const connection = await service.from("account_executor_connections").select("credential_ref,status")
            .eq("operator_id", scope.operatorId).eq("exchange_account_id", account.id)
            .eq("executor_shard_id", source.executor_shard_id).eq("environment", "REAL").single();
          if (connection.error || connection.data?.status !== "VALIDATED") throw new Error("COINOPS_FINOPS_CONNECTION_UNAVAILABLE");
          credentialRef = connection.data.credential_ref;
        }
        const snapshot = await operatorAccountSnapshot(scope.operatorId, account.id, quotes[0]!, symbols, credentialRef, "REAL", source.id);
        if (!Array.isArray(snapshot.balances)) throw new Error("COINOPS_FINOPS_WALLET_RESPONSE_INVALID");
        const residentIds = new Set(snapshot.markets.flatMap((market) => market.open_orders.map((order) => order.clientOrderId)));
        const ledgerResident = orders.filter((order) => order.exchange_account_id === account.id && ["NEW", "PARTIALLY_FILLED"].includes(order.status));
        // A fill between DB and exchange observations invalidates the combined
        // valuation. FinOps never invokes trading reconciliation to repair it.
        const consistent = ledgerResident.every((order) => order.client_order_id && residentIds.has(order.client_order_id));
        wallets.push({ accountId: account.id, balances: snapshot.balances, observedAt: snapshot.observed_at, consistent,
          source: "Binance account snapshot via executor atribuído · leitura periódica FinOps" });
        prices.push(...snapshot.markets.map((market) => ({ accountId: account.id, symbol: market.symbol,
          price: market.price, observedAt: market.observed_at })));
      }));
      observations.forEach((result, index) => {
        if (result.status === "rejected") {
          const account = candidates[offset + index]!;
          const current = wallets.find((wallet) => wallet.accountId === account.id);
          if (current) current.error = result.reason instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(result.reason.message)
            ? result.reason.message : "COINOPS_FINOPS_WALLET_SYNC_FAILED";
        }
      });
    }
  }
  return buildFinopsCapital({ operatorId: scope.operatorId, accounts, engines, runs, slotAccounts, slots, orders,
    wallets, prices, now: scope.now ?? Date.now() });
}

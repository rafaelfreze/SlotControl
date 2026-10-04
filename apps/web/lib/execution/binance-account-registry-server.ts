import "server-only";
import type { createServiceRoleClient } from "@/lib/supabase/service-role";
import { resolveExecutorForConnection } from "./executor-shards-server.ts";
import { operatorConnectionAdmin } from "./operator-executor-admin.ts";
import { completeLedgerRead } from "./complete-ledger-read.ts";

type Service = ReturnType<typeof createServiceRoleClient>;
type InactiveEngine = { id: string; symbol: string; base_asset: string; quote_asset: string;
  status: string; kill_switch: boolean; executor_shard_id: string; hard_cap_quote: number | string;
  config: { slot_count: number; max_order_quote: number } };

/** Prepares only inactive engines. This path has no exchange write capability. */
export async function syncInactiveBinanceAccount(service: Service, operatorId: string,
  accountId: string, credentialRef: string, environment: "REAL" | "TESTNET") {
  if (environment !== "REAL") return { registered_engines: 0, status: "TESTNET_ONLY" };
  const [account, engines] = await Promise.all([
    service.from("exchange_accounts").select("id,operator_id,status,kill_switch,is_legacy_default,executor_profile")
      .eq("id", accountId).eq("operator_id", operatorId).single(),
    completeLedgerRead<InactiveEngine>((start, end) => service.from("trading_engines")
      .select("id,symbol,base_asset,quote_asset,status,kill_switch,hard_cap_quote,config,executor_shard_id")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId).eq("environment", "REAL")
      .order("id").range(start, end), "COINOPS_ADMIN_REGISTRY_SCOPE_DENIED"),
  ]);
  if (account.error || !account.data || account.data.status !== "INACTIVE"
    || !account.data.kill_switch || account.data.is_legacy_default
    || account.data.executor_profile !== "coinops-fixed-ip")
    throw new Error("COINOPS_ADMIN_REGISTRY_SCOPE_DENIED");
  if (engines.length === 0) return { registered_engines: 0, status: "INACTIVE" };
  // The old parameter is compatibility only, never routing or credential authority.
  void credentialRef;
  const targets = new Map<string, Awaited<ReturnType<typeof resolveExecutorForConnection>>>();
  for (const shard of [...new Set(engines.map((engine) => engine.executor_shard_id))].sort()) {
    if (!/^executor-[0-9]{2,4}$/.test(shard)) throw new Error("COINOPS_ADMIN_REGISTRY_SCOPE_DENIED");
    targets.set(shard, await resolveExecutorForConnection(operatorId, accountId, shard));
  }
  const rows = [];
  const caps = new Map<string, number>();
  for (const engine of engines) {
    if (engine.status !== "INACTIVE" || !engine.kill_switch) throw new Error("COINOPS_ADMIN_ENGINE_ACTIVE");
    if (!caps.has(engine.quote_asset)) {
      const cap = await service.from("account_quote_caps").select("hard_cap_quote")
        .eq("operator_id", operatorId).eq("exchange_account_id", accountId)
        .eq("quote_asset", engine.quote_asset).single();
      if (cap.error || !Number.isFinite(Number(cap.data?.hard_cap_quote))) throw new Error("COINOPS_ADMIN_REGISTRY_CAP_INVALID");
      caps.set(engine.quote_asset, Number(cap.data!.hard_cap_quote));
    }
    const engineCap = Number(engine.hard_cap_quote), accountCap = caps.get(engine.quote_asset)!;
    const slotCount = Number(engine.config?.slot_count);
    const maxOrder = Number(engine.config?.max_order_quote);
    if (!Number.isFinite(engineCap) || engineCap <= 0 || !Number.isFinite(accountCap)
      || accountCap < engineCap || slotCount !== 25 || !Number.isFinite(maxOrder)
      || maxOrder <= 0 || maxOrder > engineCap) throw new Error("COINOPS_ADMIN_REGISTRY_CAP_INVALID");
    rows.push({ operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engine.id,
      environment: "REAL", symbol: engine.symbol, base_asset: engine.base_asset, quote_asset: engine.quote_asset,
      status: "INACTIVE", kill_switch: true, account_kill_switch: true, global_kill_switch: true,
      execution_allowed: false, is_legacy_default: false, legacy_ownership: false,
      hard_cap_quote: engineCap, account_cap_quote: accountCap, max_order_quote: maxOrder,
      credential_ref: targets.get(engine.executor_shard_id)!.credentialRef, executor_profile: "coinops-fixed-ip" });
  }
  for (const [quote, cap] of caps) {
    if (engines.filter((engine) => engine.quote_asset === quote).reduce((sum, engine) => sum + Number(engine.hard_cap_quote), 0) > cap + 1e-8)
      throw new Error("COINOPS_ADMIN_REGISTRY_CAP_INVALID");
  }
  // Validate the entire inventory first. Append is idempotent and cannot demote
  // an installed active engine if activation races this inactive snapshot.
  for (const shard of targets.keys()) {
    const own = rows.filter((_, index) => engines[index].executor_shard_id === shard);
    for (const quote of [...new Set(own.map((row) => row.quote_asset))]) {
      await operatorConnectionAdmin(operatorId, accountId, shard, "/v1/admin/account-cap",
        { quote_asset: quote, account_cap_quote: caps.get(quote) }, "SHARED_CAP");
    }
    const result = await operatorConnectionAdmin<{ registered_engines: number; trading_enabled: boolean; status: string }>(
      operatorId, accountId, shard, "/v1/admin/registry-append", { engines: own }, "REGISTRY");
    if (result.trading_enabled !== false || result.status !== "INACTIVE" || result.registered_engines !== own.length)
      throw new Error("COINOPS_ADMIN_REGISTRY_SYNC_FAILED");
  }
  return { registered_engines: rows.length, status: "INACTIVE" };
}

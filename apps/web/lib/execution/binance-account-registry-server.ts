import "server-only";
import { randomUUID } from "node:crypto";
import type { createServiceRoleClient } from "@/lib/supabase/service-role";
import { signedExecutorHeaders } from "./live-executor-client";

type Service = ReturnType<typeof createServiceRoleClient>;

/** Prepares only inactive engines. This path has no exchange write capability. */
export async function syncInactiveBinanceAccount(service: Service, operatorId: string,
  accountId: string, credentialRef: string, environment: "REAL" | "TESTNET") {
  if (environment !== "REAL") return { registered_engines: 0, status: "TESTNET_ONLY" };
  const [account, engines] = await Promise.all([
    service.from("exchange_accounts").select("id,operator_id,status,kill_switch,is_legacy_default,executor_profile")
      .eq("id", accountId).eq("operator_id", operatorId).single(),
    service.from("trading_engines")
      .select("id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,hard_cap_quote,config")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId).eq("environment", "REAL"),
  ]);
  if (account.error || engines.error || !account.data || account.data.status !== "INACTIVE"
    || !account.data.kill_switch || account.data.is_legacy_default
    || account.data.executor_profile !== "coinops-fixed-ip")
    throw new Error("COINOPS_ADMIN_REGISTRY_SCOPE_DENIED");
  const rows = [];
  for (const engine of engines.data ?? []) {
    if (engine.status !== "INACTIVE" || !engine.kill_switch) throw new Error("COINOPS_ADMIN_ENGINE_ACTIVE");
    const cap = await service.from("account_quote_caps").select("hard_cap_quote")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId)
      .eq("quote_asset", engine.quote_asset).single();
    const engineCap = Number(engine.hard_cap_quote), accountCap = Number(cap.data?.hard_cap_quote);
    const slotCount = Number(engine.config?.slot_count);
    if (cap.error || !Number.isFinite(engineCap) || engineCap <= 0 || !Number.isFinite(accountCap)
      || accountCap < engineCap || slotCount !== 25) throw new Error("COINOPS_ADMIN_REGISTRY_CAP_INVALID");
    rows.push({ operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engine.id,
      environment: "REAL", symbol: engine.symbol, base_asset: engine.base_asset, quote_asset: engine.quote_asset,
      status: "INACTIVE", kill_switch: true, account_kill_switch: true, global_kill_switch: true,
      execution_allowed: false, is_legacy_default: false, legacy_ownership: false,
      hard_cap_quote: engineCap, account_cap_quote: accountCap, max_order_quote: engineCap / 25,
      credential_ref: credentialRef, executor_profile: "coinops-fixed-ip" });
  }
  const ip = process.env.LIVE_EXECUTOR_EGRESS_IP, base = process.env.LIVE_EXECUTOR_BASE_URL;
  const secret = process.env.COINOPS_EXECUTOR_HMAC_SECRET;
  if (!ip || base !== `https://${ip}` || !secret) throw new Error("COINOPS_ADMIN_EXECUTOR_UNAVAILABLE");
  const requestId = randomUUID(), key = `REGISTRY:${requestId}`, path = "/v1/admin/registry";
  const body = JSON.stringify({ operator_id: operatorId, exchange_account_id: accountId,
    credential_ref: credentialRef, environment, request_id: requestId, engines: rows });
  const response = await fetch(`${base}${path}`, { method: "POST", cache: "no-store",
    headers: signedExecutorHeaders(secret, path, body, key), body, signal: AbortSignal.timeout(15_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.operator_id !== operatorId || result.exchange_account_id !== accountId
    || result.trading_enabled !== false || result.status !== "INACTIVE"
    || result.registered_engines !== rows.length)
    throw new Error("COINOPS_ADMIN_REGISTRY_SYNC_FAILED");
  return { registered_engines: rows.length, status: "INACTIVE" };
}

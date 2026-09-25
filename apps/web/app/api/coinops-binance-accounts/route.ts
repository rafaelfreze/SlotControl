import { NextRequest, NextResponse } from "next/server";
import { signedExecutorHeaders } from "@/lib/execution/live-executor-client";
import { syncInactiveBinanceAccount } from "@/lib/execution/binance-account-registry-server";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { assertOwnedAccount, assertSameOrigin, validateCredentialIntent, type CredentialIntent } from "./policy";

export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 60;

const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: noStore });

async function adminScope() {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_ADMIN_SCHEMA_DENIED");
  const tenantId = getCoinOpsServiceTenantId();
  const client = createClient();
  const user = (await client.auth.getUser()).data.user;
  if (!user || !tenantId) throw new Error("COINOPS_ADMIN_AUTH_REQUIRED");
  const result = await client.from("operators").select("id,user_id,status")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (result.error || !result.data) throw new Error("COINOPS_ADMIN_OPERATOR_DENIED");
  return { operator: result.data, service: createServiceRoleClient() };
}

async function callExecutor(input: Record<string, unknown>, requestId: string) {
  const ip = process.env.LIVE_EXECUTOR_EGRESS_IP;
  const base = process.env.LIVE_EXECUTOR_BASE_URL;
  const secret = process.env.COINOPS_EXECUTOR_HMAC_SECRET;
  if (!ip || base !== `https://${ip}` || !secret) throw new Error("COINOPS_ADMIN_EXECUTOR_UNAVAILABLE");
  const path = "/v1/admin/credentials";
  const key = `CREDENTIAL:${requestId}`;
  const body = JSON.stringify(input);
  const response = await fetch(`${base}${path}`, { method: "POST", cache: "no-store",
    headers: signedExecutorHeaders(secret, path, body, key), body, signal: AbortSignal.timeout(30_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === "string" && /^EXECUTOR_[A-Z0-9_]+$/.test(result.error)
    ? result.error : "COINOPS_ADMIN_EXECUTOR_UNAVAILABLE");
  if (result.exchange_account_id !== input.exchange_account_id || result.operator_id !== input.operator_id
    || result.environment !== input.environment || result.apiKey || result.apiSecret)
    throw new Error("COINOPS_ADMIN_EXECUTOR_SCOPE_MISMATCH");
  return result;
}

export async function GET() {
  try {
    const { operator, service } = await adminScope();
    const [accounts, checks, engines] = await Promise.all([
      service.from("exchange_accounts").select("id,display_name,status,kill_switch,is_legacy_default,credential_ref")
        .eq("operator_id", operator.id).order("created_at"),
      service.from("account_onboarding_checks").select("exchange_account_id,status,evidence,checked_at")
        .eq("operator_id", operator.id).eq("check_key", "BINANCE_CREDENTIAL").order("checked_at", { ascending: false }).limit(100),
      service.from("trading_engines").select("id,exchange_account_id,environment,symbol,quote_asset,status,hard_cap_quote,config")
        .eq("operator_id", operator.id).in("environment", ["REAL", "TESTNET"]).order("symbol"),
    ]);
    if (accounts.error || checks.error || engines.error) throw new Error("COINOPS_ADMIN_READ_FAILED");
    const latest = new Map<string, { status: string; evidence: Record<string, unknown>; checked_at: string }>();
    for (const check of checks.data ?? []) if (!latest.has(check.exchange_account_id))
      latest.set(check.exchange_account_id, check);
    return json({ accounts: (accounts.data ?? []).map((account) => ({ id: account.id, name: account.display_name,
      status: account.status, killSwitch: account.kill_switch, legacy: account.is_legacy_default,
      credentialRef: account.is_legacy_default ? null : account.credential_ref,
      validation: latest.get(account.id) ?? null })),
      engines: (engines.data ?? []).map((engine) => ({ id: engine.id,
        accountId: engine.exchange_account_id, environment: engine.environment,
        symbol: engine.symbol, quoteAsset: engine.quote_asset, status: engine.status, hardCap: engine.hard_cap_quote,
        slotCount: engine.config?.slot_count ?? null,
        initialSlotQuote: engine.config?.initial_slot_quote ?? null })) });
  } catch { return json({ error: "COINOPS_ADMIN_UNAVAILABLE" }, 403); }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request.headers.get("origin"), request.nextUrl.origin,
      request.headers.get("sec-fetch-site"), request.headers.get("x-coinops-admin-intent"),
      request.headers.get("content-type"));
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4096) throw new Error("COINOPS_ADMIN_BODY_TOO_LARGE");
    const input = JSON.parse(raw) as CredentialIntent;
    validateCredentialIntent(input);
    const { operator, service } = await adminScope();
    const accountId = input.accountId!, operation = input.operation!, requestId = input.requestId!;
    const accountRead = await service.from("exchange_accounts")
      .select("id,operator_id,display_name,status,kill_switch,is_legacy_default,credential_ref")
      .eq("id", accountId).maybeSingle();
    if (accountRead.error) throw new Error("COINOPS_ADMIN_READ_FAILED");
    let account = accountRead.data;
    assertOwnedAccount(account, operator.id);
    if (!account && operation === "CONNECT") {
      const inserted = await service.from("exchange_accounts").insert({ id: accountId, operator_id: operator.id,
        display_name: input.displayName!.trim(), status: "INACTIVE", kill_switch: true,
        is_legacy_default: false, credential_ref: `account_${accountId.replaceAll("-", "")}`,
        executor_profile: "coinops-fixed-ip" })
        .select("id,operator_id,display_name,status,kill_switch,is_legacy_default,credential_ref").single();
      if (inserted.error || !inserted.data) throw new Error("COINOPS_ADMIN_ACCOUNT_CREATE_FAILED");
      account = inserted.data;
    }
    if (!account || !["INACTIVE", "DISABLED", "ACTIVE"].includes(account.status)
      || operation !== "REVALIDATE" && (account.kill_switch !== true || account.status === "ACTIVE")
      || ["CONNECT", "REPLACE"].includes(operation) && account.status !== "INACTIVE")
      throw new Error("COINOPS_ADMIN_ACCOUNT_NOT_INACTIVE");
    if (operation === "CONNECT" && account.display_name !== input.displayName?.trim())
      throw new Error("COINOPS_ADMIN_ACCOUNT_DENIED");
    const engines = await service.from("trading_engines").select("id,environment,status,kill_switch")
      .eq("operator_id", operator.id).eq("exchange_account_id", accountId);
    if (engines.error) throw new Error("COINOPS_ADMIN_READ_FAILED");
    const environments = new Set((engines.data ?? []).filter((engine) => engine.environment !== "SHADOW")
      .map((engine) => engine.environment));
    const history = await service.from("account_onboarding_checks").select("evidence")
      .eq("operator_id", operator.id).eq("exchange_account_id", accountId)
      .eq("check_key", "BINANCE_CREDENTIAL").order("checked_at", { ascending: false }).limit(1);
    if (history.error) throw new Error("COINOPS_ADMIN_READ_FAILED");
    const recordedEnvironment = history.data?.[0]?.evidence?.environment as string | undefined;
    const environment = operation === "CONNECT" ? input.environment!
      : recordedEnvironment ?? [...environments][0] ?? (operation === "REVALIDATE" ? input.environment : undefined);
    if (!["REAL", "TESTNET"].includes(environment ?? "") || environments.size > 1
      || environments.size === 1 && !environments.has(environment)
      || operation === "CONNECT" && recordedEnvironment && recordedEnvironment !== environment)
      throw new Error("COINOPS_ADMIN_ENVIRONMENT_MISMATCH");
    if (["DEACTIVATE", "REMOVE", "REPLACE"].includes(operation)) {
      if ((engines.data ?? []).some((engine) => engine.status !== "INACTIVE" || !engine.kill_switch))
        throw new Error("COINOPS_ADMIN_ENGINE_ACTIVE");
      const [liveRuns, testnetRuns] = await Promise.all([
        service.from("robot_v1_live_runs").select("id")
          .eq("exchange_account_id", accountId).in("status", ["PREPARING", "ACTIVE", "PAUSED"]).limit(1),
        service.from("robot_v1_testnet_runs").select("id")
          .eq("exchange_account_id", accountId).in("status", ["ACTIVE", "PAUSED"]).limit(1),
      ]);
      if (liveRuns.error || testnetRuns.error || (liveRuns.data?.length ?? 0) > 0
        || (testnetRuns.data?.length ?? 0) > 0)
        throw new Error("COINOPS_ADMIN_POSITION_REVIEW_REQUIRED");
    }
    if (operation === "DEACTIVATE") {
      const disabled = await service.from("exchange_accounts").update({ status: "DISABLED", kill_switch: true })
        .eq("id", accountId).eq("operator_id", operator.id).eq("status", "INACTIVE");
      if (disabled.error) throw new Error("COINOPS_ADMIN_DEACTIVATE_FAILED");
      return json({ status: "DISABLED", accountId });
    }
    if (operation === "REPLACE" && !recordedEnvironment)
      throw new Error("COINOPS_ADMIN_CREDENTIAL_NOT_FOUND");
    const result = await callExecutor({ operator_id: operator.id, exchange_account_id: accountId,
      credential_ref: account.credential_ref, environment, operation,
      request_id: requestId,
      ...(["CONNECT", "REPLACE"].includes(operation) ? { apiKey: input.apiKey, apiSecret: input.apiSecret } : {}) }, requestId);
    const evidence = { environment, status: result.status ?? (result.removed ? "REMOVED" : "NO_CHANGE"),
      fingerprint: result.fingerprint ?? null, credential_ref: result.credential_ref ?? account.credential_ref,
      executor_ip: result.executorIp ?? null, whitelist_accepted: result.whitelistAccepted ?? null,
      permission: result.permission ?? null, account_identity: result.accountIdentity ?? null,
      balances: result.balances ?? null, validated_at: result.validatedAt ?? null };
    const recorded = await service.from("account_onboarding_checks").upsert({ operator_id: operator.id,
      exchange_account_id: accountId, check_key: "BINANCE_CREDENTIAL",
      status: result.status === "PASS" ? "PASS" : "FAIL", evidence,
      created_by: operator.user_id, idempotency_key: `credential:${requestId}` },
    { onConflict: "exchange_account_id,idempotency_key", ignoreDuplicates: true });
    if (recorded.error) throw new Error("COINOPS_ADMIN_AUDIT_FAILED");
    const registry = operation === "REMOVE" || account.status !== "INACTIVE" ? null : await syncInactiveBinanceAccount(service, operator.id,
      accountId, account.credential_ref, environment as "REAL" | "TESTNET");
    return json({ accountId, ...evidence, registry });
  } catch (error) {
    const code = error instanceof Error && /^(?:COINOPS|EXECUTOR)_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_ADMIN_UNAVAILABLE";
    return json({ error: code }, code.includes("AUTH") ? 401 : code.includes("UNAVAILABLE") ? 503 : 403);
  }
}

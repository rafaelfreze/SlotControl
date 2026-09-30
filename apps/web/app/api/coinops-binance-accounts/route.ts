import { NextRequest, NextResponse } from "next/server";
import { assertOperationalEnvironment } from "@/lib/execution/testnet-policy";
import { signedExecutorHeaders } from "@/lib/execution/live-executor-client";
import { requireLiveIdentityCoverage } from "@/lib/execution/initial-identity-bootstrap";
import { resolveExecutorForAccount, resolveExecutorShard, withExecutorShard } from "@/lib/execution/executor-shards-server";
import { assertRetiredRegistry, reassignStagedAccount } from "@/lib/execution/staged-shard-reassignment";
import { claimAccountIdentity } from "@/lib/execution/binance-identity-server";
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
  const executor = await resolveExecutorForAccount(String(input.operator_id), String(input.exchange_account_id));
  const path = "/v1/admin/credentials";
  const key = `CREDENTIAL:${requestId}`;
  const body = JSON.stringify(withExecutorShard(input, executor));
  const response = await fetch(`${executor.base}${path}`, { method: "POST", cache: "no-store",
    headers: signedExecutorHeaders(executor.secret, path, body, key), body, signal: AbortSignal.timeout(30_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === "string" && /^EXECUTOR_[A-Z0-9_]+$/.test(result.error)
    ? result.error : "COINOPS_ADMIN_EXECUTOR_UNAVAILABLE");
  if (result.exchange_account_id !== input.exchange_account_id || result.operator_id !== input.operator_id
    || result.environment !== input.environment || result.apiKey || result.apiSecret)
    throw new Error("COINOPS_ADMIN_EXECUTOR_SCOPE_MISMATCH");
  if (executor.shardId !== "executor-01" && result.executor_shard_id !== executor.shardId
    || result.executor_shard_id && result.executor_shard_id !== executor.shardId)
    throw new Error("COINOPS_ADMIN_EXECUTOR_SCOPE_MISMATCH");
  return result;
}

export async function GET() {
  try {
    const { operator, service } = await adminScope();
    const [accounts, checks, engines, shards] = await Promise.all([
      service.from("exchange_accounts").select("id,display_name,status,kill_switch,is_legacy_default,credential_ref,executor_shard_id,onboarding_environment")
        .eq("operator_id", operator.id).in("status", ["ACTIVE", "INACTIVE"]).order("created_at"),
      service.from("account_onboarding_checks").select("exchange_account_id,status,evidence,checked_at")
        .eq("operator_id", operator.id).eq("check_key", "BINANCE_CREDENTIAL").order("checked_at", { ascending: false }).limit(100),
      service.from("trading_engines").select("id,exchange_account_id,environment,symbol,quote_asset,status,hard_cap_quote,config")
        .eq("operator_id", operator.id).eq("environment", "REAL").order("symbol"),
      service.from("executor_shards").select("id,egress_ipv4"),
    ]);
    if (accounts.error || checks.error || engines.error || shards.error) throw new Error("COINOPS_ADMIN_READ_FAILED");
    const latest = new Map<string, { status: string; evidence: Record<string, unknown>; checked_at: string }>();
    for (const check of checks.data ?? []) if (!latest.has(check.exchange_account_id))
      latest.set(check.exchange_account_id, check);
    return json({ accounts: (accounts.data ?? []).map((account) => ({ id: account.id, name: account.display_name,
      status: account.status, killSwitch: account.kill_switch, legacy: account.is_legacy_default,
      shardId: account.executor_shard_id,
      executorIp: (shards.data ?? []).find((shard) => shard.id === account.executor_shard_id)?.egress_ipv4 ?? null,
      onboardingEnvironment: account.onboarding_environment,
      credentialRef: account.is_legacy_default ? null : account.credential_ref,
      validation: latest.get(account.id) ?? null })),
      engines: (engines.data ?? []).filter((engine) => (accounts.data ?? []).some((account) =>
        account.id === engine.exchange_account_id)).map((engine) => ({ id: engine.id,
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
    assertOperationalEnvironment(input.environment ?? "REAL");
    const { operator, service } = await adminScope();
    const accountId = input.accountId!, operation = input.operation!, requestId = input.requestId!;
    if (operation === "ASSIGN") {
      if (input.environment === "REAL")
        await requireLiveIdentityCoverage(service, getCoinOpsServiceTenantId()!);
      const assigned = await service.rpc("assign_executor_shard", { p_operator_id: operator.id,
        p_account_id: accountId, p_display_name: input.displayName!.trim(),
        p_environment: input.environment!, p_planned_engines: input.plannedEngines!, p_request_id: requestId });
      if (assigned.error || !assigned.data) throw new Error("COINOPS_ADMIN_ASSIGNMENT_FAILED");
      if (assigned.data.code !== "ASSIGNED") throw new Error(assigned.data.code === "CAPACITY_REQUIRED"
        ? "COINOPS_CAPACITY_REQUIRED" : "COINOPS_CAPACITY_UNKNOWN");
      return json(assigned.data);
    }
    const accountRead = await service.from("exchange_accounts")
      .select("id,operator_id,display_name,status,kill_switch,is_legacy_default,credential_ref,executor_shard_id,onboarding_environment")
      .eq("id", accountId).maybeSingle();
    if (accountRead.error) throw new Error("COINOPS_ADMIN_READ_FAILED");
    const account = accountRead.data;
    assertOwnedAccount(account, operator.id);
    assertOperationalEnvironment(account?.onboarding_environment ?? "REAL");
    if (operation === "REASSIGN_STAGED") {
      if (!account) throw new Error("COINOPS_ADMIN_ACCOUNT_DENIED");
      return json(await reassignStagedAccount({
        check: async (preview, originRetired) => {
          const result = await service.rpc("reassign_staged_executor_shard", {
            p_operator_id: operator.id, p_account_id: accountId, p_from_shard: input.fromShardId!,
            p_to_shard: input.toShardId!, p_request_id: requestId,
            p_preview: preview, p_origin_retired: originRetired });
          if (result.error || !result.data) throw new Error(
            /^COINOPS_[A-Z0-9_]+$/.test(result.error?.message ?? "")
              ? result.error!.message : "COINOPS_STAGED_REASSIGNMENT_FAILED");
          return result.data;
        },
        retire: async () => {
          // Preview independently checks the stored source. Never resolve from
          // a cached account binding or copy its vault to the destination.
          if (account.executor_shard_id !== input.fromShardId || account.status !== "INACTIVE" || !account.kill_switch)
            throw new Error("COINOPS_STAGED_REASSIGNMENT_DENIED");
          const source = resolveExecutorShard(account.executor_shard_id);
          const path = "/v1/admin/registry", key = `REGISTRY:${requestId}`;
          const body = JSON.stringify(withExecutorShard({ operator_id: operator.id,
            exchange_account_id: accountId, credential_ref: account.credential_ref,
            environment: "REAL", request_id: requestId, engines: [] }, source));
          const response = await fetch(`${source.base}${path}`, { method: "POST", cache: "no-store",
            headers: signedExecutorHeaders(source.secret, path, body, key), body,
            signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw new Error("COINOPS_SOURCE_REGISTRY_RETIREMENT_FAILED");
          assertRetiredRegistry(await response.json(), operator.id, accountId, source.shardId);
        },
      }));
    }
    if (!account && operation === "CONNECT") throw new Error("COINOPS_ADMIN_ASSIGNMENT_REQUIRED");
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
      : recordedEnvironment ?? account.onboarding_environment ?? [...environments][0]
        ?? (operation === "REVALIDATE" ? input.environment : undefined);
    assertOperationalEnvironment(environment ?? "REAL");
    if (!["REAL", "TESTNET"].includes(environment ?? "") || environments.size > 1
      || environments.size === 1 && !environments.has(environment)
      || operation === "CONNECT" && recordedEnvironment && recordedEnvironment !== environment
      || account.onboarding_environment && account.onboarding_environment !== environment)
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
    // New onboarding must claim physical ownership globally before a registry
    // can be staged. A rejected claim leaves only encrypted, nonoperating credentials.
    // Old executor01 accounts retain their existing validation/recovery behavior.
    if (operation !== "REMOVE" && (account.onboarding_environment || account.executor_shard_id !== "executor-01"))
      await claimAccountIdentity(service, operator.id, accountId, environment as "REAL" | "TESTNET",
        result.uidHash ?? (environment === "TESTNET" ? result.credentialHash : null));
    const evidence = { environment, executor_shard_id: account.executor_shard_id,
      identity_source: result.uidHash ? "BINANCE_UID" : environment === "TESTNET" && result.credentialHash ? "TESTNET_API_KEY" : null,
      status: result.status ?? (result.removed ? "REMOVED" : "NO_CHANGE"),
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

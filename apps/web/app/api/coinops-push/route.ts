import { NextRequest, NextResponse } from "next/server";

import { endpointHash, pushPublicKey, sendToDevice } from "@/lib/coinops-notifications/push-server";
import { alertDeepLink, publicPushReason } from "@/lib/coinops-notifications/push-policy";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

async function scope() {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_PUSH_SCHEMA_DENIED");
  const tenantId = getCoinOpsServiceTenantId();
  const user = (await createClient().auth.getUser()).data.user;
  if (!tenantId || !user) throw new Error("COINOPS_PUSH_AUTH_REQUIRED");
  const operator = await createClient().from("operators").select("id,user_id,product_id,tenant_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (operator.error || !operator.data) throw new Error("COINOPS_PUSH_OPERATOR_DENIED");
  return { operator: operator.data, service: createServiceRoleClient() };
}

function sameOrigin(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin
    || request.headers.get("sec-fetch-site") === "cross-site"
    || request.headers.get("content-type")?.split(";")[0] !== "application/json"
    || request.headers.get("x-coinops-admin-intent") !== "push-device")
    throw new Error("COINOPS_PUSH_ORIGIN_DENIED");
}

export async function GET(request: NextRequest) {
  try {
    const { operator, service } = await scope();
    const alertId = request.nextUrl.searchParams.get("alert");
    if (alertId) {
      if (!/^[0-9a-f-]{36}$/i.test(alertId)) throw new Error("COINOPS_PUSH_ALERT_ID_INVALID");
      const alert = await service.from("robot_v1_live_alerts")
        .select("id,exchange_account_id,trading_engine_id,severity,code,first_seen_at,resolved_at")
        .eq("id", alertId).eq("operator_id", operator.id).single();
      if (alert.error || !alert.data) throw new Error("COINOPS_PUSH_ALERT_DENIED");
      const [account, engine] = await Promise.all([
        service.from("exchange_accounts").select("display_name").eq("id", alert.data.exchange_account_id)
          .eq("operator_id", operator.id).single(),
        service.from("trading_engines").select("symbol,environment").eq("id", alert.data.trading_engine_id)
          .eq("operator_id", operator.id).eq("exchange_account_id", alert.data.exchange_account_id).single(),
      ]);
      if (account.error || engine.error || !account.data || !engine.data)
        throw new Error("COINOPS_PUSH_ALERT_DENIED");
      return json({ alert: { id: alert.data.id, account: account.data.display_name,
        symbol: engine.data.symbol, environment: engine.data.environment,
        severity: alert.data.severity, reason: publicPushReason(alert.data.code),
        openedAt: alert.data.first_seen_at, resolvedAt: alert.data.resolved_at } });
    }
    const result = await service.from("operator_push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("operator_id", operator.id).eq("user_id", operator.user_id).eq("enabled", true);
    if (result.error) throw new Error("COINOPS_PUSH_SUBSCRIPTION_READ_FAILED");
    return json({ publicKey: pushPublicKey(), activeDeviceCount: result.count ?? 0 });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "COINOPS_PUSH_UNAVAILABLE" }, 403); }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const { operator, service } = await scope();
    const input = await request.json();
    const action = input?.action;
    if (!["REGISTER", "STATUS", "TEST", "DISABLE", "PREFERENCES", "TESTNET_PROBE"].includes(action))
      throw new Error("COINOPS_PUSH_ACTION_INVALID");
    if (action === "TESTNET_PROBE") {
      if (typeof input.engineId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.engineId))
        throw new Error("COINOPS_PUSH_TESTNET_SCOPE_INVALID");
      const engine = await service.from("trading_engines")
        .select("id,operator_id,exchange_account_id,base_asset,symbol,environment,quote_asset")
        .eq("id", input.engineId).eq("operator_id", operator.id).eq("environment", "TESTNET").single();
      if (engine.error || !engine.data) throw new Error("COINOPS_PUSH_TESTNET_SCOPE_INVALID");
      const account = await service.from("exchange_accounts").select("display_name,status")
        .eq("id", engine.data.exchange_account_id).eq("operator_id", operator.id).single();
      if (account.error || !account.data || account.data.status !== "ACTIVE")
        throw new Error("COINOPS_PUSH_TESTNET_SCOPE_INVALID");
      const key = `testnet-push-probe:${engine.data.id}:${Math.floor(Date.now() / 60_000)}`;
      const previous = await service.from("account_onboarding_checks").select("id,status")
        .eq("exchange_account_id", engine.data.exchange_account_id).eq("idempotency_key", key).maybeSingle();
      if (previous.error) throw new Error("COINOPS_PUSH_TESTNET_PROBE_FAILED");
      if (previous.data) return json({ delivered: false, source: "TESTNET", alreadyQueued: true });
      const devices = await service.from("operator_push_subscriptions")
        .select("id,endpoint,p256dh,auth_secret").eq("operator_id", operator.id)
        .eq("user_id", operator.user_id).eq("enabled", true).limit(10);
      if (devices.error || !devices.data?.length) throw new Error("COINOPS_PUSH_DEVICE_NOT_REGISTERED");
      // A controlled Testnet probe is not a LIVE alert. The LIVE alert table
      // enforces REAL engine context; recording the probe there always fails.
      const probe = await service.from("account_onboarding_checks").insert({
        operator_id: operator.id, exchange_account_id: engine.data.exchange_account_id,
        trading_engine_id: engine.data.id, check_key: "TESTNET_PUSH_PROBE", status: "PENDING",
        evidence: { controlled: true, environment: "TESTNET", symbol: engine.data.symbol,
          device_count: devices.data.length }, created_by: operator.user_id, idempotency_key: key,
      }).select("id").single();
      if (probe.error || !probe.data) {
        if (probe.error?.code === "23505") return json({ source: "TESTNET", alreadySent: true });
        throw new Error("COINOPS_PUSH_TESTNET_PROBE_FAILED");
      }
      let sent = 0;
      const recordResult = (status: "PASS" | "FAIL", reason?: string) =>
        service.from("account_onboarding_checks").insert({
          operator_id: operator.id, exchange_account_id: engine.data.exchange_account_id,
          trading_engine_id: engine.data.id, check_key: "TESTNET_PUSH_RESULT", status,
          evidence: { controlled: true, environment: "TESTNET", symbol: engine.data.symbol,
            device_count: devices.data.length, sent, ...(reason ? { reason } : {}) },
          created_by: operator.user_id, idempotency_key: `${key}:result`,
        });
      try {
        for (const device of devices.data) {
          await sendToDevice(device, { title: "CoinOps — teste Testnet",
            body: `${account.data.display_name} · ${engine.data.symbol} · ${publicPushReason("TESTNET_PUSH_PROBE")}`,
            url: alertDeepLink(engine.data.exchange_account_id, engine.data.symbol, "TESTNET"),
            tag: `testnet-probe:${probe.data.id}` });
          sent++;
        }
      } catch (error) {
        await recordResult("FAIL", "DELIVERY_FAILED");
        throw error;
      }
      const recorded = await recordResult("PASS");
      if (recorded.error) throw new Error("COINOPS_PUSH_TESTNET_PROBE_AUDIT_FAILED");
      return json({ delivered: true, source: "TESTNET", deviceCount: sent });
    }
    const endpoint = input?.subscription?.endpoint;
    if (typeof endpoint !== "string") throw new Error("COINOPS_PUSH_ENDPOINT_INVALID");
    const hash = endpointHash(endpoint);
    const owned = await service.from("operator_push_subscriptions")
      .select("id,endpoint,p256dh,auth_secret,enabled,warning_enabled,last_test_at,last_success_at,last_failure_code")
      .eq("operator_id", operator.id).eq("user_id", operator.user_id).eq("endpoint_hash", hash).maybeSingle();
    if (owned.error) throw new Error("COINOPS_PUSH_SUBSCRIPTION_READ_FAILED");
    if (action === "STATUS") return json({ active: Boolean(owned.data?.enabled),
      warningEnabled: owned.data?.warning_enabled ?? true,
      lastSuccessAt: owned.data?.last_success_at ?? null,
      lastFailureCode: owned.data?.last_failure_code ?? null });
    if (action === "REGISTER") {
      const keys = input?.subscription?.keys;
      if (typeof keys?.p256dh !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(keys.p256dh)
        || typeof keys?.auth !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(keys.auth))
        throw new Error("COINOPS_PUSH_KEYS_INVALID");
      if (owned.data?.enabled) return json({ active: true, alreadyRegistered: true });
      await sendToDevice({ endpoint, p256dh: keys.p256dh, auth_secret: keys.auth },
        { title: "CoinOps — notificações ativas", body: "Este dispositivo receberá alertas operacionais.",
          url: "/automacao?view=live", tag: "coinops-device-setup" });
      const result = await service.from("operator_push_subscriptions").upsert({
        operator_id: operator.id, user_id: operator.user_id, endpoint_hash: hash, endpoint,
        p256dh: keys.p256dh, auth_secret: keys.auth,
        user_agent_label: /iPhone|iPad/i.test(request.headers.get("user-agent") ?? "") ? "iPhone/iPad" : "Navegador",
        enabled: true, last_success_at: new Date().toISOString(), last_failure_code: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,endpoint_hash" });
      if (result.error) throw new Error("COINOPS_PUSH_REGISTER_FAILED");
      return json({ active: true, tested: true });
    }
    if (!owned.data?.enabled) throw new Error("COINOPS_PUSH_DEVICE_NOT_REGISTERED");
    if (action === "DISABLE") {
      const result = await service.from("operator_push_subscriptions")
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq("id", owned.data.id).eq("operator_id", operator.id).eq("user_id", operator.user_id);
      if (result.error) throw new Error("COINOPS_PUSH_DISABLE_FAILED");
      return json({ active: false });
    }
    if (action === "PREFERENCES") {
      if (typeof input.warningEnabled !== "boolean") throw new Error("COINOPS_PUSH_PREFERENCES_INVALID");
      const result = await service.from("operator_push_subscriptions")
        .update({ warning_enabled: input.warningEnabled, updated_at: new Date().toISOString() })
        .eq("id", owned.data.id).eq("operator_id", operator.id).eq("user_id", operator.user_id);
      if (result.error) throw new Error("COINOPS_PUSH_PREFERENCES_FAILED");
      return json({ active: true, warningEnabled: input.warningEnabled });
    }
    if (owned.data.last_test_at && Date.now() - Date.parse(owned.data.last_test_at) < 60_000)
      throw new Error("COINOPS_PUSH_TEST_COOLDOWN");
    let reserveQuery = service.from("operator_push_subscriptions")
      .update({ last_test_at: new Date().toISOString() })
      .eq("id", owned.data.id).eq("operator_id", operator.id).eq("user_id", operator.user_id);
    reserveQuery = owned.data.last_test_at
      ? reserveQuery.eq("last_test_at", owned.data.last_test_at) : reserveQuery.is("last_test_at", null);
    const reserved = await reserveQuery.select("id");
    if (reserved.error || !reserved.data?.length) throw new Error("COINOPS_PUSH_TEST_COOLDOWN");
    await sendToDevice(owned.data, { title: "CoinOps — teste", body: "Notificações operacionais funcionando neste dispositivo.",
      url: "/automacao?view=live", tag: "coinops-device-test" });
    const result = await service.from("operator_push_subscriptions")
      .update({ last_success_at: new Date().toISOString(), last_failure_code: null })
      .eq("id", owned.data.id).eq("operator_id", operator.id).eq("user_id", operator.user_id);
    if (result.error) throw new Error("COINOPS_PUSH_TEST_AUDIT_FAILED");
    return json({ delivered: true });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_PUSH_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_PUSH_REQUEST_FAILED";
    return json({ error: code }, code.includes("AUTH") || code.includes("DENIED") ? 403 : 400);
  }
}

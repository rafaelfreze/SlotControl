import { createHash } from "node:crypto";
import webpush from "web-push";

import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { alertDeepLink, publicPushReason, shouldPush, validPushEndpoint } from "./push-policy";

type Service = ReturnType<typeof createServiceRoleClient>;
type Subscription = { id: string; operator_id: string; user_id: string; endpoint: string;
  p256dh: string; auth_secret: string; warning_enabled: boolean };
type Alert = { id: string; operator_id: string; exchange_account_id: string;
  trading_engine_id: string; severity: "WARNING" | "CRITICAL"; code: string;
  first_seen_at: string; resolved_at: string | null };

function configuredWebPush() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) throw new Error("COINOPS_PUSH_VAPID_UNCONFIGURED");
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new Error("COINOPS_PUSH_VAPID_PUBLIC_FORMAT_INVALID");
  if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw new Error("COINOPS_PUSH_VAPID_PRIVATE_FORMAT_INVALID");
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:onplaymkt@gmail.com", publicKey, privateKey);
  } catch { throw new Error("COINOPS_PUSH_VAPID_INVALID"); }
  return { publicKey, webpush };
}

export function pushPublicKey() { return configuredWebPush().publicKey; }

export function endpointHash(endpoint: string) {
  if (!validPushEndpoint(endpoint)) throw new Error("COINOPS_PUSH_ENDPOINT_INVALID");
  return createHash("sha256").update(endpoint).digest("hex");
}

export async function sendToDevice(subscription: Pick<Subscription, "endpoint" | "p256dh" | "auth_secret">,
  message: { title: string; body: string; url: string; tag: string }) {
  configuredWebPush();
  await webpush.sendNotification({ endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth_secret } },
  JSON.stringify(message), { TTL: 3600, timeout: 5000, urgency: "high",
    topic: createHash("sha256").update(message.tag).digest("base64url").slice(0, 32) });
}

async function discoverHeartbeatAlerts(service: Service) {
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new Error("COINOPS_PUSH_SCOPE_INVALID");
  const runs = await service.from("robot_v1_live_runs")
    .select("id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,status,last_reconciled_at,created_at")
    .eq("tenant_id", tenantId).eq("status", "ACTIVE");
  if (runs.error) throw new Error("COINOPS_PUSH_HEARTBEAT_READ_FAILED");
  const ids = (runs.data ?? []).map((row) => row.trading_engine_id);
  if (!ids.length) return 0;
  const [engines, operators, accounts] = await Promise.all([
    service.from("trading_engines").select("id,status,kill_switch").in("id", ids).eq("environment", "REAL"),
    service.from("operators").select("id,status,kill_switch")
      .in("id", [...new Set((runs.data ?? []).map((run) => run.operator_id))]),
    service.from("exchange_accounts").select("id,operator_id,status,kill_switch")
      .in("id", [...new Set((runs.data ?? []).map((run) => run.exchange_account_id))]),
  ]);
  if (engines.error || operators.error || accounts.error) throw new Error("COINOPS_PUSH_ENGINE_READ_FAILED");
  const critical = await service.from("robot_v1_live_alerts")
    .select("trading_engine_id,alert_key").eq("tenant_id", tenantId)
    .in("trading_engine_id", ids).eq("severity", "CRITICAL").is("resolved_at", null);
  if (critical.error) throw new Error("COINOPS_PUSH_CRITICAL_READ_FAILED");
  const byId = new Map((engines.data ?? []).map((row) => [row.id, row]));
  const operatorById = new Map((operators.data ?? []).map((row) => [row.id, row]));
  const accountById = new Map((accounts.data ?? []).map((row) => [row.id, row]));
  const now = Date.now();
  let stale = 0;
  for (const run of runs.data ?? []) {
    const engine = byId.get(run.trading_engine_id);
    const operator = operatorById.get(run.operator_id);
    const account = accountById.get(run.exchange_account_id);
    if (!engine || engine.status !== "ACTIVE" || !operator || !account
      || account.operator_id !== operator.id) continue;
    const killSwitch = engine.kill_switch || operator.kill_switch || account.kill_switch
      || operator.status !== "ACTIVE" || account.status !== "ACTIVE";
    const last = Date.parse(run.last_reconciled_at ?? run.created_at);
    const key = `LIVE_RUN:${run.id}:HEARTBEAT`;
    if (!killSwitch && Number.isFinite(last) && now - last > 15 * 60_000) {
      const result = await service.from("robot_v1_live_alerts").upsert({
        product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id,
        operator_id: run.operator_id, exchange_account_id: run.exchange_account_id,
        trading_engine_id: run.trading_engine_id, asset: run.asset,
        alert_key: key, severity: "CRITICAL", code: "ENGINE_HEARTBEAT_STALE",
        details: { run_id: run.id }, last_seen_at: new Date().toISOString(), resolved_at: null,
      }, { onConflict: "trading_engine_id,alert_key" });
      if (result.error) throw new Error("COINOPS_PUSH_HEARTBEAT_WRITE_FAILED");
      stale++;
    } else {
      const result = await service.from("robot_v1_live_alerts")
        .update({ resolved_at: new Date().toISOString(), last_seen_at: new Date().toISOString() })
        .eq("trading_engine_id", run.trading_engine_id).eq("alert_key", key).is("resolved_at", null);
      if (result.error) throw new Error("COINOPS_PUSH_HEARTBEAT_RESOLVE_FAILED");
    }
    const killKey = `LIVE_RUN:${run.id}:KILL_SWITCH`;
    const otherCritical = (critical.data ?? []).some((item) => item.trading_engine_id === run.trading_engine_id
      && item.alert_key !== killKey);
    if (killSwitch && !otherCritical) {
      const result = await service.from("robot_v1_live_alerts").upsert({
        product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id,
        operator_id: run.operator_id, exchange_account_id: run.exchange_account_id,
        trading_engine_id: run.trading_engine_id, asset: run.asset,
        alert_key: killKey, severity: "CRITICAL", code: "ENGINE_KILL_SWITCH_ON",
        details: { run_id: run.id }, last_seen_at: new Date().toISOString(), resolved_at: null,
      }, { onConflict: "trading_engine_id,alert_key" });
      if (result.error) throw new Error("COINOPS_PUSH_KILL_SWITCH_WRITE_FAILED");
    } else {
      const result = await service.from("robot_v1_live_alerts")
        .update({ resolved_at: new Date().toISOString(), last_seen_at: new Date().toISOString() })
        .eq("trading_engine_id", run.trading_engine_id).eq("alert_key", killKey).is("resolved_at", null);
      if (result.error) throw new Error("COINOPS_PUSH_KILL_SWITCH_RESOLVE_FAILED");
    }
  }
  return stale;
}

export async function dispatchOperationalPush() {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_PUSH_SCHEMA_INVALID");
  configuredWebPush();
  const service = createServiceRoleClient();
  let stale: number;
  try { stale = await discoverHeartbeatAlerts(service); }
  catch (error) {
    if (error instanceof Error && /^COINOPS_PUSH_[A-Z0-9_]+$/.test(error.message)) throw error;
    throw new Error("COINOPS_PUSH_HEARTBEAT_UNEXPECTED");
  }
  const alertsResult = await service.from("robot_v1_live_alerts")
    .select("id,operator_id,exchange_account_id,trading_engine_id,severity,code,first_seen_at,resolved_at")
    .eq("tenant_id", getCoinOpsServiceTenantId()).is("resolved_at", null)
    .in("severity", ["WARNING", "CRITICAL"]).order("first_seen_at", { ascending: false }).limit(200);
  if (alertsResult.error) throw new Error("COINOPS_PUSH_ALERT_READ_FAILED");
  const alerts = (alertsResult.data ?? []) as Alert[];
  const operatorIds = [...new Set(alerts.map((alert) => alert.operator_id))];
  if (!operatorIds.length) {
    const cleanup = await service.from("operator_push_deliveries")
      .update({ status: "EXPIRED", error_code: "INCIDENT_CLOSED" }).eq("status", "PENDING");
    if (cleanup.error) throw new Error("COINOPS_PUSH_PENDING_CLEANUP_FAILED");
    return { status: "NO_ALERTS", stale, queued: 0, sent: 0, failed: 0 };
  }
  const [subsResult, accountsResult, enginesResult] = await Promise.all([
    service.from("operator_push_subscriptions").select("id,operator_id,user_id,endpoint,p256dh,auth_secret,warning_enabled")
      .in("operator_id", operatorIds).eq("enabled", true),
    service.from("exchange_accounts").select("id,operator_id,display_name")
      .in("id", [...new Set(alerts.map((alert) => alert.exchange_account_id))]),
    service.from("trading_engines").select("id,operator_id,exchange_account_id,symbol,environment")
      .in("id", [...new Set(alerts.map((alert) => alert.trading_engine_id))]),
  ]);
  if (subsResult.error || accountsResult.error || enginesResult.error)
    throw new Error("COINOPS_PUSH_CONTEXT_READ_FAILED");
  const subs = (subsResult.data ?? []) as Subscription[];
  const accounts = new Map((accountsResult.data ?? []).map((item) => [item.id, item]));
  const engines = new Map((enginesResult.data ?? []).map((item) => [item.id, item]));
  const candidates = alerts.flatMap((alert) => {
    const account = accounts.get(alert.exchange_account_id);
    const engine = engines.get(alert.trading_engine_id);
    if (!account || !engine || account.operator_id !== alert.operator_id
      || engine.operator_id !== alert.operator_id || engine.exchange_account_id !== alert.exchange_account_id) return [];
    const recipients = subs.filter((sub) => sub.operator_id === alert.operator_id && shouldPush(alert.severity, sub.warning_enabled));
    return recipients
      .map((sub) => ({ alert_id: alert.id, opened_at: alert.first_seen_at,
        subscription_id: sub.id, operator_id: alert.operator_id, account_id: alert.exchange_account_id,
        engine_id: alert.trading_engine_id, severity: alert.severity, device_count: recipients.length }));
  });
  if (candidates.length) {
    const queued = await service.from("operator_push_deliveries").upsert(candidates,
      { onConflict: "alert_id,opened_at,subscription_id", ignoreDuplicates: true });
    if (queued.error) throw new Error("COINOPS_PUSH_QUEUE_FAILED");
  }
  const expired = await service.from("operator_push_deliveries").update({ status: "PENDING" })
    .eq("status", "SENDING").lt("lease_until", new Date().toISOString());
  if (expired.error) throw new Error("COINOPS_PUSH_LEASE_RECOVERY_FAILED");
  const pending = await service.from("operator_push_deliveries")
    .select("id,alert_id,opened_at,subscription_id,attempt_count")
    .eq("status", "PENDING").lte("next_attempt_at", new Date().toISOString())
    .order("created_at").limit(8);
  if (pending.error) throw new Error("COINOPS_PUSH_PENDING_READ_FAILED");
  const alertByKey = new Map(alerts.map((alert) => [`${alert.id}:${alert.first_seen_at}`, alert]));
  const subById = new Map(subs.map((sub) => [sub.id, sub]));
  let sent = 0, failed = 0;
  for (const item of pending.data ?? []) {
    const alert = alertByKey.get(`${item.alert_id}:${item.opened_at}`);
    const sub = subById.get(item.subscription_id);
    if (!alert || !sub) {
      await service.from("operator_push_deliveries").update({ status: "EXPIRED", error_code: "INCIDENT_CLOSED_OR_DEVICE_DISABLED" })
        .eq("id", item.id).eq("status", "PENDING");
      continue;
    }
    const account = accounts.get(alert.exchange_account_id);
    const engine = engines.get(alert.trading_engine_id);
    if (!account || !engine) continue;
    const claim = await service.from("operator_push_deliveries")
      .update({ status: "SENDING", attempted_at: new Date().toISOString(),
        lease_until: new Date(Date.now() + 90_000).toISOString(), attempt_count: item.attempt_count + 1 })
      .eq("id", item.id).eq("status", "PENDING").select("id");
    if (claim.error) throw new Error("COINOPS_PUSH_CLAIM_FAILED");
    if (!claim.data?.length) continue;
    try {
      const fresh = await service.from("robot_v1_live_alerts").select("id")
        .eq("id", alert.id).eq("first_seen_at", alert.first_seen_at).is("resolved_at", null).maybeSingle();
      if (fresh.error) throw new Error("COINOPS_PUSH_ALERT_REFRESH_FAILED");
      if (!fresh.data) {
        await service.from("operator_push_deliveries").update({ status: "EXPIRED", lease_until: null,
          error_code: "INCIDENT_CLOSED" }).eq("id", item.id);
        continue;
      }
      await sendToDevice(sub, { title: "CoinOps — ALERTA",
        body: `${account.display_name} · ${engine.symbol.replace(/(BRL|USDT|USDC)$/, "/$1")} · ${publicPushReason(alert.code)}`,
        url: alertDeepLink(alert.exchange_account_id, engine.symbol,
          engine.environment === "TESTNET" ? "TESTNET" : "REAL", alert.id), tag: `${alert.id}:${alert.first_seen_at}` });
      const update = await service.from("operator_push_deliveries").update({ status: "SENT",
        sent_at: new Date().toISOString(), lease_until: null, error_code: null }).eq("id", item.id);
      const device = await service.from("operator_push_subscriptions")
        .update({ last_success_at: new Date().toISOString(), last_failure_code: null })
        .eq("id", sub.id).eq("operator_id", sub.operator_id);
      if (update.error || device.error) throw new Error("COINOPS_PUSH_AUDIT_WRITE_FAILED");
      sent++;
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
      const invalid = status === 404 || status === 410;
      const retry = !invalid && item.attempt_count < 2;
      await service.from("operator_push_deliveries").update({ status: invalid ? "EXPIRED" : retry ? "PENDING" : "FAILED",
        lease_until: null, next_attempt_at: new Date(Date.now() + 60_000 * (item.attempt_count + 1)).toISOString(),
        error_code: status ? `HTTP_${status}` : "DELIVERY_FAILED" }).eq("id", item.id);
      await service.from("operator_push_subscriptions").update({ last_failure_at: new Date().toISOString(),
        last_failure_code: status ? `HTTP_${status}` : "DELIVERY_FAILED", ...(invalid ? { enabled: false } : {}) })
        .eq("id", sub.id).eq("operator_id", sub.operator_id);
      failed++;
    }
  }
  const probes = alerts.filter((alert) => alert.code === "TESTNET_PUSH_PROBE");
  for (const probe of probes) {
    const delivered = await service.from("operator_push_deliveries").select("id")
      .eq("alert_id", probe.id).eq("opened_at", probe.first_seen_at).eq("status", "SENT").limit(1);
    if (delivered.error) throw new Error("COINOPS_PUSH_PROBE_AUDIT_FAILED");
    if (!delivered.data?.length && Date.now() - Date.parse(probe.first_seen_at) < 2 * 60_000) continue;
    const result = await service.from("robot_v1_live_alerts").update({ resolved_at: new Date().toISOString() })
      .eq("id", probe.id).is("resolved_at", null);
    if (result.error) throw new Error("COINOPS_PUSH_PROBE_RESOLVE_FAILED");
  }
  return { status: failed ? "PARTIAL_FAILURE" : "OK", stale, queued: candidates.length, sent, failed };
}

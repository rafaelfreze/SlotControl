import { createECDH, createHash } from "node:crypto";
import webpush from "web-push";

import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { alertDeepLink, publicBlockedPushReason, pushDeliveryErrorCode, validPushEndpoint } from "./push-policy";
import { evaluateOperationalPush, operationalAlertRunId, primaryOperationalAlerts, samePushInstant,
  OPERATIONAL_PUSH_TTL_SECONDS, type OperationalPushAlert, type OperationalPushAccount,
  type OperationalPushEngine, type OperationalPushRun, type OperationalPushIncident,
  type OperationalPushCheck } from "./operational-push-policy";

type Service = ReturnType<typeof createServiceRoleClient>;
type Subscription = { id: string; operator_id: string; user_id: string; endpoint: string;
  p256dh: string; auth_secret: string; warning_enabled: boolean };
type Alert = OperationalPushAlert;
type Pending = { id: string; alert_id: string; opened_at: string; subscription_id: string;
  operator_id: string; account_id: string; engine_id: string; attempt_count: number; error_code: string | null;
  created_at: string };
type Snapshot = { alerts: Alert[]; accounts: OperationalPushAccount[]; engines: OperationalPushEngine[];
  runs: OperationalPushRun[]; incidents: OperationalPushIncident[]; checks: OperationalPushCheck[] };
const ALERT_COLUMNS = "id,operator_id,exchange_account_id,trading_engine_id,severity,code,alert_key,details,first_seen_at,resolved_at";
const SAFE_RETRY = /^PROVIDER_REJECTED_HTTP_(429|500|502|503|504)$/;

function configuredWebPush() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) throw new Error("COINOPS_PUSH_VAPID_UNCONFIGURED");
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new Error("COINOPS_PUSH_VAPID_PUBLIC_FORMAT_INVALID");
  if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw new Error("COINOPS_PUSH_VAPID_PRIVATE_FORMAT_INVALID");
  try {
    const derived = createECDH("prime256v1");
    derived.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (derived.getPublicKey("base64url", "uncompressed") !== publicKey)
      throw new Error("COINOPS_PUSH_VAPID_PAIR_MISMATCH");
  } catch (error) {
    if (error instanceof Error && error.message === "COINOPS_PUSH_VAPID_PAIR_MISMATCH") throw error;
    throw new Error("COINOPS_PUSH_VAPID_INVALID");
  }
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

/** An HTTP rejection is distinguishable from an ambiguous timeout/connection loss. */
export class PushTransportError extends Error {
  readonly statusCode: number | undefined;
  readonly outcome: "REJECTED" | "UNKNOWN";
  constructor(status?: number) {
    super(pushDeliveryErrorCode(status));
    this.name = "PushTransportError";
    this.statusCode = Number.isInteger(status) && status! >= 400 && status! <= 599 ? status : undefined;
    this.outcome = this.statusCode ? "REJECTED" : "UNKNOWN";
  }
}

export async function sendToDevice(subscription: Pick<Subscription, "endpoint" | "p256dh" | "auth_secret">,
  message: { title: string; body: string; url: string; tag: string }, options: { ttl?: number } = {}) {
  configuredWebPush();
  try {
    await webpush.sendNotification({ endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth_secret } },
    JSON.stringify(message), { TTL: options.ttl ?? 3600, timeout: 5000, urgency: "high",
      topic: createHash("sha256").update(message.tag).digest("base64url").slice(0, 32) });
  } catch (error) {
    throw new PushTransportError((error as { statusCode?: number })?.statusCode);
  }
}

async function loadSnapshot(service: Service, tenantId: string, engineId?: string): Promise<Snapshot> {
  let query = service.from("robot_v1_live_alerts").select(ALERT_COLUMNS)
    .eq("tenant_id", tenantId).is("resolved_at", null).eq("severity", "CRITICAL");
  if (engineId) query = query.eq("trading_engine_id", engineId);
  const alertsResult = await query.order("first_seen_at").limit(201);
  if (alertsResult.error || (alertsResult.data?.length ?? 0) > 200)
    throw new Error("COINOPS_PUSH_ALERT_READ_FAILED");
  const alerts = (alertsResult.data ?? []) as Alert[];
  if (!alerts.length) return { alerts, accounts: [], engines: [], runs: [], incidents: [], checks: [] };
  const ids = (values: string[]) => [...new Set(values)];
  const engineIds = ids(alerts.map(alert => alert.trading_engine_id));
  const [accounts, engines, runs, incidents, checks] = await Promise.all([
    service.from("exchange_accounts").select("id,operator_id,display_name,status")
      .in("id", ids(alerts.map(alert => alert.exchange_account_id))),
    service.from("trading_engines")
      .select("id,operator_id,exchange_account_id,symbol,environment,executor_shard_id,status,kill_switch")
      .in("id", engineIds),
    service.from("robot_v1_live_runs")
      .select("id,operator_id,exchange_account_id,trading_engine_id,symbol,status,lease_until,last_error")
      .eq("tenant_id", tenantId).in("trading_engine_id", engineIds).in("status", ["ACTIVE", "PAUSED"]),
    service.from("watchdog_incidents")
      .select("incident_id,shard_id,engine_id,account_id,market,incident_key,detected_condition,state_after,result,opened_at,last_seen_at,resolved_at,last_recovery_attempt_at")
      .in("engine_id", engineIds).is("resolved_at", null),
    service.from("watchdog_checks").select("shard_id,checked_at,shard_state,blocked_engines"),
  ]);
  if (accounts.error || engines.error || runs.error || incidents.error || checks.error)
    throw new Error("COINOPS_PUSH_CONTEXT_READ_FAILED");
  return { alerts, accounts: accounts.data as OperationalPushAccount[] ?? [],
    engines: engines.data as OperationalPushEngine[] ?? [], runs: runs.data as OperationalPushRun[] ?? [],
    incidents: incidents.data as OperationalPushIncident[] ?? [], checks: checks.data as OperationalPushCheck[] ?? [] };
}

function contextFor(snapshot: Snapshot, alert: Alert, now: number) {
  const one = <T,>(rows: T[]) => rows.length === 1 ? rows[0] : null;
  const engine = one(snapshot.engines.filter(row => row.id === alert.trading_engine_id));
  const run = one(snapshot.runs.filter(row => row.trading_engine_id === alert.trading_engine_id
    && row.id === operationalAlertRunId(alert)));
  return { alert, engine, account: one(snapshot.accounts.filter(row => row.id === alert.exchange_account_id)), run,
    incident: one(snapshot.incidents.filter(row => row.engine_id === alert.trading_engine_id
      && row.incident_key === `${run?.id}:${alert.code}`)),
    check: one(snapshot.checks.filter(row => row.shard_id === engine?.executor_shard_id)), now };
}

function deliveryScope(item: Pending, alert: Alert, sub: Subscription) {
  return item.operator_id === alert.operator_id && item.account_id === alert.exchange_account_id
    && item.engine_id === alert.trading_engine_id && sub.operator_id === alert.operator_id
    && item.alert_id === alert.id && samePushInstant(item.opened_at, alert.first_seen_at);
}

/** A derived WATCHDOG alert and its later engine root may represent the same
 * incident. Existing delivery audit is sufficient; no schema/financial write. */
async function previousEpisodeDelivery(service: Service, item: Pending, alert: Alert,
  incident: OperationalPushIncident): Promise<"NONE" | "IN_FLIGHT" | "ALREADY_ESCALATED" | "ATTEMPTS_EXHAUSTED"> {
  const prior = await service.from("operator_push_deliveries")
    .select("id,alert_id,status,error_code,created_at,attempt_count")
    .eq("operator_id", item.operator_id).eq("account_id", item.account_id).eq("engine_id", item.engine_id)
    .eq("subscription_id", item.subscription_id).neq("id", item.id)
    .gte("attempted_at", incident.opened_at).limit(101);
  if (prior.error || (prior.data?.length ?? 0) > 100) throw new Error("COINOPS_PUSH_EPISODE_READ_FAILED");
  const records = prior.data ?? [];
  if (!records.length) return "NONE";
  const references = await service.from("robot_v1_live_alerts").select(ALERT_COLUMNS)
    .eq("operator_id", alert.operator_id).eq("exchange_account_id", alert.exchange_account_id)
    .eq("trading_engine_id", alert.trading_engine_id).eq("code", alert.code)
    .in("id", [...new Set(records.map(row => row.alert_id))]);
  if (references.error) throw new Error("COINOPS_PUSH_EPISODE_READ_FAILED");
  const sameRunIds = new Set((references.data as Alert[] ?? [])
    .filter(row => operationalAlertRunId(row) === operationalAlertRunId(alert)).map(row => row.id));
  const same = records.filter(row => sameRunIds.has(row.alert_id));
  if (same.some(row => row.status === "SENT" || ["DELIVERY_OUTCOME_UNKNOWN", "PROVIDER_ACCEPTED_AUDIT_FAILED"]
    .includes(row.error_code))) return "ALREADY_ESCALATED";
  // A peer may already be inside HTTP. Never dethrone it based on UUID/time.
  // If two claims observe each other, both defer; next tick's single canonical
  // primary expires the obsolete carrier and the remaining pending row converges.
  if (same.some(row => row.status === "SENDING")) return "IN_FLIGHT";
  if (item.attempt_count + same.reduce((sum, row) => sum + Number(row.attempt_count), 0) >= 3)
    return "ATTEMPTS_EXHAUSTED";
  return "NONE";
}

/** Escalate only a persistent, current Watchdog block. No alert/trading mutations. */
export async function dispatchOperationalPush() {
  const tenantId = getCoinOpsServiceTenantId();
  if (getSupabaseDataSchema() !== "coinops" || !tenantId) throw new Error("COINOPS_PUSH_SCHEMA_INVALID");
  configuredWebPush();
  const service = createServiceRoleClient();
  const snapshot = await loadSnapshot(service, tenantId);
  const operatorsResult = await service.from("operators").select("id,user_id")
    .eq("tenant_id", tenantId).eq("status", "ACTIVE");
  if (operatorsResult.error) throw new Error("COINOPS_PUSH_OPERATOR_READ_FAILED");
  const operators = new Map((operatorsResult.data ?? []).map(row => [row.id, row.user_id]));
  const operatorIds = [...operators.keys()];
  if (!operatorIds.length) return { status: "NO_ALERTS", stale: 0, queued: 0, sent: 0, failed: 0 };
  const subsResult = await service.from("operator_push_subscriptions")
    .select("id,operator_id,user_id,endpoint,p256dh,auth_secret,warning_enabled")
    .in("operator_id", operatorIds).eq("enabled", true);
  if (subsResult.error) throw new Error("COINOPS_PUSH_CONTEXT_READ_FAILED");
  const subs = (subsResult.data ?? []).filter(row => operators.get(row.operator_id) === row.user_id) as Subscription[];
  const primary = primaryOperationalAlerts(snapshot.alerts);
  const eligible = primary.filter(alert => evaluateOperationalPush(contextFor(snapshot, alert, Date.now())).eligible);
  const candidates = eligible.flatMap(alert => subs.filter(sub => sub.operator_id === alert.operator_id)
    .map(sub => ({ alert_id: alert.id, opened_at: alert.first_seen_at,
      subscription_id: sub.id, operator_id: alert.operator_id, account_id: alert.exchange_account_id,
      engine_id: alert.trading_engine_id, severity: alert.severity,
      device_count: subs.filter(device => device.operator_id === alert.operator_id).length })));
  if (candidates.length) {
    const queued = await service.from("operator_push_deliveries").upsert(candidates,
      { onConflict: "alert_id,opened_at,subscription_id", ignoreDuplicates: true });
    if (queued.error) throw new Error("COINOPS_PUSH_QUEUE_FAILED");
  }
  // A dead sender may already have reached the provider. Never retry that transport blindly.
  const expired = await service.from("operator_push_deliveries")
    .update({ status: "FAILED", lease_until: null, error_code: "DELIVERY_OUTCOME_UNKNOWN" })
    .in("operator_id", operatorIds).eq("status", "SENDING").lt("lease_until", new Date().toISOString());
  if (expired.error) throw new Error("COINOPS_PUSH_LEASE_RECOVERY_FAILED");
  const pending = await service.from("operator_push_deliveries")
    .select("id,alert_id,opened_at,subscription_id,operator_id,account_id,engine_id,attempt_count,error_code,created_at")
    .in("operator_id", operatorIds).eq("status", "PENDING").lte("next_attempt_at", new Date().toISOString())
    .order("created_at").limit(100);
  if (pending.error) throw new Error("COINOPS_PUSH_PENDING_READ_FAILED");
  const subById = new Map(subs.map(sub => [sub.id, sub]));
  const pendingRows = pending.data as Pending[] ?? [];
  const actionable = (item: Pending) => {
    const alert = primary.find(row => row.id === item.alert_id && samePushInstant(row.first_seen_at, item.opened_at));
    const sub = subById.get(item.subscription_id);
    return Boolean(alert && sub && deliveryScope(item, alert, sub));
  };
  const closedIds = pendingRows.filter(item => !actionable(item)).map(item => item.id);
  if (closedIds.length) {
    const ended = await service.from("operator_push_deliveries")
      .update({ status: "EXPIRED", error_code: "INCIDENT_CLOSED_OR_NOT_ACTIONABLE" })
      .in("id", closedIds).in("operator_id", operatorIds).eq("status", "PENDING");
    if (ended.error) throw new Error("COINOPS_PUSH_PENDING_CLEANUP_FAILED");
  }
  let sent = 0, failed = 0, claimedCount = 0;
  for (const item of pendingRows.filter(actionable)) {
    if (claimedCount >= 8) break;
    const alert = primary.find(row => row.id === item.alert_id && samePushInstant(row.first_seen_at, item.opened_at));
    const sub = subById.get(item.subscription_id);
    if (!alert || !sub) continue;
    if (!evaluateOperationalPush(contextFor(snapshot, alert, Date.now())).eligible) continue;
    if (item.attempt_count > 0 && !SAFE_RETRY.test(item.error_code ?? "")) {
      await service.from("operator_push_deliveries")
        .update({ status: "FAILED", error_code: "DELIVERY_OUTCOME_UNKNOWN" })
        .eq("id", item.id).eq("operator_id", item.operator_id).eq("status", "PENDING");
      continue;
    }
    if (item.attempt_count >= 3) continue;
    const claimedAt = new Date().toISOString();
    const claim = await service.from("operator_push_deliveries")
      .update({ status: "SENDING", attempted_at: claimedAt,
        lease_until: new Date(Date.now() + 90_000).toISOString(), attempt_count: item.attempt_count + 1 })
      .eq("id", item.id).eq("operator_id", item.operator_id).eq("status", "PENDING")
      .eq("attempt_count", item.attempt_count).select("id");
    if (claim.error) throw new Error("COINOPS_PUSH_CLAIM_FAILED");
    if (!claim.data?.length) continue;
    claimedCount++;
    const updateClaim = (values: Record<string, unknown>) => service.from("operator_push_deliveries")
      .update(values).eq("id", item.id).eq("operator_id", item.operator_id)
      .eq("status", "SENDING").eq("attempted_at", claimedAt).eq("attempt_count", item.attempt_count + 1);
    let previous: Awaited<ReturnType<typeof previousEpisodeDelivery>>;
    try { previous = await previousEpisodeDelivery(service, item, alert, contextFor(snapshot, alert, Date.now()).incident!); }
    catch {
      await updateClaim({ status: "PENDING", lease_until: null, attempt_count: item.attempt_count,
        error_code: item.error_code, next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
      continue;
    }
    if (previous !== "NONE") {
      await updateClaim({ status: previous === "IN_FLIGHT" ? "PENDING" : "EXPIRED", lease_until: null,
        attempt_count: item.attempt_count, error_code: previous === "ALREADY_ESCALATED"
          ? "WATCHDOG_EPISODE_ALREADY_ESCALATED" : previous === "ATTEMPTS_EXHAUSTED"
            ? "WATCHDOG_EPISODE_ATTEMPTS_EXHAUSTED" : item.error_code,
        next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
      continue;
    }
    // These are all pre-transport observations. If they fail, no notification was sent.
    let fresh: Snapshot;
    let device: Subscription | null;
    try {
      const [state, deviceResult] = await Promise.all([
        loadSnapshot(service, tenantId, alert.trading_engine_id),
        service.from("operator_push_subscriptions")
          .select("id,operator_id,user_id,endpoint,p256dh,auth_secret,warning_enabled")
          .eq("id", sub.id).eq("operator_id", sub.operator_id).eq("user_id", sub.user_id)
          .eq("enabled", true).maybeSingle(),
      ]);
      if (deviceResult.error) throw new Error("COINOPS_PUSH_DEVICE_REFRESH_FAILED");
      fresh = state; device = deviceResult.data as Subscription | null;
    } catch {
      await updateClaim({ status: "PENDING", lease_until: null, attempt_count: item.attempt_count,
        error_code: item.error_code, next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
      continue;
    }
    const refreshed = primaryOperationalAlerts(fresh.alerts).find(row => row.id === alert.id
      && samePushInstant(row.first_seen_at, alert.first_seen_at));
    if (!device || !refreshed || !deliveryScope(item, refreshed, device)) {
      await updateClaim({ status: "EXPIRED", lease_until: null, attempt_count: item.attempt_count,
        error_code: "INCIDENT_CLOSED_OR_NOT_ACTIONABLE" });
      continue;
    }
    const context = contextFor(fresh, refreshed, Date.now());
    if (!evaluateOperationalPush(context).eligible) {
      // Missing/stale evidence is UNKNOWN, not proof of resolution. The same
      // pending episode may become actionable once Watchdog confirms the block.
      await updateClaim({ status: "PENDING", lease_until: null,
        attempt_count: item.attempt_count, error_code: item.error_code,
        next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
      continue;
    }
    try {
      await sendToDevice(device, { title: "CoinOps — BLOQUEIO PERSISTENTE",
        body: `${context.account!.display_name} · ${context.engine!.symbol.replace(/(BRL|USDT|USDC)$/, "/$1")} · ${context.engine!.executor_shard_id!.replace("executor-", "Executor ")} · Watchdog não resolveu: ${publicBlockedPushReason(refreshed.code)}`,
        url: alertDeepLink(refreshed.exchange_account_id, context.engine!.symbol, "REAL", refreshed.id,
          refreshed.trading_engine_id), tag: `blocked:${refreshed.id}:${Date.parse(refreshed.first_seen_at)}` },
      { ttl: OPERATIONAL_PUSH_TTL_SECONDS });
    } catch (error) {
      const transport = error instanceof PushTransportError ? error : new PushTransportError();
      const invalid = transport.statusCode === 404 || transport.statusCode === 410;
      const retry = transport.outcome === "REJECTED" && [429, 500, 502, 503, 504].includes(transport.statusCode!)
        && item.attempt_count + 1 < 3;
      await updateClaim({ status: invalid ? "EXPIRED" : retry ? "PENDING" : "FAILED", lease_until: null,
        next_attempt_at: new Date(Date.now() + 60_000 * (item.attempt_count + 1)).toISOString(),
        error_code: transport.outcome === "REJECTED" ? `PROVIDER_REJECTED_HTTP_${transport.statusCode}`
          : "DELIVERY_OUTCOME_UNKNOWN" });
      await service.from("operator_push_subscriptions").update({ last_failure_at: new Date().toISOString(),
        last_failure_code: transport.message, ...(invalid ? { enabled: false } : {}) })
        .eq("id", device.id).eq("operator_id", device.operator_id);
      failed++;
      continue;
    }
    // Provider accepted. Audit failure must never flow into the transport retry above.
    sent++;
    const saved = await updateClaim({ status: "SENT", sent_at: new Date().toISOString(),
      lease_until: null, error_code: null });
    const deviceSaved = await service.from("operator_push_subscriptions")
      .update({ last_success_at: new Date().toISOString(), last_failure_code: null })
      .eq("id", device.id).eq("operator_id", device.operator_id);
    if (saved.error || deviceSaved.error) {
      failed++;
      await updateClaim({ status: "FAILED", lease_until: null, error_code: "PROVIDER_ACCEPTED_AUDIT_FAILED" });
      console.error(JSON.stringify({ event: "COINOPS_PUSH_AUDIT", code: "COINOPS_PUSH_PROVIDER_ACCEPTED_AUDIT_FAILED" }));
    }
  }
  return { status: failed ? "PARTIAL_FAILURE" : "OK", stale: 0, queued: candidates.length, sent, failed };
}

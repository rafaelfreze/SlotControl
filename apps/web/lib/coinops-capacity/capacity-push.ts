import { PushTransportError, sendToDevice } from "@/lib/coinops-notifications/push-server";
import { unresolvedInfrastructureBlock } from "@/lib/coinops-notifications/infrastructure-push-policy";
import { samePushInstant, OPERATIONAL_PUSH_TTL_SECONDS } from "@/lib/coinops-notifications/operational-push-policy";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { capacityScope } from "./capacity-server";
import { capacityAlertMessage } from "./capacity-alert-policy";

type Alert = { id: string; shard_id: string; code: string; severity: "WARNING" | "CRITICAL";
  first_seen_at: string };
type Device = { id: string; operator_id: string; user_id: string; enabled: boolean; endpoint: string; p256dh: string;
  auth_secret: string; warning_enabled: boolean };
type Pending = { id: string; alert_id: string; opened_at: string; subscription_id: string; attempt_count: number;
  error_code: string | null };
const INCIDENT_COLUMNS = "shard_id,engine_id,account_id,incident_key,detected_condition,opened_at,last_seen_at,state_after,result,resolved_at";
const SAFE_RETRY = /^PROVIDER_REJECTED_HTTP_(429|500|502|503|504)$/;

/** Infrastructure incidents are shard-scoped; never masquerade as an engine alert. */
export async function dispatchCapacityPush() {
  const service = capacityScope();
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new Error("COINOPS_CAPACITY_SCOPE_INVALID");
  const [alertsResult, operatorsResult, checksResult, incidentsResult] = await Promise.all([
    service.from("executor_capacity_alerts")
      .select("id,shard_id,code,severity,first_seen_at").is("resolved_at", null),
    service.from("operators").select("id,user_id").eq("tenant_id", tenantId).eq("status", "ACTIVE"),
    service.from("watchdog_checks").select("shard_id,checked_at,shard_state"),
    service.from("watchdog_incidents")
      .select(INCIDENT_COLUMNS)
      .eq("incident_key", "SHARD:EXECUTOR_OFFLINE").is("resolved_at", null),
  ]);
  if (alertsResult.error || operatorsResult.error || checksResult.error || incidentsResult.error
    || !Array.isArray(alertsResult.data) || !Array.isArray(operatorsResult.data)
    || !Array.isArray(checksResult.data) || !Array.isArray(incidentsResult.data))
    throw new Error("COINOPS_CAPACITY_PUSH_READ_FAILED");
  const alerts = alertsResult.data as Alert[];
  const one = <T,>(rows: T[]) => rows.length === 1 ? rows[0] : null;
  const actionable = alerts.filter((alert) => unresolvedInfrastructureBlock(alert,
    one(checksResult.data.filter((check) => check.shard_id === alert.shard_id)),
    one(incidentsResult.data.filter((incident) => incident.shard_id === alert.shard_id))));
  const operatorIds = operatorsResult.data.map((item) => item.id);
  const devicesResult = await service.from("operator_push_subscriptions")
    .select("id,operator_id,user_id,enabled,endpoint,p256dh,auth_secret,warning_enabled")
    .in("operator_id", operatorIds);
  if (devicesResult.error || !Array.isArray(devicesResult.data)) throw new Error("COINOPS_CAPACITY_PUSH_DEVICE_READ_FAILED");
  const scopedDevices = (devicesResult.data as Device[]).filter(device => operatorsResult.data.some(operator =>
    operator.id === device.operator_id && operator.user_id === device.user_id));
  const subscriptionIds = scopedDevices.map(device => device.id);
  const devices = scopedDevices.filter(device => device.enabled);
  // Capacity/resource warnings stay visible in the panel. The sole external
  // exception is a Watchdog-confirmed persistent shard outage, never a mute.
  const candidates = actionable.flatMap((alert) => devices.map((device) => ({
    alert_id: alert.id, opened_at: alert.first_seen_at, subscription_id: device.id,
  })));
  if (candidates.length) {
    const queued = await service.from("executor_capacity_deliveries").upsert(candidates,
      { onConflict: "alert_id,opened_at,subscription_id", ignoreDuplicates: true });
    if (queued.error) throw new Error("COINOPS_CAPACITY_PUSH_QUEUE_FAILED");
  }
  const recovered = await service.from("executor_capacity_deliveries")
    .update({ status: "FAILED", lease_until: null, error_code: "DELIVERY_OUTCOME_UNKNOWN" }).eq("status", "SENDING")
    .in("subscription_id", subscriptionIds)
    .lt("lease_until", new Date().toISOString());
  if (recovered.error) throw new Error("COINOPS_CAPACITY_PUSH_LEASE_FAILED");
  const pending = await service.from("executor_capacity_deliveries")
    .select("id,alert_id,opened_at,subscription_id,attempt_count,error_code")
    .in("subscription_id", subscriptionIds).eq("status", "PENDING").lte("next_attempt_at", new Date().toISOString())
    .order("created_at").limit(8);
  if (pending.error || !Array.isArray(pending.data)) throw new Error("COINOPS_CAPACITY_PUSH_PENDING_FAILED");
  const alertById = new Map(alerts.map((item) => [item.id, item]));
  const deviceById = new Map(devices.map((item) => [item.id, item]));
  let sent = 0, failed = 0;
  for (const item of (pending.data ?? []) as Pending[]) {
    const alert = alertById.get(item.alert_id);
    const device = deviceById.get(item.subscription_id);
    if (item.attempt_count > 0 && !SAFE_RETRY.test(item.error_code ?? "")) {
      await service.from("executor_capacity_deliveries").update({ status: "FAILED", lease_until: null,
        error_code: "DELIVERY_OUTCOME_UNKNOWN" }).eq("id", item.id).eq("status", "PENDING")
        .eq("attempt_count", item.attempt_count).eq("subscription_id", item.subscription_id);
      continue;
    }
    if (!alert || !device || !samePushInstant(item.opened_at, alert.first_seen_at)
      || alert.code !== "EXECUTOR_OFFLINE" || alert.severity !== "CRITICAL") {
      await service.from("executor_capacity_deliveries").update({ status: "EXPIRED",
        error_code: "INCIDENT_CLOSED_OR_DEVICE_DISABLED" }).eq("id", item.id).eq("status", "PENDING")
        .eq("attempt_count", item.attempt_count).eq("subscription_id", item.subscription_id);
      continue;
    }
    if (item.attempt_count >= 3) {
      await service.from("executor_capacity_deliveries").update({ status: "FAILED", error_code: "ATTEMPTS_EXHAUSTED" })
        .eq("id", item.id).eq("status", "PENDING").eq("attempt_count", item.attempt_count)
        .eq("subscription_id", item.subscription_id);
      continue;
    }
    const attemptedAt = new Date().toISOString();
    const attempt = item.attempt_count + 1;
    const claimed = await service.from("executor_capacity_deliveries")
      .update({ status: "SENDING", attempted_at: attemptedAt,
        lease_until: new Date(Date.now() + 90_000).toISOString(), attempt_count: attempt })
      .eq("id", item.id).eq("status", "PENDING").eq("attempt_count", item.attempt_count)
      .eq("subscription_id", item.subscription_id).select("id");
    if (claimed.error) throw new Error("COINOPS_CAPACITY_PUSH_CLAIM_FAILED");
    if (!claimed.data?.length) continue;
    const updateClaim = (values: Record<string, unknown>) => service.from("executor_capacity_deliveries")
      .update(values).eq("id", item.id).eq("status", "SENDING")
      .eq("attempt_count", attempt).eq("attempted_at", attemptedAt).eq("subscription_id", item.subscription_id);
    // Until the transport is invoked, uncertainty is a deferred observation,
    // not a failed notification or a consumed provider attempt.
    let freshAlert: Alert | null, freshDevice: Device | null;
    try {
      const [fresh, check, incident, subscription] = await Promise.all([
        service.from("executor_capacity_alerts").select("id,shard_id,code,severity,first_seen_at")
        .eq("id", alert.id).eq("first_seen_at", alert.first_seen_at)
        .is("resolved_at", null).maybeSingle(),
        service.from("watchdog_checks").select("shard_id,checked_at,shard_state")
          .eq("shard_id", alert.shard_id).maybeSingle(),
        service.from("watchdog_incidents")
          .select(INCIDENT_COLUMNS)
          .eq("shard_id", alert.shard_id).eq("incident_key", "SHARD:EXECUTOR_OFFLINE")
          .is("resolved_at", null).maybeSingle(),
        service.from("operator_push_subscriptions").select("id,operator_id,user_id,enabled,endpoint,p256dh,auth_secret,warning_enabled")
          .eq("id", device.id).eq("operator_id", device.operator_id).eq("user_id", device.user_id)
          .eq("enabled", true).maybeSingle(),
      ]);
      if (fresh.error || check.error || incident.error || subscription.error)
        throw new Error("COINOPS_CAPACITY_PUSH_REFRESH_FAILED");
      freshAlert = fresh.data as Alert | null; freshDevice = subscription.data as Device | null;
      if (!freshAlert || !freshDevice) {
        await updateClaim({ status: "EXPIRED", lease_until: null, attempt_count: item.attempt_count,
          error_code: "INCIDENT_CLOSED_OR_DEVICE_DISABLED" });
        continue;
      }
      if (!samePushInstant(freshAlert.first_seen_at, alert.first_seen_at)
        || freshAlert.shard_id !== alert.shard_id
        || !unresolvedInfrastructureBlock(freshAlert, check.data, incident.data))
        throw new Error("COINOPS_CAPACITY_PUSH_BLOCK_UNCONFIRMED");
      // Reopening a capacity row during the same continuous Watchdog outage
      // is not a new incident. Accepted or unknown prior deliveries are final.
      const previous = await service.from("executor_capacity_deliveries")
        .select("status,error_code,attempt_count").eq("alert_id", alert.id)
        .eq("subscription_id", item.subscription_id).neq("id", item.id)
        .gte("attempted_at", incident.data!.opened_at).limit(101);
      if (previous.error || !Array.isArray(previous.data) || previous.data.length > 100)
        throw new Error("COINOPS_CAPACITY_PUSH_EPISODE_READ_FAILED");
      if (previous.data.some(row => row.status === "SENT"
        || ["DELIVERY_OUTCOME_UNKNOWN", "PROVIDER_ACCEPTED_AUDIT_FAILED"].includes(row.error_code)
        || row.status === "FAILED" && !SAFE_RETRY.test(row.error_code ?? ""))) {
        await updateClaim({ status: "EXPIRED", lease_until: null, attempt_count: item.attempt_count,
          error_code: "INCIDENT_ALREADY_ESCALATED" });
        continue;
      }
      if (previous.data.some(row => row.status === "SENDING"))
        throw new Error("COINOPS_CAPACITY_PUSH_EPISODE_IN_PROGRESS");
      if (previous.data.reduce((total, row) => total + row.attempt_count, item.attempt_count) >= 3) {
        await updateClaim({ status: "FAILED", lease_until: null, attempt_count: item.attempt_count,
          error_code: "ATTEMPTS_EXHAUSTED" });
        continue;
      }
    } catch {
      await updateClaim({ status: "PENDING", lease_until: null, attempt_count: item.attempt_count,
        next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
        error_code: item.error_code ?? "BLOCK_EVIDENCE_UNAVAILABLE" });
      continue;
    }
    try {
      const message = capacityAlertMessage(freshAlert);
      await sendToDevice(freshDevice, { ...message, title: "CoinOps — BLOQUEIO PERSISTENTE" },
        { ttl: OPERATIONAL_PUSH_TTL_SECONDS });
    } catch (error) {
      const transport = error instanceof PushTransportError ? error : new PushTransportError();
      const invalid = transport.statusCode === 404 || transport.statusCode === 410;
      const retry = transport.outcome === "REJECTED" && [429, 500, 502, 503, 504].includes(transport.statusCode!)
        && attempt < 3;
      await updateClaim({ status: invalid ? "EXPIRED" : retry ? "PENDING" : "FAILED", lease_until: null,
        next_attempt_at: new Date(Date.now() + 60_000 * attempt).toISOString(),
        error_code: transport.outcome === "REJECTED" ? `PROVIDER_REJECTED_HTTP_${transport.statusCode}`
          : "DELIVERY_OUTCOME_UNKNOWN" });
      await service.from("operator_push_subscriptions").update({ last_failure_at: new Date().toISOString(),
        last_failure_code: transport.message, ...(invalid ? { enabled: false } : {}) })
        .eq("id", freshDevice.id).eq("operator_id", freshDevice.operator_id).eq("user_id", freshDevice.user_id);
      failed++;
      continue;
    }
    // Accepted pushes never re-enter transport retry, even when audit fails.
    sent++;
    const saved = await updateClaim({ status: "SENT", sent_at: new Date().toISOString(), lease_until: null, error_code: null });
    if (saved.error) {
      failed++;
      await updateClaim({ status: "FAILED", lease_until: null, error_code: "PROVIDER_ACCEPTED_AUDIT_FAILED" });
    }
  }
  return { status: failed ? "PARTIAL_FAILURE" : "DISPATCHED", sent, failed };
}

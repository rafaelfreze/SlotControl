import { sendToDevice } from "@/lib/coinops-notifications/push-server";
import { shouldPush } from "@/lib/coinops-notifications/push-policy";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { capacityScope } from "./capacity-server";
import { capacityAlertMessage } from "./capacity-alert-policy";

type Alert = { id: string; shard_id: string; code: string; severity: "WARNING" | "CRITICAL";
  first_seen_at: string };
type Device = { id: string; operator_id: string; endpoint: string; p256dh: string;
  auth_secret: string; warning_enabled: boolean };

/** Infrastructure incidents are shard-scoped; never masquerade as an engine alert. */
export async function dispatchCapacityPush() {
  const service = capacityScope();
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new Error("COINOPS_CAPACITY_SCOPE_INVALID");
  const [alertsResult, operatorsResult] = await Promise.all([
    service.from("executor_capacity_alerts")
      .select("id,shard_id,code,severity,first_seen_at").is("resolved_at", null),
    service.from("operators").select("id").eq("tenant_id", tenantId).eq("status", "ACTIVE"),
  ]);
  if (alertsResult.error || operatorsResult.error)
    throw new Error("COINOPS_CAPACITY_PUSH_READ_FAILED");
  const alerts = (alertsResult.data ?? []) as Alert[];
  const operatorIds = (operatorsResult.data ?? []).map((item) => item.id);
  if (!alerts.length || !operatorIds.length) return { status: "NO_ALERTS", sent: 0 };
  const devicesResult = await service.from("operator_push_subscriptions")
    .select("id,operator_id,endpoint,p256dh,auth_secret,warning_enabled")
    .in("operator_id", operatorIds).eq("enabled", true);
  if (devicesResult.error) throw new Error("COINOPS_CAPACITY_PUSH_DEVICE_READ_FAILED");
  const devices = (devicesResult.data ?? []) as Device[];
  const candidates = alerts.flatMap((alert) => devices.filter((device) =>
    shouldPush(alert.severity, device.warning_enabled)).map((device) => ({
    alert_id: alert.id, opened_at: alert.first_seen_at, subscription_id: device.id,
  })));
  if (candidates.length) {
    const queued = await service.from("executor_capacity_deliveries").upsert(candidates,
      { onConflict: "alert_id,opened_at,subscription_id", ignoreDuplicates: true });
    if (queued.error) throw new Error("COINOPS_CAPACITY_PUSH_QUEUE_FAILED");
  }
  const recovered = await service.from("executor_capacity_deliveries")
    .update({ status: "PENDING" }).eq("status", "SENDING")
    .lt("lease_until", new Date().toISOString());
  if (recovered.error) throw new Error("COINOPS_CAPACITY_PUSH_LEASE_FAILED");
  const pending = await service.from("executor_capacity_deliveries")
    .select("id,alert_id,opened_at,subscription_id,attempt_count")
    .eq("status", "PENDING").lte("next_attempt_at", new Date().toISOString())
    .order("created_at").limit(8);
  if (pending.error) throw new Error("COINOPS_CAPACITY_PUSH_PENDING_FAILED");
  const alertById = new Map(alerts.map((item) => [`${item.id}:${item.first_seen_at}`, item]));
  const deviceById = new Map(devices.map((item) => [item.id, item]));
  let sent = 0;
  for (const item of pending.data ?? []) {
    const alert = alertById.get(`${item.alert_id}:${item.opened_at}`);
    const device = deviceById.get(item.subscription_id);
    if (!alert || !device) {
      await service.from("executor_capacity_deliveries").update({ status: "EXPIRED",
        error_code: "INCIDENT_CLOSED_OR_DEVICE_DISABLED" }).eq("id", item.id).eq("status", "PENDING");
      continue;
    }
    const claimed = await service.from("executor_capacity_deliveries")
      .update({ status: "SENDING", attempted_at: new Date().toISOString(),
        lease_until: new Date(Date.now() + 90_000).toISOString(), attempt_count: item.attempt_count + 1 })
      .eq("id", item.id).eq("status", "PENDING").select("id");
    if (claimed.error) throw new Error("COINOPS_CAPACITY_PUSH_CLAIM_FAILED");
    if (!claimed.data?.length) continue;
    try {
      const fresh = await service.from("executor_capacity_alerts").select("id")
        .eq("id", alert.id).eq("first_seen_at", alert.first_seen_at)
        .is("resolved_at", null).maybeSingle();
      if (fresh.error) throw new Error("COINOPS_CAPACITY_PUSH_REFRESH_FAILED");
      if (!fresh.data) {
        await service.from("executor_capacity_deliveries").update({ status: "EXPIRED",
          lease_until: null, error_code: "INCIDENT_CLOSED" }).eq("id", item.id);
        continue;
      }
      await sendToDevice(device, capacityAlertMessage(alert));
      const saved = await service.from("executor_capacity_deliveries").update({ status: "SENT",
        sent_at: new Date().toISOString(), lease_until: null, error_code: null }).eq("id", item.id);
      if (saved.error) throw new Error("COINOPS_CAPACITY_PUSH_AUDIT_FAILED");
      sent++;
    } catch {
      await service.from("executor_capacity_deliveries").update({
        status: item.attempt_count >= 2 ? "FAILED" : "PENDING", lease_until: null,
        next_attempt_at: new Date(Date.now() + 60_000 * (item.attempt_count + 1)).toISOString(),
        error_code: "DELIVERY_FAILED" }).eq("id", item.id);
    }
  }
  return { status: "DISPATCHED", sent };
}

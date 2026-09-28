import "server-only";
import { randomUUID } from "node:crypto";
import { getCoinOpsServiceTenantId } from "../supabase/env";
import { sendToDevice } from "../coinops-notifications/push-server";
import { assetHealthService } from "./access";
import { shouldNotifyAssetHealthTransition } from "./rules";
import type { AssetHealthStatus, BinanceHealthStatus } from "./types";

type HealthStatus = AssetHealthStatus | BinanceHealthStatus;
type Event = { id: string; asset: string; status_before: HealthStatus; status_after: HealthStatus; created_at: string };
type Device = { id: string; user_id: string; operator_id: string; endpoint: string; p256dh: string; auth_secret: string; warning_enabled: boolean };
const labels: Record<HealthStatus, string> = {
  HEALTHY: "SAUDÁVEL", ATTENTION: "ATENÇÃO", STRUCTURAL_RISK: "RISCO ESTRUTURAL", CRITICAL_RISK: "RISCO CRÍTICO", INSUFFICIENT_DATA: "DADOS INSUFICIENTES",
};

/** Separate outbox: never creates an engine alert or touches engine recovery. */
export async function dispatchAssetHealthPush() {
  const service = assetHealthService(), now = new Date();
  const [eventsResult, operators] = await Promise.all([
    service.from("asset_health_events").select("id,asset,status_before,status_after,created_at")
      .gte("created_at", new Date(now.getTime() - 24 * 60 * 60_000).toISOString()).order("created_at").limit(100),
    service.from("operators").select("id,user_id").eq("tenant_id", getCoinOpsServiceTenantId()!).eq("status", "ACTIVE"),
  ]);
  if (eventsResult.error || operators.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_READ_FAILED");
  const events = (eventsResult.data as Event[] ?? []).filter((event) => shouldNotifyAssetHealthTransition(event.status_before, event.status_after));
  const admins = new Map((operators.data ?? []).map((operator) => [operator.id, operator.user_id]));
  if (!admins.size) return { status: "NO_ADMIN_DEVICES", sent: 0 };
  const subscriptions = await service.from("operator_push_subscriptions")
    .select("id,user_id,operator_id,endpoint,p256dh,auth_secret,warning_enabled")
    .in("operator_id", [...admins.keys()]).eq("enabled", true);
  if (subscriptions.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_DEVICE_READ_FAILED");
  const devices = (subscriptions.data as Device[] ?? []).filter((device) => admins.get(device.operator_id) === device.user_id);
  const allowed = (event: Event, device: Device) => device.warning_enabled
    || event.status_after === "STRUCTURAL_RISK" || event.status_before === "STRUCTURAL_RISK"
    || event.status_after === "CRITICAL_RISK" || event.status_before === "CRITICAL_RISK";
  const candidates = events.flatMap((event) => devices.filter((device) => allowed(event, device))
    .map((device) => ({ event_id: event.id, subscription_id: device.id })));
  if (candidates.length) {
    const queue = await service.from("asset_health_deliveries").upsert(candidates,
      { onConflict: "event_id,subscription_id", ignoreDuplicates: true });
    if (queue.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_QUEUE_FAILED");
  }
  const requeue = await service.from("asset_health_deliveries").update({ status: "PENDING", lease_token: null, lease_until: null })
    .eq("status", "SENDING").lt("lease_until", now.toISOString());
  if (requeue.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_REQUEUE_FAILED");
  const pending = await service.from("asset_health_deliveries").select("id,event_id,subscription_id,attempt_count")
    .eq("status", "PENDING").lte("next_attempt_at", now.toISOString()).order("next_attempt_at").limit(8);
  if (pending.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_PENDING_FAILED");
  let sent = 0, failed = 0;
  for (const row of pending.data ?? []) {
    const event = events.find((item) => item.id === row.event_id), device = devices.find((item) => item.id === row.subscription_id);
    if (!event || !device || !allowed(event, device)) {
      const expired = await service.from("asset_health_deliveries").update({ status: "EXPIRED", error_code: "EVENT_EXPIRED_OR_DEVICE_DISABLED" })
        .eq("id", row.id).eq("status", "PENDING");
      if (expired.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_EXPIRE_FAILED");
      continue;
    }
    const token = randomUUID();
    const claim = await service.from("asset_health_deliveries").update({ status: "SENDING", lease_token: token,
      lease_until: new Date(Date.now() + 90_000).toISOString(), attempt_count: row.attempt_count + 1 })
      .eq("id", row.id).eq("status", "PENDING").select("id");
    if (claim.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_CLAIM_FAILED");
    if (!claim.data?.length) continue;
    try {
      await sendToDevice(device, { title: `CoinOps · Saúde ${event.asset}`,
        body: `${labels[event.status_before]} → ${labels[event.status_after]}. Avaliação informativa; nenhuma ordem foi alterada.`,
        url: `/automacao?view=live&account=ALL&assetHealth=${event.asset}`, tag: `asset-health:${event.id}` });
      const saved = await service.from("asset_health_deliveries").update({ status: "SENT", sent_at: new Date().toISOString(),
        lease_token: null, lease_until: null, error_code: null }).eq("id", row.id).eq("lease_token", token);
      if (saved.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_AUDIT_FAILED");
      sent++;
    } catch {
      failed++;
      const saved = await service.from("asset_health_deliveries").update({ status: row.attempt_count >= 2 ? "FAILED" : "PENDING",
        lease_token: null, lease_until: null, error_code: "DELIVERY_FAILED",
        next_attempt_at: new Date(Date.now() + 30 * 60_000).toISOString() }).eq("id", row.id).eq("lease_token", token);
      if (saved.error) throw new Error("COINOPS_ASSET_HEALTH_PUSH_AUDIT_FAILED");
    }
  }
  return { status: failed ? "PARTIAL_FAILURE" : "DISPATCHED", sent, failed };
}

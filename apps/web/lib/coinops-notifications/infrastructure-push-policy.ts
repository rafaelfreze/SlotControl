import { OPERATIONAL_PUSH_BLOCKED_MS, OPERATIONAL_PUSH_FRESH_MS } from "./operational-push-policy.ts";

type Alert = { shard_id: string; code: string; severity: string; first_seen_at: string };
type Check = { shard_id: string; checked_at: string; shard_state: string };
type Incident = { shard_id: string; engine_id: string | null; account_id: string | null;
  incident_key: string; detected_condition: string;
  opened_at: string; last_seen_at: string; state_after: string; result: string; resolved_at: string | null };

/** Capacity/market advisories do not prove an operational block. Keep them in
 * the panel. An actual unavailable executor remains an actionable exception. */
export function unresolvedInfrastructureBlock(alert: Alert, check: Check | null,
  incident: Incident | null, now = Date.now()) {
  if (!/^executor-[0-9]{2,}$/.test(alert.shard_id)
    || alert.code !== "EXECUTOR_OFFLINE" || alert.severity !== "CRITICAL" || !check || !incident
    || check.shard_id !== alert.shard_id || incident.shard_id !== alert.shard_id
    || incident.engine_id !== null || incident.account_id !== null
    || check.shard_state !== "OFFLINE" || incident.incident_key !== "SHARD:EXECUTOR_OFFLINE"
    || incident.detected_condition !== "EXECUTOR_OFFLINE" || incident.state_after !== "OFFLINE"
    || incident.result !== "OPEN" || incident.resolved_at) return false;
  const opened = Date.parse(incident.opened_at), alertOpened = Date.parse(alert.first_seen_at);
  const checked = Date.parse(check.checked_at), seen = Date.parse(incident.last_seen_at);
  return [now, opened, alertOpened, checked, seen].every(Number.isFinite)
    && opened <= now && alertOpened <= now && seen >= Math.max(opened, alertOpened)
    && checked >= Math.max(opened, alertOpened) && checked <= now + 5_000 && seen <= now + 5_000
    && now - opened >= OPERATIONAL_PUSH_BLOCKED_MS && now - alertOpened >= OPERATIONAL_PUSH_BLOCKED_MS
    && now - checked <= OPERATIONAL_PUSH_FRESH_MS && now - seen <= OPERATIONAL_PUSH_FRESH_MS;
}

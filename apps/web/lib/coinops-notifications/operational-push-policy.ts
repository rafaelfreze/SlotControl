/** Notification escalation only. This policy never authorizes trading or recovery. */
export const OPERATIONAL_PUSH_BLOCKED_MS = 120_000;
export const OPERATIONAL_PUSH_FRESH_MS = 150_000;
export const OPERATIONAL_PUSH_TTL_SECONDS = 60;
export const OPERATIONAL_PUSH_LEASE_DEFERRAL_MS = 600_000;

export type OperationalPushAlert = {
  id: string; operator_id: string; exchange_account_id: string; trading_engine_id: string;
  severity: string; code: string; alert_key: string; details: unknown;
  first_seen_at: string; resolved_at: string | null;
};
export type OperationalPushEngine = {
  id: string; operator_id: string; exchange_account_id: string; symbol: string;
  environment: string; executor_shard_id: string | null; status: string; kill_switch: boolean;
};
export type OperationalPushAccount = { id: string; operator_id: string; display_name: string; status: string };
export type OperationalPushRun = {
  id: string; operator_id: string; exchange_account_id: string; trading_engine_id: string;
  symbol: string; status: string; lease_until: string | null; last_error: string | null;
};
export type OperationalPushIncident = {
  incident_id: string; shard_id: string; engine_id: string | null; account_id: string | null;
  market: string | null; incident_key: string; detected_condition: string; state_after: string;
  result: string; opened_at: string; last_seen_at: string; resolved_at: string | null;
  last_recovery_attempt_at?: string | null;
};
export type OperationalPushCheck = {
  shard_id: string; checked_at: string; shard_state: string; blocked_engines: number;
};
export type OperationalPushContext = {
  alert: OperationalPushAlert; engine: OperationalPushEngine | null; account: OperationalPushAccount | null;
  run: OperationalPushRun | null; incident: OperationalPushIncident | null; check: OperationalPushCheck | null;
  now: number;
};

const timestamp = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
export function samePushInstant(a: string, b: string) {
  return Number.isFinite(timestamp(a)) && timestamp(a) === timestamp(b);
}
export function operationalAlertRunId(alert: OperationalPushAlert): string | null {
  if (!alert.details || typeof alert.details !== "object" || Array.isArray(alert.details)) return null;
  const runId = (alert.details as { run_id?: unknown }).run_id;
  return typeof runId === "string" && /^[0-9a-f-]{36}$/i.test(runId) ? runId : null;
}

/** An open warning is a retry checkpoint, not proof of an operator-actionable block. */
export function evaluateOperationalPush(input: OperationalPushContext): { eligible: boolean; reason: string } {
  const { alert, engine, account, run, incident, check, now } = input;
  const deny = (reason: string) => ({ eligible: false, reason });
  if (alert.resolved_at || alert.severity !== "CRITICAL") return deny("NOT_OPEN_CRITICAL");
  if (!engine || !account || !run || !incident || !check) return deny("BLOCK_EVIDENCE_INCOMPLETE");
  if (engine.environment !== "REAL" || engine.status !== "ACTIVE"
    || account.status !== "ACTIVE" || engine.id !== alert.trading_engine_id
    || account.id !== alert.exchange_account_id || engine.exchange_account_id !== account.id
    || engine.operator_id !== alert.operator_id || account.operator_id !== alert.operator_id
    || run.operator_id !== alert.operator_id || run.trading_engine_id !== engine.id
    || run.exchange_account_id !== account.id || run.symbol !== engine.symbol
    || operationalAlertRunId(alert) !== run.id
    || !engine.executor_shard_id || incident.shard_id !== engine.executor_shard_id
    || incident.engine_id !== engine.id || incident.account_id !== account.id
    || incident.market !== engine.symbol || check.shard_id !== engine.executor_shard_id
    || incident.incident_key !== `${run.id}:${alert.code}` || incident.detected_condition !== alert.code)
    return deny("BLOCK_SCOPE_MISMATCH");
  if (!alert.alert_key.startsWith(`LIVE_RUN:${run.id}:`) && alert.alert_key !== `WATCHDOG:${run.id}`)
    return deny("BLOCK_SCOPE_MISMATCH");
  if (!["ACTIVE", "PAUSED"].includes(run.status)) return deny("RUN_NOT_OPERATIONAL");
  // PAUSED with a proven protection incident still escalates. Intentional pause alone never does.
  if (incident.resolved_at || incident.state_after !== "BLOCKED"
    || !["OPEN", "BLOCKED_SAFE"].includes(incident.result)) return deny("NOT_UNRESOLVED_BLOCK");
  const opened = timestamp(incident.opened_at), seen = timestamp(incident.last_seen_at);
  const alertOpened = timestamp(alert.first_seen_at), checked = timestamp(check.checked_at);
  if (![opened, seen, alertOpened, checked, now].every(Number.isFinite)
    || seen < opened || checked < opened || checked < alertOpened
    || opened > now || alertOpened > now || checked > now + 5_000 || seen > now + 5_000)
    return deny("BLOCK_EVIDENCE_TIME_INVALID");
  if (now - checked > OPERATIONAL_PUSH_FRESH_MS || now - seen > OPERATIONAL_PUSH_FRESH_MS
    || check.shard_state !== "BLOCKED" || check.blocked_engines < 1)
    return deny("WATCHDOG_NOT_CURRENTLY_BLOCKED");
  if (now - opened < OPERATIONAL_PUSH_BLOCKED_MS || now - alertOpened < OPERATIONAL_PUSH_BLOCKED_MS)
    return deny("WAITING_FOR_NORMAL_RECOVERY");
  // A blocked engine still leases its worker to protect TP/reconcile fills.
  // Minute-aligned cron leases must not silence a confirmed block forever.
  // RECOVERING is rejected above regardless of age; this is notification-only.
  if (Number.isFinite(timestamp(run.lease_until)) && timestamp(run.lease_until) > now
    && now - Math.max(opened, alertOpened) < OPERATIONAL_PUSH_LEASE_DEFERRAL_MS)
    return deny("RECOVERY_OR_RECONCILIATION_IN_PROGRESS");
  return { eligible: true, reason: "UNRESOLVED_WATCHDOG_BLOCK" };
}

/** Prefer the engine's root alert. Derived WATCHDOG rows do not multiply one block. */
export function primaryOperationalAlerts(alerts: OperationalPushAlert[]) {
  const candidates = alerts.filter((alert) => alert.severity === "CRITICAL" && !alert.resolved_at
    && operationalAlertRunId(alert));
  const groups = new Map<string, OperationalPushAlert[]>();
  for (const alert of candidates) {
    const key = `${alert.operator_id}:${alert.exchange_account_id}:${alert.trading_engine_id}:${operationalAlertRunId(alert)}`;
    groups.set(key, [...(groups.get(key) ?? []), alert]);
  }
  return [...groups.values()].map((items) => [...items].sort((a, b) => {
    const priority = (alert: OperationalPushAlert) => alert.alert_key.endsWith(":CRITICAL") ? 0
      : alert.alert_key.startsWith("WATCHDOG:") ? 2 : 1;
    return priority(a) - priority(b) || timestamp(a.first_seen_at) - timestamp(b.first_seen_at)
      || a.id.localeCompare(b.id);
  })[0]);
}

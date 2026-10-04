import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { advanceLiveRun } from "@/lib/execution/robot-v1-live-server";
import { shardedEngineMap } from "@/lib/execution/sharded-engine-map";
import { criticalAlertsForRun, evaluateFastRun, type FastAccount, type FastAlert, type FastEngine, type FastOrder,
  type FastRun, type FastSlot } from "./watchdog-policy";

type Service = ReturnType<typeof createServiceRoleClient>;
type ScopedRun = FastRun & { product_id: string; tenant_id: string; user_id: string;
  operator_id: string; asset: string };
type Incident = { incident_id: string; shard_id: string; engine_id: string | null;
  incident_key: string; opened_at: string; last_recovery_attempt_at: string | null };
const RECOVERY_BACKOFF_MS = 5 * 60_000;
const SHARD_STALE_MS = 3 * 60_000;

async function openIncident(service: Service, shardId: string, run: ScopedRun | null,
  code: string, stateAfter: string, now: number, open: Incident[]) {
  const incidentKey = run ? `${run.id}:${code}` : `SHARD:${code}`;
  const existing = open.find((item) => item.shard_id === shardId && item.incident_key === incidentKey);
  if (existing) {
    const touch = await service.from("watchdog_incidents").update({ last_seen_at: new Date(now).toISOString() })
      .eq("incident_id", existing.incident_id).is("resolved_at", null);
    if (touch.error) throw new Error("COINOPS_WATCHDOG_INCIDENT_TOUCH_FAILED");
    return existing;
  }
  const saved = await service.from("watchdog_incidents").insert({ shard_id: shardId,
    account_id: run?.exchange_account_id ?? null, engine_id: run?.trading_engine_id ?? null,
    market: run?.symbol ?? null, incident_key: incidentKey, detected_condition: code,
    severity: "CRITICAL", state_before: "UNKNOWN", state_after: stateAfter,
    result: "OPEN", error_code: code }).select("incident_id,shard_id,engine_id,incident_key,opened_at,last_recovery_attempt_at").maybeSingle();
  if (saved.error || !saved.data) {
    // A concurrent cron can win the partial unique index. Never create two incidents.
    const winner = await service.from("watchdog_incidents")
      .select("incident_id,shard_id,engine_id,incident_key,opened_at,last_recovery_attempt_at")
      .eq("shard_id", shardId).eq("incident_key", incidentKey).is("resolved_at", null).maybeSingle();
    if (winner.error || !winner.data) throw new Error("COINOPS_WATCHDOG_INCIDENT_OPEN_FAILED");
    return winner.data as Incident;
  }
  const incident = saved.data as Incident;
  open.push(incident);
  return incident;
}

async function resolveIncident(service: Service, incident: Incident, now: number,
  result: "RECOVERED" | "SUPERSEDED" = "RECOVERED") {
  const ended = await service.from("watchdog_incidents").update({ resolved_at: new Date(now).toISOString(),
    last_seen_at: new Date(now).toISOString(), state_after: result === "RECOVERED" ? "HEALTHY" : "DEGRADED", result,
    recovery_duration_ms: Math.max(0, now - Date.parse(incident.opened_at)), error_code: null })
    .eq("incident_id", incident.incident_id).is("resolved_at", null);
  if (ended.error) throw new Error("COINOPS_WATCHDOG_INCIDENT_RESOLVE_FAILED");
}

async function updateEngineAlert(service: Service, run: ScopedRun, code: string | null, now: number) {
  const key = `WATCHDOG:${run.id}`;
  if (code && code !== "WATCHDOG_LOCAL_GATE_CLOSED") {
    const saved = await service.from("robot_v1_live_alerts").upsert({
      product_id: run.product_id, tenant_id: run.tenant_id, user_id: run.user_id,
      operator_id: run.operator_id, exchange_account_id: run.exchange_account_id,
      trading_engine_id: run.trading_engine_id, asset: run.asset,
      alert_key: key, severity: "CRITICAL", code,
      details: { run_id: run.id }, last_seen_at: new Date(now).toISOString(), resolved_at: null,
    }, { onConflict: "trading_engine_id,alert_key" });
    if (saved.error) throw new Error("COINOPS_WATCHDOG_ALERT_WRITE_FAILED");
  } else if (!code) {
    const cleared = await service.from("robot_v1_live_alerts")
      .update({ resolved_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString() })
      .eq("trading_engine_id", run.trading_engine_id).eq("alert_key", key).is("resolved_at", null);
    if (cleared.error) throw new Error("COINOPS_WATCHDOG_ALERT_RESOLVE_FAILED");
  }
}

async function claimRecovery(service: Service, incident: Incident, now: number) {
  if (incident.last_recovery_attempt_at
    && now - Date.parse(incident.last_recovery_attempt_at) < RECOVERY_BACKOFF_MS) return false;
  let claim = service.from("watchdog_incidents")
    .update({ last_recovery_attempt_at: new Date(now).toISOString(), result: "RECOVERING",
      state_after: "RECOVERING" }).eq("incident_id", incident.incident_id).is("resolved_at", null);
  claim = incident.last_recovery_attempt_at
    ? claim.eq("last_recovery_attempt_at", incident.last_recovery_attempt_at)
    : claim.is("last_recovery_attempt_at", null);
  const result = await claim.select("incident_id");
  if (result.error) throw new Error("COINOPS_WATCHDOG_RECOVERY_CLAIM_FAILED");
  return Boolean(result.data?.length);
}

/** DB-only normal path. The existing engine worker is called only for a
 * debounced, proven stale run; it owns all Binance reconciliation and writes. */
export async function runServerWatchdog() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    throw new Error("COINOPS_WATCHDOG_SCOPE_INVALID");
  const service = createServiceRoleClient();
  const started = Date.now();
  const tenantId = getCoinOpsServiceTenantId()!;
  const [shards, samples, runsResult, openResult, alertsResult, capacityAlertsResult] = await Promise.all([
    service.from("executor_shards").select("id,enabled").eq("enabled", true).order("id"),
    service.from("executor_capacity_samples").select("shard_id,heartbeat_at,observed_at,scheduler_backlog"),
    service.from("robot_v1_live_runs")
      .select("id,product_id,tenant_id,user_id,operator_id,asset,trading_engine_id,exchange_account_id,status,symbol,last_reconciled_at,last_error,lease_until")
      .eq("tenant_id", tenantId).eq("status", "ACTIVE"),
    service.from("watchdog_incidents")
      .select("incident_id,shard_id,engine_id,incident_key,opened_at,last_recovery_attempt_at")
      .is("resolved_at", null),
    service.from("robot_v1_live_alerts").select("trading_engine_id,exchange_account_id,alert_key,severity,code,details")
      .eq("tenant_id", tenantId).is("resolved_at", null),
    service.from("executor_capacity_alerts").select("shard_id,code").is("resolved_at", null),
  ]);
  if (shards.error || samples.error || runsResult.error || openResult.error || alertsResult.error
    || capacityAlertsResult.error)
    throw new Error("COINOPS_WATCHDOG_SNAPSHOT_FAILED");
  if (!shards.data?.length) throw new Error("COINOPS_WATCHDOG_NO_ENABLED_SHARDS");
  const runs = (runsResult.data ?? []) as ScopedRun[];
  const ids = <T,>(items: T[]) => [...new Set(items)];
  const [accountsResult, enginesResult, slotsResult, ordersResult, configResult] = runs.length
    ? await Promise.all([
      service.from("exchange_accounts").select("id,executor_shard_id,status,kill_switch")
        .in("id", ids(runs.map((run) => run.exchange_account_id))),
      service.from("trading_engines").select("id,exchange_account_id,symbol,status,kill_switch,strategy_config_pending,executor_shard_id")
        .in("id", ids(runs.map((run) => run.trading_engine_id))),
      service.from("robot_v1_live_slots").select("run_id,id,entry_state,position_quantity,updated_at")
        .in("run_id", runs.map((run) => run.id)),
      service.from("robot_v1_live_orders").select("run_id,slot_id,side,status,exchange_order_id")
        .in("run_id", runs.map((run) => run.id))
        .in("status", ["PREPARED", "NEW", "PARTIALLY_FILLED"]),
      service.from("strategy_bulk_engine_updates").select("trading_engine_id,status,updated_at")
        .in("trading_engine_id", ids(runs.map((run) => run.trading_engine_id)))
        .in("status", ["PENDING", "APPLYING", "BLOCKED_SAFE"]),
    ]) : [null, null, null, null, null];
  if (accountsResult?.error || enginesResult?.error || slotsResult?.error || ordersResult?.error || configResult?.error)
    throw new Error("COINOPS_WATCHDOG_LEDGER_READ_FAILED");
  const accounts = new Map(((accountsResult?.data ?? []) as FastAccount[]).map((row) => [row.id, row]));
  const engines = new Map(((enginesResult?.data ?? []) as FastEngine[]).map((row) => [row.id, row]));
  const updates = new Map(((configResult?.data ?? []) as Array<{ trading_engine_id: string; status: string;
    updated_at: string }>).map((row) => [row.trading_engine_id, row]));
  const slots = (slotsResult?.data ?? []) as FastSlot[];
  const orders = (ordersResult?.data ?? []) as FastOrder[];
  const groupedSlots = new Map<string, FastSlot[]>();
  const groupedOrders = new Map<string, FastOrder[]>();
  for (const slot of slots) groupedSlots.set(slot.run_id, [...(groupedSlots.get(slot.run_id) ?? []), slot]);
  for (const order of orders) groupedOrders.set(order.run_id, [...(groupedOrders.get(order.run_id) ?? []), order]);
  const open = (openResult.data ?? []) as Incident[];
  const activeWatchdogAlerts = new Set((alertsResult.data ?? [])
    .filter((item) => item.alert_key.startsWith("WATCHDOG:"))
    .map((item) => `${item.trading_engine_id}:${item.alert_key}`));
  const alerts = (alertsResult.data ?? []) as FastAlert[];
  const existingCritical = new Set(runs.filter((run) => criticalAlertsForRun(run, alerts).length)
    .map((run) => run.id));
  const now = Date.now();
  const findings = runs.map((run) => {
    const account = accounts.get(run.exchange_account_id) ?? null;
    const shardId = engines.get(run.trading_engine_id)?.executor_shard_id ?? "unassigned";
    return { run, shardId, finding: evaluateFastRun({ run,
      engine: engines.get(run.trading_engine_id) ?? null, account, shardId,
      slots: groupedSlots.get(run.id) ?? [], orders: groupedOrders.get(run.id) ?? [], alerts,
      configUpdate: updates.get(run.trading_engine_id) ?? null, now }) };
  });
  if (findings.some((item) => item.shardId === "unassigned"))
    throw new Error("COINOPS_WATCHDOG_OWNERSHIP_UNKNOWN");
  const enabledShardIds = new Set((shards.data ?? []).map((shard) => shard.id));
  if (findings.some((item) => !enabledShardIds.has(item.shardId)))
    throw new Error("COINOPS_WATCHDOG_SHARD_UNAVAILABLE");
  const shardResults = await Promise.all((shards.data ?? []).map(async (shard) => {
    try {
    const sample = (samples.data ?? []).find((item) => item.shard_id === shard.id);
    const heartbeat = sample ? Date.parse(sample.heartbeat_at) : NaN;
    const offline = !Number.isFinite(heartbeat) || now - heartbeat > SHARD_STALE_MS;
    const shardOpen = open.filter((item) => item.shard_id === shard.id
      && item.incident_key === "SHARD:EXECUTOR_OFFLINE");
    if (offline) await openIncident(service, shard.id, null, "EXECUTOR_OFFLINE", "OFFLINE", now, open);
    const own = findings.filter((item) => item.shardId === shard.id);
    let healthy = 0; let recovering = 0; let blocked = 0; let stale = 0;
    const candidates: typeof own = [];
    for (const item of own) {
      const { run, finding } = item;
      if (finding.state === "HEALTHY") healthy++;
      else if (finding.state === "RECOVERING") recovering++;
      else if (finding.state === "STALE") stale++;
      else blocked++;
      const previous = open.filter((entry) => entry.engine_id === run.trading_engine_id);
      if (!finding.code) {
        if (finding.state === "HEALTHY" && !offline) {
          for (const incident of previous) await resolveIncident(service, incident, now);
          if (activeWatchdogAlerts.has(`${run.trading_engine_id}:WATCHDOG:${run.id}`))
            await updateEngineAlert(service, run, null, now);
        }
        continue;
      }
      for (const incident of previous.filter((entry) => entry.incident_key !== `${run.id}:${finding.code}`))
        await resolveIncident(service, incident, now, "SUPERSEDED");
      await openIncident(service, shard.id, run, finding.code, finding.state, now, open);
      const watchdogKey = `${run.trading_engine_id}:WATCHDOG:${run.id}`;
      if (existingCritical.has(run.id)) {
        if (activeWatchdogAlerts.has(watchdogKey)) await updateEngineAlert(service, run, null, now);
      } else await updateEngineAlert(service, run, finding.code, now);
      if (!offline && finding.recoverable) candidates.push(item);
    }
    if (offline) { healthy = 0; recovering = 0; blocked = 0; stale = own.length; }
    if (!offline && own.every((item) => item.finding.state === "HEALTHY"))
      for (const incident of shardOpen) await resolveIncident(service, incident, now);
    const capacityCodes = new Set((capacityAlertsResult.data ?? [])
      .filter((item) => item.shard_id === shard.id).map((item) => item.code));
    const state = offline ? "OFFLINE" : blocked ? "BLOCKED" : stale ? "STALE"
      : recovering ? "RECOVERING" : capacityCodes.has("CAPACITY_LIMIT") ? "CAPACITY_LIMIT"
      : capacityCodes.has("EXECUTOR_CAPACITY_WARNING") || capacityCodes.has("BINANCE_WEIGHT_WARNING")
        ? "CAPACITY_WARNING" : "HEALTHY";
    const saved = await service.from("watchdog_checks").upsert({ shard_id: shard.id,
      checked_at: new Date(now).toISOString(), shard_state: state, healthy_engines: healthy,
      recovering_engines: recovering, blocked_engines: blocked, stale_engines: stale,
      check_duration_ms: Date.now() - started, updated_at: new Date().toISOString() },
    { onConflict: "shard_id" });
    if (saved.error) throw new Error("COINOPS_WATCHDOG_CHECK_WRITE_FAILED");
    return { shardId: shard.id, state, healthy, recovering, blocked, stale, candidates };
    } catch (error) {
      const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
        ? error.message : "COINOPS_WATCHDOG_SHARD_FAILED";
      console.error(JSON.stringify({ event: "COINOPS_WATCHDOG_SHARD", shardId: shard.id, code }));
      return { shardId: shard.id, state: "DEGRADED", healthy: 0, recovering: 0,
        blocked: 0, stale: 0, candidates: [] as typeof findings };
    }
  }));
  // Never perform Binance REST during a healthy check. Only a stale, eligible
  // engine may enter the existing lease-protected reconciliation path.
  const candidates = shardResults.flatMap((item) => item.candidates
    .sort((a, b) => {
      const attempted = (candidate: typeof a) => Date.parse(open.find((incident) =>
        incident.incident_key === `${candidate.run.id}:${candidate.finding.code}`)
        ?.last_recovery_attempt_at ?? "1970-01-01T00:00:00Z");
      return attempted(a) - attempted(b);
    }).slice(0, 2));
  const recoveries = await shardedEngineMap(candidates, (item) => item.shardId, 2,
    async (item) => {
      const incident = open.find((entry) => entry.shard_id === item.shardId
        && entry.incident_key === `${item.run.id}:${item.finding.code}`);
      if (!incident || !await claimRecovery(service, incident, now)) return { status: "SKIPPED" };
      try {
        const result = await advanceLiveRun(item.run.id, "WATCHDOG_STALE_RECOVERY");
        const stillRunning = ["OK", "RESTARTED", "BUSY_OR_INACTIVE", "RETRY"].includes(result.status);
        const saved = await service.from("watchdog_incidents").update({
          actions_taken: [{ action: "EXISTING_ENGINE_RECONCILIATION", status: result.status }],
          state_after: stillRunning ? "RECOVERING" : "BLOCKED",
          result: stillRunning ? "RECOVERING" : "BLOCKED_SAFE",
        }).eq("incident_id", incident.incident_id).is("resolved_at", null);
        if (saved.error) throw new Error("COINOPS_WATCHDOG_RECOVERY_AUDIT_FAILED");
        return { status: result.status };
      } catch (error) {
        const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
          ? error.message : "COINOPS_WATCHDOG_RECOVERY_FAILED";
        await service.from("watchdog_incidents").update({ state_after: "BLOCKED",
          result: "BLOCKED_SAFE", error_code: code,
          actions_taken: [{ action: "EXISTING_ENGINE_RECONCILIATION", status: "FAILED" }] })
          .eq("incident_id", incident.incident_id).is("resolved_at", null);
        return { status: "BLOCKED_SAFE", code };
      }
    }, Math.floor(now / 60_000));
  return { status: shardResults.some((item) => item.state !== "HEALTHY") ? "ATTENTION" : "HEALTHY",
    checkedAt: new Date(now).toISOString(), durationMs: Date.now() - started,
    shards: shardResults.map(({ candidates: _candidates, ...item }) => item), recoveries };
}

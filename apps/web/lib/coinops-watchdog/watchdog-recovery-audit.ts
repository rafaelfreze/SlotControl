import type { createServiceRoleClient } from "../supabase/service-role";

type Service = ReturnType<typeof createServiceRoleClient>;
type RecoveryScope = { shardId: string; accountId: string; engineId: string;
  runId: string; alertCode: string; alertSeenAt: string };

/** Best-effort evidence only, after a guarded resume has succeeded. This hook
 * neither authorizes trading nor marks the engine healthy: the next watchdog
 * check must independently validate and close the incident. */
export async function recordVerifiedReadRecovery(service: Service, scope: RecoveryScope,
  now = new Date().toISOString()): Promise<"RECORDED" | "AUDIT_FAILED"> {
  try {
    const incidents = await service.from("watchdog_incidents")
      .select("incident_id,actions_taken,last_recovery_attempt_at")
      .eq("shard_id", scope.shardId).eq("account_id", scope.accountId).eq("engine_id", scope.engineId)
      .like("incident_key", `${scope.runId}:%`).is("resolved_at", null);
    if (incidents.error) throw new Error("COINOPS_WATCHDOG_RECOVERY_AUDIT_FAILED");
    const recoveryId = `${scope.runId}:${scope.alertSeenAt}`;
    for (const incident of incidents.data ?? []) {
      const previous = Array.isArray(incident.actions_taken) ? incident.actions_taken : [];
      if (previous.some((action) => action && typeof action === "object"
        && action.recovery_id === recoveryId)) continue;
      let update = service.from("watchdog_incidents").update({
        actions_taken: [...previous, { action: "VERIFIED_READ_RECOVERY", status: "RESUMED",
          source_alert_code: scope.alertCode, recovery_id: recoveryId, timestamp: now }],
        last_recovery_attempt_at: now, last_seen_at: now, state_after: "RECOVERING", result: "RECOVERING",
      }).eq("incident_id", incident.incident_id).eq("shard_id", scope.shardId)
        .eq("account_id", scope.accountId).eq("engine_id", scope.engineId)
        .like("incident_key", `${scope.runId}:%`).is("resolved_at", null);
      update = incident.last_recovery_attempt_at
        ? update.eq("last_recovery_attempt_at", incident.last_recovery_attempt_at)
        : update.is("last_recovery_attempt_at", null);
      const saved = await update.select("incident_id");
      if (saved.error || saved.data?.length !== 1)
        throw new Error("COINOPS_WATCHDOG_RECOVERY_AUDIT_FAILED");
    }
    return "RECORDED";
  } catch {
    // A logging failure must not reclose a safely recovered trading gate.
    console.error(JSON.stringify({ event: "COINOPS_WATCHDOG_RECOVERY_AUDIT",
      code: "COINOPS_WATCHDOG_RECOVERY_AUDIT_FAILED", shard_id: scope.shardId,
      account_id: scope.accountId, engine_id: scope.engineId, run_id: scope.runId }));
    return "AUDIT_FAILED";
  }
}

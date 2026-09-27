import "server-only";
import { randomUUID } from "node:crypto";
import { assetHealthService } from "./access";
import { collectorStatus, dueCadences, type CollectorState } from "./collector-policy";
import { deriveAssetHealth, mergeAssetHealthMetrics } from "./rules";
import { collectAssetHealthMetrics } from "./sources";
import { snapshotForDisplay } from "./snapshot-view";
import type { AssetHealthAsset, AssetHealthDashboard, AssetHealthHistoryItem, AssetHealthSnapshot } from "./types";

const ASSETS: AssetHealthAsset[] = ["BTC", "SOL"];
const safeError = (error: unknown) => error instanceof Error && /^COINOPS_ASSET_HEALTH_[A-Z0-9_]+$/.test(error.message)
  ? error.message : "COINOPS_ASSET_HEALTH_SYNC_FAILED";

/** No source requests or persistence on page loads. Expired evidence is reclassified read-only. */
export async function loadAssetHealthDashboard(days: 30 | 90 | 365 = 30): Promise<AssetHealthDashboard> {
  const service = assetHealthService(), now = new Date();
  const [current, state, events] = await Promise.all([
    service.from("asset_health_current").select("asset,assessment"),
    service.from("asset_health_collector_state").select("*").eq("id", "default").maybeSingle(),
    service.from("asset_health_events").select("asset,status_after,created_at,reasons")
      .gte("created_at", new Date(now.getTime() - days * 86_400_000).toISOString())
      .order("created_at", { ascending: false }).limit(500),
  ]);
  if (current.error || state.error || events.error) throw new Error("COINOPS_ASSET_HEALTH_READ_FAILED");
  const assets: AssetHealthDashboard["assets"] = {};
  for (const row of current.data ?? []) {
    const snapshot = row.assessment as AssetHealthSnapshot;
    if (!ASSETS.includes(snapshot.asset)) continue;
    const refreshed = snapshotForDisplay(snapshot, now);
    const history: AssetHealthHistoryItem[] = (events.data ?? []).filter((event) => event.asset === snapshot.asset)
      .map((event) => ({ status: event.status_after, evaluatedAt: event.created_at, reasons: event.reasons }));
    assets[snapshot.asset] = { ...refreshed, evaluatedAt: snapshot.evaluatedAt,
      previousStatus: snapshot.previousStatus, history };
  }
  return { generatedAt: now.toISOString(), collector: collectorStatus(state.data as CollectorState | null, now), assets };
}

/** Single fenced worker; writes exclusively to asset_health_* tables, never trading. */
export async function syncAssetHealth() {
  const service = assetHealthService(), token = randomUUID(), started = Date.now();
  const claim = await service.rpc("asset_health_claim", { p_token: token });
  if (claim.error) throw new Error("COINOPS_ASSET_HEALTH_CLAIM_FAILED");
  if (claim.data !== true) return { status: "SKIPPED_LOCK_OR_COOLDOWN" };
  try {
    const [state, current] = await Promise.all([
      service.from("asset_health_collector_state").select("*").eq("id", "default").single(),
      service.from("asset_health_current").select("asset,assessment"),
    ]);
    if (state.error || current.error) throw new Error("COINOPS_ASSET_HEALTH_READ_FAILED");
    const now = new Date(), cadences = dueCadences(state.data as CollectorState, now);
    const collected = await collectAssetHealthMetrics(cadences, now);
    const evaluated = new Date();
    const snapshots = ASSETS.map((asset) => {
      const previous = (current.data ?? []).find((row) => row.asset === asset)?.assessment as AssetHealthSnapshot | undefined;
      const metrics = mergeAssetHealthMetrics(previous?.metrics ?? [], collected.filter((metric) => metric.asset === asset), evaluated);
      return { ...deriveAssetHealth({ asset, metrics, now: evaluated, previous }), previousStatus: previous?.status ?? null };
    });
    const finished = await service.rpc("asset_health_finish", { p_token: token, p_snapshots: snapshots,
      p_cadences: Object.fromEntries(cadences.map((cadence) => [cadence, evaluated.toISOString()])),
      p_duration_ms: Date.now() - started });
    if (finished.error || finished.data !== true) throw new Error("COINOPS_ASSET_HEALTH_FINISH_FAILED");
    return { status: "SYNCED", evaluatedAt: evaluated.toISOString(), durationMs: Date.now() - started,
      cadences, assets: snapshots.map(({ asset, status, healthyIndicators, totalIndicators }) =>
        ({ asset, status, healthyIndicators, totalIndicators })) };
  } catch (error) {
    const code = safeError(error);
    await service.rpc("asset_health_fail", { p_token: token, p_error_code: code });
    throw new Error(code);
  }
}

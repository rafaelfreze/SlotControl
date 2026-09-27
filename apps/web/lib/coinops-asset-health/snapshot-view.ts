import { deriveAssetHealth } from "./rules";
import type { AssetHealthSnapshot } from "./types";

/** Page reads can invalidate stale evidence, never manufacture a new structural decision. */
export function snapshotForDisplay(snapshot: AssetHealthSnapshot, now: Date): AssetHealthSnapshot {
  const view = deriveAssetHealth({ asset: snapshot.asset, metrics: snapshot.metrics, now, previous: snapshot });
  const expires = Date.parse(snapshot.validUntil);
  const engineStale = !Number.isFinite(expires) || expires <= now.getTime();
  const insufficient = engineStale || view.status === "INSUFFICIENT_DATA";
  const reasons = engineStale ? ["A avaliação persistida expirou. Aguardando o coletor server-side; isso não significa risco estrutural do ativo."]
    : view.status === "INSUFFICIENT_DATA" ? view.reasons : snapshot.reasons;
  return { ...snapshot, metrics: view.metrics, sources: view.sources, categories: view.categories,
    healthyIndicators: view.healthyIndicators, totalIndicators: view.totalIndicators, coverage: view.coverage,
    status: insufficient ? "INSUFFICIENT_DATA" : snapshot.status, summary: reasons[0], reasons,
    validUntil: engineStale ? snapshot.validUntil : new Date(Math.min(expires, Date.parse(view.validUntil))).toISOString() };
}

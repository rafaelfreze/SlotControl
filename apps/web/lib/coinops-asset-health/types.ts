export type AssetHealthAsset = "BTC" | "SOL";
export type AssetHealthStatus = "HEALTHY" | "ATTENTION" | "STRUCTURAL_RISK" | "INSUFFICIENT_DATA";
export type AssetMetricStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "SOURCE_UNAVAILABLE" | "DATA_STALE";
export type AssetMetricClass = "CRITICAL" | "PRIMARY" | "COMPLEMENTARY_PROXY";
export type AssetHealthCategory = "NETWORK" | "SECURITY" | "DEVELOPMENT" | "LIQUIDITY" | "ECOSYSTEM";
export type AssetHealthCadence = "FAST" | "STRUCTURAL" | "DEVELOPMENT";

export type AssetMetric = {
  asset: AssetHealthAsset;
  key: string;
  label: string;
  category: AssetHealthCategory;
  cadence: AssetHealthCadence;
  status: AssetMetricStatus;
  /** Evidence tier used by the deterministic global-status quorum. */
  indicatorClass?: AssetMetricClass;
  value: unknown;
  unit: string | null;
  reason: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  source: { id: string; name: string; url: string; independenceGroup?: string };
  fetchedAt: string;
  metricAt: string | null;
  /** Freshness of the observation, distinct from a release/block/event date. */
  observedAt?: string;
  ttlSeconds: number;
  errorCode?: string | null;
  errorAt?: string | null;
  collectionStatus?: "OK" | "SOURCE_UNAVAILABLE";
  optional?: boolean;
  contextOnly?: boolean;
};

export type AssetCategoryAssessment = {
  category: AssetHealthCategory;
  status: "HEALTHY" | "OBSERVE" | "ATTENTION" | "RISK" | "INSUFFICIENT_DATA";
  healthy: number;
  total: number;
  summary: string;
};

export type AssetHealthAssessment = {
  asset: AssetHealthAsset;
  status: AssetHealthStatus;
  healthyIndicators: number;
  totalIndicators: number;
  summary: string;
  reasons: string[];
  categories: AssetCategoryAssessment[];
  metrics: AssetMetric[];
  sources: Array<{ id: string; name: string; url: string; fetchedAt: string; status: string }>;
  trigger: string;
  evaluatedAt: string;
  validUntil: string;
  criticalSinceByMetric: Record<string, string>;
  coverage: { available: number; expected: number; missingCategories: AssetHealthCategory[]; unavailableOptional: number };
};

export type AssetHealthSnapshot = AssetHealthAssessment & {
  previousStatus: AssetHealthStatus | null;
};

export type AssetHealthHistoryItem = {
  status: AssetHealthStatus;
  evaluatedAt: string;
  reasons: string[];
};

export type AssetHealthDashboard = {
  generatedAt: string;
  collector: { status: "HEALTHY" | "STALE" | "FAILED" | "NOT_RUN"; lastRunAt: string | null; nextExpectedAt: string | null };
  assets: Partial<Record<AssetHealthAsset, AssetHealthSnapshot & { history: AssetHealthHistoryItem[] }>>;
};

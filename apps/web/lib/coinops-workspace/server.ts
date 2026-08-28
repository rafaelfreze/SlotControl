import "server-only";

import {
  rankDefensiveCandidates,
  rankNormalCandidates,
  type OfficialAsset,
  type OfficialStrategyMode,
  type QueueSlot,
  type SlotPool
} from "@/lib/coinops-monitoring/domain";
import type { OfficialMonitoringOverview } from "@/lib/coinops-monitoring/server";
import { createClient } from "@/lib/supabase/server";

export type CoinOpsWorkspaceAsset = OfficialAsset;
export type CoinOpsWorkspaceClient = ReturnType<typeof createClient>;

export type CoinOpsWorkspaceSourceError = {
  source: string;
  code: string | null;
  message: string;
};

export type CoinOpsWorkspaceBaselineAsset = {
  asset: CoinOpsWorkspaceAsset;
  operationalTotal: number;
  realizedProfit: number;
  openPnl: number;
  slotsExisting: number;
  slotsEnabled: number;
  slotsOpen: number;
  slotsFree: number;
};

export type CoinOpsWorkspaceBaselineSlot = {
  slotId: string;
  asset: CoinOpsWorkspaceAsset;
  slotNumber: number;
  status: string | null;
  realGains: number;
  operationalGains: number;
  addedGains: number;
  externalContribution: number;
  operationalValue: number;
  entry: number | null;
  target: number | null;
  positionQuantity: number | null;
  openedAt: string | null;
  rank: number | null;
  enabled: boolean;
};

export type CoinOpsWorkspaceDailySnapshot = {
  id: string;
  cycleId: string;
  date: string;
  timezone: string;
  btcPrice: number | null;
  mode: OfficialStrategyMode | null;
  operationalTotal: number | null;
  openSlots: number | null;
  mainOpen: number | null;
  snapshot_date: string;
  operational_total: number | null;
  metrics: Record<string, unknown>;
};

export type CoinOpsWorkspaceAlert = {
  id: string;
  type: string;
  title: string;
  severity: "INFO" | "ATTENTION" | "CRITICAL" | string;
  message: string;
  occurredAt: string;
  occurred_at: string;
  readAt: string | null;
  metadata: Record<string, unknown>;
};

export type CoinOpsWorkspaceCycle = {
  id: string;
  number: number;
  mode: OfficialStrategyMode | string;
  status: string;
  startAt: string;
  endAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  redistributionStatus: string;
};

export type CoinOpsWorkspaceReport = {
  id: string;
  cycleId: string;
  status: string;
  version: number;
  payload: Record<string, unknown>;
  generatedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
};

export type CoinOpsWorkspacePoolConfiguration = {
  asset: CoinOpsWorkspaceAsset;
  slotId: string | null;
  slotNumber: number;
  pool: SlotPool;
  enabled: boolean;
  funded: boolean;
  allowReserve: boolean;
  activeFromCycle: number;
};

export type CoinOpsWorkspaceProgress = {
  id: string;
  cycleId: string;
  slotId: string;
  slot_id: string;
  asset: CoinOpsWorkspaceAsset;
  target: number;
  cycleRealGains: number;
  redistributionIn: number;
  redistributionOut: number;
  externalGainEquivalent: number;
  cycleProgress: number;
  cycle_progress: number;
  entriesCount: number;
  gainsCount: number;
  openedSeconds: number;
  lastOperatedAt: string | null;
  slot: {
    slotNumber: number;
    status: string;
    operationalGains: number;
    operationalValue: number;
    realGains: number;
    entry: number | null;
    target: number | null;
    updatedAt: string | null;
    positionOpenedAt: string | null;
  } | null;
};

export type CoinOpsWorkspaceQueueItem = {
  priority: number;
  asset: CoinOpsWorkspaceAsset;
  slotId: string;
  slot_id: string;
  slotNumber: number;
  slot_number: number;
  pool: SlotPool;
  status: string;
  operationalGains: number;
  operational_gains: number;
  realGains: number;
  operationalValue: number;
  operational_value: number;
  cycleProgress: number;
  cycle_progress: number;
  cycleTarget: number;
  target: number | null;
  excess: number;
  deficit: number;
  entry: number | null;
  targetPrice: number | null;
  lastOperatedAt: string | null;
};

export type CoinOpsWorkspaceData = {
  available: boolean;
  active: boolean;
  degraded: boolean;
  overview: OfficialMonitoringOverview;
  baselineAssets: CoinOpsWorkspaceBaselineAsset[];
  baselineSlots: CoinOpsWorkspaceBaselineSlot[];
  dailySnapshots: CoinOpsWorkspaceDailySnapshot[];
  snapshots: CoinOpsWorkspaceDailySnapshot[];
  alerts: CoinOpsWorkspaceAlert[];
  cycles: CoinOpsWorkspaceCycle[];
  reports: CoinOpsWorkspaceReport[];
  progress: CoinOpsWorkspaceProgress[];
  poolConfiguration: CoinOpsWorkspacePoolConfiguration[];
  queues: Record<CoinOpsWorkspaceAsset, CoinOpsWorkspaceQueueItem[]>;
  queue: CoinOpsWorkspaceQueueItem[];
  sourceErrors: CoinOpsWorkspaceSourceError[];
};

type QueryError = { code?: string | null; message: string };
type QueryResult = { data: unknown; error: QueryError | null };
type ProgressSlotRow = {
  slot_number?: unknown;
  status?: unknown;
  operational_gains?: unknown;
  operational_slot_value?: unknown;
  real_gains?: unknown;
  preco_entrada?: unknown;
  preco_alvo?: unknown;
  updated_at?: unknown;
  position_opened_at?: unknown;
};

const EMPTY_OVERVIEW: OfficialMonitoringOverview = { ok: true, active: false };
const EMPTY_QUEUES: Record<CoinOpsWorkspaceAsset, CoinOpsWorkspaceQueueItem[]> = { BTC: [], SOL: [] };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asAsset(value: unknown): CoinOpsWorkspaceAsset | null {
  return value === "BTC" || value === "SOL" ? value : null;
}

function asPool(value: unknown): SlotPool | null {
  return value === "MAIN" || value === "RESERVE" ? value : null;
}

function asMode(value: unknown): OfficialStrategyMode | null {
  return value === "NORMAL_GROWTH" || value === "DEFENSIVE_POST_ATH" ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readJoinedSlot(value: unknown): ProgressSlotRow | null {
  if (Array.isArray(value)) return value.length > 0 ? asRecord(value[0]) : null;
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function sourceError(source: string, error: QueryError | null): CoinOpsWorkspaceSourceError | null {
  if (!error) return null;
  return { source, code: error.code ?? null, message: error.message };
}

function toProgress(rows: Record<string, unknown>[]): CoinOpsWorkspaceProgress[] {
  return rows.flatMap((row) => {
    const asset = asAsset(row.asset);
    const slotId = asString(row.slot_id);
    if (!asset || !slotId) return [];
    const joined = readJoinedSlot(row.slot);
    return [{
      id: asString(row.id),
      cycleId: asString(row.cycle_id),
      slotId,
      slot_id: slotId,
      asset,
      target: asNumber(row.target),
      cycleRealGains: asNumber(row.cycle_real_gains),
      redistributionIn: asNumber(row.cycle_redistribution_in),
      redistributionOut: asNumber(row.cycle_redistribution_out),
      externalGainEquivalent: asNumber(row.cycle_external_gain_equivalent),
      cycleProgress: asNumber(row.cycle_progress),
      cycle_progress: asNumber(row.cycle_progress),
      entriesCount: asNumber(row.entries_count),
      gainsCount: asNumber(row.gains_count),
      openedSeconds: asNumber(row.opened_seconds),
      lastOperatedAt: asNullableString(row.last_operated_at),
      slot: joined ? {
        slotNumber: asNumber(joined.slot_number),
        status: asString(joined.status),
        operationalGains: asNumber(joined.operational_gains),
        operationalValue: asNumber(joined.operational_slot_value),
        realGains: asNumber(joined.real_gains),
        entry: asNullableNumber(joined.preco_entrada),
        target: asNullableNumber(joined.preco_alvo),
        updatedAt: asNullableString(joined.updated_at),
        positionOpenedAt: asNullableString(joined.position_opened_at)
      } : null
    }];
  });
}

function buildAssetQueue(
  asset: CoinOpsWorkspaceAsset,
  mode: OfficialStrategyMode | null,
  cycleNumber: number,
  progress: CoinOpsWorkspaceProgress[],
  poolConfiguration: CoinOpsWorkspacePoolConfiguration[]
): CoinOpsWorkspaceQueueItem[] {
  if (!mode || cycleNumber <= 0) return [];

  const progressBySlot = new Map(
    progress.filter((item) => item.asset === asset && item.slot).map((item) => [item.slotId, item])
  );
  const configurations = poolConfiguration.filter((item) => item.asset === asset && item.slotId);
  const queueSlots: QueueSlot[] = configurations.flatMap((configuration) => {
    const item = configuration.slotId ? progressBySlot.get(configuration.slotId) : null;
    if (!item?.slot || item.slot.status === "aberto") return [];
    return [{
      id: item.slotId,
      slotNumber: item.slot.slotNumber,
      pool: configuration.pool,
      enabled: configuration.enabled,
      funded: configuration.funded,
      activeFromCycleNumber: configuration.activeFromCycle,
      operationalGains: item.slot.operationalGains,
      operationalValue: item.slot.operationalValue,
      cycleProgress: item.cycleProgress,
      lastOperatedAt: item.lastOperatedAt
    }];
  });

  const target = progress
    .filter((item) => item.asset === asset)
    .reduce((highest, item) => Math.max(highest, item.target), 0);
  let ranked: QueueSlot[];
  if (mode === "NORMAL_GROWTH") {
    ranked = rankNormalCandidates(queueSlots, target, cycleNumber, false);
  } else {
    const main = rankDefensiveCandidates(queueSlots, cycleNumber, false);
    if (main.length > 0) {
      ranked = main;
    } else {
      const reserveAllowed = new Set(
        configurations
          .filter((item) => item.pool === "RESERVE" && item.allowReserve && item.slotId)
          .map((item) => item.slotId as string)
      );
      ranked = rankDefensiveCandidates(
        queueSlots.filter((item) => reserveAllowed.has(item.id)),
        cycleNumber,
        true
      );
    }
  }

  return ranked.flatMap((rankedSlot, index) => {
    const item = progressBySlot.get(rankedSlot.id);
    if (!item?.slot) return [];
    return [{
      priority: index + 1,
      asset,
      slotId: item.slotId,
      slot_id: item.slotId,
      slotNumber: item.slot.slotNumber,
      slot_number: item.slot.slotNumber,
      pool: rankedSlot.pool,
      status: item.slot.status,
      operationalGains: item.slot.operationalGains,
      operational_gains: item.slot.operationalGains,
      realGains: item.slot.realGains,
      operationalValue: item.slot.operationalValue,
      operational_value: item.slot.operationalValue,
      cycleProgress: item.cycleProgress,
      cycle_progress: item.cycleProgress,
      cycleTarget: item.target,
      target: mode === "NORMAL_GROWTH" ? item.target : null,
      excess: Math.max(0, item.cycleProgress - item.target),
      deficit: Math.max(0, item.target - item.cycleProgress),
      entry: item.slot.entry,
      targetPrice: item.slot.target,
      lastOperatedAt: item.lastOperatedAt
    }];
  });
}

function inactiveWorkspace(
  overview: OfficialMonitoringOverview,
  sourceErrors: CoinOpsWorkspaceSourceError[] = []
): CoinOpsWorkspaceData {
  return {
    available: sourceErrors.length === 0,
    active: false,
    degraded: sourceErrors.length > 0,
    overview,
    baselineAssets: [],
    baselineSlots: [],
    dailySnapshots: [],
    snapshots: [],
    alerts: [],
    cycles: [],
    reports: [],
    progress: [],
    poolConfiguration: [],
    queues: { ...EMPTY_QUEUES },
    queue: [],
    sourceErrors
  };
}

export async function loadCoinOpsWorkspaceData(
  supabase: CoinOpsWorkspaceClient = createClient(),
  suppliedOverview?: OfficialMonitoringOverview
): Promise<CoinOpsWorkspaceData> {
  let overview = suppliedOverview ?? null;
  const initialErrors: CoinOpsWorkspaceSourceError[] = [];

  if (!overview) {
    const overviewResult = await supabase.rpc("get_official_monitoring_overview");
    if (overviewResult.error) {
      initialErrors.push({
        source: "official-monitoring-overview",
        code: overviewResult.error.code ?? null,
        message: overviewResult.error.message
      });
      overview = EMPTY_OVERVIEW;
    } else {
      overview = (overviewResult.data ?? EMPTY_OVERVIEW) as OfficialMonitoringOverview;
    }
  }

  const baselineId = overview.active ? overview.baseline?.id : null;
  if (!overview.active || !baselineId) return inactiveWorkspace(overview, initialErrors);

  const currentCycleId = overview.cycle?.id ?? null;
  const progressRequest = currentCycleId
    ? supabase
      .from("cycle_slot_progress")
      .select("id,cycle_id,slot_id,asset,target,cycle_real_gains,cycle_redistribution_in,cycle_redistribution_out,cycle_external_gain_equivalent,cycle_progress,entries_count,gains_count,opened_seconds,last_operated_at,slot:slots(slot_number,status,operational_gains,operational_slot_value,real_gains,preco_entrada,preco_alvo,updated_at,position_opened_at)")
      .eq("cycle_id", currentCycleId)
    : Promise.resolve({ data: [], error: null });

  const results = await Promise.all([
    supabase
      .from("monitoring_baseline_assets")
      .select("asset,operational_total,realized_profit,open_pnl,slots_existing,slots_enabled,slots_open,slots_free")
      .eq("baseline_id", baselineId)
      .order("asset"),
    supabase
      .from("monitoring_baseline_slots")
      .select("slot_id,asset,slot_number,snapshot")
      .eq("baseline_id", baselineId)
      .order("asset")
      .order("slot_number"),
    supabase
      .from("cycle_daily_snapshots")
      .select("id,cycle_id,snapshot_date,timezone,metrics")
      .eq("baseline_id", baselineId)
      .order("snapshot_date", { ascending: false })
      .limit(400),
    supabase
      .from("monitoring_alerts")
      .select("id,alert_type,severity,message,occurred_at,read_at,metadata")
      .eq("baseline_id", baselineId)
      .order("occurred_at", { ascending: false })
      .limit(100),
    supabase
      .from("operational_cycles")
      .select("id,cycle_number,mode,status,start_at,end_at,closed_at,close_reason,redistribution_status")
      .eq("baseline_id", baselineId)
      .order("cycle_number", { ascending: false })
      .limit(100),
    supabase
      .from("cycle_reports")
      .select("id,cycle_id,status,report_version,payload,generated_at,finalized_at,created_at")
      .eq("baseline_id", baselineId)
      .order("created_at", { ascending: false })
      .limit(100),
    progressRequest,
    supabase
      .from("slot_pool_configuration")
      .select("asset,slot_id,slot_number,pool,enabled,funded,allow_reserve,active_from_cycle")
      .eq("baseline_id", baselineId)
      .order("asset")
      .order("slot_number")
  ]) as QueryResult[];

  const sourceNames = [
    "baseline-assets",
    "baseline-slots",
    "daily-snapshots",
    "alerts",
    "cycles",
    "reports",
    "cycle-slot-progress",
    "slot-pool-configuration"
  ];
  const sourceErrors = [
    ...initialErrors,
    ...results.flatMap((result, index) => {
      const error = sourceError(sourceNames[index], result.error);
      return error ? [error] : [];
    })
  ];

  const baselineAssets: CoinOpsWorkspaceBaselineAsset[] = asRows(results[0]?.data).flatMap((row) => {
    const asset = asAsset(row.asset);
    if (!asset) return [];
    return [{
      asset,
      operationalTotal: asNumber(row.operational_total),
      realizedProfit: asNumber(row.realized_profit),
      openPnl: asNumber(row.open_pnl),
      slotsExisting: asNumber(row.slots_existing),
      slotsEnabled: asNumber(row.slots_enabled),
      slotsOpen: asNumber(row.slots_open),
      slotsFree: asNumber(row.slots_free)
    }];
  });

  const baselineSlots: CoinOpsWorkspaceBaselineSlot[] = asRows(results[1]?.data).flatMap((row) => {
    const asset = asAsset(row.asset);
    const slotId = asString(row.slot_id);
    if (!asset || !slotId) return [];
    const snapshot = asRecord(row.snapshot);
    return [{
      slotId,
      asset,
      slotNumber: asNumber(row.slot_number),
      status: asNullableString(snapshot.status),
      realGains: asNumber(snapshot.real_gains),
      operationalGains: asNumber(snapshot.operational_gains),
      addedGains: asNumber(snapshot.added_gains),
      externalContribution: asNumber(snapshot.external_contribution),
      operationalValue: asNumber(snapshot.operational_value),
      entry: asNullableNumber(snapshot.entry),
      target: asNullableNumber(snapshot.target),
      positionQuantity: asNullableNumber(snapshot.position_quantity),
      openedAt: asNullableString(snapshot.opened_at),
      rank: asNullableNumber(snapshot.rank),
      enabled: asBoolean(snapshot.enabled)
    }];
  });

  const dailySnapshots: CoinOpsWorkspaceDailySnapshot[] = asRows(results[2]?.data)
    .map((row) => {
      const metrics = asRecord(row.metrics);
      return {
        id: asString(row.id),
        cycleId: asString(row.cycle_id),
        date: asString(row.snapshot_date),
        timezone: asString(row.timezone),
        btcPrice: asNullableNumber(metrics.btc_price),
        mode: asMode(metrics.mode),
        operationalTotal: asNullableNumber(metrics.operational_total),
        openSlots: asNullableNumber(metrics.open_slots),
        mainOpen: asNullableNumber(metrics.main_open),
        snapshot_date: asString(row.snapshot_date),
        operational_total: asNullableNumber(metrics.operational_total),
        metrics
      };
    })
    .reverse();

  const alerts: CoinOpsWorkspaceAlert[] = asRows(results[3]?.data).map((row) => ({
    id: asString(row.id),
    type: asString(row.alert_type),
    title: asString(row.alert_type).replaceAll("_", " "),
    severity: asString(row.severity),
    message: asString(row.message),
    occurredAt: asString(row.occurred_at),
    occurred_at: asString(row.occurred_at),
    readAt: asNullableString(row.read_at),
    metadata: asRecord(row.metadata)
  }));

  const cycles: CoinOpsWorkspaceCycle[] = asRows(results[4]?.data).map((row) => ({
    id: asString(row.id),
    number: asNumber(row.cycle_number),
    mode: asString(row.mode),
    status: asString(row.status),
    startAt: asString(row.start_at),
    endAt: asNullableString(row.end_at),
    closedAt: asNullableString(row.closed_at),
    closeReason: asNullableString(row.close_reason),
    redistributionStatus: asString(row.redistribution_status)
  }));

  const reports: CoinOpsWorkspaceReport[] = asRows(results[5]?.data).map((row) => ({
    id: asString(row.id),
    cycleId: asString(row.cycle_id),
    status: asString(row.status),
    version: asNumber(row.report_version),
    payload: asRecord(row.payload),
    generatedAt: asNullableString(row.generated_at),
    finalizedAt: asNullableString(row.finalized_at),
    createdAt: asString(row.created_at)
  }));

  const progress = toProgress(asRows(results[6]?.data));
  const poolConfiguration: CoinOpsWorkspacePoolConfiguration[] = asRows(results[7]?.data).flatMap((row) => {
    const asset = asAsset(row.asset);
    const pool = asPool(row.pool);
    if (!asset || !pool) return [];
    return [{
      asset,
      slotId: asNullableString(row.slot_id),
      slotNumber: asNumber(row.slot_number),
      pool,
      enabled: asBoolean(row.enabled),
      funded: asBoolean(row.funded),
      allowReserve: asBoolean(row.allow_reserve),
      activeFromCycle: asNumber(row.active_from_cycle, 1)
    }];
  });

  const mode = asMode(overview.strategy?.mode);
  const cycleNumber = overview.cycle?.number ?? 0;
  const queues: Record<CoinOpsWorkspaceAsset, CoinOpsWorkspaceQueueItem[]> = {
    BTC: buildAssetQueue("BTC", mode, cycleNumber, progress, poolConfiguration),
    SOL: buildAssetQueue("SOL", mode, cycleNumber, progress, poolConfiguration)
  };
  const queue = [...queues.BTC, ...queues.SOL]
    .sort((first, second) => first.priority - second.priority || first.asset.localeCompare(second.asset));

  return {
    available: true,
    active: true,
    degraded: sourceErrors.length > 0,
    overview,
    baselineAssets,
    baselineSlots,
    dailySnapshots,
    snapshots: dailySnapshots,
    alerts,
    cycles,
    reports,
    progress,
    poolConfiguration,
    queues,
    queue,
    sourceErrors
  };
}

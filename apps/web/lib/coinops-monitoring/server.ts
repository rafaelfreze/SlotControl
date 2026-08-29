import "server-only";

import { createClient } from "@/lib/supabase/server";

export type MonitoringAssetOverview = {
  target: number | null;
  enabled: number;
  below_target: number;
  next_slot: {
    slot_id: string;
    slot_number: number;
    progress: number;
    operational_gains: number;
  } | null;
};

export type OfficialMonitoringOverview = {
  ok: boolean;
  active: boolean;
  baseline?: {
    id: string;
    official_date: string;
    started_at: string;
    timezone: string;
    summary: Record<string, unknown>;
  };
  strategy?: {
    version: number;
    mode: "NORMAL_GROWTH" | "DEFENSIVE_POST_ATH";
    btc_spacing: number;
    sol_spacing: number;
    official_ath: number;
    defensive_anchor_ath: number | null;
  };
  cycle?: {
    id: string;
    number: number;
    mode: string;
    start_at: string;
    end_at: string | null;
    days_remaining: number | null;
  };
  assets?: Partial<Record<"BTC" | "SOL", MonitoringAssetOverview>>;
  pools?: Partial<Record<"BTC" | "SOL", {
    main_enabled: number;
    main_open: number;
    reserve_enabled: number;
    reserve_available: number;
  }>>;
  reports?: Array<{ id: string; cycle_id: string; status: string; version: number }>;
};

export type BaselinePreviewAsset = {
  asset?: "BTC" | "SOL";
  operational_total: number;
  patrimony?: number;
  realized_profit?: number;
  open_pnl?: number;
  external_contributions?: number;
  slots: number;
  open?: number;
  open_slots?: number;
  free?: number;
  free_slots?: number;
  real_gains?: number;
  operational_gains?: number;
  added_gains?: number;
};

export type BaselinePreviewSlot = {
  id?: string;
  slot_id?: string;
  slot_number: number;
  asset: "BTC" | "SOL";
  status: string;
  operational_gains: number;
  real_gains: number;
  added_gains: number;
  operational_value: number;
  open_pnl: number;
  entry: number | null;
  target: number | null;
  quantity: number | null;
  opened_at: string | null;
  rank: number | null;
  enabled: boolean;
  pool: "MAIN" | "RESERVE" | string;
};

export type BaselinePreviewAccount = {
  operational_total: number;
  patrimony: number;
  realized_profit: number;
  open_pnl: number;
  external_contributions: number;
  slots: number;
  open_slots: number;
  free_slots: number;
  real_gains: number;
  operational_gains: number;
  added_gains: number;
  prices: { BTC: number; SOL: number };
  official_btc_ath: number;
  mode: "NORMAL_GROWTH" | "DEFENSIVE_POST_ATH";
};

export type BaselinePreview = {
  ok: boolean;
  ready: boolean;
  errors: string[];
  already_active: boolean;
  official_date: string;
  timezone: string;
  slots: number | BaselinePreviewSlot[];
  open_slots: number;
  operational_total: number;
  realized_profit_legacy: number;
  external_contributions_legacy: number;
  assets: Record<string, BaselinePreviewAsset> | BaselinePreviewAsset[];
  account?: BaselinePreviewAccount;
  slot_details?: BaselinePreviewSlot[];
  state_hash?: string;
};

export type OfficialMonitoringLoadOptions = {
  includeDetailedPreview?: boolean;
};

export type OfficialMonitoringActivationContext = {
  btcPrice: number;
  solPrice: number;
  officialBtcAth: number;
};

export async function loadOfficialMonitoring(options: OfficialMonitoringLoadOptions = {}) {
  const supabase = createClient();

  if (!options.includeDetailedPreview) {
    const [overviewResponse, previewResponse] = await Promise.all([
      supabase.rpc("get_official_monitoring_overview"),
      supabase.rpc("preview_official_monitoring_baseline")
    ]);

    return {
      overview: (overviewResponse.data || { ok: true, active: false }) as OfficialMonitoringOverview,
      preview: (previewResponse.data || null) as BaselinePreview | null,
      error: overviewResponse.error?.message || previewResponse.error?.message || null,
      activationContext: null
    };
  }

  const { data: overviewData, error: overviewError } = await supabase.rpc("get_official_monitoring_overview");
  const overview = (overviewData || { ok: true, active: false }) as OfficialMonitoringOverview;

  if (!overview.active && !overviewError) {
    try {
      const [{ BTC: btcPrice, SOL: solPrice }, { data: currentState, error: stateError }] = await Promise.all([
        fetchOfficialReferencePrices(),
        supabase.from("btc_market_state").select("ath_price").eq("singleton", true).maybeSingle()
      ]);

      if (stateError) throw stateError;

      const officialBtcAth = Math.max(btcPrice, Number(currentState?.ath_price || btcPrice));
      const { data: preview, error: previewError } = await supabase.rpc(
        "preview_official_monitoring_baseline_details",
        {
          p_btc_price: btcPrice,
          p_sol_price: solPrice,
          p_btc_ath: officialBtcAth
        }
      );

      return {
        overview,
        preview: (preview || null) as BaselinePreview | null,
        error: previewError?.message || null,
        activationContext: {
          btcPrice,
          solPrice,
          officialBtcAth
        } satisfies OfficialMonitoringActivationContext
      };
    } catch (error) {
      return {
        overview,
        preview: null,
        error: error instanceof Error ? error.message : "COINOPS_BASELINE_PREVIEW_FAILED",
        activationContext: null
      };
    }
  }

  return {
    overview,
    preview: null,
    error: overviewError?.message || null,
    activationContext: null
  };
}

export async function fetchOfficialReferencePrices() {
  const [btcResponse, solResponse] = await Promise.all([
    fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", { cache: "no-store" }),
    fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", { cache: "no-store" })
  ]);

  if (!btcResponse.ok || !solResponse.ok) throw new Error("COINOPS_BASELINE_PRICE_FEED_UNAVAILABLE");

  const [btcPayload, solPayload] = await Promise.all([
    btcResponse.json() as Promise<{ price?: string }>,
    solResponse.json() as Promise<{ price?: string }>
  ]);
  const BTC = Number(btcPayload.price);
  const SOL = Number(solPayload.price);

  if (![BTC, SOL].every((price) => Number.isFinite(price) && price > 0)) {
    throw new Error("COINOPS_BASELINE_PRICE_INVALID");
  }

  return { BTC, SOL };
}

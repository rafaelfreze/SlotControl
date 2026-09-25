import type { Props } from "./automation-mobile";
import { buildPremiumAssets, type PremiumAsset, type PremiumEnvironment } from "./premium-model.ts";
import type { EngineContext } from "../../lib/execution/operator-context";

/** Public presentation only. Credential references never cross this boundary. */
export type PremiumAccount = { id: string; displayName: string; status: string; killSwitch: boolean };
export type PremiumEngine = Omit<PremiumAsset, "currency"> & {
  engineId: string; accountId: string; accountDisplayName: string; currency: string;
  engineStatus: string; killSwitch: boolean;
};
export type PremiumSelection = { accountId: string; symbol: string };
export type PremiumOperatorPresentation = {
  accounts: PremiumAccount[];
  accountCaps?: Array<{ accountId: string; currency: string; cap: number }>;
  engines: PremiumEngine[];
  /** Existing forms consume only one engine's scoped sources. */
  engineData: Record<string, Props>;
  selection?: PremiumSelection;
};
type MoneyField = "capital" | "committed" | "reserved" | "exposure" | "freeCapital" | "realizedPnl" | "openPnl" | "cap";

export function selectPremiumEngines(engines: PremiumEngine[], environment: PremiumEnvironment,
  selection: PremiumSelection): PremiumEngine[] {
  return engines.filter((engine) => engine.environment === environment
    && (selection.accountId === "ALL" || engine.accountId === selection.accountId)
    && (selection.symbol === "ALL" || engine.symbol === selection.symbol));
}

export function premiumNativeGroups(engines: PremiumEngine[]) {
  const groups = new Map<string, { accountId: string; accountDisplayName: string;
    environment: PremiumEnvironment; currency: string; engines: PremiumEngine[] }>();
  for (const engine of engines) {
    const key = `${engine.accountId}:${engine.environment}:${engine.currency}`;
    const group = groups.get(key) ?? { accountId: engine.accountId, accountDisplayName: engine.accountDisplayName,
      environment: engine.environment, currency: engine.currency, engines: [] };
    group.engines.push(engine); groups.set(key, group);
  }
  return [...groups.values()];
}

/** Refuse mixed native currencies/accounts instead of silently adding them. */
export function premiumNativeTotal(engines: PremiumEngine[], field: MoneyField): number | null {
  if (!engines.length || premiumNativeGroups(engines).length !== 1
    || engines.some((engine) => engine[field] === null)) return null;
  return engines.reduce((sum, engine) => sum + (engine[field] ?? 0), 0);
}

/** Compatibility for isolated 5.5 fixtures. Production always supplies registry IDs. */
export function legacyPremiumEngines(data: Props): PremiumEngine[] {
  return (["REAL", "SHADOW", "TESTNET"] as const).flatMap((environment) =>
    buildPremiumAssets(data, environment).map((asset) => ({ ...asset,
      engineId: `legacy:${environment}:${asset.symbol}`, accountId: "legacy",
      accountDisplayName: "Rafael", engineStatus: asset.status, killSwitch: false })));
}

export function concretePremiumEngine(engines: PremiumEngine[], selection: PremiumSelection,
  environment: PremiumEnvironment): PremiumEngine | null {
  if (selection.accountId === "ALL" || selection.symbol === "ALL") return null;
  const selected = selectPremiumEngines(engines, environment, selection);
  return selected.length === 1 ? selected[0] : null;
}

export function buildPremiumEngine(data: Props, context: EngineContext, now = Date.now()): PremiumEngine {
  if (context.base_asset !== "BTC" && context.base_asset !== "SOL")
    throw new Error("COINOPS_PRESENTATION_BASE_UNSUPPORTED");
  const model = buildPremiumAssets({ ...data, engineContext: context }, context.environment, now)
    .find((item) => item.asset === context.base_asset)!;
  const preparation = data.livePreparation?.configs.find((config) => config.asset === context.base_asset);
  const killSwitch = context.global_kill_switch || context.account_kill_switch || context.engine_kill_switch
    || (context.environment === "REAL" && ((preparation && "kill_switch" in preparation && preparation.kill_switch === true)
      || preparation?.live_enabled === false || data.nativeLiveControl?.killSwitch === true
      || (data.nativeLiveControl !== undefined && !data.nativeLiveControl.liveEnabled)));
  const blocked = context.environment === "REAL" && (killSwitch || context.status !== "ACTIVE");
  return { ...model, symbol: context.symbol, currency: context.quote_asset,
    engineId: context.trading_engine_id, accountId: context.exchange_account_id,
    accountDisplayName: context.account_display_name, engineStatus: context.status,
    cap: context.environment === "REAL" ? Number(context.hard_cap_quote) : model.cap,
    health: blocked && model.health.healthy ? { healthy: false, tone: "attention", label: "PROTEGIDO",
      reason: "Novas entradas bloqueadas por controle da conta, motor ou preparação LIVE." } : model.health,
    killSwitch };
}

import type { V1Asset } from "./robot-v1";

export type StrategyApplyPolicy = "NEXT_CYCLE_ONLY" | "NEXT_BUY_RECONCILE" | "FUTURE_ENTRIES_ONLY" | "METADATA_ONLY";
export type StrategyParameterKey = "gain_rate" | "normal_spacing_rate" | "post_ath_spacing_rate" | "monthly_target";
export type StrategyParameterDefinition = {
  key: StrategyParameterKey;
  label: string;
  description: string;
  type: "PERCENT" | "INTEGER";
  unit: "%" | "gains/slot/mês";
  min: number;
  max: number;
  precision: number;
  markets: readonly V1Asset[];
  applyPolicy: StrategyApplyPolicy;
  requiresOrderReconciliation: boolean;
  scope: "ENGINE";
  editable: true;
  storage: { table: "PROFILE" | "PREPARATION"; column: StrategyParameterKey };
};

/** The only UI/API/runtime registry for official bulk-editable strategy data.
 * Values are stored as decimal rates, except the integer monthly target. */
export const STRATEGY_PARAMETER_REGISTRY: Readonly<Record<StrategyParameterKey, StrategyParameterDefinition>> = {
  gain_rate: {
    key: "gain_rate", label: "Gain alvo", type: "PERCENT", unit: "%", min: 0.1, max: 20, precision: 4,
    description: "Alvo de ganho usado por novos ciclos. Posições e TP do ciclo atual preservam a versão original.",
    markets: ["BTC", "SOL"], applyPolicy: "NEXT_CYCLE_ONLY", requiresOrderReconciliation: false,
    scope: "ENGINE", editable: true, storage: { table: "PROFILE", column: "gain_rate" },
  },
  normal_spacing_rate: {
    key: "normal_spacing_rate", label: "Spacing de compra", type: "PERCENT", unit: "%", min: 0.1, max: 20, precision: 4,
    description: "Queda entre compras no regime normal. Somente BUY futura compatível é reconciliada.",
    markets: ["BTC", "SOL"], applyPolicy: "NEXT_BUY_RECONCILE", requiresOrderReconciliation: true,
    scope: "ENGINE", editable: true, storage: { table: "PROFILE", column: "normal_spacing_rate" },
  },
  post_ath_spacing_rate: {
    key: "post_ath_spacing_rate", label: "Spacing pós-ATH", type: "PERCENT", unit: "%", min: 0.1, max: 20, precision: 4,
    description: "Queda entre compras no regime pós-ATH. Histórico, posições e TP não são recalculados.",
    markets: ["BTC", "SOL"], applyPolicy: "NEXT_BUY_RECONCILE", requiresOrderReconciliation: true,
    scope: "ENGINE", editable: true, storage: { table: "PROFILE", column: "post_ath_spacing_rate" },
  },
  monthly_target: {
    key: "monthly_target", label: "Meta mensal", type: "INTEGER", unit: "gains/slot/mês", min: 1, max: 1000, precision: 0,
    description: "Objetivo mensal por slot no mês-calendário operacional. Não apaga gains e nunca para o motor.",
    markets: ["BTC", "SOL"], applyPolicy: "FUTURE_ENTRIES_ONLY", requiresOrderReconciliation: false,
    scope: "ENGINE", editable: true, storage: { table: "PREPARATION", column: "monthly_target" },
  },
};

export const STRATEGY_PARAMETERS = Object.values(STRATEGY_PARAMETER_REGISTRY);

export function strategyParameter(key: unknown): StrategyParameterDefinition {
  if (typeof key !== "string" || !(key in STRATEGY_PARAMETER_REGISTRY))
    throw new Error("COINOPS_BULK_PARAMETER_INVALID");
  return STRATEGY_PARAMETER_REGISTRY[key as StrategyParameterKey];
}

export function parseStrategyParameterValue(definition: StrategyParameterDefinition, value: unknown): number {
  if (typeof value !== "string" || !value.trim() || !/^\d+(?:[.,]\d+)?$/.test(value.trim()))
    throw new Error("COINOPS_BULK_VALUE_INVALID");
  const display = Number(value.trim().replace(",", "."));
  if (!Number.isFinite(display) || display < definition.min || display > definition.max
    || definition.type === "INTEGER" && !Number.isInteger(display)
    || definition.type === "PERCENT" && (value.split(/[.,]/)[1]?.length ?? 0) > definition.precision)
    throw new Error("COINOPS_BULK_VALUE_INVALID");
  return definition.type === "PERCENT" ? display / 100 : display;
}

export function formatStrategyParameterValue(definition: StrategyParameterDefinition, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const display = definition.type === "PERCENT" ? value * 100 : value;
  return `${display.toLocaleString("pt-BR", { maximumFractionDigits: definition.precision })}${definition.type === "PERCENT" ? "%" : ""}`;
}

export function isParameterCompatible(definition: StrategyParameterDefinition, asset: string): asset is V1Asset {
  return definition.markets.includes(asset as V1Asset);
}

export function strategyParameterAffectsCurrentLadder(definition: StrategyParameterDefinition,
  regime: "NORMAL" | "POST_ATH" | string | null | undefined): boolean {
  if (!definition.requiresOrderReconciliation) return false;
  return definition.key === "normal_spacing_rate" && regime === "NORMAL"
    || definition.key === "post_ath_spacing_rate" && regime === "POST_ATH";
}

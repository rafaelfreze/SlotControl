import { distributeLiveCapital } from "./live-capital-distribution.ts";
import { isIdentity } from "./operator-context.ts";
import { DEFAULT_ENGINE_SLOT_COUNT, validateEngineSlotCount } from "./engine-slot-topology.ts";

export type EnginePlanInput = { accountId: string; requestId: string; quote: "BRL" | "USDT" | "USDC";
  capital: string; engines: Array<{ asset: "BTC" | "SOL"; capital: string;
    gainPercent: string; spacingPercent: string; postAthPercent: string; monthlyTarget?: number;
    slotCount?: number; perSlotQuote?: string }> };

function cents(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(value))
    throw new Error("COINOPS_PLAN_AMOUNT_INVALID");
  const [whole, decimal = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("COINOPS_PLAN_AMOUNT_INVALID");
  return result;
}

function rate(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/.test(value))
    throw new Error("COINOPS_PLAN_RATE_INVALID");
  const result = Number(value) / 100;
  if (!Number.isFinite(result) || result < 0.001 || result > 0.2)
    throw new Error("COINOPS_PLAN_RATE_INVALID");
  return result;
}

export function validateEnginePlan(input: EnginePlanInput) {
  if (!input || !isIdentity(input.accountId) || !isIdentity(input.requestId)
    || !["BRL", "USDT", "USDC"].includes(input.quote)
    || !Array.isArray(input.engines) || input.engines.length < 1
    || input.engines.some((item) => !["BTC", "SOL"].includes(item.asset)))
    throw new Error("COINOPS_PLAN_INPUT_INVALID");
  const capitalCents = cents(input.capital);
  const engines = input.engines.map((item) => {
    const engineCents = cents(item.capital);
    const slotCount = validateEngineSlotCount(item.slotCount === undefined ? DEFAULT_ENGINE_SLOT_COUNT : item.slotCount);
    if (item.perSlotQuote !== undefined && cents(item.perSlotQuote) * slotCount !== engineCents)
      throw new Error("COINOPS_PLAN_SLOT_CAP_SUM_MISMATCH");
    const allocation = distributeLiveCapital(engineCents / 100, slotCount);
    return { asset: item.asset, symbol: `${item.asset}${input.quote}`,
      capital: engineCents / 100, slotCount, allocation,
      gain: rate(item.gainPercent), spacing: rate(item.spacingPercent),
      postAth: rate(item.postAthPercent), monthlyTarget: item.monthlyTarget ?? (item.asset === "BTC" ? 7 : 2) };
  });
  // PostgreSQL integer storage range, not an artificial strategy/engine quota.
  if (engines.some((engine) => !Number.isSafeInteger(engine.monthlyTarget) || engine.monthlyTarget < 1
    || engine.monthlyTarget > 2147483647)) throw new Error("COINOPS_PLAN_TARGET_INVALID");
  if (engines.reduce((sum, item) => sum + Math.round(item.capital * 100), 0) !== capitalCents)
    throw new Error("COINOPS_PLAN_CAP_SUM_MISMATCH");
  return { accountId: input.accountId, requestId: input.requestId,
    quote: input.quote, capital: capitalCents / 100, engines };
}

export function equalEngineCapitals(total: string, assets: readonly ("BTC" | "SOL")[]) {
  if (!assets.length || assets.length > 2 || new Set(assets).size !== assets.length)
    throw new Error("COINOPS_PLAN_MARKET_INVALID");
  if (assets.length === 1) return [cents(total) / 100];
  return distributeLiveCapital(cents(total) / 100, assets.length);
}

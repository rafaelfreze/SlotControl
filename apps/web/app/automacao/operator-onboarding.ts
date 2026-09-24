import { isIdentity } from "../../lib/execution/operator-context.ts";

export const ONBOARDING_STEPS = [
  ["DRAFT_CONFIG", "Conta, mercado e limites preparados"],
  ["CREDENTIAL_BOUND", "Credencial instalada no executor seguro"],
  ["READ_ONLY", "GET autenticado na Binance pelo executor"],
  ["WHITELIST", "IPv4 46.101.104.48 autorizado"],
  ["SPOT_PERMISSION", "Permissão Spot verificada"],
  ["DRY_RUN", "Dry-run de 25 slots sem ordens"],
  ["ACTIVATION_GATE", "Gate final e autorização de ativação"],
] as const;
export type OnboardingCheck = { exchange_account_id: string; trading_engine_id: string | null;
  check_key: string; status: "PENDING" | "PASS" | "FAIL"; checked_at: string };
export type AccountDraft = { accountId: string; engineId: string; displayName: string;
  environment: "REAL" | "SHADOW" | "TESTNET"; symbol: string; capital: string;
  engineCap: string; accountCap: string; gainPercent: string; spacingPercent: string; postAthPercent: string };

export function validateAccountDraft(draft: AccountDraft) {
  if (!isIdentity(draft.accountId) || !isIdentity(draft.engineId) || draft.accountId === draft.engineId
    || typeof draft.displayName !== "string" || !draft.displayName.trim() || draft.displayName.trim().length > 80
    || !["REAL", "SHADOW", "TESTNET"].includes(draft.environment)) throw new Error("COINOPS_ONBOARDING_INPUT_INVALID");
  const market = /^(BTC|SOL)(BRL|USDT|USDC)$/.exec(draft.symbol);
  if (!market || draft.environment === "TESTNET" && market[2] === "BRL") throw new Error("COINOPS_ONBOARDING_MARKET_INVALID");
  const amount = (value: string) => {
    if (typeof value !== "string" || !/^\d+(?:\.\d{1,8})?$/.test(value)
      || !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 1_000_000_000)
      throw new Error("COINOPS_ONBOARDING_AMOUNT_INVALID");
    return Number(value);
  };
  const capital = amount(draft.capital), engineCap = amount(draft.engineCap), accountCap = amount(draft.accountCap);
  if (capital > engineCap || engineCap > accountCap) throw new Error("COINOPS_ONBOARDING_CAP_INVALID");
  const percent = (value: string) => { const n = amount(value); if (n < 0.1 || n > 20) throw new Error("COINOPS_ONBOARDING_PROFILE_INVALID"); return n / 100; };
  return { ...draft, displayName: draft.displayName.trim(), base: market[1], quote: market[2], capital,
    engineCap, accountCap, gain: percent(draft.gainPercent), spacing: percent(draft.spacingPercent), postAth: percent(draft.postAthPercent) };
}

export function latestOnboardingChecks(checks: OnboardingCheck[], accountId: string, engineId: string) {
  return ONBOARDING_STEPS.map(([key, label]) => ({ key, label,
    evidence: checks.filter((row) => row.exchange_account_id === accountId
      && row.trading_engine_id === engineId && row.check_key === key)
      .sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0] ?? null }));
}

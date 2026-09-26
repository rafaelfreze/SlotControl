import type { AutomationView } from "./automation-center";
import type { PremiumEngine, PremiumSelection } from "./premium-operator";

export type AutomationSignalScope = {
  environment: string; exchange_account_id: string; trading_engine_id: string; symbol: string;
};

/** A browser subscribes only to engines visible in its current read-only context. */
export function automationSignalScopes(engines: PremiumEngine[], view: AutomationView,
  selection: PremiumSelection): AutomationSignalScope[] {
  const environment = view === "overview" ? null : view === "live" ? "REAL" : view.toUpperCase();
  return engines.filter((engine) => (environment === null || engine.environment === environment)
    && (selection.accountId === "ALL" || engine.accountId === selection.accountId)
    && (selection.symbol === "ALL" || engine.symbol === selection.symbol)
    && /^[0-9a-f-]{36}$/i.test(engine.engineId))
    .map((engine) => ({ environment: engine.environment,
      exchange_account_id: engine.accountId, trading_engine_id: engine.engineId, symbol: engine.symbol }))
    .sort((a, b) => a.trading_engine_id.localeCompare(b.trading_engine_id));
}

export function automationSignalMatches(scope: AutomationSignalScope, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  return signal.environment === scope.environment
    && signal.exchange_account_id === scope.exchange_account_id
    && signal.trading_engine_id === scope.trading_engine_id
    && signal.symbol === scope.symbol;
}

/** One Realtime filter per visible context, not one filter per engine/slot.
 * Auth/RLS remains authoritative; the exact tuple is checked again on receipt. */
export function automationSignalFilter(scopes: AutomationSignalScope[],
  selection: PremiumSelection): string | undefined {
  if (!scopes.length) return undefined;
  if (selection.accountId !== "ALL" && selection.symbol !== "ALL" && scopes.length === 1)
    return `trading_engine_id=eq.${scopes[0].trading_engine_id}`;
  if (selection.accountId !== "ALL") return `exchange_account_id=eq.${selection.accountId}`;
  if (selection.symbol !== "ALL") return `symbol=eq.${selection.symbol}`;
  return scopes.every((scope) => scope.environment === scopes[0].environment)
    ? `environment=eq.${scopes[0].environment}` : undefined;
}

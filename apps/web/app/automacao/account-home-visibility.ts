import type { PremiumEngine, PremiumOperatorPresentation, PremiumSelection } from "./premium-operator";

export type AccountHomePreference = NonNullable<PremiumOperatorPresentation["accountHomePreferences"]>[number];

/** Hiding is a persisted presentation choice, not permission to ignore protection.
 * The canonical read model must prove every operational REAL engine intentionally
 * paused with fresh, complete order/TP evidence. Unknown/active/new engines keep
 * the account visible. Synchronization still observes the unfiltered fleet. */
export function safeHiddenAccountIds(engines: PremiumEngine[], preferences: AccountHomePreference[] = []): Set<string> {
  const hidden = new Set<string>();
  for (const preference of preferences) {
    if (!preference.hidden) continue;
    const operational = engines.filter((engine) => engine.accountId === preference.accountId
      && engine.environment === "REAL" && (engine.engineStatus === "ACTIVE"
        || ["ACTIVE", "PAUSED", "PREPARING"].includes(engine.status)));
    if (operational.length > 0 && operational.every((engine) => engine.status === "PAUSED"
      && engine.engineStatus === "ACTIVE" && engine.killSwitch && engine.entryPauseProtected === true))
      hidden.add(preference.accountId);
  }
  return hidden;
}

/** Only the ALL-account REAL home view applies hiding. Direct selection remains
 * complete and critical/stale evidence invalidates the safe-hidden projection. */
export function homeVisibleEngines(engines: PremiumEngine[], selection: PremiumSelection,
  hiddenAccounts: ReadonlySet<string>): PremiumEngine[] {
  return selection.accountId === "ALL" ? engines.filter((engine) => engine.environment !== "REAL"
    || !hiddenAccounts.has(engine.accountId)) : engines;
}

/** Product retirement (2026-09-30), not an environment-variable toggle.
 * Keep historical ledgers/reporting; only REAL remains operational.
 * Stale COINOPS_TESTNET_ENABLED=true must never reopen this environment.
 */
export function isTestnetEnabled(): boolean { return false; }

export function assertOperationalEnvironment(environment: string) {
  if (environment === "TESTNET" && !isTestnetEnabled())
    throw new Error("COINOPS_TESTNET_DISABLED");
}

export function isRetiredTestnetView(params?: { view?: string; testnet?: string }) {
  return params?.view === "testnet" || params?.testnet !== undefined;
}

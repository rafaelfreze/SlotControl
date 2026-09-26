export type EngineAccountEnvironment = "REAL" | "TESTNET";

export type EngineCatalogAccount = {
  id: string;
  display_name: string;
  status: string;
  kill_switch: boolean;
  is_legacy_default: boolean;
  onboarding_environment: EngineAccountEnvironment | null;
  executor_shard_id: string | null;
};

export type EngineCredentialCheck = {
  status: string;
  evidence: { status?: string; environment?: string } | null;
} | null;

// Assignment determines where a new account belongs. A credential check only
// permits configuration after its environment agrees with that assignment.
export function engineCatalogAccount(account: EngineCatalogAccount, check: EngineCredentialCheck) {
  const checkedEnvironment = check?.evidence?.environment;
  const validEnvironment = checkedEnvironment === "REAL" || checkedEnvironment === "TESTNET"
    ? checkedEnvironment : null;
  const environment = account.onboarding_environment ?? validEnvironment
    ?? (account.is_legacy_default ? "REAL" : null);
  return {
    ...account,
    environment,
    credentialValidated: check?.status === "PASS" && check.evidence?.status === "PASS"
      && validEnvironment === environment && !!account.executor_shard_id,
  };
}

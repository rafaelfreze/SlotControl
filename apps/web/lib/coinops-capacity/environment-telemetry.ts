/** Testnet is credential-bound transport, not the REAL executor registry. The
 * database remains authoritative for engine/run ownership and counts. */
export function testnetCredentialCoverage(sample: {
  registry_scope?: string; credential_account_ids?: string[];
}, activeAccountIds: readonly string[]) {
  return sample.registry_scope === "CREDENTIAL_BOUND_TRANSPORT"
    && Array.isArray(sample.credential_account_ids)
    && sample.credential_account_ids.every((id) => typeof id === "string" && id.length > 0)
    && activeAccountIds.every((id) => sample.credential_account_ids!.includes(id));
}

type CredentialValidation = { evidence?: { fingerprint?: string | null; status?: string } } | null | undefined;

/** Only a successful vault-write response proves REPLACE is possible.
 * Failed attempts and removed credentials must follow CONNECT, whose executor
 * implementation remains idempotent for the same existing API fingerprint. */
export function credentialOnboardingOperation(validation: CredentialValidation): "CONNECT" | "REPLACE" {
  const evidence = validation?.evidence;
  return evidence?.fingerprint && ["PASS", "WARNING"].includes(evidence.status ?? "") ? "REPLACE" : "CONNECT";
}

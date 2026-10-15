export type ProvisioningStage = "service_client" | "nonce_claim" | "actor_resolution" | "actor_operator_read" | "actor_auth_read" | "existing_access_read" | "identity_create" | "identity_reconcile_read" | "account_auth_read" | "account_access_read" | "account_result";
const stages = new Set<string>(["service_client", "nonce_claim", "actor_resolution", "actor_operator_read", "actor_auth_read", "existing_access_read", "identity_create", "identity_reconcile_read", "account_auth_read", "account_access_read", "account_result"]);
const codes = new Set([
  "unexpected_failure", "validation_failed", "weak_password", "email_exists", "user_already_exists", "user_not_found", "user_banned", "not_admin", "bad_jwt", "bad_json", "no_authorization", "invalid_credentials", "invalid_request", "request_timeout", "timeout", "conflict", "over_request_rate_limit", "over_email_send_rate_limit", "email_address_invalid", "email_address_not_authorized", "email_provider_disabled", "signup_disabled",
  "provisioning_actor_unavailable", "account_readback_unavailable", "account_access_unavailable", "account_request_conflict", "billing_backend_mismatch", "billing_origin_invalid", "COINOPS_VIEWER_PASSWORD_INVALID", "COINOPS_VIEWER_CREATE_UNCONFIRMED", "COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED", "COINOPS_VIEWER_CONTACT_INVALID",
  "42501", "23505", "23502", "23503", "23514", "22023", "42P01", "42703", "PGRST116", "PGRST202", "PGRST204", "PGRST301", "PGRST302",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only fixed stages, allowlisted codes/status and a validated request UUID leave the server. */
export function provisioningDiagnostic(stage: ProvisioningStage, error: unknown, requestId?: string) {
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; message?: unknown } : {};
  const candidate = typeof value.code === "string" ? value.code : typeof value.message === "string" ? value.message : "";
  return {
    event: "COINOPS_ACCOUNT_PROVISION_FAILED",
    stage: stages.has(stage) ? stage : "unknown",
    ...(requestId && uuid.test(requestId) ? { request_id: requestId.toLowerCase() } : {}),
    code: codes.has(candidate) ? candidate : "unclassified",
    ...(typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? { provider_status: value.status } : {}),
  };
}

export function reportProvisioningFailure(stage: ProvisioningStage, error: unknown, requestId?: string) {
  console.error(JSON.stringify(provisioningDiagnostic(stage, error, requestId)));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9]{32,128}$/;

export type CredentialIntent = { operation?: string; requestId?: string; accountId?: string;
  displayName?: string; environment?: string; plannedEngines?: number; apiKey?: string; apiSecret?: string;
  fromShardId?: string; toShardId?: string };

export function assertSameOrigin(origin: string | null, targetOrigin: string,
  fetchSite: string | null, intentHeader: string | null, contentType: string | null) {
  if (!origin || origin !== targetOrigin || fetchSite && fetchSite !== "same-origin"
    || intentHeader !== "binance-credentials" || contentType?.split(";")[0] !== "application/json")
    throw new Error("COINOPS_ADMIN_CSRF_DENIED");
}

export function validateCredentialIntent(input: CredentialIntent) {
  if (!UUID.test(input.requestId ?? "") || !UUID.test(input.accountId ?? "")
    || !["ASSIGN", "REASSIGN_STAGED", "CONNECT", "REVALIDATE", "REPLACE", "DEACTIVATE", "REMOVE"].includes(input.operation ?? ""))
    throw new Error("COINOPS_ADMIN_INTENT_INVALID");
  if (input.operation === "REASSIGN_STAGED" && (!/^executor-[0-9]{2,}$/.test(input.fromShardId ?? "")
    || !/^executor-[0-9]{2,}$/.test(input.toShardId ?? "") || input.fromShardId === input.toShardId))
    throw new Error("COINOPS_ADMIN_INTENT_INVALID");
  if (input.operation !== "REASSIGN_STAGED" && (input.fromShardId || input.toShardId))
    throw new Error("COINOPS_ADMIN_INTENT_INVALID");
  if (["ASSIGN", "CONNECT"].includes(input.operation ?? "") && (!input.displayName
    || input.displayName.trim().length < 1 || input.displayName.trim().length > 80
    || !["REAL", "TESTNET"].includes(input.environment ?? "")))
    throw new Error("COINOPS_ADMIN_INTENT_INVALID");
  if (input.operation === "ASSIGN" && (![1, 2].includes(input.plannedEngines ?? 0)
    || !Number.isInteger(input.plannedEngines))) throw new Error("COINOPS_ADMIN_INTENT_INVALID");
  if (["CONNECT", "REPLACE"].includes(input.operation ?? "")
    && (!KEY.test(input.apiKey ?? "") || !KEY.test(input.apiSecret ?? "")))
    throw new Error("COINOPS_ADMIN_CREDENTIAL_FORMAT_INVALID");
  if (!["CONNECT", "REPLACE"].includes(input.operation ?? "") && (input.apiKey || input.apiSecret))
    throw new Error("COINOPS_ADMIN_INTENT_INVALID");
}

export function assertOwnedAccount(account: { operator_id: string; is_legacy_default: boolean } | null,
  operatorId: string) {
  if (account && (account.operator_id !== operatorId || account.is_legacy_default))
    throw new Error("COINOPS_ADMIN_ACCOUNT_DENIED");
}

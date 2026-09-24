const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ViewerIntent = { operation?: string; requestId?: string; accountId?: string;
  userId?: string; displayName?: string; email?: string };

export function assertViewerIntent(input: ViewerIntent) {
  if (!UUID.test(input.requestId ?? "") || !["CREATE", "DISABLE", "ENABLE", "RESET", "REVOKE"].includes(input.operation ?? ""))
    throw new Error("COINOPS_VIEWER_INTENT_INVALID");
  if (input.operation === "CREATE") {
    if (!UUID.test(input.accountId ?? "") || !input.displayName || input.displayName.trim().length > 80
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email ?? "") || (input.email ?? "").length > 320)
      throw new Error("COINOPS_VIEWER_INTENT_INVALID");
  } else if (!UUID.test(input.userId ?? "") || input.accountId || input.email || input.displayName) {
    throw new Error("COINOPS_VIEWER_INTENT_INVALID");
  }
}

export function assertViewerOrigin(origin: string | null, expected: string, site: string | null,
  intent: string | null, contentType: string | null) {
  if (origin !== expected || site && site !== "same-origin" || intent !== "viewer-access"
    || contentType?.split(";")[0] !== "application/json") throw new Error("COINOPS_VIEWER_CSRF_DENIED");
}

export function assertViewerAccount(account: { operator_id: string; status: string } | null, operatorId: string) {
  if (!account || account.operator_id !== operatorId || !["ACTIVE", "INACTIVE"].includes(account.status))
    throw new Error("COINOPS_VIEWER_ACCOUNT_DENIED");
}

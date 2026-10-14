const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ViewerIntent = { operation?: string; requestId?: string; accountId?: string;
  userId?: string; displayName?: string; email?: string; password?: string; companyName?: string; ownerName?: string; whatsapp?: string };

export function assertViewerIntent(input: ViewerIntent) {
  if (!UUID.test(input.requestId ?? "") || !["CREATE", "CREATE_WITH_PASSWORD", "DISABLE", "ENABLE", "RESET", "REVOKE", "REASSIGN", "ASSIGN", "DELETE"].includes(input.operation ?? ""))
    throw new Error("COINOPS_VIEWER_INTENT_INVALID");
  if (input.operation === "CREATE_WITH_PASSWORD") {
    if (input.accountId !== undefined || input.userId !== undefined || input.displayName !== undefined
      || typeof input.companyName !== "string" || input.companyName.trim().length < 2 || input.companyName.trim().length > 120
      || typeof input.ownerName !== "string" || input.ownerName.trim().length < 2 || input.ownerName.trim().length > 120
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email ?? "") || (input.email ?? "").length > 320)
      throw new Error("COINOPS_VIEWER_INTENT_INVALID");
    if (typeof input.password !== "string" || input.password.length < 8) throw new Error("COINOPS_VIEWER_PASSWORD_INVALID");
    normalizeViewerWhatsApp(input.whatsapp);
  } else if (input.operation === "CREATE") {
    if (!UUID.test(input.accountId ?? "") || !input.displayName?.trim() || input.displayName.trim().length > 80
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email ?? "") || (input.email ?? "").length > 320 || input.password !== undefined)
      throw new Error("COINOPS_VIEWER_INTENT_INVALID");
  } else if (input.operation === "REASSIGN" || input.operation === "ASSIGN") {
    if (!UUID.test(input.userId ?? "") || !UUID.test(input.accountId ?? "") || input.email || input.displayName || input.password !== undefined)
      throw new Error("COINOPS_VIEWER_INTENT_INVALID");
  } else if (!UUID.test(input.userId ?? "") || input.accountId || input.email || input.displayName || input.password !== undefined) {
    throw new Error("COINOPS_VIEWER_INTENT_INVALID");
  }
}

export function assertViewerInactive(status: string) {
  if (status !== "INACTIVE") throw new Error("COINOPS_VIEWER_REASSIGN_REQUIRES_INACTIVE");
}

export function assertViewerResetActive(status: string) {
  if (status !== "ACTIVE") throw new Error("COINOPS_VIEWER_RESET_REQUIRES_ACTIVE");
}

export function viewerResetFailureCode(error: { code?: string; status?: number } | null) {
  if (error?.status === 429 || error?.code === "over_email_send_rate_limit") return "COINOPS_VIEWER_RESET_RATE_LIMIT";
  if (error?.code === "user_banned") return "COINOPS_VIEWER_RESET_REQUIRES_ACTIVE";
  return "COINOPS_VIEWER_RESET_FAILED";
}

export function assertViewerRestoreIdentity(user: { email?: string; app_metadata?: Record<string, unknown> } | null, email: string) {
  if (!user || user.email?.toLowerCase() !== email || user.app_metadata?.coinops_role !== "VIEWER")
    throw new Error("COINOPS_VIEWER_RESTORE_IDENTITY_DENIED");
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

export function viewerInviteFailureCode(error: { code?: string; status?: number } | null) {
  return ["email_exists", "user_already_exists"].includes(error?.code ?? "")
    ? "COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED" : "COINOPS_VIEWER_INVITE_FAILED";
}

export function normalizeViewerWhatsApp(value: unknown) {
  if (typeof value !== "string") throw new Error("COINOPS_VIEWER_CONTACT_INVALID");
  const digits=value.replace(/\D/g,"");const phone="+"+((digits.length===12||digits.length===13)&&digits.startsWith("55")?digits:"55"+digits);
  if(!/^\+55[1-9][0-9](9[0-9]{8}|[2-9][0-9]{7})$/.test(phone)) throw new Error("COINOPS_VIEWER_CONTACT_INVALID");
  return phone;
}

/** Accept only the authenticated destination executor's signed observation.
 * No secret or physical UID is included in the persisted/public proof. */
export function accountConnectionProof(result: Record<string, unknown>, target: { shardId: string; ip: string;
  credentialRef: string }, operatorId: string, accountId: string, now = Date.now()) {
  const permission = result.permission as Record<string, unknown> | undefined;
  const validatedAt = typeof result.validatedAt === "string" ? Date.parse(result.validatedAt) : NaN;
  if (result.operator_id !== operatorId || result.exchange_account_id !== accountId
    || result.executor_shard_id !== target.shardId || result.environment !== "REAL"
    || result.status !== "PASS" || result.executorIp !== target.ip || result.whitelistAccepted !== true
    || result.credential_ref !== target.credentialRef || !Number.isFinite(now) || !Number.isFinite(validatedAt)
    || now - validatedAt > 30_000 || validatedAt > now + 2000
    || permission?.read !== true || permission.spotTrading !== true
    || ["withdrawals", "internalTransfer", "universalTransfer", "margin", "futures", "options",
      "fixTrading", "portfolioMargin"].some((name) => permission[name] !== false)
    || result.apiKey !== undefined || result.apiSecret !== undefined)
    throw new Error("COINOPS_BINANCE_CREDENTIAL_SHARD_VALIDATION_REQUIRED");
  const safePermissions = Object.fromEntries(["read", "spotTrading", "withdrawals", "internalTransfer",
    "universalTransfer", "margin", "futures", "options", "fixTrading", "portfolioMargin"].map((name) => [name, permission![name]]));
  return { status: "PASS", environment: "REAL", executor_shard_id: target.shardId,
    executor_ip: target.ip, credential_ref: target.credentialRef, whitelist_accepted: true,
    permission: safePermissions, validated_at: result.validatedAt };
}

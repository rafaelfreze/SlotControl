/** A slow/restarted worker must never renew an expired lease or another
 * worker's ownership. The persistence callback performs owner+expiry CAS. */
export async function renewExecutionLease(input: {
  owner: string | null; expiresAt: string | null;
  persist: (expectedOwner: string, observedAt: string, nextExpiry: string) => Promise<boolean>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const observed = now();
  if (!input.owner || !input.expiresAt || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= observed)
    throw new Error("COINOPS_EXECUTION_LEASE_LOST");
  const nextExpiry = new Date(observed + 90_000).toISOString();
  if (!await input.persist(input.owner, new Date(observed).toISOString(), nextExpiry)
    || now() >= Date.parse(nextExpiry)) throw new Error("COINOPS_EXECUTION_LEASE_LOST");
  return nextExpiry;
}

/** Only a server-proven transient GET observation may carry this public digest.
 * Unknown/auth/permission/schema errors never inherit automatic recovery. */
export const AUTOMATION_READ_TRANSIENT_DIGEST = "COINOPS_AUTOMATION_READ_TRANSIENT";
export const AUTOMATION_READ_RECOVERY_DELAYS = [5_000, 15_000] as const;

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = (pathname: string) => `coinops-automation-read-recovery-v2:${pathname}`;
const supported = (pathname: string) => pathname === "/automacao";

function attempts(storage: RecoveryStorage, pathname: string): number | null {
  if (!supported(pathname)) return null;
  try {
    const raw = storage.getItem(key(pathname));
    if (raw === null) return 0;
    const count: unknown = JSON.parse(raw);
    return Number.isInteger(count) && Number(count) >= 0 && Number(count) <= AUTOMATION_READ_RECOVERY_DELAYS.length
      ? Number(count) : null;
  } catch { return null; }
}

export function planAutomationReadRecovery(storage: RecoveryStorage, pathname: string, digest: string | undefined) {
  if (digest !== AUTOMATION_READ_TRANSIENT_DIGEST) return null;
  const count = attempts(storage, pathname);
  return count === null || count >= AUTOMATION_READ_RECOVERY_DELAYS.length ? null
    : { attempt: count + 1, delay: AUTOMATION_READ_RECOVERY_DELAYS[count] };
}

/** Consume just before a visible/online retry, not before a cancelled timer. */
export function claimAutomationReadRecovery(storage: RecoveryStorage, pathname: string, digest: string | undefined): boolean {
  const plan = planAutomationReadRecovery(storage, pathname, digest);
  if (!plan) return false;
  try { storage.setItem(key(pathname), JSON.stringify(plan.attempt)); return true; }
  catch { return false; }
}

/** A successfully rendered fresh server page ends the episode. Merely elapsed
 * time/focus/reset must not replenish a persistent failure's retry budget. */
export function clearAutomationReadRecovery(storage: RecoveryStorage, pathname: string): void {
  if (!supported(pathname)) return;
  try { storage.removeItem(key(pathname)); } catch { /* manual recovery remains available */ }
}

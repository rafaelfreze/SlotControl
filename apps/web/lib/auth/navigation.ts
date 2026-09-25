export const AUTHENTICATED_HOME = "/automacao";

type ReturnPaths = { redirectTo?: unknown; returnTo?: unknown; next?: unknown };

/** Auth returns stay inside CoinOps; an absent/invalid target uses the operational home. */
export function getAuthDestination(paths: ReturnPaths = {}): string {
  const value = paths.redirectTo ?? paths.returnTo ?? paths.next;
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return AUTHENTICATED_HOME;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) {
    return AUTHENTICATED_HOME;
  }
  try {
    const origin = "https://coinops.invalid";
    const target = new URL(value, origin);
    if (target.origin !== origin || target.pathname.startsWith("//")) return AUTHENTICATED_HOME;
    if (target.pathname === "/dashboard" || target.pathname.startsWith("/dashboard/")) return AUTHENTICATED_HOME;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return AUTHENTICATED_HOME;
  }
}

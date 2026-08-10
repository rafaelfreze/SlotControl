const COINOPS_PRODUCTION_ORIGIN = "https://cripto-flax.vercel.app";

function normalizeOrigin(value: string | undefined) {
  if (!value) return COINOPS_PRODUCTION_ORIGIN;
  try {
    const url = new URL(value);
    if (process.env.NODE_ENV === "production" && url.origin !== COINOPS_PRODUCTION_ORIGIN) {
      return COINOPS_PRODUCTION_ORIGIN;
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost") return COINOPS_PRODUCTION_ORIGIN;
    return url.origin;
  } catch {
    return COINOPS_PRODUCTION_ORIGIN;
  }
}

export function getCoinOpsAuthCallback(nextPath: "/dashboard" | "/redefinir-senha") {
  const origin = normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL);
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("next", nextPath);
  return callback.toString();
}

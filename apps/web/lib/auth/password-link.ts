export type PasswordLink =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "session"; accessToken: string; refreshToken: string };

/** Supabase admin invites/recovery return an implicit fragment, while the SSR
 * browser client uses PKCE. Only the password page may bridge these flows. */
export function parsePasswordLink(hash: string): PasswordLink {
  if (!hash || hash === "#") return { kind: "none" };
  if (!hash.startsWith("#")) return { kind: "invalid" };
  const params = new URLSearchParams(hash.slice(1));
  if (params.get("error") || !["invite", "recovery"].includes(params.get("type") ?? ""))
    return { kind: "invalid" };
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return { kind: "invalid" };
  return { kind: "session", accessToken, refreshToken };
}

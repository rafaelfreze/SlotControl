export type PasswordLink =
  | { kind: "none" }
  | { kind: "invalid"; reason?: "disabled" }
  | { kind: "session"; accessToken: string; refreshToken: string };

/** Supabase admin invites/recovery return an implicit fragment, while the SSR
 * browser client uses PKCE. Only the password page may bridge these flows. */
export function parsePasswordLink(hash: string): PasswordLink {
  if (!hash || hash === "#") return { kind: "none" };
  if (!hash.startsWith("#")) return { kind: "invalid" };
  const params = new URLSearchParams(hash.slice(1));
  if (params.get("error_code") === "user_banned") return { kind: "invalid", reason: "disabled" };
  if (params.get("error") || !["invite", "recovery"].includes(params.get("type") ?? ""))
    return { kind: "invalid" };
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return { kind: "invalid" };
  return { kind: "session", accessToken, refreshToken };
}

export function passwordLinkError(link: PasswordLink) {
  return link.kind === "invalid" && link.reason === "disabled"
    ? "Este acesso foi desativado. Não utilize o convite antigo; solicite ao administrador um link do acesso ativo à conta correta."
    : "Link inválido ou expirado. Solicite um novo link de recuperação e utilize somente o e-mail mais recente.";
}

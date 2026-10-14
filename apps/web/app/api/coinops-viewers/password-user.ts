import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ViewerIntent } from "./policy";

export async function createPasswordViewerIdentity(service: Pick<SupabaseClient, "auth">, input: ViewerIntent, actorId: string) {
  const email = input.email!.trim().toLowerCase();
  const marker = { request_id: input.requestId, actor_id: actorId, account_id: input.accountId };
  const created = await service.auth.admin.createUser({ email, password: input.password!, email_confirm: true,
    app_metadata: { coinops_role: "VIEWER", coinops_provision: marker } });
  if (!created.error && created.data.user) return created.data.user;
  if (created.error?.code === "weak_password") throw new Error("COINOPS_VIEWER_PASSWORD_INVALID");
  if (!["email_exists", "user_already_exists"].includes(created.error?.code ?? ""))
    throw new Error("COINOPS_VIEWER_CREATE_UNCONFIRMED");
  // Recover only this exact request after a lost response/binding failure. The
  // server never returns the Auth directory or modifies an existing password.
  for (let page = 1; page <= 20; page++) {
    const users = await service.auth.admin.listUsers({ page, perPage: 100 });
    if (users.error) break;
    const user = users.data.users.find((candidate: User) => candidate.email?.toLowerCase() === email);
    if (user) {
      const provision = user.app_metadata?.coinops_provision;
      if (user.app_metadata?.coinops_role === "VIEWER" && provision?.request_id === input.requestId
        && provision?.actor_id === actorId && provision?.account_id === input.accountId) return user;
      break;
    }
    if (users.data.users.length < 100) break;
  }
  throw new Error("COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED");
}

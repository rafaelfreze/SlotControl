"use client";

import { createClient } from "@/lib/supabase/browser";

export function ViewerSignOut() {
  return <button type="button" className="viewer-signout" onClick={async () => {
    await createClient().auth.signOut({ scope: "local" });
    window.location.assign("/login");
  }}>Sair</button>;
}

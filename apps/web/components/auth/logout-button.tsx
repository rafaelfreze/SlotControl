"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { createClient } from "@/lib/supabase/browser";

export function LogoutButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleLogout() {
    startTransition(async () => {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <button className="ghost-button" type="button" onClick={handleLogout} disabled={isPending}>
      {isPending ? "Saindo..." : "Sair"}
    </button>
  );
}

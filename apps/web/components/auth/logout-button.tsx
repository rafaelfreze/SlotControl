"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { createClient } from "@/lib/supabase/browser";

export function LogoutButton({ label = "Sair", className = "ghost-button" }: { label?: string; className?: string }) {
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
    <button className={className} type="button" onClick={handleLogout} disabled={isPending}>
      {isPending ? "Saindo..." : label}
    </button>
  );
}

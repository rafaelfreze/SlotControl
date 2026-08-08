"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/browser";

export function PasswordResetForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const configured = isSupabaseConfigured();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") || "");
    const confirmation = String(formData.get("confirmation") || "");

    if (password !== confirmation) {
      setError("As senhas precisam ser iguais.");
      return;
    }

    startTransition(async () => {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }

      await supabase.auth.signOut();
      router.replace("/login?auth=password-updated");
      router.refresh();
    });
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label>
        Nova senha
        <input name="password" type="password" minLength={8} placeholder="Minimo 8 caracteres" autoComplete="new-password" required />
      </label>
      <label>
        Confirmar nova senha
        <input name="confirmation" type="password" minLength={8} placeholder="Repita a nova senha" autoComplete="new-password" required />
      </label>
      {error ? <div className="form-error">{error}</div> : null}
      <button className="solid-button" type="submit" disabled={isPending || !configured}>
        {isPending ? "Atualizando..." : "Atualizar senha"}
      </button>
    </form>
  );
}

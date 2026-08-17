"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { friendlyAuthError, MIN_PASSWORD_LENGTH, validateNewPassword } from "@/lib/auth/password-policy";
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

    const validationError = validateNewPassword(password, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }

    startTransition(async () => {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(friendlyAuthError(updateError, "reset"));
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
        <input name="password" type="password" minLength={MIN_PASSWORD_LENGTH} placeholder="Mínimo 8 caracteres" autoComplete="new-password" required />
      </label>
      <label>
        Confirmar nova senha
        <input name="confirmation" type="password" minLength={MIN_PASSWORD_LENGTH} placeholder="Repita a nova senha" autoComplete="new-password" required />
      </label>
      <p className="auth-hint">Use pelo menos 8 caracteres.</p>
      {error ? <div className="form-error">{error}</div> : null}
      <button className="solid-button" type="submit" disabled={isPending || !configured}>
        {isPending ? "Atualizando..." : "Atualizar senha"}
      </button>
    </form>
  );
}

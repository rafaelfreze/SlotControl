"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/browser";

type AuthFormProps = {
  mode: "login" | "signup";
  redirectTo: string;
};

export function AuthForm({ mode, redirectTo }: AuthFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const configured = isSupabaseConfigured();
  const isSignup = mode === "signup";

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!configured) {
      setError("Configure o Supabase antes de testar autenticacao.");
      return;
    }

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    const displayName = String(formData.get("displayName") || "").trim();

    startTransition(async () => {
      const supabase = createClient();

      if (isSignup) {
        const { data, error: signupError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              display_name: displayName
            },
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`
          }
        });

        if (signupError) {
          setError(signupError.message);
          return;
        }

        if (!data.session) {
          setMessage("Conta criada. Confira seu email para confirmar o acesso, se essa opcao estiver ativa.");
          return;
        }
      } else {
        const { error: loginError } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (loginError) {
          setError(loginError.message);
          return;
        }
      }

      router.replace(redirectTo);
      router.refresh();
    });
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      {isSignup ? (
        <label>
          Nome
          <input name="displayName" type="text" placeholder="Rafael" autoComplete="name" />
        </label>
      ) : null}

      <label>
        Email
        <input name="email" type="email" placeholder="voce@email.com" autoComplete="email" required />
      </label>

      <label>
        Senha
        <input
          name="password"
          type="password"
          minLength={6}
          placeholder="Minimo 6 caracteres"
          autoComplete={isSignup ? "new-password" : "current-password"}
          required
        />
      </label>

      {error ? <div className="form-error">{error}</div> : null}
      {message ? <div className="form-success">{message}</div> : null}

      <button className="solid-button" type="submit" disabled={isPending || !configured}>
        {isPending ? "Processando..." : isSignup ? "Criar conta" : "Entrar"}
      </button>
    </form>
  );
}

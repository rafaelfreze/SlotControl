"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { getCoinOpsAuthCallback, getCoinOpsPasswordRedirect } from "@/lib/auth-email-url";
import { AUTHENTICATED_HOME } from "@/lib/auth/navigation";
import { friendlyAuthError, MIN_PASSWORD_LENGTH, validateNewPassword } from "@/lib/auth/password-policy";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/browser";

type AuthFormProps = {
  mode: "login" | "signup" | "recovery";
  redirectTo: string;
};

export function AuthForm({ mode, redirectTo }: AuthFormProps) {
  const router = useRouter();
  const [isPending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const configured = isSupabaseConfigured();
  const isSignup = mode === "signup";
  const isRecovery = mode === "recovery";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError(null);
    setMessage(null);

    if (!configured) {
      setError("Configure o Supabase antes de testar autenticacao.");
      return;
    }

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    const companyName = String(formData.get("companyName") || "").trim();
    const ownerName = String(formData.get("ownerName") || "").trim();
    const digits = String(formData.get("whatsapp") || "").replace(/\D/g, "");
    const whatsapp = "+" + ((digits.length === 12 || digits.length === 13) && digits.startsWith("55") ? digits : "55" + digits);

    inFlight.current = true;
    setPending(true);
    try {
      const supabase = createClient();

      if (isRecovery) {
        const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: getCoinOpsPasswordRedirect()
        });

        if (recoveryError) {
          setError(friendlyAuthError(recoveryError, "recovery"));
          return;
        }

        setMessage("Se o email estiver cadastrado, enviaremos as instrucoes para redefinir a senha.");
        return;
      }

      if (isSignup) {
        const validationError = validateNewPassword(password);
        if (validationError) {
          setError(validationError);
          return;
        }
        if (companyName.length < 2 || ownerName.length < 2 || !/^\+55[1-9][0-9](9[0-9]{8}|[2-9][0-9]{7})$/.test(whatsapp)) { setError("Confira empresa, nome do dono e WhatsApp com DDD."); return; }
        const { data, error: signupError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              onplay_product: "coinops", company_name: companyName, owner_name: ownerName, whatsapp
            },
            emailRedirectTo: getCoinOpsAuthCallback(AUTHENTICATED_HOME)
          }
        });

        if (signupError) {
          setError(friendlyAuthError(signupError, "signup"));
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
          setError(friendlyAuthError(loginError, "login"));
          return;
        }
      }

      router.replace(redirectTo);
      router.refresh();
    } catch (failure) {
      setError(friendlyAuthError(failure, isRecovery ? "recovery" : isSignup ? "signup" : "login"));
    } finally { inFlight.current = false; setPending(false); }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      {isSignup ? <>
        <label>Nome da empresa<input name="companyName" minLength={2} maxLength={120} required autoComplete="organization" /></label>
        <label>Nome do dono<input name="ownerName" minLength={2} maxLength={120} required autoComplete="name" /></label>
        <label>WhatsApp<input name="whatsapp" type="tel" required autoComplete="tel" placeholder="DDD e número" /></label>
      </> : null}
      <label>
        Email
        <input name="email" type="email" placeholder="voce@email.com" autoComplete="email" required />
      </label>

      {!isRecovery ? (
        <label>
          Senha
          <input
            name="password"
            type="password"
            minLength={isSignup ? MIN_PASSWORD_LENGTH : undefined}
            placeholder={isSignup ? "Mínimo 8 caracteres" : "Sua senha"}
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
          />
        </label>
      ) : null}



      {error ? <div className="form-error" role="alert">{error}</div> : null}
      {message ? <div className="form-success" role="status">{message}</div> : null}

      <button className="solid-button" type="submit" disabled={isPending || !configured}>
        {isPending ? "Processando..." : isRecovery ? "Enviar instrucoes" : isSignup ? "Criar conta" : "Entrar"}
      </button>
    </form>
  );
}

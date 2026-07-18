import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/components/auth/auth-form";
import { CoinOpsBrand } from "@/components/app/coinops-brand";

export const metadata: Metadata = {
  title: "Entrar"
};

export default function LoginPage({
  searchParams
}: {
  searchParams?: { auth?: string; redirectTo?: string; setup?: string };
}) {
  return (
    <main className="page-shell auth-shell">
      <Link className="brand-link auth-brand" href="/">
        <CoinOpsBrand subtitle="Acesso seguro" />
      </Link>

      <section className="auth-card">
        <p className="eyebrow">Login</p>
        <h1>Entrar no painel</h1>
        <p className="muted-text">Acesse seus slots, historico e configuracoes privadas.</p>

        {searchParams?.setup === "missing-env" ? (
          <div className="inline-alert">
            Preencha as variaveis do Supabase em `.env.local` para ativar login e dashboard.
          </div>
        ) : null}

        {searchParams?.auth === "callback-error" ? (
          <div className="inline-alert">
            Nao foi possivel confirmar a sessao. Tente entrar novamente.
          </div>
        ) : null}

        <AuthForm mode="login" redirectTo={searchParams?.redirectTo || "/dashboard"} />

        <p className="auth-switch">
          Ainda nao tem conta? <Link href="/cadastro">Criar conta</Link>
        </p>
      </section>
    </main>
  );
}

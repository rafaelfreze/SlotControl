import type { Metadata } from "next";
import Link from "next/link";

import { AuthForm } from "@/components/auth/auth-form";
import { CoinOpsBrand } from "@/components/app/coinops-brand";

export const metadata: Metadata = {
  title: "Criar conta"
};

export default function CadastroPage() {
  return (
    <main className="page-shell auth-shell">
      <Link className="brand-link auth-brand" href="/">
        <CoinOpsBrand subtitle="Novo usuario" />
      </Link>

      <section className="auth-card">
        <p className="eyebrow">Cadastro</p>
        <h1>Criar sua conta</h1>
        <p className="muted-text">Cada usuario tera seus proprios slots, historico e configuracoes.</p>

        <AuthForm mode="signup" redirectTo="/dashboard" />

        <p className="auth-switch">
          Ja tem conta? <Link href="/login">Entrar</Link>
        </p>
      </section>
    </main>
  );
}

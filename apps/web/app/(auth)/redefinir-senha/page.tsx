import type { Metadata } from "next";
import Link from "next/link";

import { CoinOpsBrand } from "@/components/app/coinops-brand";
import { PasswordResetForm } from "@/components/auth/password-reset-form";

export const metadata: Metadata = { title: "Redefinir senha" };

export default function PasswordResetPage() {
  return (
    <main className="page-shell auth-shell">
      <Link className="brand-link auth-brand" href="/">
        <CoinOpsBrand subtitle="Acesso seguro" />
      </Link>
      <section className="auth-card">
        <p className="eyebrow">Nova senha</p>
        <h1>Escolha uma senha segura</h1>
        <p className="muted-text">Sua nova senha sera usada no proximo acesso.</p>
        <PasswordResetForm />
      </section>
    </main>
  );
}

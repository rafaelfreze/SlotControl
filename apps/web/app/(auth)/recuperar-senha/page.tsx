import type { Metadata } from "next";
import Link from "next/link";

import { CoinOpsBrand } from "@/components/app/coinops-brand";
import { AuthForm } from "@/components/auth/auth-form";

export const metadata: Metadata = { title: "Recuperar senha" };

export default function PasswordRecoveryPage() {
  return (
    <main className="page-shell auth-shell">
      <Link className="brand-link auth-brand" href="/">
        <CoinOpsBrand subtitle="Acesso seguro" />
      </Link>
      <section className="auth-card">
        <p className="eyebrow">Recuperar senha</p>
        <h1>Redefina seu acesso</h1>
        <p className="muted-text">Informe seu email para receber um link seguro de redefinicao.</p>
        <AuthForm mode="recovery" redirectTo="/login" />
        <p className="auth-switch"><Link href="/login">Voltar para o login</Link></p>
      </section>
    </main>
  );
}

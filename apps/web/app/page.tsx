import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

async function getSessionEmail() {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  return user?.email ?? null;
}

export default async function HomePage() {
  const email = await getSessionEmail();

  if (email) {
    redirect("/dashboard");
  }

  return (
    <main className="page-shell landing-shell">
      <nav className="top-nav" aria-label="Principal">
        <Link className="brand-link" href="/">
          <span className="brand-mark" aria-hidden="true">
            SG
          </span>
          <span>
            <strong>SlotGain Control</strong>
            <small>SaaS cripto</small>
          </span>
        </Link>
        <div className="nav-actions">
          <Link className="ghost-link" href="/login">
            Entrar
          </Link>
          <Link className="solid-link" href="/cadastro">
            Criar conta
          </Link>
        </div>
      </nav>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">Controle por slots com dados privados</p>
          <h1>Seu painel de slots cripto pronto para virar SaaS.</h1>
          <p className="hero-text">
            Controle seus slots com Supabase Auth, dashboard protegido e dados
            separados por usuario.
          </p>
          <div className="hero-actions">
            <Link className="solid-link large" href="/cadastro">
              Comecar agora
            </Link>
            <Link className="ghost-link large" href="/login">
              Ja tenho conta
            </Link>
          </div>
        </div>

        <div className="market-preview" aria-label="Previa do dashboard">
          <div className="preview-header">
            <span>BTC 1%</span>
            <strong>+12.8%</strong>
          </div>
          <div className="chart-bars" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="preview-metrics">
            <article>
              <span>Total atualizado</span>
              <strong>1.482,40 USDT</strong>
            </article>
            <article>
              <span>Slots abertos</span>
              <strong>4</strong>
            </article>
          </div>
          <div className="slot-tape" aria-hidden="true">
            <span className="is-open">Aberto</span>
            <span className="is-gain">Gain</span>
            <span className="is-zero">Zerado</span>
          </div>
        </div>
      </section>

      <section className="feature-grid" aria-label="Recursos">
        <article>
          <span>01</span>
          <h2>Login e cadastro</h2>
          <p>Supabase Auth fica responsavel por conta, sessao e separacao de usuarios.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Dashboard protegido</h2>
          <p>Rotas privadas passam pelo middleware antes de mostrar qualquer dado.</p>
        </article>
        <article>
          <span>03</span>
          <h2>PWA inicial</h2>
          <p>Manifest, icones e tema cripto ja estao prontos para evoluir no celular.</p>
        </article>
      </section>
    </main>
  );
}

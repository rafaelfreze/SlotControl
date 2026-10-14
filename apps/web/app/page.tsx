import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { CoinOpsBrand } from "@/components/app/coinops-brand";
import { AUTHENTICATED_HOME } from "@/lib/auth/navigation";

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
    redirect(AUTHENTICATED_HOME);
  }

  return (
    <main className="page-shell landing-shell">
      <nav className="top-nav" aria-label="Principal">
        <Link className="brand-link" href="/">
          <CoinOpsBrand subtitle="Operacoes inteligentes em cripto" />
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
          <p className="eyebrow">Operacoes privadas com dados em tempo real</p>
          <h1>Operacoes inteligentes em criptomoedas.</h1>
          <p className="hero-text">
            Controle suas operacoes com dashboard protegido e dados
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

        <div className="market-preview" aria-label="Como começar"><h2>Seu acesso em três etapas</h2>
          <ol><li>Crie seu cadastro e confirme o e-mail.</li><li>Siga o tutorial e combine o vínculo da conta com o administrador.</li><li>Acompanhe somente os dados da sua conta depois da configuração.</li></ol>
          <p>Cadastro e acompanhamento não representam promessa de rendimento. A configuração operacional é uma etapa separada.</p>
        </div>
      </section>

      <section className="feature-grid" aria-label="Recursos">
        <article>
          <span>01</span>
          <h2>Login e cadastro</h2>
          <p>Seu e-mail e senha dão acesso ao tutorial e ao acompanhamento autorizado.</p>
        </article>
        <article>
          <span>02</span>
          <h2>Dashboard protegido</h2>
          <p>Cada cliente acompanha somente sua conta após o vínculo seguro.</p>
        </article>
        <article>
          <span>03</span>
          <h2>No celular e computador</h2>
          <p>Acesse pelo navegador e use os recursos disponíveis no seu dispositivo.</p>
        </article>
      </section>
    </main>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { AppHeader, MobileScreen, SectionCard } from "@/components/app/mobile-ui";

export const metadata: Metadata = { title: "Mais" };

const destinations = [
  { href: "/plano-crescimento/relatorios", title: "Relatórios", description: "Acompanhe os resultados e a evolução dos ciclos." },
  { href: "/ciclos", title: "Ciclos", description: "Veja cada ciclo, suas etapas e o histórico preservado." },
  { href: "/alertas", title: "Alertas", description: "Consulte avisos que merecem atenção." },
  { href: "/automacao", title: "Automação", description: "Acompanhe a simulação Shadow e a conexão somente leitura." },
  { href: "/config", title: "Configurações", description: "Ajuste as preferências disponíveis para sua conta." }
];

export default function MorePage() {
  return (
    <MobileScreen>
      <AppHeader title="Mais" />
      <SectionCard title="Ferramentas e acompanhamento" subtitle="Escolha uma área para continuar">
        <nav className="coinops-more-links" aria-label="Outras áreas do CoinOps">
          {destinations.map((item) => (
            <Link key={item.href} href={item.href}>
              <span><strong>{item.title}</strong><small>{item.description}</small></span>
              <b aria-hidden="true">›</b>
            </Link>
          ))}
        </nav>
      </SectionCard>
    </MobileScreen>
  );
}

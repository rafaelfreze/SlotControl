import Link from "next/link";
import { redirect } from "next/navigation";

import { AppHeader, EmptyState, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { loadCoinOpsWorkspaceData } from "@/lib/coinops-workspace/server";
import { createClient } from "@/lib/supabase/server";

import { DesktopCycles } from "./desktop-cycles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ciclos oficiais" };

export default async function CyclesPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const workspace = await loadCoinOpsWorkspaceData(supabase);
  const timeZone = workspace.overview.baseline?.timezone || "America/Campo_Grande";
  const reportsByCycle = new Map(workspace.reports.map((report) => [report.cycleId, report]));

  const mobileCycles = (
    <>
      <AppHeader title="Ciclos" backHref="/plano-crescimento" />
      <section className="official-report-header">
        <div><small>Pós-baseline</small><h1>Ciclos oficiais</h1></div>
        <p>Períodos reais da estratégia, sem misturar o histórico legado.</p>
      </section>
      {workspace.sourceErrors.length && !workspace.cycles.length ? (
        <EmptyState><strong>Ciclos indisponíveis</strong><span>Não foi possível carregar os registros agora.</span></EmptyState>
      ) : (
        <SectionCard title="Linha do tempo" subtitle={`${workspace.cycles.length} ciclos registrados`}>
          <div className="official-event-list">
            {workspace.cycles.map((cycle) => {
              const report = reportsByCycle.get(cycle.id);
              return (
                <p key={cycle.id}>
                  <b>Ciclo {cycle.number} · {cycle.mode === "DEFENSIVE_POST_ATH" ? "Defensivo" : "Normal"}</b>
                  <span>{formatMobilePeriod(cycle.startAt, cycle.endAt, timeZone)} · {cycle.status}</span>
                  {report ? <Link href={`/plano-crescimento/relatorios/${report.id}`}>Ver relatório</Link> : null}
                </p>
              );
            })}
            {!workspace.cycles.length ? <p>Nenhum ciclo iniciado desde o baseline.</p> : null}
          </div>
        </SectionCard>
      )}
    </>
  );

  return (
    <MobileScreen desktop={<DesktopCycles userLabel={user.email || "Conta CoinOps"} workspace={workspace} />}>
      {mobileCycles}
    </MobileScreen>
  );
}

function formatMobilePeriod(start: string, end: string | null, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
  return `${formatter.format(new Date(start))} → ${end ? formatter.format(new Date(end)) : "em andamento"}`;
}

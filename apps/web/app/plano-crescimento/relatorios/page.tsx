import Link from "next/link";
import { redirect } from "next/navigation";

import { AppHeader, EmptyState, MobileScreen } from "@/components/app/mobile-ui";
import { createClient } from "@/lib/supabase/server";

import { DesktopReports, type DesktopReportListItem } from "./desktop-reports";

export const dynamic = "force-dynamic";
export const metadata = { title: "Relatórios oficiais" };

export default async function ReportsPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: reports, error }, { data: baseline }] = await Promise.all([
    supabase
      .from("cycle_reports")
      .select("id,status,report_version,generated_at,finalized_at,operational_cycles(cycle_number,mode,start_at,end_at,status)")
      .order("created_at", { ascending: false }),
    supabase
      .from("monitoring_baselines")
      .select("official_date,started_at")
      .eq("status", "ACTIVE")
      .maybeSingle()
  ]);

  const officialDate = baseline?.official_date
    ? baseline.official_date.slice(0, 10).split("-").reverse().join("/")
    : null;

  const desktopReports: DesktopReportListItem[] = (reports ?? []).map((report) => {
    const cycle = report.operational_cycles as unknown as {
      cycle_number: number;
      mode: string;
      start_at: string;
      end_at: string | null;
      status: string;
    } | null;

    return {
      id: report.id,
      status: report.status,
      report_version: report.report_version,
      generated_at: report.generated_at,
      finalized_at: report.finalized_at,
      cycle
    };
  });

  const mobileReports = (
    <>
      <AppHeader title="Relatórios" backHref="/plano-crescimento" />
      <section className="official-report-header">
        <div><small>Pós-baseline</small><h1>Ciclos reais</h1></div>
        <p>{officialDate ? `Somente eventos desde ${officialDate}.` : "Os eventos oficiais começarão na ativação."} O legado não é misturado.</p>
      </section>
      {error ? (
        <EmptyState><strong>Relatórios indisponíveis</strong><span>{error.message}</span></EmptyState>
      ) : desktopReports.length ? (
        <div className="official-report-list">
          {desktopReports.map((report) => {
            const cycle = report.cycle;
            return (
              <Link href={`/plano-crescimento/relatorios/${report.id}`} key={report.id}>
                <div>
                  <strong>Ciclo {cycle?.cycle_number}</strong>
                  <small>{new Date(cycle?.start_at || "").toLocaleDateString("pt-BR")} → {cycle?.end_at ? new Date(cycle.end_at).toLocaleDateString("pt-BR") : "em andamento"}</small>
                </div>
                <span>{cycle?.mode === "DEFENSIVE_POST_ATH" ? "Defensivo" : "Normal"}</span>
                <b>{report.status}</b>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyState><strong>Nenhum relatório</strong><span>Ative o baseline oficial para iniciar o Ciclo 1.</span></EmptyState>
      )}
    </>
  );

  return (
    <MobileScreen
      desktop={(
        <DesktopReports
          userLabel={user.email || "Conta CoinOps"}
          reports={desktopReports}
          error={error?.message || null}
        />
      )}
    >
      {mobileReports}
    </MobileScreen>
  );
}

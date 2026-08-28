import { redirect } from "next/navigation";

import { AppHeader, EmptyState, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { loadCoinOpsWorkspaceData } from "@/lib/coinops-workspace/server";
import { createClient } from "@/lib/supabase/server";

import { DesktopAlerts } from "./desktop-alerts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alertas" };

export default async function AlertsPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const workspace = await loadCoinOpsWorkspaceData(supabase);
  const timeZone = workspace.overview.baseline?.timezone || "America/Campo_Grande";

  const mobileAlerts = (
    <>
      <AppHeader title="Alertas" backHref="/dashboard" />
      <section className="official-report-header">
        <div><small>Monitoramento</small><h1>Alertas oficiais</h1></div>
        <p>Eventos confirmados desde o baseline da estratégia.</p>
      </section>
      {workspace.sourceErrors.length && !workspace.alerts.length ? (
        <EmptyState><strong>Alertas indisponíveis</strong><span>Não foi possível carregar os eventos agora.</span></EmptyState>
      ) : (
        <SectionCard title="Eventos recentes" subtitle={`${workspace.alerts.filter((alert) => !alert.readAt).length} novos`}>
          <div className="official-event-list">
            {workspace.alerts.map((alert) => (
              <p key={alert.id}>
                <b>{formatMobileAlertType(alert.type)}</b>
                <span>{alert.message} · {formatMobileDate(alert.occurredAt, timeZone)}</span>
              </p>
            ))}
            {!workspace.alerts.length ? <p>Nenhum alerta registrado desde o baseline.</p> : null}
          </div>
        </SectionCard>
      )}
    </>
  );

  return (
    <MobileScreen desktop={<DesktopAlerts userLabel={user.email || "Conta CoinOps"} workspace={workspace} />}>
      {mobileAlerts}
    </MobileScreen>
  );
}

function formatMobileAlertType(type: string) {
  return type.replaceAll("_", " ");
}

function formatMobileDate(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

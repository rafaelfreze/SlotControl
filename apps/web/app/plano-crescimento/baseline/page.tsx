import { redirect } from "next/navigation";

import { AppHeader, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { loadOfficialMonitoring } from "@/lib/coinops-monitoring/server";
import { formatUsdt } from "@/lib/slotgain/format";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Baseline oficial" };

const formatOfficialDate = (value: string) => {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
};

const formatActivationTimestamp = (value: string, timezone: string) => {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: timezone
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString("pt-BR");
  }
};

export default async function BaselinePage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { overview } = await loadOfficialMonitoring();
  if (!overview.active || !overview.baseline) return redirect("/plano-crescimento");

  const [{ data: assets }, { data: slots }] = await Promise.all([
    supabase
      .from("monitoring_baseline_assets")
      .select("asset,operational_total,realized_profit,open_pnl,slots_existing,slots_enabled,slots_open,slots_free")
      .eq("baseline_id", overview.baseline.id),
    supabase
      .from("monitoring_baseline_slots")
      .select("asset,slot_number,snapshot")
      .eq("baseline_id", overview.baseline.id)
      .order("asset")
      .order("slot_number")
  ]);

  return (
    <MobileScreen>
      <AppHeader title="Baseline oficial" backHref="/plano-crescimento" />
      <SectionCard title="Estratégia oficial" subtitle="Corte imutável">
        <div className="official-report-summary">
          <span>Data<strong>{formatOfficialDate(overview.baseline.official_date)}</strong></span>
          <span>Ativado em<strong>{formatActivationTimestamp(overview.baseline.started_at, overview.baseline.timezone)}</strong></span>
          <span>Timezone<strong>{overview.baseline.timezone}</strong></span>
          <span>Versão<strong>v{overview.strategy?.version}</strong></span>
        </div>
        <p className="official-report-note">
          Tudo anterior ao timestamp de ativação permanece preservado como legado e não entra nos deltas dos ciclos.
        </p>
      </SectionCard>
      <section className="official-report-assets">
        {(assets || []).map((asset) => (
          <article key={asset.asset}>
            <h2>{asset.asset}</h2>
            <strong>{formatUsdt(Number(asset.operational_total))}</strong>
            <small>{asset.slots_enabled}/{asset.slots_existing} habilitados · {asset.slots_open} abertos</small>
          </article>
        ))}
      </section>
      <details className="official-slot-snapshot">
        <summary>Snapshot dos slots ({slots?.length || 0})</summary>
        <div>
          {(slots || []).map((slot) => {
            const snapshot = slot.snapshot as Record<string, unknown>;
            return (
              <p key={`${slot.asset}-${slot.slot_number}`}>
                <b>{slot.asset} #{slot.slot_number}</b>
                <span>{String(snapshot?.status || "—")}</span>
                <span>{formatUsdt(Number(snapshot?.operational_value || 0))}</span>
              </p>
            );
          })}
        </div>
      </details>
    </MobileScreen>
  );
}

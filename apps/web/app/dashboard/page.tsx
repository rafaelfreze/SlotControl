import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LogoutButton } from "@/components/auth/logout-button";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Dashboard"
};

type SlotRow = {
  id: string;
  status: "zerado" | "aberto" | "gain" | "hold";
  gains: number;
  base_value: string | number;
  gain_rate: string | number;
  slot_number: number;
};

function formatUsdt(value: number) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)} USDT`;
}

function getCurrentValue(slot: SlotRow) {
  const baseValue = Number(slot.base_value || 0);
  const gainRate = Number(slot.gain_rate || 0);
  return baseValue * Math.pow(1 + gainRate, Number(slot.gains || 0));
}

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    redirect("/login?setup=missing-env");
  }

  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [strategiesResponse, slotsResponse, historyResponse] = await Promise.all([
    supabase.from("strategies").select("id,key,title,asset,sort_order").order("sort_order"),
    supabase
      .from("slots")
      .select("id,status,gains,base_value,gain_rate,slot_number")
      .order("sort_order", { ascending: true }),
    supabase
      .from("history_events")
      .select("id,action,detail,event_at")
      .order("event_at", { ascending: false })
      .limit(5)
  ]);

  const slots = (slotsResponse.data ?? []) as SlotRow[];
  const totalBase = slots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const totalUpdated = slots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const openSlots = slots.filter((slot) => slot.status === "aberto").length;
  const totalGains = slots.reduce((sum, slot) => sum + Number(slot.gains || 0), 0);
  const setupErrors = [strategiesResponse.error, slotsResponse.error, historyResponse.error].filter(Boolean);

  return (
    <main className="page-shell dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Dashboard protegido</p>
          <h1>SlotGain Control</h1>
          <p className="muted-text">{user.email}</p>
        </div>
        <LogoutButton />
      </header>

      {setupErrors.length > 0 ? (
        <section className="inline-alert dashboard-alert">
          Execute `supabase/schema.sql` no seu projeto Supabase para criar tabelas, RLS e dados iniciais.
        </section>
      ) : null}

      <section className="metric-grid" aria-label="Resumo">
        <article className="metric-card">
          <span>Total atualizado</span>
          <strong>{formatUsdt(totalUpdated)}</strong>
        </article>
        <article className="metric-card positive">
          <span>Lucro estimado</span>
          <strong>{formatUsdt(totalUpdated - totalBase)}</strong>
        </article>
        <article className="metric-card">
          <span>Slots abertos</span>
          <strong>{openSlots}</strong>
        </article>
        <article className="metric-card">
          <span>Gains</span>
          <strong>{totalGains}</strong>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Estrategias</p>
              <h2>Ativas no Supabase</h2>
            </div>
            <span>{strategiesResponse.data?.length ?? 0}</span>
          </div>
          <div className="strategy-list">
            {(strategiesResponse.data ?? []).map((strategy) => (
              <div key={strategy.id} className="strategy-item">
                <strong>{strategy.title}</strong>
                <span>{strategy.asset}</span>
              </div>
            ))}
            {strategiesResponse.data?.length === 0 ? (
              <p className="empty-copy">Nenhuma estrategia encontrada para este usuario.</p>
            ) : null}
          </div>
        </article>

        <article className="panel-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Historico</p>
              <h2>Ultimas acoes</h2>
            </div>
          </div>
          <div className="history-list">
            {(historyResponse.data ?? []).map((item) => (
              <div key={item.id} className="history-item">
                <strong>{item.action}</strong>
                <span>{item.detail || "Registro criado no Supabase."}</span>
              </div>
            ))}
            {historyResponse.data?.length === 0 ? (
              <p className="empty-copy">Sem historico ainda.</p>
            ) : null}
          </div>
        </article>
      </section>
    </main>
  );
}

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
  sort_order: number;
  notes: string;
  updated_at: string | null;
  strategies?:
    | {
        title: string;
        asset: string;
        key: string;
      }
    | {
        title: string;
        asset: string;
        key: string;
      }[]
    | null;
};

type SlotView = Omit<SlotRow, "strategies"> & {
  strategies?: {
    title: string;
    asset: string;
    key: string;
  } | null;
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

function normalizeSlot(slot: SlotRow): SlotView {
  return {
    ...slot,
    strategies: Array.isArray(slot.strategies) ? slot.strategies[0] : slot.strategies
  };
}

function getStatusLabel(status: SlotRow["status"]) {
  const labels = {
    zerado: "Zerado",
    aberto: "Aberto",
    gain: "Gain",
    hold: "Hold"
  };

  return labels[status] || status;
}

function formatDate(value: string | null) {
  if (!value) {
    return "Nunca";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Data invalida";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
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
      .select("id,status,gains,base_value,gain_rate,slot_number,sort_order,notes,updated_at,strategies(title,asset,key)")
      .order("sort_order", { ascending: true }),
    supabase
      .from("history_events")
      .select("id,action,detail,event_at")
      .order("event_at", { ascending: false })
      .limit(5)
  ]);

  const slots = ((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot);
  const totalBase = slots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const totalUpdated = slots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const openSlots = slots.filter((slot) => slot.status === "aberto").length;
  const closedSlots = slots.filter((slot) => slot.status !== "aberto" && slot.status !== "hold").length;
  const totalGains = slots.reduce((sum, slot) => sum + Number(slot.gains || 0), 0);
  const setupErrors = [strategiesResponse.error, slotsResponse.error, historyResponse.error].filter(Boolean);
  const strategies = strategiesResponse.data ?? [];
  const recentSlots = slots.slice(0, 18);

  return (
    <main className="page-shell dashboard-shell">
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <span className="brand-mark" aria-hidden="true">
            SG
          </span>
          <div>
            <p className="eyebrow">Controle cripto por slots</p>
            <h1>SlotGain Control</h1>
            <p className="muted-text">{user.email}</p>
          </div>
        </div>
        <LogoutButton />
      </header>

      <nav className="dashboard-tabs" aria-label="Areas do painel">
        <a href="#dashboard">Dashboard</a>
        <a href="#slots">Slots</a>
        <a href="#historico">Historico</a>
        <a href="#configuracoes">Configuracoes</a>
      </nav>

      {setupErrors.length > 0 ? (
        <section className="inline-alert dashboard-alert">
          Execute `supabase/schema.sql` no seu projeto Supabase para criar tabelas, RLS e dados iniciais.
        </section>
      ) : null}

      <section id="dashboard" className="metric-grid" aria-label="Resumo">
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
          <span>Gains totais</span>
          <strong>{totalGains}</strong>
        </article>
      </section>

      <section className="crypto-summary-grid" aria-label="Resumo por cripto">
        {strategies.map((strategy) => {
          const strategySlots = slots.filter((slot) => slot.strategies?.key === strategy.key);
          const strategyBase = strategySlots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
          const strategyUpdated = strategySlots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
          return (
            <article key={strategy.id} className="crypto-card">
              <div className="crypto-card-header">
                <h2>{strategy.asset}</h2>
                <span>{strategySlots.length} slots</span>
              </div>
              <p>
                Lucro <strong>{formatUsdt(strategyUpdated - strategyBase)}</strong>
              </p>
              <div className="crypto-stats">
                <span>
                  Gains <strong>{strategySlots.reduce((sum, slot) => sum + Number(slot.gains || 0), 0)}</strong>
                </span>
                <span>
                  Abertos <strong>{strategySlots.filter((slot) => slot.status === "aberto").length}</strong>
                </span>
              </div>
            </article>
          );
        })}
      </section>

      <section className="dashboard-grid">
        <article id="slots" className="panel-card slots-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Slots</p>
              <h2>Lista compacta</h2>
            </div>
            <span>{slots.length}</span>
          </div>

          <div className="slot-filter-row" aria-label="Resumo dos filtros">
            <span>Todos <strong>{slots.length}</strong></span>
            <span>Abertos <strong>{openSlots}</strong></span>
            <span>Fechados <strong>{closedSlots}</strong></span>
          </div>

          <div className="slot-list">
            {recentSlots.map((slot) => (
              <div key={slot.id} className={`slot-item status-${slot.status}`}>
                <div className="slot-order">#{slot.slot_number}</div>
                <div className="slot-main">
                  <strong>{slot.strategies?.title || "Estrategia"}</strong>
                  <span>{formatDate(slot.updated_at)}</span>
                </div>
                <div className="slot-gains">
                  <strong>{slot.gains}</strong>
                  <span>{slot.gains === 1 ? "gain" : "gains"}</span>
                </div>
                <div className="slot-value">
                  <strong>{formatUsdt(getCurrentValue(slot))}</strong>
                  <span className={`status-pill status-${slot.status}`}>{getStatusLabel(slot.status)}</span>
                </div>
              </div>
            ))}
            {slots.length === 0 ? (
              <p className="empty-copy">Nenhum slot encontrado para este usuario.</p>
            ) : null}
          </div>
        </article>

        <aside className="side-stack">
          <article className="panel-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Adicionar slots</p>
                <h2>Nova posicao</h2>
              </div>
            </div>
            <form className="tool-form">
              <label>
                Moeda
                <select disabled>
                  {strategies.map((strategy) => (
                    <option key={strategy.id}>{strategy.title}</option>
                  ))}
                </select>
              </label>
              <label>
                Slots
                <input type="number" min="1" max="50" placeholder="1" disabled />
              </label>
              <button className="solid-button" type="button" disabled>
                Em breve
              </button>
            </form>
          </article>

          <article className="panel-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Saldo e redistribuicao</p>
                <h2>Manutencao</h2>
              </div>
            </div>
            <form className="tool-form">
              <label>
                USDT por slot
                <input type="number" min="0.01" step="0.01" placeholder="Ex.: 5" disabled />
              </label>
              <button className="solid-button" type="button" disabled>
                Adicionar saldo
              </button>
              <button className="ghost-button" type="button" disabled>
                Redistribuir
              </button>
            </form>
          </article>
        </aside>
      </section>

      <section className="dashboard-grid lower-grid">
        <article id="historico" className="panel-card">
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

        <article id="configuracoes" className="panel-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Configuracoes</p>
              <h2>Publicacao e conta</h2>
            </div>
          </div>
          <div className="settings-list">
            <div>
              <span>Usuario</span>
              <strong>{user.email}</strong>
            </div>
            <div>
              <span>Supabase</span>
              <strong>Auth ativo</strong>
            </div>
            <div>
              <span>Deploy</span>
              <strong>Preparado para Vercel</strong>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}

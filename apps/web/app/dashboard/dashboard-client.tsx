"use client";

import { useMemo, useState } from "react";

import { LogoutButton } from "@/components/auth/logout-button";
import {
  addBalance,
  createSlots,
  createStrategy,
  deleteStrategy,
  openSlot,
  redistributeGains,
  registerGain,
  resetSlot,
  updateSlot,
  updateStrategy
} from "./actions";

export type StrategyView = {
  id: string;
  key: string;
  title: string;
  display_name: string;
  asset: string;
  base_value: number | string;
  gain_rate: number | string;
  drop_percent: number | string;
  restart_amount: number;
  redistribution_target: number;
  sort_order: number;
};

export type SlotStatus = "zerado" | "aberto" | "gain" | "hold";

export type SlotView = {
  id: string;
  strategy_id: string;
  status: SlotStatus;
  gains: number;
  base_value: number | string;
  gain_rate: number | string;
  slot_number: number;
  sort_order: number;
  notes: string;
  updated_at: string | null;
  strategy?: StrategyView | null;
};

export type HistoryEvent = {
  id: string;
  action: string;
  detail: string;
  event_at: string;
  strategy_key: string | null;
  slot_number: number | null;
};

type SlotFilter = "all" | "aberto" | "closed" | "gain";

type DashboardClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  history: HistoryEvent[];
  setupError: string | null;
  initialNotice: string | null;
};

function formatUsdt(value: number) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)} USDT`;
}

function formatPercent(value: number | string) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  }).format(Number(value || 0) * 100);
}

function formatDecimal(value: number | string) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function getCurrentValue(slot: Pick<SlotView, "base_value" | "gain_rate" | "gains">) {
  return Number(slot.base_value || 0) * Math.pow(1 + Number(slot.gain_rate || 0), Number(slot.gains || 0));
}

function getStatusLabel(status: SlotStatus) {
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

export function DashboardClient({ userEmail, strategies, slots, history, setupError, initialNotice }: DashboardClientProps) {
  const [slotFilter, setSlotFilter] = useState<SlotFilter>("all");
  const [strategyFilter, setStrategyFilter] = useState("all");
  const [notice, setNotice] = useState<string | null>(initialNotice);

  const visibleSlots = useMemo(
    () =>
      slots.filter((slot) => {
        if (slotFilter === "closed") {
          return slot.status === "gain" || slot.status === "zerado";
        }

        if (slotFilter !== "all" && slot.status !== slotFilter) {
          return false;
        }

        if (strategyFilter !== "all" && slot.strategy_id !== strategyFilter) {
          return false;
        }

        return true;
      }),
    [slotFilter, slots, strategyFilter]
  );

  const totalBase = slots.reduce((sum, slot) => sum + Number(slot.base_value || 0), 0);
  const totalUpdated = slots.reduce((sum, slot) => sum + getCurrentValue(slot), 0);
  const openSlots = slots.filter((slot) => slot.status === "aberto").length;
  const gainSlots = slots.filter((slot) => slot.status === "gain").length;
  const zeroSlots = slots.filter((slot) => slot.status === "zerado").length;
  const closedSlots = gainSlots + zeroSlots;
  const totalGains = slots.reduce((sum, slot) => sum + Number(slot.gains || 0), 0);

  function exportBackup() {
    const backup = {
      app: "SlotGain Control",
      exportedAt: new Date().toISOString(),
      user: userEmail,
      strategies,
      slots,
      history
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `slotgain-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setNotice("Backup exportado com os dados carregados do Supabase.");
  }

  function announce(message: string) {
    setNotice(message);
  }

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
            <p className="muted-text">{userEmail}</p>
          </div>
        </div>
        <LogoutButton />
      </header>

      <nav className="dashboard-tabs" aria-label="Areas do painel">
        <a href="#dashboard"><span>Dashboard</span></a>
        <a href="#slots"><span>Slots</span></a>
        <a href="#historico"><span>Historico</span></a>
        <a href="#configuracoes"><span>Config</span></a>
      </nav>

      {setupError ? (
        <section className="inline-alert dashboard-alert">
          Falha ao carregar dados do Supabase: {setupError}
        </section>
      ) : null}

      {notice ? (
        <section className="form-success dashboard-notice" role="status">
          {notice}
        </section>
      ) : null}

      <section id="dashboard" className="metric-grid" aria-label="Resumo">
        <article className="metric-card">
          <span>Total atualizado</span>
          <strong>{formatUsdt(totalUpdated)}</strong>
        </article>
        <article className="metric-card positive">
          <span>Lucro acumulado</span>
          <strong>{formatUsdt(totalUpdated - totalBase)}</strong>
        </article>
        <article className="metric-card">
          <span>Slots abertos</span>
          <strong>{openSlots}</strong>
        </article>
        <article className="metric-card">
          <span>Total de gains</span>
          <strong>{totalGains}</strong>
        </article>
      </section>

      <section className="crypto-summary-grid" aria-label="Resumo por cripto">
        {strategies.map((strategy) => {
          const strategySlots = slots.filter((slot) => slot.strategy_id === strategy.id);
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
          <div className="panel-heading compact-heading">
            <div>
              <p className="eyebrow">Slots</p>
              <h2>Lista compacta</h2>
            </div>
            <select
              className="compact-select"
              value={strategyFilter}
              onChange={(event) => setStrategyFilter(event.target.value)}
              aria-label="Filtrar por estrategia"
            >
              <option value="all">Todas</option>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.title}
                </option>
              ))}
            </select>
          </div>

          <div className="slot-filter-row" aria-label="Filtros rapidos">
            <button type="button" className={slotFilter === "all" ? "active" : ""} onClick={() => setSlotFilter("all")}>
              Todos <strong>{slots.length}</strong>
            </button>
            <button
              type="button"
              className={slotFilter === "aberto" ? "active" : ""}
              onClick={() => setSlotFilter("aberto")}
            >
              Abertos <strong>{openSlots}</strong>
            </button>
            <button
              type="button"
              className={slotFilter === "closed" ? "active" : ""}
              onClick={() => setSlotFilter("closed")}
            >
              Fechados <strong>{closedSlots}</strong>
            </button>
            <button type="button" className={slotFilter === "gain" ? "active" : ""} onClick={() => setSlotFilter("gain")}>
              Gain <strong>{gainSlots}</strong>
            </button>
          </div>

          <div className="slot-list">
            {visibleSlots.map((slot) => (
              <details key={slot.id} className={`slot-item status-${slot.status}`}>
                <summary>
                  <div className="slot-order">#{slot.slot_number}</div>
                  <div className="slot-main">
                    <strong>{slot.strategy?.title || "Estrategia"}</strong>
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
                </summary>

                <div className="slot-actions-panel">
                  <div className="quick-actions">
                    <form action={openSlot}>
                      <input type="hidden" name="slotId" value={slot.id} />
                      <button
                        className="slot-button open"
                        type="submit"
                        disabled={slot.status === "aberto"}
                        onClick={() => announce("Abrindo slot no Supabase...")}
                      >
                        Abrir
                      </button>
                    </form>
                    <form action={registerGain}>
                      <input type="hidden" name="slotId" value={slot.id} />
                      <button
                        className="slot-button gain"
                        type="submit"
                        disabled={slot.status === "zerado"}
                        onClick={() => announce("Registrando gain no Supabase...")}
                      >
                        +Gain
                      </button>
                    </form>
                    <form action={resetSlot}>
                      <input type="hidden" name="slotId" value={slot.id} />
                      <button className="slot-button reset" type="submit" onClick={() => announce("Zerando slot no Supabase...")}>
                        Zerar
                      </button>
                    </form>
                  </div>

                  <form className="slot-edit-form" action={updateSlot}>
                    <input type="hidden" name="slotId" value={slot.id} />
                    <label>
                      Status
                      <select name="status" defaultValue={slot.status === "hold" ? "gain" : slot.status}>
                        <option value="zerado">Zerado</option>
                        <option value="aberto">Aberto</option>
                        <option value="gain">Gain</option>
                      </select>
                    </label>
                    <label>
                      Gains
                      <input name="gains" type="number" min="0" step="1" defaultValue={slot.gains} />
                    </label>
                    <label>
                      Base USDT
                      <input name="baseValue" type="number" min="0" step="0.01" defaultValue={Number(slot.base_value)} />
                    </label>
                    <label className="wide-field">
                      Observacoes
                      <input name="notes" type="text" defaultValue={slot.notes || ""} />
                    </label>
                    <button className="slot-button edit" type="submit" onClick={() => announce("Salvando edicao no Supabase...")}>
                      Editar
                    </button>
                  </form>
                </div>
              </details>
            ))}
            {visibleSlots.length === 0 ? <p className="empty-copy padded-empty">Nenhum slot neste filtro.</p> : null}
          </div>
        </article>

        <aside className="side-stack">
          <ToolsPanel strategies={strategies} announce={announce} />
        </aside>
      </section>

      <section className="dashboard-grid lower-grid">
        <article id="historico" className="panel-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Historico</p>
              <h2>Ultimas acoes</h2>
            </div>
            <span>{history.length}</span>
          </div>
          <div className="history-list">
            {history.map((item) => (
              <div key={item.id} className="history-item">
                <strong>{item.action}</strong>
                <span>{item.detail || "Registro criado no Supabase."}</span>
                <small>{formatDate(item.event_at)}</small>
              </div>
            ))}
            {history.length === 0 ? <p className="empty-copy">Sem historico ainda.</p> : null}
          </div>
        </article>

        <article id="configuracoes" className="panel-card settings-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Configuracoes</p>
              <h2>Estrategias e backup</h2>
            </div>
          </div>
          <div className="settings-list">
            <div>
              <span>Usuario</span>
              <strong>{userEmail}</strong>
            </div>
            <div>
              <span>Estrategias</span>
              <strong>{strategies.length}</strong>
            </div>
            <div>
              <span>Slots</span>
              <strong>{slots.length}</strong>
            </div>
            <div>
              <span>Backup</span>
              <button className="ghost-button compact-action" type="button" onClick={exportBackup}>
                Exportar JSON
              </button>
            </div>
            <div>
              <span>Preferencia</span>
              <strong>Tema escuro mobile</strong>
            </div>
          </div>
          <StrategiesPanel strategies={strategies} announce={announce} />
        </article>
      </section>
    </main>
  );
}

function StrategiesPanel({ strategies, announce }: { strategies: StrategyView[]; announce: (message: string) => void }) {
  return (
    <section className="settings-strategies">
      <div className="panel-heading nested-heading">
        <div>
          <p className="eyebrow">Estrategias</p>
          <h2>BTC, SOL e novas moedas</h2>
        </div>
        <span>{strategies.length}</span>
      </div>

      <form className="tool-form strategy-create-form" action={createStrategy}>
        <label>
          Nome
          <input name="title" placeholder="ETH 2%" required />
        </label>
        <label>
          Chave
          <input name="key" placeholder="eth" />
        </label>
        <label>
          Ativo
          <input name="asset" placeholder="ETH" required />
        </label>
        <label>
          Base USDT
          <input name="baseValue" type="number" min="0" step="0.01" placeholder="10" required />
        </label>
        <label>
          Gain %
          <input name="gainRate" type="number" min="0" step="0.01" placeholder="1" required />
        </label>
        <label>
          Queda %
          <input name="dropPercent" type="number" min="0" step="0.01" placeholder="2" />
        </label>
        <label>
          Reinicio
          <input name="restartAmount" type="number" min="0" step="1" placeholder="5" />
        </label>
        <label>
          Meta
          <input name="redistributionTarget" type="number" min="0" step="1" placeholder="50" />
        </label>
        <button className="solid-button" type="submit" onClick={() => announce("Criando estrategia no Supabase...")}>
          Criar
        </button>
      </form>

      <div className="strategy-list editable-strategy-list">
        {strategies.map((strategy) => (
          <details key={strategy.id} className="strategy-editor">
            <summary>
              <strong>{strategy.title}</strong>
              <span>
                {strategy.asset} | {formatPercent(strategy.gain_rate)}%
              </span>
            </summary>
            <form className="tool-form" action={updateStrategy}>
              <input type="hidden" name="strategyId" value={strategy.id} />
              <label>
                Nome
                <input name="title" defaultValue={strategy.title} required />
              </label>
              <label>
                Ativo
                <input name="asset" defaultValue={strategy.asset} required />
              </label>
              <label>
                Base USDT
                <input name="baseValue" type="number" min="0" step="0.01" defaultValue={Number(strategy.base_value)} />
              </label>
              <label>
                Gain %
                <input name="gainRate" type="number" min="0" step="0.01" defaultValue={formatPercent(strategy.gain_rate)} />
              </label>
              <label>
                Queda %
                <input name="dropPercent" type="number" min="0" step="0.01" defaultValue={formatDecimal(strategy.drop_percent)} />
              </label>
              <label>
                Reinicio
                <input name="restartAmount" type="number" min="0" step="1" defaultValue={strategy.restart_amount} />
              </label>
              <label>
                Meta
                <input
                  name="redistributionTarget"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={strategy.redistribution_target}
                />
              </label>
              <button className="slot-button edit" type="submit" onClick={() => announce("Atualizando estrategia no Supabase...")}>
                Salvar
              </button>
            </form>
            <form action={deleteStrategy}>
              <input type="hidden" name="strategyId" value={strategy.id} />
              <input type="hidden" name="title" value={strategy.title} />
              <button
                className="danger-button full-width-button"
                type="submit"
                onClick={() => announce("Removendo estrategia no Supabase...")}
              >
                Remover estrategia
              </button>
            </form>
          </details>
        ))}
      </div>
    </section>
  );
}

function ToolsPanel({ strategies, announce }: { strategies: StrategyView[]; announce: (message: string) => void }) {
  return (
    <>
      <article className="panel-card">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Adicionar slots</p>
            <h2>Nova posicao</h2>
          </div>
        </div>
        <form className="tool-form" action={createSlots}>
          <label>
            Moeda
            <select name="strategyId" required>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Slots
            <input name="quantity" type="number" min="1" max="50" defaultValue="1" required />
          </label>
          <button
            className="solid-button"
            type="submit"
            disabled={strategies.length === 0}
            onClick={() => announce("Criando slots no Supabase...")}
          >
            Adicionar slots
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
        <form className="tool-form" action={addBalance}>
          <label>
            Moeda
            <select name="strategyId" required>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            USDT por slot
            <input name="amount" type="number" min="0.01" step="0.01" placeholder="Ex.: 5" required />
          </label>
          <button
            className="solid-button"
            type="submit"
            disabled={strategies.length === 0}
            onClick={() => announce("Adicionando saldo nos slots fechados...")}
          >
            Adicionar saldo
          </button>
        </form>
        <p className="tool-hint">Aplica apenas em slots fechados: Gain e Zerado.</p>
        <form className="tool-form single-action-form" action={redistributeGains}>
          <label>
            Redistribuir
            <select name="strategyId" required>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.title}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-button"
            type="submit"
            disabled={strategies.length === 0}
            onClick={() => announce("Redistribuindo gains nos slots fechados...")}
          >
            Redistribuir gains
          </button>
        </form>
        <p className="tool-hint">Redistribui somente gains de slots fechados. Slots abertos ficam intactos.</p>
      </article>
    </>
  );
}

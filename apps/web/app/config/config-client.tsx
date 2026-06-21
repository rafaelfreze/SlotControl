"use client";

import { useState } from "react";

import { AppShell } from "@/components/app/app-shell";
import { createStrategy, deleteStrategy, updateStrategy } from "@/app/dashboard/actions";
import { formatDecimal, formatPercent } from "@/lib/slotgain/format";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type ConfigClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
};

export function ConfigClient({ userEmail, strategies, slots, setupError, initialNotice }: ConfigClientProps) {
  const [notice, setNotice] = useState<string | null>(initialNotice);

  function exportBackup() {
    const backup = {
      app: "SlotGain Control",
      exportedAt: new Date().toISOString(),
      user: userEmail,
      strategies,
      slots
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
    setNotice("Backup exportado com dados carregados do Supabase.");
  }

  function announce(message: string) {
    setNotice(message);
  }

  return (
    <AppShell userEmail={userEmail}>
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar configuracoes: {setupError}</section> : null}
      {notice ? (
        <section className="form-success dashboard-notice" role="status">
          {notice}
        </section>
      ) : null}

      <article className="panel-card settings-panel config-summary-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Config</p>
            <h2>Resumo</h2>
          </div>
        </div>
        <div className="settings-list">
          <div>
            <span>Estrategias existentes</span>
            <strong>{strategies.map((strategy) => strategy.asset).join(" / ") || "Nenhuma"}</strong>
          </div>
          <div>
            <span>Slots totais</span>
            <strong>{slots.length}</strong>
          </div>
          <div>
            <span>Backup</span>
            <button className="ghost-button compact-action" type="button" onClick={exportBackup}>
              Exportar JSON
            </button>
          </div>
        </div>
      </article>

      <details className="panel-card mini-drawer">
        <summary>Estrategias Avancadas</summary>
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
          <button className="solid-button" type="submit" onClick={() => announce("Criando estrategia...")}>
            Criar estrategia
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
                  <input name="redistributionTarget" type="number" min="0" step="1" defaultValue={strategy.redistribution_target} />
                </label>
                <button className="slot-button edit" type="submit" onClick={() => announce("Atualizando estrategia...")}>
                  Salvar
                </button>
              </form>
              <form action={deleteStrategy}>
                <input type="hidden" name="strategyId" value={strategy.id} />
                <input type="hidden" name="title" value={strategy.title} />
                <button className="danger-button full-width-button" type="submit" onClick={() => announce("Removendo estrategia...")}>
                  Remover estrategia
                </button>
              </form>
            </details>
          ))}
        </div>
      </details>

      <details className="panel-card mini-drawer">
        <summary>Preferencias do usuario</summary>
        <div className="settings-list">
          <div>
            <span>Tema</span>
            <strong>Escuro cripto</strong>
          </div>
          <div>
            <span>Persistencia</span>
            <strong>Supabase</strong>
          </div>
          <div>
            <span>Modo principal</span>
            <strong>Mobile first</strong>
          </div>
        </div>
      </details>
    </AppShell>
  );
}

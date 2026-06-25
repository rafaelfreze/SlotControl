"use client";

import { useMemo, useState } from "react";

import { AppShell } from "@/components/app/app-shell";
import {
  addBalance,
  applyStrategyMarketPrices,
  createSlots,
  moveSlot,
  openSlot,
  redistributeGains,
  registerGain,
  resetSlot,
  updateSlot
} from "@/app/dashboard/actions";
import {
  formatDate,
  formatSignedPercent,
  formatSignedUsdt,
  formatUsdt,
  getCurrentValue,
  getOpenMarketMetrics,
  getStatusLabel
} from "@/lib/slotgain/format";
import type { SlotView, StrategyView } from "@/lib/slotgain/types";

type SlotFilter = "aberto" | "gain" | "closed" | "all";

type SlotsClientProps = {
  userEmail: string;
  strategies: StrategyView[];
  slots: SlotView[];
  setupError: string | null;
  initialNotice: string | null;
  initialAsset: string | null;
  initialFlow: string | null;
};

export function SlotsClient({ userEmail, strategies, slots, setupError, initialNotice, initialAsset, initialFlow }: SlotsClientProps) {
  const initialStrategyId =
    strategies.find((strategy) => strategy.asset.toUpperCase() === initialAsset?.toUpperCase())?.id || "all";
  const initialSlotFilter: SlotFilter = initialFlow === "abrir" ? "closed" : initialFlow === "gain" ? "aberto" : "aberto";
  const [slotFilter, setSlotFilter] = useState<SlotFilter>(initialSlotFilter);
  const [strategyFilter, setStrategyFilter] = useState(initialStrategyId);
  const [notice, setNotice] = useState<string | null>(initialNotice);

  const openSlots = slots.filter((slot) => slot.status === "aberto").length;
  const gainSlots = slots.filter((slot) => slot.status === "gain").length;
  const zeroSlots = slots.filter((slot) => slot.status === "zerado").length;
  const closedSlots = gainSlots + zeroSlots;

  const visibleSlots = useMemo(
    () =>
      slots.filter((slot) => {
        if (slotFilter === "closed" && slot.status !== "gain" && slot.status !== "zerado") {
          return false;
        }

        if (slotFilter !== "all" && slotFilter !== "closed" && slot.status !== slotFilter) {
          return false;
        }

        if (strategyFilter !== "all" && slot.strategy_id !== strategyFilter) {
          return false;
        }

        return true;
      }),
    [slotFilter, slots, strategyFilter]
  );

  function announce(message: string) {
    setNotice(message);
  }

  return (
    <AppShell userEmail={userEmail}>
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar dados: {setupError}</section> : null}
      {notice ? (
        <section className="form-success dashboard-notice" role="status">
          {notice}
        </section>
      ) : null}

      <section className="operation-strip" aria-label="Fluxo principal">
        <form action={redistributeGains}>
          <select name="strategyId" required aria-label="Moeda para redistribuir">
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.title}
              </option>
            ))}
          </select>
          <button className="solid-button" type="submit" disabled={strategies.length === 0} onClick={() => announce("Redistribuindo gains...")}>
            Redistribuir
          </button>
        </form>
        <details className="mini-drawer">
          <summary>Adicionar saldo</summary>
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
              USDT por slot fechado
              <input name="amount" type="number" min="0.01" step="0.01" placeholder="Ex.: 5" required />
            </label>
            <button className="solid-button" type="submit" disabled={strategies.length === 0} onClick={() => announce("Adicionando saldo...")}>
              Aplicar
            </button>
          </form>
        </details>
      </section>

      <details className="panel-card mini-drawer market-price-drawer">
        <summary>Marcacao a mercado</summary>
        <form className="tool-form compact-create-form" action={applyStrategyMarketPrices}>
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
            Entrada do primeiro slot
            <input name="firstEntryPrice" type="number" min="0.00000001" step="0.00000001" placeholder="Ex.: 65000" required />
          </label>
          <label>
            Preco atual
            <input name="currentPrice" type="number" min="0" step="0.00000001" placeholder="Ex.: 66800" />
          </label>
          <button className="solid-button" type="submit" disabled={strategies.length === 0} onClick={() => announce("Atualizando precos...")}>
            Aplicar
          </button>
        </form>
      </details>

      <article className="panel-card slots-panel">
        <div className="panel-heading compact-heading">
          <div>
            <p className="eyebrow">Slots</p>
            <h2>Operacao diaria</h2>
          </div>
          <select className="compact-select" value={strategyFilter} onChange={(event) => setStrategyFilter(event.target.value)} aria-label="Filtrar por estrategia">
            <option value="all">Todas</option>
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.title}
              </option>
            ))}
          </select>
        </div>

        <div className="slot-filter-row" aria-label="Filtros rapidos">
          <button type="button" className={slotFilter === "aberto" ? "active" : ""} onClick={() => setSlotFilter("aberto")}>
            Abertos <strong>{openSlots}</strong>
          </button>
          <button type="button" className={slotFilter === "gain" ? "active" : ""} onClick={() => setSlotFilter("gain")}>
            Gain <strong>{gainSlots}</strong>
          </button>
          <button type="button" className={slotFilter === "closed" ? "active" : ""} onClick={() => setSlotFilter("closed")}>
            Fechados <strong>{closedSlots}</strong>
          </button>
          <button type="button" className={slotFilter === "all" ? "active" : ""} onClick={() => setSlotFilter("all")}>
            Todos <strong>{slots.length}</strong>
          </button>
        </div>

        <div className="slot-list">
          {visibleSlots.map((slot) => (
            <SlotItem key={slot.id} slot={slot} announce={announce} />
          ))}
          {visibleSlots.length === 0 ? <p className="empty-copy padded-empty">Nenhum slot neste filtro.</p> : null}
        </div>
      </article>

      <details className="panel-card mini-drawer secondary-create">
        <summary>Adicionar novos slots</summary>
        <form className="tool-form compact-create-form" action={createSlots}>
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
            Quantidade
            <input name="quantity" type="number" min="1" max="50" defaultValue="1" required />
          </label>
          <button className="solid-button" type="submit" disabled={strategies.length === 0} onClick={() => announce("Criando slots...")}>
            Adicionar
          </button>
        </form>
      </details>
    </AppShell>
  );
}

function SlotItem({ slot, announce }: { slot: SlotView; announce: (message: string) => void }) {
  const market = getOpenMarketMetrics(slot);

  return (
            <details className={`slot-item status-${slot.status}`}>
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
                {slot.status === "aberto" ? (
                  <div className="open-market-grid">
                    <MarketStat label="Entrada" value={market.precoEntrada > 0 ? String(market.precoEntrada) : "-"} />
                    <MarketStat label="Atual" value={market.precoAtual > 0 ? String(market.precoAtual) : "-"} />
                    <MarketStat label="Alvo" value={market.precoAlvo > 0 ? String(market.precoAlvo) : "-"} tone="yellow" />
                    <MarketStat label="Valor inicial" value={formatUsdt(market.valorSlot)} />
                    <MarketStat label="Valor marcado" value={formatUsdt(market.valorMarcado)} />
                    <MarketStat
                      label="Resultado USDT"
                      value={formatSignedUsdt(market.resultadoAbertoUsdt)}
                      tone={market.resultadoAbertoUsdt < 0 ? "red" : "green"}
                    />
                    <MarketStat
                      label="Resultado %"
                      value={formatSignedPercent(market.resultadoAbertoPercentual)}
                      tone={market.resultadoAbertoUsdt < 0 ? "red" : "green"}
                    />
                    <MarketStat label="Ate gain" value={formatSignedPercent(market.distanciaAteGainPercentual)} tone="yellow" />
                  </div>
                ) : null}
                <div className="quick-actions slot-main-actions">
                  <SlotAction action={moveSlot} slotId={slot.id} label="Subir" hidden={{ direction: "up" }} onClick={() => announce("Movendo slot...")} />
                  <SlotAction action={moveSlot} slotId={slot.id} label="Descer" hidden={{ direction: "down" }} onClick={() => announce("Movendo slot...")} />
                  <SlotAction action={openSlot} slotId={slot.id} label="Abrir" className="open" disabled={slot.status === "aberto"} onClick={() => announce("Abrindo slot...")} />
                  <SlotAction action={registerGain} slotId={slot.id} label="+Gain" className="gain" disabled={slot.status === "zerado"} onClick={() => announce("Registrando gain...")} />
                  <SlotAction action={resetSlot} slotId={slot.id} label="Zerar" className="reset" onClick={() => announce("Zerando slot...")} />
                </div>

                <details className="mini-drawer edit-drawer">
                  <summary>Editar</summary>
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
                    <label>
                      Preco entrada
                      <input name="entryPrice" type="number" min="0" step="0.00000001" defaultValue={Number(slot.preco_entrada || 0) || ""} />
                    </label>
                    <label>
                      Preco atual
                      <input name="currentPrice" type="number" min="0" step="0.00000001" defaultValue={Number(slot.preco_atual || 0) || ""} />
                    </label>
                    <label>
                      Preco alvo
                      <input name="targetPrice" type="number" min="0" step="0.00000001" defaultValue={Number(slot.preco_alvo || 0) || ""} />
                    </label>
                    <label className="wide-field">
                      Observacoes
                      <input name="notes" type="text" defaultValue={slot.notes || ""} />
                    </label>
                    <button className="slot-button edit" type="submit" onClick={() => announce("Salvando edicao...")}>
                      Salvar edicao
                    </button>
                  </form>
                </details>
              </div>
            </details>
  );
}

function MarketStat({ label, value, tone }: { label: string; value: string; tone?: "green" | "red" | "yellow" }) {
  return (
    <span className={tone ? `market-stat ${tone}` : "market-stat"}>
      <em>{label}</em>
      <strong>{value}</strong>
    </span>
  );
}

function SlotAction({
  action,
  slotId,
  label,
  className = "",
  disabled = false,
  hidden,
  onClick
}: {
  action: (formData: FormData) => void | Promise<void>;
  slotId: string;
  label: string;
  className?: string;
  disabled?: boolean;
  hidden?: Record<string, string>;
  onClick: () => void;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="slotId" value={slotId} />
      {hidden
        ? Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)
        : null}
      <button className={`slot-button ${className}`} type="submit" disabled={disabled} onClick={onClick}>
        {label}
      </button>
    </form>
  );
}

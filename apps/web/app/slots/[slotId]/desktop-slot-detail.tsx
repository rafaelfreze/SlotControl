"use client";

import Link from "next/link";
import { useState } from "react";

import { moveSlot, openSlot, registerGain, resetSlot, updateSlot } from "@/app/dashboard/actions";
import { DesktopKpiCard, DesktopPanel, DesktopWorkspace } from "@/components/app/desktop-workspace";
import { SlotActionForm, type MarketTickerState } from "@/components/app/mobile-ui";
import { useCoinOpsWorkspaceData } from "@/lib/coinops-workspace/client";
import { summarizeCapitalContributions, summarizeSlotCapitalFlow, type CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import { formatDate, formatDecimal, formatPrice, formatSignedUsdt, formatUsdt, getCurrentValue, getOpenMarketMetrics } from "@/lib/slotgain/format";
import type { HistoryEvent, SlotView } from "@/lib/slotgain/types";

import styles from "./desktop-slot-detail.module.css";

export function DesktopSlotDetail({
  slot,
  contributions,
  history,
  setupError,
  livePrices,
  userLabel
}: {
  slot: SlotView;
  contributions: CapitalContributionView[];
  history: HistoryEvent[];
  setupError: string | null;
  livePrices: MarketTickerState;
  userLabel: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const { data: workspace } = useCoinOpsWorkspaceData();
  const monitoring = workspace?.overview;
  const asset = slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
  const livePrice = livePrices.prices[asset];
  const operationalGains = Number(slot.operational_gains ?? slot.gains ?? 0);
  const contribution = summarizeCapitalContributions(contributions, { slotId: slot.id });
  const capital = summarizeSlotCapitalFlow(slot);
  const market = getOpenMarketMetrics(slot, livePrice);
  const pnl = slot.status === "aberto" ? market.resultadoAbertoUsdt : Number(slot.realized_profit || 0);
  const isOpen = slot.status === "aberto";

  return (
    <DesktopWorkspace
      title={`Slot #${slot.slot_number} · ${asset}`}
      subtitle="Detalhe operacional, capital e histórico"
      livePrices={livePrices}
      monitoring={monitoring}
      userLabel={userLabel}
      actions={<Link className="desktop-row-action" href="/slots">Voltar aos slots</Link>}
    >
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar parte do slot: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice" role="status">{notice}</section> : null}

      <section className={`${styles.hero} desktop-panel`}>
        <div className={`${styles.assetIcon} ${styles[asset.toLowerCase()]}`} aria-hidden="true">{asset === "BTC" ? "₿" : "S"}</div>
        <div className={styles.heroIdentity}>
          <span>{asset === "BTC" ? "Bitcoin" : "Solana"}</span>
          <h2>Slot #{slot.slot_number}</h2>
          <p>{slot.strategy?.title || asset} · atualizado {slot.updated_at ? formatDate(slot.updated_at) : "—"}</p>
        </div>
        <span className={`desktop-status ${isOpen ? "open" : "free"}`}>{isOpen ? "OPEN" : "LIVRE"}</span>
        <div className={styles.heroActions}>
          {isOpen ? (
            <SlotActionForm action={registerGain} slotId={slot.id} label="✓ Registrar gain" pendingLabel="Registrando..." buttonClassName="desktop-primary-button" onSubmit={() => setNotice("Registrando gain...")} />
          ) : (
            <SlotActionForm action={openSlot} slotId={slot.id} label="+ Abrir operação" pendingLabel="Abrindo..." buttonClassName="desktop-primary-button" hidden={livePrice ? { entryPrice: String(Math.round(livePrice)) } : undefined} onSubmit={() => setNotice("Abrindo slot...")} />
          )}
          <Link className="desktop-secondary-button" href="/historico">Histórico completo</Link>
        </div>
      </section>

      <section className={styles.kpis} aria-label="Resumo do slot">
        <DesktopKpiCard label="Saldo operacional" value={formatUsdt(getCurrentValue(slot))} helper="Base atual para a próxima operação" tone="positive" />
        <DesktopKpiCard label="Gains operacionais" value={formatDecimal(operationalGains)} helper="Nível operacional vigente" tone="gold" />
        <DesktopKpiCard label="PnL" value={formatSignedUsdt(pnl)} helper={isOpen ? "Marcação de mercado" : "Lucro realizado registrado"} tone={pnl >= 0 ? "positive" : "negative"} />
        <DesktopKpiCard label="Gains reais" value={formatDecimal(slot.real_gains)} helper="Histórico imutável" />
        <DesktopKpiCard label="Aportes" value={formatUsdt(contribution.amountUsdt)} helper={`${formatDecimal(contribution.gains)} gains equivalentes`} />
        <DesktopKpiCard label="Status" value={isOpen ? "OPEN" : "LIVRE"} helper="Estado operacional atual" tone={isOpen ? "positive" : "neutral"} />
      </section>

      <section className={styles.layout}>
        <div className={styles.primaryColumn}>
          <DesktopPanel title="Operação atual" eyebrow="Posição e preços">
            <dl className={styles.factGrid}>
              <Fact label="Preço de entrada" value={slot.preco_entrada ? formatPrice(Number(slot.preco_entrada)) : "—"} />
              <Fact label="Preço atual" value={isOpen ? formatPrice(livePrice || Number(slot.preco_atual || 0)) : "—"} />
              <Fact label="Alvo" value={slot.preco_alvo ? formatPrice(Number(slot.preco_alvo)) : "—"} />
              <Fact label="Taxa de gain" value={`${formatDecimal(Number(slot.gain_rate || 0) * 100)}%`} />
              <Fact label="Capital da posição" value={slot.position_notional_usdt === null ? "—" : formatUsdt(Number(slot.position_notional_usdt || 0))} />
              <Fact label="Unidade de gain" value={slot.position_gain_unit_usdt === null ? "—" : formatUsdt(Number(slot.position_gain_unit_usdt || 0))} />
              <Fact label="PnL aberto" value={isOpen ? formatSignedUsdt(market.resultadoAbertoUsdt) : "—"} tone={market.resultadoAbertoUsdt >= 0 ? "positive" : "negative"} />
              <Fact label="Distância do alvo" value={isOpen && market.hasPrices ? `${formatDecimal(market.distanciaAteGainPercentual)}%` : "—"} />
            </dl>
          </DesktopPanel>

          <DesktopPanel title="Composição do capital" eyebrow="Aportes e redistribuições">
            <dl className={styles.factGrid}>
              <Fact label="Base do slot" value={formatUsdt(Number(slot.base_value || 0))} />
              <Fact label="Aporte externo" value={formatUsdt(contribution.amountUsdt)} />
              <Fact label="Gains de aporte" value={`+${formatDecimal(contribution.gains)}`} />
              <Fact label="Redistribuição recebida" value={formatUsdt(Number(slot.redistribution_received_usdt || 0))} />
              <Fact label="Redistribuição enviada" value={formatUsdt(Number(slot.redistribution_sent_usdt || 0))} />
              <Fact label="Redistribuição líquida" value={formatSignedUsdt(capital.redistributionNetUsdt)} tone={capital.redistributionNetUsdt >= 0 ? "positive" : "negative"} />
              <Fact label="Capital adicional líquido" value={formatSignedUsdt(capital.additionalCapitalNetUsdt)} tone={capital.additionalCapitalNetUsdt >= 0 ? "positive" : "negative"} />
              <Fact label="Versão contábil" value={`v${slot.accounting_version}`} />
            </dl>
          </DesktopPanel>

          <DesktopPanel
            title="Últimas operações"
            eyebrow={`${history.length} eventos carregados`}
            actions={<Link className="desktop-row-action" href="/historico">Ver histórico completo</Link>}
          >
            <div className="desktop-table-wrap">
              <table className="desktop-data-table">
                <caption className="visually-hidden">Últimos eventos deste slot</caption>
                <thead><tr><th>Data</th><th>Evento</th><th>Detalhes</th></tr></thead>
                <tbody>
                  {history.map((event) => (
                    <tr key={event.id}>
                      <td>{formatDate(event.event_at)}</td>
                      <td><strong>{event.action}</strong></td>
                      <td>{formatHistoryDetail(event.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!history.length ? <div className="desktop-empty"><strong>Nenhuma operação registrada</strong><span>Os próximos eventos deste slot aparecerão aqui.</span></div> : null}
            </div>
          </DesktopPanel>
        </div>

        <aside className={styles.aside}>
          <DesktopPanel title="Gains" eyebrow="Composição operacional">
            <dl className={styles.factList}>
              <Fact label="Gains reais" value={formatDecimal(slot.real_gains)} />
              <Fact label="Gains operacionais" value={formatDecimal(operationalGains)} />
              <Fact label="Legado adicionado" value={formatDecimal(slot.added_gains)} />
              <Fact label="Gains de aporte" value={formatDecimal(contribution.gains)} />
              <Fact label="Lucro realizado" value={formatUsdt(Number(slot.realized_profit || 0))} tone={Number(slot.realized_profit || 0) >= 0 ? "positive" : "negative"} />
            </dl>
            <Link className={styles.planLink} href="/plano-crescimento">Ver rank e escada no Plano ›</Link>
          </DesktopPanel>

          <DesktopPanel title="Ações" eyebrow="Mesmos fluxos do mobile">
            <div className={styles.actionStack}>
              <SlotActionForm action={resetSlot} slotId={slot.id} label="Zerar slot" pendingLabel="Zerando..." buttonClassName="desktop-danger-button" onSubmit={() => setNotice("Zerando slot...")} />
              <div className={styles.moveActions}>
                <SlotActionForm action={moveSlot} slotId={slot.id} label="Subir" buttonClassName="desktop-secondary-button" hidden={{ direction: "up" }} onSubmit={() => setNotice("Movendo slot...")} />
                <SlotActionForm action={moveSlot} slotId={slot.id} label="Descer" buttonClassName="desktop-secondary-button" hidden={{ direction: "down" }} onSubmit={() => setNotice("Movendo slot...")} />
              </div>
            </div>
          </DesktopPanel>

          <DesktopPanel title="Observações" eyebrow="Edição segura">
            <form className={styles.notesForm} action={updateSlot}>
              <input type="hidden" name="slotId" value={slot.id} />
              <input type="hidden" name="status" value={slot.status} />
              <input type="hidden" name="baseValue" value={Number(slot.base_value)} />
              <label htmlFor={`desktop-slot-notes-${slot.id}`}>Notas do slot</label>
              <textarea id={`desktop-slot-notes-${slot.id}`} name="notes" defaultValue={slot.notes || ""} rows={4} />
              <button className="desktop-secondary-button" type="submit">Salvar observações</button>
            </form>
          </DesktopPanel>
        </aside>
      </section>
    </DesktopWorkspace>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  return <div><dt>{label}</dt><dd className={tone ? styles[tone] : undefined}>{value}</dd></div>;
}

function formatHistoryDetail(detail: string) {
  if (!detail.startsWith("{")) return detail;
  try {
    const parsed = JSON.parse(detail) as { message?: unknown; note?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (typeof parsed.note === "string" && parsed.note) return parsed.note;
  } catch {
    return "Registro operacional";
  }
  return "Registro operacional";
}

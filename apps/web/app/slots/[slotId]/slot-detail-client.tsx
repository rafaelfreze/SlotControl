"use client";

import Link from "next/link";
import { useState } from "react";

import { moveSlot, openSlot, registerGain, resetSlot, updateSlot } from "@/app/dashboard/actions";
import { AppHeader, MobileScreen, PnLValue, StatusBadge } from "@/components/app/mobile-ui";
import { summarizeCapitalContributions, summarizeSlotCapitalFlow, type CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import { formatDate, formatDecimal, formatPrice, formatSignedUsdt, formatUsdt, getCurrentValue, getOpenMarketMetrics } from "@/lib/slotgain/format";
import { useLivePrices } from "@/lib/slotgain/live-prices";
import type { HistoryEvent, SlotView } from "@/lib/slotgain/types";

export function SlotDetailClient({ slot, contributions, history, setupError }: { slot: SlotView; contributions: CapitalContributionView[]; history: HistoryEvent[]; setupError: string | null }) {
  const livePrices = useLivePrices();
  const [notice, setNotice] = useState<string | null>(null);
  const asset = slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
  const operationalGains = Number(slot.operational_gains ?? slot.gains ?? 0);
  const contribution = summarizeCapitalContributions(contributions, { slotId: slot.id });
  const capital = summarizeSlotCapitalFlow(slot);
  const livePrice = livePrices.prices[asset];
  const pnl = slot.status === "aberto" ? getOpenMarketMetrics(slot, livePrice).resultadoAbertoUsdt : Number(slot.realized_profit || 0);

  return (
    <MobileScreen>
      <AppHeader title={`Slot #${slot.slot_number} ${asset}`} backHref="/slots" action={<StatusBadge status={slot.status} />} />
      {setupError ? <section className="inline-alert dashboard-alert">Falha ao carregar o slot: {setupError}</section> : null}
      {notice ? <section className="form-success dashboard-notice" role="status">{notice}</section> : null}

      <section className={`full-slot-detail ${asset.toLowerCase()}`}>
        <header className="full-slot-hero">
          <span className={`full-slot-icon ${asset.toLowerCase()}`} aria-hidden="true">{asset === "BTC" ? "₿" : "S"}</span>
          <h1>Slot #{slot.slot_number}</h1>
          <p>{asset} · {asset === "BTC" ? "Bitcoin" : "Solana"}</p>
        </header>

        <div className="full-slot-metrics">
          <Detail label="Gains operacionais" value={formatDecimal(operationalGains)} />
          <Detail label="Saldo operacional" value={formatUsdt(getCurrentValue(slot))} />
          <Detail label="Gains reais" value={formatDecimal(slot.real_gains)} />
          <Detail label="Gains adicionados" value={`+${formatDecimal(contribution.gains)}`} />
          <Detail label="Aportes" value={formatUsdt(contribution.amountUsdt)} />
          <div><span>PnL</span><PnLValue value={pnl}>{formatSignedUsdt(pnl)}</PnLValue></div>
          <Detail label="Status" value={slot.status === "aberto" ? "OPEN" : "LIVRE"} />
          <Detail label="Rank" value="Ver escada" />
        </div>

        <details className="full-slot-secondary">
          <summary>Detalhes contábeis e da posição</summary>
          <dl>
            <DetailRow label="Lucro realizado" value={formatUsdt(Number(slot.realized_profit || 0))} />
            <DetailRow label="Legado (adicionados)" value={formatDecimal(slot.added_gains)} />
            <DetailRow label="Redistribuição líquida" value={formatSignedUsdt(capital.redistributionNetUsdt)} />
            <DetailRow label="Capital adicional líquido" value={formatSignedUsdt(capital.additionalCapitalNetUsdt)} />
            <DetailRow label="Preço médio" value={slot.preco_entrada ? formatPrice(Number(slot.preco_entrada)) : "—"} />
            <DetailRow label="Alvo" value={slot.preco_alvo ? formatPrice(Number(slot.preco_alvo)) : "—"} />
            <DetailRow label="Última atualização" value={slot.updated_at ? formatDate(slot.updated_at) : "—"} />
          </dl>
        </details>

        <div className="full-slot-actions">
          {slot.status === "aberto" ? <button disabled>Aberto</button> : <Action action={openSlot} slotId={slot.id} label="Abrir" hidden={livePrice ? { entryPrice: String(Math.round(livePrice)) } : undefined} onClick={() => setNotice("Abrindo slot...")} />}
          <Action action={registerGain} slotId={slot.id} label="Adicionar gain" disabled={slot.status === "zerado" || slot.status === "hold"} onClick={() => setNotice("Registrando gain...")} />
          <Action action={resetSlot} slotId={slot.id} label="Zerar" onClick={() => setNotice("Zerando slot...")} />
        </div>

        <details className="slot-advanced-actions full-slot-edit">
          <summary>Editar e organizar</summary>
          <div className="slot-card-actions">
            <Action action={moveSlot} slotId={slot.id} label="Subir" hidden={{ direction: "up" }} onClick={() => setNotice("Movendo slot...")} />
            <Action action={moveSlot} slotId={slot.id} label="Descer" hidden={{ direction: "down" }} onClick={() => setNotice("Movendo slot...")} />
          </div>
          <form className="tool-form stacked-form" action={updateSlot}>
            <input type="hidden" name="slotId" value={slot.id} />
            <input type="hidden" name="status" value={slot.status} />
            <input type="hidden" name="baseValue" value={Number(slot.base_value)} />
            <label>Observações<input name="notes" type="text" defaultValue={slot.notes || ""} /></label>
            <button type="submit">Salvar</button>
          </form>
        </details>
      </section>

      <section className="slot-recent-operations">
        <h2>Últimas operações</h2>
        <div>
          {history.slice(0, 3).map((event) => (
            <article key={event.id}><time>{formatDate(event.event_at)}</time><strong>{event.action}</strong><span>{event.detail.startsWith("{") ? "Registro operacional" : event.detail}</span></article>
          ))}
          {!history.length ? <p>Nenhuma operação registrada para este slot.</p> : null}
        </div>
        <Link href="/historico">Ver histórico completo</Link>
      </section>
    </MobileScreen>
  );
}

function Detail({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function DetailRow({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }

function Action({ action, slotId, label, disabled = false, hidden, onClick }: { action: (formData: FormData) => void | Promise<void>; slotId: string; label: string; disabled?: boolean; hidden?: Record<string, string>; onClick: () => void }) {
  return <form action={action}><input type="hidden" name="slotId" value={slotId} />{hidden ? Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />) : null}<button type="submit" disabled={disabled} onClick={onClick}>{label}</button></form>;
}

"use client";

import { useState } from "react";
import { nextMonthlyResetAt } from "@/lib/execution/monthly-slot-policy";
import type { Props } from "./automation-mobile";

type Asset = "BTC" | "SOL";
type Environment = "SHADOW" | "TESTNET";
type SlotInfo = { slotNumber: number; positionState: string; entryPrice: number | string | null; tpPrice: number | string | null; balance: number | string | null };
type Filter = "operational" | "physical" | "gain_desc" | "gain_asc" | "reached" | "eligible" | "open" | "waiting";
const number = (value: number | string | null, digits = 2) => value == null || !Number.isFinite(Number(value)) ? "—"
  : Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits });
const reset = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Campo_Grande", dateStyle: "short" }).format(new Date(value));

/** The same policy snapshot is rendered for Shadow and fictitious Testnet.
 * Rank is a physical-slot queue, never a replacement for price/reentry priority. */
export function MonthlySlotView({ data, environment, asset, slots }: { data: Props; environment: Environment; asset: Asset; slots: SlotInfo[] }) {
  const [filter, setFilter] = useState<Filter>("operational"), [all, setAll] = useState(false);
  const statuses = (data.monthlyGoals || []).filter((row) => row.environment === environment && row.asset === asset);
  if (statuses.length !== 25) return <p className="av2-missed-note">Metas mensais: aguardando evidência completa dos 25 slots físicos.</p>;
  const rows = statuses.map((status) => ({ ...status, slot: slots.find((item) => item.slotNumber === status.physicalSlotNumber) }));
  const shown = rows.filter((row) => filter === "reached" ? row.monthlyTargetReached
    : filter === "eligible" ? row.eligibleForNewEntry
    : filter === "open" ? ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(row.slot?.positionState || "")
    : filter === "waiting" ? !["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED", "ARMED"].includes(row.slot?.positionState || "") && !row.monthlyTargetReached
    : true).sort((a, b) => filter === "physical" ? a.physicalSlotNumber - b.physicalSlotNumber
      : filter === "gain_desc" ? b.lifetimeGainCount - a.lifetimeGainCount || a.physicalSlotNumber - b.physicalSlotNumber
      : filter === "gain_asc" ? a.lifetimeGainCount - b.lifetimeGainCount || a.physicalSlotNumber - b.physicalSlotNumber
      : Number(["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(b.slot?.positionState || ""))
        - Number(["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(a.slot?.positionState || ""))
        || (a.operationalRank ?? 99) - (b.operationalRank ?? 99) || a.physicalSlotNumber - b.physicalSlotNumber);
  const visible = all || filter !== "operational" ? shown : shown.slice(0, 6);
  const reachedCount = statuses.filter((row) => row.monthlyTargetReached).length;
  const eligibleCount = statuses.filter((row) => row.eligibleForNewEntry).length;
  const monthlyCount = statuses.reduce((sum, row) => sum + (row.monthlyGainCount ?? 0), 0);
  const nextAction = (row: typeof rows[number]) => ["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"].includes(row.slot?.positionState || "") ? "Aguardar TP"
    : row.monthlyTargetReached ? "Aguardar próximo mês"
    : !row.eligibleForNewEntry ? "Reconciliar evidência"
    : row.slot?.positionState === "MISSED" ? "Aguardar próximo ciclo"
    : row.slot?.positionState === "ARMED" ? "Próxima BUY armada" : "Aguardar preço/reentrada";
  return <div className="av2-monthly-panel" aria-label={`Metas mensais ${environment} ${asset}`}>
    <div className="av2-monthly-head"><div><strong>Metas mensais por slot · {asset}</strong><small>{statuses[0]?.periodKey} · America/Campo_Grande · reset {reset(nextMonthlyResetAt(`${statuses[0]?.periodKey}-15T12:00:00Z`))}</small></div>
      <span>{reachedCount === 25 ? "META MENSAL COMPLETA" : `${reachedCount}/25 META BATIDA · ${eligibleCount} elegíveis · ${monthlyCount} gains no mês`}</span></div>
    <label className="av2-monthly-filter">Visão <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
      <option value="operational">Ordem operacional</option><option value="physical">Slot físico</option><option value="gain_desc">Mais gains</option><option value="gain_asc">Menos gains</option>
      <option value="reached">Meta batida</option><option value="eligible">Elegíveis</option><option value="open">OPEN</option><option value="waiting">Aguardando</option>
    </select></label>
    <div className="av2-monthly-list">{visible.map((row) => <div className="av2-monthly-row" key={row.physicalSlotId} data-reached={row.monthlyTargetReached}>
      <div><strong>Slot físico #{row.physicalSlotNumber} · Rank {row.operationalRank === null ? "—" : `#${row.operationalRank}`}</strong>
        <small>{row.slot?.positionState || row.entryState} · {row.lifetimeGainCount} gains totais · {row.monthlyGainCount ?? "?"}/{row.monthlyGainTarget} no mês</small></div>
      <div><strong>{row.monthlyTargetReached ? `META BATIDA ${row.monthlyGainCount}/${row.monthlyGainTarget}` : row.eligibleForNewEntry ? "ELEGÍVEL" : "EVIDÊNCIA INCOMPLETA"}</strong>
        <small>Saldo composto {number(row.slot?.balance ?? row.balanceUsdc, 4)} USDC · Entrada {number(row.slot?.entryPrice ?? null)} · TP {number(row.slot?.tpPrice ?? null)}</small></div>
      <div><strong>{nextAction(row)}</strong><small>{row.monthlyTargetReached ? "Este slot não fará novas entradas até o próximo mês." : "O preço/reentrada válido conserva prioridade sobre o rank."}</small></div>
    </div>)}</div>
    {!visible.length ? <p className="av2-empty">Nenhum slot corresponde ao filtro.</p> : null}
    {filter === "operational" && shown.length > 6 ? <button type="button" className="av2-subtle-button" onClick={() => setAll(!all)}>{all ? "Ver menos" : `Ver todos os ${shown.length} slots`}</button> : null}
  </div>;
}

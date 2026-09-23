"use client";

import type { MonthlySlotStatus } from "@/lib/execution/monthly-slot-policy";
import { nextMonthlyResetAt } from "@/lib/execution/monthly-slot-policy";
import { monthlyNextAction } from "./monthly-slot-order";
import type { MonthlySlotFilter } from "./monthly-slot-order";

export { orderMonthlySlotRows } from "./monthly-slot-order";
export type { MonthlySlotFilter } from "./monthly-slot-order";
const number = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 4 });

export function MonthlySlotToolbar({ statuses, filter, onFilter }: { statuses: MonthlySlotStatus[]; filter: MonthlySlotFilter; onFilter: (filter: MonthlySlotFilter) => void }) {
  if (statuses.length !== 25) return <p className="av2-missed-note">Metas mensais: aguardando evidência completa dos 25 slots físicos.</p>;
  const reached = statuses.filter((row) => row.monthlyTargetReached).length;
  const eligible = statuses.filter((row) => row.eligibleForNewEntry).length;
  const reset = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Campo_Grande", dateStyle: "short" })
    .format(new Date(nextMonthlyResetAt(`${statuses[0].periodKey}-15T12:00:00Z`)));
  return <div className="av2-monthly-toolbar" aria-label="Metas mensais e ordem dos slots">
    <span><strong>{reached}/25 metas</strong> · {eligible} elegíveis · {statuses[0].periodKey} · reinicia {reset}</span>
    <label>Lista <select value={filter} onChange={(event) => onFilter(event.target.value as MonthlySlotFilter)}>
      <option value="operational">Ordem operacional</option><option value="physical">Slot físico</option>
      <option value="gain_desc">Mais gains</option><option value="gain_asc">Menos gains</option>
      <option value="reached">Meta batida</option><option value="eligible">Elegíveis</option>
      <option value="open">OPEN</option><option value="waiting">Aguardando</option>
    </select></label>
  </div>;
}

export function MonthlySlotHint({ status }: { status?: MonthlySlotStatus }) {
  if (!status) return null;
  return <small className="av2-monthly-hint">{status.operationalRank === null ? "Sem rank" : `Rank #${status.operationalRank}`} · {status.monthlyGainCount ?? "?"}/{status.monthlyGainTarget} mês{status.monthlyTargetReached ? " · META BATIDA" : ""}</small>;
}

export function MonthlySlotDetails({ status }: { status?: MonthlySlotStatus }) {
  if (!status) return null;
  const target = status as MonthlySlotStatus & { environment?: "SHADOW" | "TESTNET"; asset?: "BTC" | "SOL" };
  return <>
    <span>Rank operacional<strong>{status.operationalRank === null ? "Fora da fila" : `#${status.operationalRank}`}</strong></span>
    <span>Gains totais<strong>{status.lifetimeGainCount}{status.marketGainCount != null && status.manualGainCount != null ? ` · mercado ${status.marketGainCount} + manual ${status.manualGainCount}` : ""}</strong></span>
    <span>Gains do mês / meta<strong>{status.monthlyGainCount ?? "Evidência pendente"} / {status.monthlyGainTarget}{status.monthlyMarketGainCount != null && status.monthlyManualGainCount != null ? ` · mercado ${status.monthlyMarketGainCount} + manual ${status.monthlyManualGainCount}` : ""}</strong></span>
    <span>Elegibilidade<strong>{status.monthlyTargetReached ? "META BATIDA · até o próximo mês" : status.eligibleForNewEntry ? "Elegível" : "Evidência incompleta"}</strong></span>
    <span>Saldo composto<strong>{number(status.balanceUsdc)} USDC</strong></span>
    <span>Próxima ação<strong>{monthlyNextAction(status)}</strong></span>
    {target.environment && target.asset ? <span>Ajustes manuais<strong><a href={`/automacao?view=${target.environment.toLowerCase()}&adjust=${target.environment}:${target.asset}:${status.physicalSlotNumber}#manual-adjustments`}>Adicionar gain ou aporte →</a></strong></span> : null}
  </>;
}

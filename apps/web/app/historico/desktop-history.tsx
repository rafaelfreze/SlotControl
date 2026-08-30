"use client";

import { useMemo, useState } from "react";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import type { MarketTickerState } from "@/components/app/mobile-ui";
import type { OfficialMonitoringOverview } from "@/lib/coinops-monitoring/server";
import { formatDate, formatSignedUsdt } from "@/lib/slotgain/format";
import type { HistoryEvent } from "@/lib/slotgain/types";
import { parseHistoryDetail } from "./historico-client";

type Filter = "all" | "operation" | "gain" | "aporte" | "redistribution" | "regime" | "system";
type Asset = "ALL" | "BTC" | "SOL";
type Scope = "baseline" | "legacy" | "all";

export function DesktopHistory({ userLabel, history, livePrices, monitoring, baselineStartedAt }: { userLabel: string; history: HistoryEvent[]; livePrices: MarketTickerState; monitoring: OfficialMonitoringOverview; baselineStartedAt: string | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [asset, setAsset] = useState<Asset>("ALL");
  const [scope, setScope] = useState<Scope>(baselineStartedAt ? "baseline" : "all");
  const [query, setQuery] = useState("");
  const rows = useMemo(() => history.filter((item) => {
    const parsed = parseHistoryDetail(item);
    const action = `${item.action} ${parsed.eventType}`.toLowerCase();
    const itemAsset = (parsed.asset || item.strategy?.asset || item.strategy_key || "").toUpperCase();
    const itemTime = new Date(item.event_at).getTime();
    const baselineTime = baselineStartedAt ? new Date(baselineStartedAt).getTime() : null;
    if (scope === "baseline" && baselineTime !== null && itemTime < baselineTime) return false;
    if (scope === "legacy" && (baselineTime === null || itemTime >= baselineTime)) return false;
    if (asset !== "ALL" && itemAsset !== asset) return false;
    if (query && !`${item.action} ${parsed.message} ${item.slot_number || ""}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === "gain") return action.includes("gain") || action.includes("saida");
    if (filter === "aporte") return action.includes("aporte") || action.includes("contribution");
    if (filter === "redistribution") return action.includes("redistrib");
    if (filter === "regime") return action.includes("ath") || action.includes("regime") || action.includes("fundo");
    if (filter === "system") return parsed.origin === "SISTEMA";
    if (filter === "operation") return !action.includes("aporte") && !action.includes("contribution");
    return true;
  }), [asset, baselineStartedAt, filter, history, query, scope]);

  return <DesktopWorkspace title="Histórico" subtitle={`${rows.length} eventos no filtro atual`} livePrices={livePrices} monitoring={monitoring} userLabel={userLabel}>
    <section className="desktop-toolbar">
      <div className="desktop-filter-group">{([
        ["all", "Todos"], ["operation", "Operações"], ["gain", "Gains"], ["aporte", "Aportes"], ["redistribution", "Redistribuições"], ["regime", "Regimes"], ["system", "Sistema"]
      ] as Array<[Filter, string]>).map(([value, label]) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div>
      <label className="desktop-search"><span className="visually-hidden">Buscar no histórico</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar evento..." /></label>
      <label className="desktop-sort"><span>Ativo</span><select value={asset} onChange={(event) => setAsset(event.target.value as Asset)}><option value="ALL">Todos</option><option value="BTC">BTC</option><option value="SOL">SOL</option></select></label>
      {baselineStartedAt ? <label className="desktop-sort"><span>Período</span><select value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="baseline">Desde o baseline</option><option value="legacy">Legado</option><option value="all">Todo período</option></select></label> : null}
    </section>

    <section className="desktop-panel desktop-history-panel">
      <header className="desktop-panel-header"><div><span>Timeline auditável</span><h2>Eventos operacionais</h2></div><span className="desktop-data-note">Clique em uma linha para detalhes</span></header>
      <div className="desktop-table-wrap"><table className="desktop-data-table desktop-history-table"><thead><tr><th>Data</th><th>Ativo</th><th>Slot</th><th>Evento</th><th>Origem</th><th>Valor</th><th>Detalhes</th></tr></thead><tbody>{rows.map((item) => {
        const parsed = parseHistoryDetail(item);
        const itemAsset = (parsed.asset || item.strategy?.asset || item.strategy_key || "-").toUpperCase();
        const value = parsed.realizedProfit ?? parsed.valueAfter ?? parsed.slotValue;
        return <tr key={item.id}><td><time dateTime={item.event_at}>{formatDate(item.event_at)}</time></td><td><span className={`desktop-asset-pill ${itemAsset === "SOL" ? "sol" : "btc"}`}>{itemAsset}</span></td><td>{item.slot_number ? `#${item.slot_number}` : "-"}</td><td><strong>{item.action}</strong></td><td>{parsed.origin}</td><td className={value !== null && value < 0 ? "financial-negative" : "financial-positive"}>{value === null ? "-" : formatSignedUsdt(value)}</td><td><details className="desktop-row-details"><summary aria-label="Ver detalhes">Ver</summary><div><strong>{parsed.message}</strong>{parsed.batchId ? <p>Total: {formatSignedUsdt(parsed.totalAmount || 0)} · {formatSignedUsdt(parsed.amountPerSlot || 0)} por slot · {parsed.slotCount} slots · {parsed.openSlotCount} abertos incluídos</p> : null}{parsed.note ? <p>{parsed.note}</p> : null}<small>{parsed.eventType}{parsed.batchId ? ` · Lote ${parsed.batchId}` : ""}</small></div></details></td></tr>;
      })}</tbody></table>{!rows.length ? <p className="desktop-empty">Nenhum evento corresponde aos filtros selecionados.</p> : null}</div>
    </section>
  </DesktopWorkspace>;
}

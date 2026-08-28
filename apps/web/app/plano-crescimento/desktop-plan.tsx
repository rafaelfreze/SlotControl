"use client";

import Link from "next/link";
import { useState } from "react";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import type { MarketTickerState } from "@/components/app/mobile-ui";
import type { OfficialMonitoringOverview } from "@/lib/coinops-monitoring/server";
import { formatDate, formatUsdt } from "@/lib/slotgain/format";
import { AssetLadderSection, type AssetLadderPlanResponse, type AssetPlanActionKeys } from "./btc-ladder-section";
import type { ProgrammedGrowthPlanResponse } from "./growth-plan-client";

type Asset = "BTC" | "SOL";

export function DesktopPlan({
  userLabel,
  livePrices,
  monitoring,
  plan,
  btcLadder,
  solLadder,
  btcActionKeys,
  solActionKeys
}: {
  userLabel: string;
  livePrices: MarketTickerState;
  monitoring: OfficialMonitoringOverview;
  plan: ProgrammedGrowthPlanResponse;
  btcLadder: AssetLadderPlanResponse;
  solLadder: AssetLadderPlanResponse;
  btcActionKeys: AssetPlanActionKeys;
  solActionKeys: AssetPlanActionKeys;
}) {
  const [asset, setAsset] = useState<Asset>("BTC");
  const ladder = asset === "BTC" ? btcLadder : solLadder;
  const actionKeys = asset === "BTC" ? btcActionKeys : solActionKeys;
  const rows = ladder.ladder || ladder.ranking || [];
  const reference = Number(ladder.reference_level ?? ladder.suggested_reference_level ?? 0);
  const monitoredAsset = monitoring.assets?.[asset];
  const target = monitoring.active && monitoredAsset ? monitoredAsset.target : Number(ladder.monthly_goal || (asset === "BTC" ? 7 : 2));
  const progress = Number(ladder.real_gains_month || 0);
  const excess = Number(ladder.available_excess_gains || 0);
  const spacing = monitoring.strategy ? (asset === "BTC" ? monitoring.strategy.btc_spacing : monitoring.strategy.sol_spacing) : null;

  return <DesktopWorkspace title="Plano operacional" subtitle="Metas, escada e redistribuição" livePrices={livePrices} monitoring={monitoring} userLabel={userLabel} actions={<><Link href="/plano-crescimento/regras">Regras atuais</Link><Link href="/plano-crescimento/relatorios">Relatórios</Link></>}>
    <section className="desktop-plan-heading">
      <div className="desktop-asset-selector" role="tablist" aria-label="Selecionar ativo">
        {(["BTC", "SOL"] as const).map((value) => <button type="button" role="tab" aria-selected={asset === value} className={asset === value ? "active" : ""} key={value} onClick={() => setAsset(value)}>{value}<small>{(value === "BTC" ? btcLadder : solLadder).ladder?.length || 0} slots</small></button>)}
      </div>
      <div className="desktop-cycle-summary">
        <span><small>Ciclo atual</small><strong>{monitoring.cycle ? `#${monitoring.cycle.number}` : "Legado"}</strong></span>
        <span><small>Iniciado em</small><strong>{monitoring.cycle ? formatDate(monitoring.cycle.start_at) : plan.started_at ? formatDate(plan.started_at) : "-"}</strong></span>
        <span><small>Dias restantes</small><strong>{monitoring.cycle?.days_remaining ?? "-"}</strong></span>
        <span><small>Modo</small><strong>{monitoring.strategy ? (monitoring.strategy.mode === "DEFENSIVE_POST_ATH" ? "Defensivo" : "Normal") : "Aguardando"}</strong></span>
      </div>
    </section>

    <section className="desktop-plan-kpis">
      <PlanKpi label="Meta" value={target === null ? "Pausada" : `${target} gains`} helper="Por slot habilitado" />
      <PlanKpi label="Progresso real" value={`${progress} gains`} helper="No período atual" />
      <PlanKpi label="Referência" value={reference > 0 ? `${reference} gains` : "Não definida"} helper="Escada operacional" />
      <PlanKpi label="Excedente" value={`${excess} gains`} helper="Disponível" />
      <PlanKpi label="Elegível" value={formatUsdt(Number(ladder.available_excess_usdt || 0))} helper="Para redistribuição" />
      <PlanKpi label="Slots" value={String(rows.length)} helper={`${monitoring.assets?.[asset]?.below_target ?? 0} abaixo da meta`} />
    </section>

    <section className="desktop-plan-layout">
      <div className="desktop-plan-main">
        <AssetLadderSection key={asset} asset={asset} plan={ladder} actionKeys={actionKeys} />
      </div>
      <aside className="desktop-plan-aside">
        <article className="desktop-panel"><header className="desktop-panel-header"><div><span>Operação</span><h2>Resumo {asset}</h2></div></header><dl className="desktop-plan-facts">
          <div><dt>Espaçamento</dt><dd>{spacing === null ? "—" : String(spacing) + "%"}</dd></div>
          <div><dt>Meta oficial</dt><dd>{target ?? "Pausada"}</dd></div>
          <div><dt>Próximo slot</dt><dd>#{monitoring.assets?.[asset]?.next_slot?.slot_number ?? "-"}</dd></div>
          <div><dt>Principais abertos</dt><dd>{monitoring.pools?.[asset]?.main_open ?? 0}/25</dd></div>
          <div><dt>Reserva habilitada</dt><dd>{monitoring.pools?.[asset]?.reserve_enabled ?? 0}</dd></div>
        </dl></article>
        <article className="desktop-panel desktop-plan-links"><header className="desktop-panel-header"><div><span>Monitoramento</span><h2>Auditoria do ciclo</h2></div></header><Link href="/plano-crescimento/baseline">Ver baseline</Link><Link href="/ciclos">Ver ciclos</Link><Link href="/plano-crescimento/relatorios">Ver relatórios</Link></article>
      </aside>
    </section>
  </DesktopWorkspace>;
}

function PlanKpi({ label, value, helper }: { label: string; value: string; helper: string }) {
  return <article className="desktop-kpi"><span>{label}</span><strong>{value}</strong><small>{helper}</small></article>;
}

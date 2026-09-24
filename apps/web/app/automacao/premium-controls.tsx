"use client";

import { useState } from "react";

import { selectTestnetAssetData } from "@/lib/slotgain/testnet-asset-view";

import { ProductionBalances, TestnetControls, type AutomationView } from "./automation-center";
import type { Props } from "./automation-mobile";
import { LivePreparationPanel } from "./live-preparation-panel";
import { ShadowControls } from "./shadow-controls";

type ControlsEnvironment = Exclude<AutomationView, "overview">;
const environments: ReadonlyArray<{ id: ControlsEnvironment; label: string }> = [
  { id: "live", label: "Real" },
  { id: "shadow", label: "Shadow" },
  { id: "testnet", label: "Testnet" }
];

/** Reuses the established forms; opening this drawer never dispatches an action. */
export function PremiumControls({ data, view, asset }: { data: Props; view: AutomationView; asset: "BTC" | "SOL" }) {
  const [overviewEnvironment, setOverviewEnvironment] = useState<ControlsEnvironment>("live");
  const environment = view === "overview" ? overviewEnvironment : view;
  const testnetData = environment === "testnet" ? { ...data, ...selectTestnetAssetData(data, asset) } : null;

  return <div className="premium-controls coinops-automation ac-center" data-controls-environment={environment}>
    {view === "overview" ? <nav className="ac-order-filters" aria-label="Ambiente dos controles">{environments.map((item) => <button key={item.id} type="button" aria-pressed={environment === item.id} onClick={() => setOverviewEnvironment(item.id)}>{item.label}</button>)}</nav> : null}
    <p className="premium-controls-scope">{asset} · {environment === "live" ? "Binance Production · capital real em BRL" : environment === "testnet" ? "Binance Spot Testnet · fundos fictícios em USDC" : "Shadow · simulação virtual em USDC"}. Configurações e controles separados por ambiente.</p>
    {environment === "shadow" ? <ShadowControls key={`shadow:${asset}`} data={data} asset={asset} /> : null}
    {testnetData ? <TestnetControls key={`testnet:${asset}`} data={testnetData} asset={asset} /> : null}
    {environment === "live" ? <>
      <p className="px-caption">O painel de preparação abaixo avalia saldo livre para iniciar um novo ciclo. Durante um ciclo ativo, parte do capital já está em posições e reservas; esse gate não substitui a saúde operacional exibida no dashboard.</p>
      <details className="premium-controls-balances"><summary>Saldos Binance Production · somente consulta</summary><ProductionBalances data={data} asset={asset} /></details>
      {data.livePreparation ? <LivePreparationPanel key={`live:${asset}`} data={data.livePreparation} asset={asset} /> : <section className="ac-panel" role="status"><h2>Configuração Real indisponível</h2><p>Não foi possível carregar os limites e gates nesta consulta. Isso não confirma uma interrupção do executor. Consulte o estado operacional antes de qualquer ação.</p></section>}
    </> : null}
  </div>;
}

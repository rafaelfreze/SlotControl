"use client";

import { useState } from "react";

import type { AthSimulationStep } from "@/lib/execution/ath-simulator";

type Asset = "BTC" | "SOL";
type Result = { simulationId: string; state: { regime: string; athPrice: number | null }; cycleNumber: number;
  missedLevels: number; primary: number[]; reserve: number[]; steps: AthSimulationStep[];
  slots: Array<{ physicalSlotNumber: number; lifetimeGainCount: number; monthlyGainCount: number | null; balanceUsdc: number; entryState: string }> };
const initialGains = Array.from({ length: 25 }, (_, index) => String(index + 1)).join(",");
const pct = (value: string) => Number(value.trim().replace(",", ".")) / 100;
const counts = (value: string) => value.split(/[;,\s]+/).filter(Boolean).map(Number);
const pricesOf = (value: string) => value.split(/[;\s]+/).filter(Boolean).map((part) => Number(part.replace(",", ".")));
const sequence = (anchor: number, spacing: number) => [anchor, ...Array.from({ length: 24 }, (_, index) =>
  Number((anchor * (1 - spacing) ** (index + 1) - .000001).toFixed(8)))].join("; ");

export function AthSimulatorClient() {
  const [asset, setAsset] = useState<Asset>("BTC");
  const [initialPrice, setInitialPrice] = useState("105");
  const [previousAth, setPreviousAth] = useState("100");
  const [floor, setFloor] = useState("");
  const [gain, setGain] = useState("1,2");
  const [normal, setNormal] = useState("2");
  const [post, setPost] = useState("5");
  const [lifetime, setLifetime] = useState(initialGains);
  const [monthly, setMonthly] = useState(Array(25).fill("0").join(","));
  const [prices, setPrices] = useState(sequence(105, .05));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const setAssetDefaults = (next: Asset) => {
    setAsset(next); setGain(next === "BTC" ? "1,2" : "5,5"); setNormal(next === "BTC" ? "2" : "3");
    setPost(next === "BTC" ? "5" : "8"); setResult(null);
  };
  const run = async () => {
    setRunning(true); setError(null); setResult(null);
    try {
      const response = await fetch("/api/coinops-ath-simulator", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset,
          initialPrice: Number(initialPrice.replace(",", ".")), previousAth: Number(previousAth.replace(",", ".")),
          floorReference: floor.trim() ? Number(floor.replace(",", ".")) : null,
          parameters: { gainRate: pct(gain), normalSpacing: pct(normal), postAthSpacing: pct(post) },
          lifetimeGains: counts(lifetime), monthlyGains: counts(monthly), prices: pricesOf(prices) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Falha na simulação");
      setResult(payload as Result);
    } catch (runError) { setError(runError instanceof Error ? runError.message : "Falha na simulação"); }
    finally { setRunning(false); }
  };
  const buys = result?.steps.filter((step) => step.event === "INITIAL_MARKET_FILLED" || step.event === "BUY_FILLED") || [];
  return <main className="ath-simulator"><header><a href="/automacao">← Automação</a><span>COINOPS · LAB ISOLADO</span><h1>Simulador de Estratégia / Cenário ATH</h1><p>Replay determinístico em namespace SIM-. Não consulta a exchange nem altera Shadow, Testnet, Production, gains ou capital operacional.</p></header>
    <section className="ath-sim-panel"><h2>Parâmetros do cenário</h2><div className="ath-sim-grid">
      <label>Ativo<select value={asset} onChange={(event) => setAssetDefaults(event.target.value as Asset)}><option>BTC</option><option>SOL</option></select></label>
      <label>Preço inicial / novo ATH<input value={initialPrice} onChange={(event) => setInitialPrice(event.target.value)} inputMode="decimal" /></label>
      <label>ATH anterior<input value={previousAth} onChange={(event) => setPreviousAth(event.target.value)} inputMode="decimal" /></label>
      <label>Floor manual (opcional)<input value={floor} onChange={(event) => setFloor(event.target.value)} inputMode="decimal" placeholder="Referência de retorno ainda não definida" /></label>
      <label>Gain %<input value={gain} onChange={(event) => setGain(event.target.value)} inputMode="decimal" /></label>
      <label>Queda normal %<input value={normal} onChange={(event) => setNormal(event.target.value)} inputMode="decimal" /></label>
      <label>Queda pós-ATH %<input value={post} onChange={(event) => setPost(event.target.value)} inputMode="decimal" /></label>
    </div><div className="ath-sim-large-fields"><label>Lifetime gains dos 25 slots (1→25)<textarea value={lifetime} onChange={(event) => setLifetime(event.target.value)} rows={3} /></label>
      <label>Gains do mês dos 25 slots<textarea value={monthly} onChange={(event) => setMonthly(event.target.value)} rows={3} /></label>
      <label>Sequência artificial de preços / candles (separe por ;, vírgula decimal aceita)<textarea value={prices} onChange={(event) => setPrices(event.target.value)} rows={5} /></label></div>
      <div className="ath-sim-actions"><button type="button" onClick={() => setPrices(sequence(Number(initialPrice.replace(",", ".")), pct(post)))}>Gerar queda de 25 níveis</button><button type="button" onClick={run} disabled={running}>{running ? "Simulando…" : "Executar cenário isolado"}</button></div>
      {error ? <p role="alert" className="ath-sim-error">{error}</p> : null}</section>
    {result ? <section className="ath-sim-panel"><h2>Resultado · {result.simulationId}</h2><div className="ath-sim-kpis"><span>Regime<strong>{result.state.regime}</strong></span><span>ATH<strong>{result.state.athPrice ?? "—"}</strong></span><span>Ciclos<strong>{result.cycleNumber}</strong></span><span>Missed<strong>{result.missedLevels}</strong></span></div>
      <p><strong>Primary selecionado / ordem:</strong> {result.primary.join(" → ") || "—"}</p><p><strong>Reserve / ordem:</strong> {result.reserve.join(" → ") || "—"}</p><p><strong>BUY executadas:</strong> {buys.map((step) => `#${step.slot}`).join(" → ") || "—"}</p>
      <details><summary>Ver {result.steps.length} decisões e eventos passo a passo</summary><div className="ath-sim-table"><table><thead><tr><th>Passo</th><th>Preço</th><th>Regime</th><th>Evento</th><th>Slot</th><th>Grupo/rank</th><th>Alvo</th><th>Saldo</th><th>Gains mês/total</th><th>Decisão</th><th>Próxima BUY</th><th>OPEN</th></tr></thead><tbody>{result.steps.map((step, index) => <tr key={`${step.index}-${step.event}-${index}`}><td>{step.index}</td><td>{step.price}</td><td>{step.regime}</td><td>{step.event}</td><td>{step.slot ?? "—"}</td><td>{step.group ? `${step.group} #${step.groupRank}` : "—"}</td><td>{step.targetPrice ?? "—"}</td><td>{step.balanceUsdc ?? "—"}</td><td>{step.monthlyGains ?? "—"}/{step.lifetimeGains ?? "—"}</td><td>{step.decisionId ? <code title={step.decisionId}>{step.decisionId.slice(0, 10)}…</code> : "—"}</td><td>{step.nextBuy ?? "—"}</td><td>{step.openCount}</td></tr>)}</tbody></table></div></details>
    </section> : null}<p className="ath-sim-foot">Simulation ID é um hash determinístico do input; nenhuma ordem ou saldo é persistido. Production READ-ONLY · LIVE bloqueado.</p></main>;
}

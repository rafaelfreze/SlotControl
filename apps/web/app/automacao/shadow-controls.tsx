"use client";

import { EngineScopeFields } from "./engine-scope-fields";

import type { FormEvent } from "react";

import { COINOPS_TIME_ZONE } from "@/lib/slotgain/format";

import type { Props } from "./automation-mobile";
import { controlRobotV1Shadow, saveRobotV1Parameters } from "./robot-v1-actions";

const activeCycles = new Set(["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]);
const number = (value: number | string | null | undefined, digits = 2) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
  ? Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits }) : "—";
const percent = (value: number | string | null | undefined) => number(Number(value || 0) * 100, 2);
const date = (value?: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: COINOPS_TIME_ZONE }).format(new Date(value)) : "Ainda não disponível";

function confirmKill(event: FormEvent<HTMLFormElement>) {
  if (!window.confirm("Ativar o kill switch pausa novas entradas deste robô Shadow. O ciclo e o histórico serão preservados. Continuar?")) event.preventDefault();
}

/** Presentation of the existing Shadow actions, shared by both automation layouts. */
export function ShadowControls({ data, asset }: { data: Props; asset: "BTC" | "SOL" }) {
  const config = data.configs.find((item) => item.asset === asset);
  const cycle = data.cycles.find((item) => item.asset === asset && activeCycles.has(item.status));
  const paused = data.engineContext?.status === "PAUSED";
  const active = Boolean(cycle) && !paused && !config?.kill_switch && !config?.pause_new_entries;

  return <section className="ac-panel premium-shadow-controls" aria-label={`Configuração Shadow ${asset}`}>
    <div className="ac-panel-heading"><div><span className="ac-kicker">SIMULAÇÃO VIRTUAL</span><h2>Shadow · {asset}/{data.engineContext?.quote_asset ?? "USDC"}</h2></div><span className={`ac-badge ${active ? "ac-badge--green" : "ac-badge--slate"}`}>{paused ? "PAUSADO" : active ? "ATIVO" : config?.kill_switch ? "KILL SWITCH" : "ENTRADAS PAUSADAS"}</span></div>
    <p>Ciclo atual: capital {number(cycle?.capital_usdc ?? config?.capital_usdc, 2)} {data.engineContext?.quote_asset ?? "USDC"} · gain {percent(cycle?.gain_rate ?? config?.gain_rate)}% · queda entre compras {percent(cycle?.entry_spacing ?? config?.entry_spacing)}% · iniciado {date(cycle?.started_at)}.</p>
    <form className="av2-parameters" action={saveRobotV1Parameters} key={config?.id + asset}><EngineScopeFields context={data.engineContext} />
      <input type="hidden" name="asset" value={asset} />
      <label>Capital do próximo ciclo ({data.engineContext?.quote_asset ?? "USDC"})<input name="capital_usdc" type="number" min="0.01" max="2500" step="0.01" defaultValue={Number(config?.next_capital_usdc ?? config?.capital_usdc ?? 250)} required /></label>
      <label>Gain %<input name="gain_percent" type="number" min="0.1" max="20" step="0.1" defaultValue={Number(config?.next_gain_rate ?? config?.gain_rate ?? 0) * 100} required /></label>
      <label>Queda entre compras %<input name="spacing_percent" type="number" min="0.1" max="20" step="0.1" defaultValue={Number(config?.next_entry_spacing ?? config?.entry_spacing ?? 0) * 100} required /></label>
      <button type="submit">Salvar próximo ciclo</button><button type="submit" name="preset" value="quick" formNoValidate>Usar perfil rápido 0,5% / 1%</button>
    </form>
    <small>Gain: percentual de alta necessário para vender uma posição. Queda entre compras: distância entre entradas. O ciclo e os TPs abertos preservam seus parâmetros; alterações entram no próximo ciclo. Estes controles afetam somente o Shadow.</small>
    <div className="av2-control-actions">
      <form action={controlRobotV1Shadow}><EngineScopeFields context={data.engineContext} /><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="start" /><button type="submit" disabled={Boolean(cycle)}>Iniciar Shadow</button></form>
      <form action={controlRobotV1Shadow}><EngineScopeFields context={data.engineContext} /><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value={paused ? "resume" : "pause"} /><button type="submit">{paused ? "Iniciar Shadow" : "Pausar Shadow"}</button></form>
      <form action={controlRobotV1Shadow} onSubmit={confirmKill}><EngineScopeFields context={data.engineContext} /><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="kill" /><button type="submit" className="av2-danger">Kill switch</button></form>
      <form action={controlRobotV1Shadow} className="av2-restart"><EngineScopeFields context={data.engineContext} /><input type="hidden" name="asset" value={asset} /><input type="hidden" name="command" value="restart" /><label><input type="checkbox" name="restart_confirmed" value="yes" required /> Confirmo o reinício virtual e a preservação do histórico.</label><button type="submit">Reiniciar simulação</button></form>
    </div>
  </section>;
}

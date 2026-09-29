"use client";

import { useState } from "react";
import Link from "next/link";
import { PremiumBrand, PremiumDrawer, PremiumIcon, type IconName } from "./premium-primitives";
import "./premium-automation.css";

/** Public structure only. No session/ledger cache and no guessed operational state. */
export function AutomationLoadingShell() {
  const [panel, setPanel] = useState<string | null>(null);
  const open = (name: string) => {
    setPanel(name);
    try { sessionStorage.setItem("coinops.pending-panel", name); } catch { /* storage can be disabled */ }
  };
  const close = () => { setPanel(null); try { sessionStorage.removeItem("coinops.pending-panel"); } catch { /* optional */ } };
  return <div className="px-app px-loading">
    <header className="px-topbar"><PremiumBrand /><span role="status">Atualizando dados…</span></header>
    <nav className="px-toolbar" aria-label="Ferramentas da Automação">
      <button type="button" onClick={close}><PremiumIcon name="home" />Início</button>
      {([ ["strategy", "Estratégia", "strategy"], ["adjust", "Ajustes", "adjustments"], ["settings", "Configurações", "config"] ] as Array<[IconName, string, string]>).map(([icon, label, key]) =>
        <button type="button" key={key} onClick={() => open(key)}><PremiumIcon name={icon} />{label}</button>)}
      <Link href="/custos-operacao"><PremiumIcon name="wallet" />Custos &amp; Operação</Link>
    </nav>
    <main aria-busy="true">
      <p className="px-caption">Confirmando sessão e estado atual. O executor continua independente desta tela.</p>
      <div className="px-loading-bar" aria-hidden="true" />
      <div className="px-loading-hero px-panel" aria-hidden="true"><div className="px-loading-line" /><div className="px-loading-line" /></div>
      <div className="px-loading-grid" aria-hidden="true"><div className="px-panel" /><div className="px-panel" /><div className="px-panel" /></div>
    </main>
    <PremiumDrawer open={panel !== null} title={panel === "strategy" ? "Estratégia" : panel === "adjustments" ? "Ajustes" : "Configurações"} onClose={close}>
      <p role="status">Carregando dados autorizados deste módulo…</p>
    </PremiumDrawer>
  </div>;
}

"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PremiumBrand, PremiumIcon, type IconName } from "./premium-primitives";

const destinations: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/automacao", label: "Automação", icon: "server" },
  { href: "/dashboard", label: "Resumo", icon: "home" },
  { href: "/slots", label: "Slots", icon: "orders" },
  { href: "/plano-crescimento", label: "Plano", icon: "chart" },
  { href: "/historico", label: "Histórico", icon: "orders" },
  { href: "/relatorios", label: "Relatórios", icon: "reports" },
  { href: "/ciclos", label: "Ciclos", icon: "strategy" },
  { href: "/alertas", label: "Alertas", icon: "shield" },
  { href: "/config", label: "Configurações", icon: "settings" },
];

/** A disclosure in document flow: mobile navigation never covers the dashboard. */
export function PremiumGlobalNavigation({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const navigationId = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div ref={root} className="px-global-navigation" onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <header className="px-topbar">
      <button ref={trigger} type="button" className="px-global-trigger px-icon-button"
        aria-label="Navegação do CoinOps" aria-expanded={open} aria-controls={navigationId}
        onClick={() => setOpen((previous) => !previous)}><PremiumIcon name={open ? "close" : "menu"} /></button>
      <PremiumBrand />
      {children}
    </header>
    <nav id={navigationId} className="px-global-links" aria-label="Áreas do CoinOps" hidden={!open}>
      {destinations.map(({ href, label, icon }) => <Link key={href} href={href} prefetch={false}
        aria-current={href === "/automacao" ? "page" : undefined} onClick={() => setOpen(false)}>
        <PremiumIcon name={icon} /><span>{label}</span><PremiumIcon name="arrow" />
      </Link>)}
    </nav>
  </div>;
}

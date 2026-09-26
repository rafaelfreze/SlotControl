"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export type IconName = "home" | "orders" | "strategy" | "simulator" | "adjust" | "reports" | "settings" | "arrow" | "wallet" | "chart" | "shield" | "server" | "menu" | "close";
const paths: Record<IconName, string> = {
  home: "m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9", orders: "M5 4h14v16H5zM8 8h8M8 12h3M14 12h2M8 16h8",
  strategy: "M4 19h16M5 15l4-5 4 2 6-8M4 4v15", simulator: "M4 7h4v12H4zM10 3h4v16h-4zM16 10h4v9h-4z",
  adjust: "M4 7h16M4 17h16M8 4v6M16 14v6", reports: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7",
  settings: "m10 3-1 3-3 1-2 3 2 2v3l3 1 1 3h4l1-3 3-1v-3l2-2-2-3-3-1-1-3zM9 11a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
  arrow: "M4 12h15m-5-5 5 5-5 5", wallet: "M4 6h15v14H4zM4 6V3h12v3M15 11h6v5h-6z",
  chart: "m3 18 6-7 4 3 7-10m-5 0h5v5", shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6",
  server: "M4 4h16v6H4zM4 14h16v6H4zM7 7h1M7 17h1M12 7h5M12 17h5", menu: "M4 6h16M4 12h16M4 18h16", close: "m6 6 12 12M6 18 18 6",
};
export function PremiumIcon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`px-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function PremiumBrand() {
  return <a href="/automacao" className="px-brand" aria-label="CoinOps · Automação"><svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M19 4A16 16 0 1 0 34 15M26 5l8 7-10 1M25 15a8 8 0 1 0 1 11" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg><span><strong>CoinOps</strong><small>Automação cripto · Simples e eficiente</small></span></a>;
}
export function AssetIcon({ asset }: { asset: "BTC" | "SOL" }) {
  return <span className={`px-coin px-coin--${asset.toLowerCase()}`} aria-hidden="true">{asset === "BTC" ? "₿" : <svg viewBox="0 0 32 32"><path d="m8 6-5 5h21l5-5zM3 14l5 5h21l-5-5zM8 22l-5 5h21l5-5z" fill="currentColor" /></svg>}</span>;
}
export function PremiumDrawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => { document.documentElement.style.overflow = previousOverflow; };
  }, [open]);
  return <dialog ref={ref} className="px-drawer" aria-labelledby={titleId} onCancel={onClose} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right) onClose(); } }}>
    <header className="px-drawer-header"><div className="px-drawer-header-top"><PremiumBrand /><button type="button" className="px-icon-button" aria-label="Fechar" onClick={onClose}><PremiumIcon name="close" /></button></div><h2 id={titleId}>{title}</h2></header><div className="px-drawer-body">{children}</div>
  </dialog>;
}
export const displayNumber = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: digits === 2 ? 2 : 0 });
export const displayMoney = (value: number | null | undefined, currency: string) => value == null ? "—" : `${currency === "BRL" ? "R$ " : ""}${displayNumber(value)}${currency === "BRL" ? "" : ` ${currency}`}`;
export const displayTime = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Cuiaba", dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Sem leitura";

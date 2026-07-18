"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

type Tone = "gold" | "purple" | "green" | "red" | "blue" | "neutral";

export function AppHeader({
  title = "SLOTGAIN",
  subtitle = "CONTROL",
  backHref,
  rightHref = "/config"
}: {
  title?: string;
  subtitle?: string;
  backHref?: string;
  rightHref?: string;
}) {
  return (
    <header className="mobile-app-header sg-header">
      <Link className="mobile-icon-button sg-back-button" href={backHref || "/slots"} aria-label={backHref ? "Voltar" : "Abrir menu de slots"}>
        {backHref ? <span className="mobile-icon-glyph">{`\u2039`}</span> : <><span /><span /><span /></>}
      </Link>
      <div className="mobile-brand">
        <span className="mobile-brand-mark">SG</span>
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
      </div>
      <Link className="mobile-icon-button settings-icon" href={rightHref} aria-label="Configuracoes">
        <span className="mobile-icon-glyph">{`\u2699`}</span>
      </Link>
    </header>
  );
}

export function MobileScreen({ children }: { children: ReactNode }) {
  return (
    <div className="app-frame">
      <DesktopSidebar />
      <main className="mobile-dashboard-shell app-screen">{children}</main>
      <BottomNavigation />
    </div>
  );
}

const navigation = [
  { href: "/dashboard", label: "Resumo", icon: "◈" },
  { href: "/slots", label: "Slots", icon: "▦" },
  { href: "/historico", label: "Historico", icon: "◷" },
  { href: "/config", label: "Config", icon: "⚙" }
];

function isCurrent(pathname: string, href: string) {
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
}

export function BottomNavigation() {
  const pathname = usePathname();
  return <nav className="bottom-navigation" aria-label="Navegacao principal">{navigation.map((item) => <Link key={item.href} href={item.href} className={isCurrent(pathname, item.href) ? "active" : ""}><span aria-hidden="true">{item.icon}</span><small>{item.label}</small></Link>)}</nav>;
}

export function DesktopSidebar() {
  const pathname = usePathname();
  return <aside className="desktop-sidebar" aria-label="Navegacao lateral"><Link className="sidebar-brand" href="/dashboard"><b>SG</b><span>SlotGain<small>CONTROL</small></span></Link><nav>{navigation.map((item) => <Link key={item.href} href={item.href} className={isCurrent(pathname, item.href) ? "active" : ""}><span aria-hidden="true">{item.icon}</span>{item.label}</Link>)}</nav></aside>;
}

export function StatCard({ title, value, helper, tone = "neutral" }: { title: string; value: string; helper?: string; tone?: Tone }) {
  return (
    <article className={`mobile-metric-card stat-card ${tone}`}>
      <span className={`metric-icon ${tone}`}>{title.slice(0, 1)}</span>
      <p>{title}</p>
      <strong>{value}</strong>
      {helper ? <em>{helper}</em> : null}
    </article>
  );
}

export function SectionCard({ title, subtitle, children, tone = "neutral" }: { title?: string; subtitle?: string; children: ReactNode; tone?: Tone }) {
  return (
    <section className={`section-card ${tone}`}>
      {title ? (
        <div className="section-card-heading">
          <div>
            <p>{subtitle}</p>
            <h2>{title}</h2>
          </div>
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function ActionButton({
  href,
  onClick,
  title,
  subtitle,
  tone = "neutral",
  type = "button"
}: {
  href?: string;
  onClick?: () => void;
  title: string;
  subtitle?: string;
  tone?: Tone;
  type?: "button" | "submit";
}) {
  const content = (
    <>
      <span className={`action-orb ${tone}`}>{title.slice(0, 1)}</span>
      <span>
        <strong>{title}</strong>
        {subtitle ? <em>{subtitle}</em> : null}
      </span>
      <b>{`\u203A`}</b>
    </>
  );

  if (href) {
    return (
      <Link className="dashboard-action-card" href={href}>
        {content}
      </Link>
    );
  }

  return (
    <button className="dashboard-action-card" type={type} onClick={onClick}>
      {content}
    </button>
  );
}

export function FilterChips<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ label: string; value: T; count?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="filter-chips">
      {options.map((option) => (
        <button key={option.value} type="button" className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>
          {option.label}
          {typeof option.count === "number" ? <strong>{option.count}</strong> : null}
        </button>
      ))}
    </div>
  );
}

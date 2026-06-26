"use client";

import Link from "next/link";
import type { ReactNode } from "react";

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
      <Link className="mobile-icon-button sg-back-button" href={backHref || "/dashboard"} aria-label="Voltar">
        {backHref ? "<" : <><span /><span /><span /></>}
      </Link>
      <div className="mobile-brand">
        <span className="mobile-brand-mark">SG</span>
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
      </div>
      <Link className="mobile-icon-button settings-icon" href={rightHref} aria-label="Configuracoes">
        *
      </Link>
    </header>
  );
}

export function MobileScreen({ children }: { children: ReactNode }) {
  return <main className="mobile-dashboard-shell app-screen">{children}</main>;
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
      <b>›</b>
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

export function ProgressBar({ value, tone = "gold" }: { value: number; tone?: Tone }) {
  return (
    <i className={`sg-progress ${tone}`}>
      <b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </i>
  );
}

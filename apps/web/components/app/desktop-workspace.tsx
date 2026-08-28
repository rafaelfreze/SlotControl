"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import type { OfficialMonitoringOverview } from "@/lib/coinops-monitoring/server";
import { formatPrice } from "@/lib/slotgain/format";

import type { MarketTickerState } from "./mobile-ui";

type DesktopIconName = "dashboard" | "slots" | "plan" | "history" | "reports" | "cycles" | "alerts" | "settings" | "pulse" | "user";
type DesktopNavigationItem = { href: string; label: string; icon: DesktopIconName };

export const desktopNavigation: readonly DesktopNavigationItem[] = [
  { href: "/dashboard", label: "Resumo", icon: "dashboard" },
  { href: "/slots", label: "Slots", icon: "slots" },
  { href: "/plano-crescimento", label: "Plano", icon: "plan" },
  { href: "/historico", label: "Histórico", icon: "history" },
  { href: "/plano-crescimento/relatorios", label: "Relatórios", icon: "reports" },
  { href: "/ciclos", label: "Ciclos", icon: "cycles" },
  { href: "/alertas", label: "Alertas", icon: "alerts" },
  { href: "/config", label: "Configurações", icon: "settings" }
] as const;

export type DesktopWorkspaceProps = {
  title: string;
  subtitle?: string;
  livePrices?: MarketTickerState;
  monitoring?: OfficialMonitoringOverview;
  userLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function DesktopWorkspace({ title, subtitle, livePrices, monitoring, userLabel, actions, children }: DesktopWorkspaceProps) {
  return (
    <div className="desktop-workspace-root">
      <DesktopSidebar livePrices={livePrices} monitoring={monitoring} userLabel={userLabel} />
      <div className="desktop-workspace-main">
        <DesktopTopbar title={title} subtitle={subtitle} livePrices={livePrices} monitoring={monitoring} actions={actions} />
        <main className="desktop-workspace-content">{children}</main>
      </div>
    </div>
  );
}

export function DesktopSidebar({ livePrices, monitoring, userLabel }: Pick<DesktopWorkspaceProps, "livePrices" | "monitoring" | "userLabel">) {
  const pathname = usePathname();
  const activeHref = getActiveNavigationHref(pathname);
  const feed = getFeedState(livePrices);
  const mode = getModePresentation(monitoring);

  return (
    <aside className="desktop-workspace-sidebar" aria-label="Navegação principal do CoinOps">
      <Link className="desktop-sidebar-brand" href="/dashboard" aria-label="CoinOps - Resumo">
        <Image src="/icon-96x96.png" alt="" width={34} height={34} priority />
        <span>COINOPS</span>
      </Link>
      <nav className="desktop-sidebar-nav">
        {desktopNavigation.map((item) => {
          const isActive = item.href === activeHref;
          return (
            <Link key={item.href} href={item.href} className="desktop-sidebar-link" data-active={String(isActive)} aria-current={isActive ? "page" : undefined}>
              <DesktopIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="desktop-sidebar-context" aria-label="Contexto operacional">
        <span className={`desktop-mode-indicator ${mode.tone}`}>{mode.label}</span>
        {monitoring?.cycle ? (
          <small>Ciclo {monitoring.cycle.number}{typeof monitoring.cycle.days_remaining === "number" ? ` · ${monitoring.cycle.days_remaining} dias restantes` : ""}</small>
        ) : <small>Monitoramento oficial</small>}
      </div>
      <footer className="desktop-sidebar-footer">
        <div className="desktop-feed-status" data-tone={feed.tone} role="status">
          <DesktopIcon name="pulse" />
          <span><small>Conexão</small><strong>{feed.label}</strong></span>
        </div>
        {userLabel ? (
          <div className="desktop-user-summary">
            <DesktopIcon name="user" />
            <span><small>Sessão</small><strong>{userLabel}</strong></span>
          </div>
        ) : null}
      </footer>
    </aside>
  );
}

export function DesktopTopbar({ title, subtitle, livePrices, monitoring, actions }: Pick<DesktopWorkspaceProps, "title" | "subtitle" | "livePrices" | "monitoring" | "actions">) {
  const mode = getModePresentation(monitoring);
  return (
    <header className="desktop-workspace-topbar">
      <div className="desktop-topbar-heading">
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div className="desktop-topbar-context">
        {livePrices ? (
          <div className="desktop-topbar-prices" aria-label="Cotações atuais">
            <span>BTC <strong>{formatPrice(livePrices.prices.BTC)}</strong></span>
            <span>SOL <strong>{formatPrice(livePrices.prices.SOL)}</strong></span>
          </div>
        ) : null}
        {monitoring?.cycle ? <span className="desktop-context-chip">Ciclo {monitoring.cycle.number}</span> : null}
        {monitoring?.active ? <span className={`desktop-context-chip ${mode.tone}`}>{mode.label}</span> : null}
        {livePrices ? <span className="desktop-topbar-updated">Atualizado <strong>{formatUpdatedAt(livePrices.lastUpdated)}</strong></span> : null}
        {actions ? <div className="desktop-topbar-actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function DesktopPanel({ title, eyebrow, actions, className = "", children }: { title?: string; eyebrow?: string; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`desktop-panel ${className}`.trim()}>
      {title || eyebrow || actions ? (
        <div className="desktop-panel-heading">
          <div>{eyebrow ? <span>{eyebrow}</span> : null}{title ? <h2>{title}</h2> : null}</div>
          {actions ? <div className="desktop-panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function DesktopKpiCard({ label, value, helper, icon, tone = "neutral", children }: { label: string; value: ReactNode; helper?: ReactNode; icon?: ReactNode; tone?: "neutral" | "gold" | "positive" | "negative" | "btc" | "sol" | "info"; children?: ReactNode }) {
  return (
    <article className="desktop-kpi" data-tone={tone}>
      <div className="desktop-kpi-heading"><span>{label}</span>{icon ? <i aria-hidden="true">{icon}</i> : null}</div>
      <strong>{value}</strong>
      {helper ? <small>{helper}</small> : null}
      {children}
    </article>
  );
}

export function DesktopEmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="desktop-empty-state"><strong>{title}</strong>{children ? <span>{children}</span> : null}</div>;
}

function getActiveNavigationHref(pathname: string) {
  return desktopNavigation
    .filter((item) => pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`)))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
}

function getModePresentation(monitoring?: OfficialMonitoringOverview) {
  if (!monitoring?.active) return { label: "Aguardando baseline", tone: "neutral" };
  if (monitoring.strategy?.mode === "DEFENSIVE_POST_ATH") return { label: "Defensivo", tone: "defensive" };
  return { label: "Normal", tone: "normal" };
}

function getFeedState(livePrices?: MarketTickerState) {
  if (!livePrices) return { label: "Sem cotação", tone: "neutral" };
  if (livePrices.status === "online" && !livePrices.isStale) return { label: "Feed online", tone: "online" };
  if (livePrices.isStale) return { label: "Feed desatualizado", tone: "stale" };
  if (livePrices.status === "loading") return { label: "Conectando", tone: "loading" };
  return { label: "Feed offline", tone: "offline" };
}

function formatUpdatedAt(value?: Date | null) {
  if (!value || Number.isNaN(value.getTime())) return "--:--";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

const desktopIconPaths: Record<DesktopIconName, string> = {
  dashboard: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  slots: "M5 3h14v18H5zM8 7h8M8 12h8M8 17h5",
  plan: "m4 19 6-6 4 3 6-9M15 7h5v5",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  reports: "M5 3h10l4 4v14H5zM15 3v5h4M8 17v-4M12 17V9M16 17v-6",
  cycles: "M20 7h-5V2M20 7a8 8 0 1 0 1 8",
  alerts: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12l2-1-2-4-2 1-2-1-1-3h-4L9 7 7 8 5 7l-2 4 2 1v2l-2 1 2 4 2-1 2 1 1 3h4l1-3 2-1 2 1 2-4-2-1Z",
  pulse: "M3 12h4l2-5 4 10 2-5h6",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0"
};

function DesktopIcon({ name }: { name: DesktopIconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={desktopIconPaths[name]} /></svg>;
}

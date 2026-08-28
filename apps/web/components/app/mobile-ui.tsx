"use client";

import Link from "next/link";
import Image from "next/image";
import type { FormEvent, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { usePathname } from "next/navigation";
import { getFinancialValueTone } from "@/lib/slotgain/financial-tone";
import { formatPrice } from "@/lib/slotgain/format";

type Tone = "gold" | "purple" | "green" | "red" | "blue" | "neutral";

export function AppHeader({
  title,
  backHref = "/dashboard",
  action
}: {
  title: string;
  backHref?: string;
  action?: ReactNode;
}) {
  return (
    <header className="minimal-page-header">
      <Link className="minimal-page-header-back" href={backHref} aria-label="Voltar">
        {`\u2039`}
      </Link>
      <h1>{title}</h1>
      <div className="minimal-page-header-action">{action}</div>
    </header>
  );
}

export function MobileScreen({ children, desktop }: { children: ReactNode; desktop?: ReactNode }) {
  return (
    <div className={`app-frame${desktop ? " has-desktop-workspace" : ""}`}>
      <DesktopSidebar />
      <main className="mobile-dashboard-shell app-screen">{children}</main>
      <BottomNavigation />
      {desktop ? <div className="desktop-workspace-slot">{desktop}</div> : null}
    </div>
  );
}

export function BrandHeader({ compact = false }: { compact?: boolean }) {
  return (
    <header className={`app-brand-header${compact ? " compact" : ""}`} aria-label="CoinOps">
      <Image src="/icon-96x96.png" alt="" width={26} height={26} priority />
      <span>COINOPS</span>
    </header>
  );
}

export type MarketTickerState = {
  prices: Partial<Record<"BTC" | "SOL", number>>;
  lastUpdated: Date | null;
  status: "online" | "offline" | "loading";
  isStale: boolean;
};

export function MarketTicker({ livePrices, className = "" }: { livePrices: MarketTickerState; className?: string }) {
  const status = livePrices.status === "online" ? "ONLINE" : livePrices.isStale ? "ATUALIZANDO" : "OFFLINE";
  const updatedAt = livePrices.lastUpdated
    ? new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(livePrices.lastUpdated)
    : "--:--";

  return (
    <section className={`market-ticker ${livePrices.status} ${className}`.trim()} aria-label="Cotações em tempo real">
      <TickerCell label="BTCUSDT" value={formatPrice(livePrices.prices.BTC)} />
      <TickerCell label="SOLUSDT" value={formatPrice(livePrices.prices.SOL)} />
      <TickerCell label={status} value={updatedAt} online />
    </section>
  );
}

function TickerCell({ label, value, online = false }: { label: string; value: string; online?: boolean }) {
  return <div className={online ? "online" : undefined}><span>{label}</span><strong>{value}</strong></div>;
}

const navigation = [
  { href: "/dashboard", label: "Resumo", icon: "◈" },
  { href: "/slots", label: "Slots", icon: "▦" },
  { href: "/plano-crescimento", label: "Plano", icon: "↗" },
  { href: "/historico", label: "Histórico", icon: "◷" },
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
  return <aside className="desktop-sidebar" aria-label="Navegacao lateral"><Link className="sidebar-brand" href="/dashboard"><Image src="/icon-96x96.png" alt="CoinOps" width={34} height={34} priority /><span>CoinOps<small>OPERACOES EM CRIPTO</small></span></Link><nav>{navigation.map((item) => <Link key={item.href} href={item.href} className={isCurrent(pathname, item.href) ? "active" : ""}><span aria-hidden="true">{item.icon}</span>{item.label}</Link>)}</nav></aside>;
}

export function StatCard({ title, value, helper, tone = "neutral", financialValue }: { title: string; value: string; helper?: string; tone?: Tone; financialValue?: number }) {
  return (
    <article className={`mobile-metric-card stat-card ${tone}`}>
      <span className={`metric-icon ${tone}`}>{title.slice(0, 1)}</span>
      <p>{title}</p>
      <strong className={financialValue === undefined ? undefined : `financial-${getFinancialValueTone(financialValue)}`}>{value}</strong>
      {helper ? <em>{helper}</em> : null}
    </article>
  );
}

export function SectionCard({ title, subtitle, children, tone = "neutral", className = "" }: { title?: string; subtitle?: string; children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <section className={`section-card ${tone} ${className}`.trim()}>
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

export function SectionHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return (
    <div className="compact-section-header">
      <div>{eyebrow ? <span>{eyebrow}</span> : null}<h2>{title}</h2></div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const isOpen = status.toLowerCase() === "aberto" || status.toLowerCase() === "open";
  return <span className={`status-badge ${isOpen ? "open" : "free"}`}>{isOpen ? "OPEN" : "LIVRE"}</span>;
}

export function PnLValue({ value, children }: { value: number; children: ReactNode }) {
  return <strong className={`pnl-value financial-${getFinancialValueTone(value)}`}>{children}</strong>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="compact-empty-state">{children}</div>;
}

export function SlotActionForm({
  action,
  slotId,
  label,
  pendingLabel,
  className = "",
  buttonClassName = "",
  disabled = false,
  hidden,
  onSubmit
}: {
  action: (formData: FormData) => void | Promise<void>;
  slotId: string;
  label: string;
  pendingLabel?: string;
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
  hidden?: Record<string, string>;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className={className} action={action} onSubmit={onSubmit}>
      <input type="hidden" name="slotId" value={slotId} />
      {hidden ? Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />) : null}
      <SlotSubmitButton
        className={buttonClassName}
        disabled={disabled}
        label={label}
        pendingLabel={pendingLabel || `${label}...`}
      />
    </form>
  );
}

function SlotSubmitButton({ className, disabled, label, pendingLabel }: { className: string; disabled: boolean; label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button className={className} type="submit" disabled={disabled || pending} aria-busy={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

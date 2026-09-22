"use client";

import type { ReactNode } from "react";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import { MarketTicker, MobileScreen } from "@/components/app/mobile-ui";
import { useLivePrices } from "@/lib/slotgain/live-prices";
import { AutomationStatusStrip, type AutomationStatus } from "./automation-cockpit";

export function AutomationPageShell({ userLabel, children, status }: { userLabel: string; children: ReactNode; status: AutomationStatus }) {
  const livePrices = useLivePrices();

  return (
    <MobileScreen desktop={
      <DesktopWorkspace title="Automação" userLabel={userLabel} livePrices={livePrices} center={<AutomationStatusStrip status={status} />}>
        {children}
      </DesktopWorkspace>
    }>
      <header className="cp-mobile-topbar"><div><strong>CoinOps · Automação</strong><a href="/mais" aria-label="Abrir menu">☰</a></div><MarketTicker livePrices={livePrices} /><AutomationStatusStrip status={status} /></header>
      {children}
    </MobileScreen>
  );
}

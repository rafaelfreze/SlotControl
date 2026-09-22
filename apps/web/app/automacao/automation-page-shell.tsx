"use client";

import type { ReactNode } from "react";

import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import { MarketTicker, MobileScreen } from "@/components/app/mobile-ui";
import { useLivePrices } from "@/lib/slotgain/live-prices";

export function AutomationPageShell({ userLabel, children }: { userLabel: string; children: ReactNode }) {
  const livePrices = useLivePrices();

  return (
    <MobileScreen desktop={
      <DesktopWorkspace title="Automação — Seu robô CoinOps" subtitle="Mercado real e simulado, com execução segura em etapas." userLabel={userLabel} livePrices={livePrices}>
        {children}
      </DesktopWorkspace>
    }>
      <div className="ac-mobile-live-prices"><MarketTicker livePrices={livePrices} /></div>
      {children}
    </MobileScreen>
  );
}

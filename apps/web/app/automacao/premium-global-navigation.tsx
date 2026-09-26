"use client";

import { type ReactNode } from "react";
import { PremiumBrand } from "./premium-primitives";

/** The Automation toolbar owns navigation; legacy destinations stay hidden. */
export function PremiumGlobalNavigation({ children }: { children: ReactNode }) {
  return <div className="px-global-navigation">
    <header className="px-topbar">
      <PremiumBrand />
      {children}
    </header>
  </div>;
}

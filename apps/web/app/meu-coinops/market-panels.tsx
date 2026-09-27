"use client";

import { useId, useState, type ReactNode } from "react";

type MarketPanel = "details" | "ranking";

/** Read-only presentation: opening either panel never refreshes balances or trading state. */
export function ViewerMarketPanels({ market, details, ranking }: {
  market: string; details: ReactNode; ranking: ReactNode;
}) {
  const id = useId();
  const [openPanel, setOpenPanel] = useState<MarketPanel | null>(null);
  const toggle = (panel: MarketPanel) => setOpenPanel((current) => current === panel ? null : panel);
  return <div className="viewer-market-panels">
    <div className="viewer-market-actions" aria-label={`Informações de ${market}`}>
      <button type="button" id={`${id}-details-button`} aria-expanded={openPanel === "details"}
        aria-controls={`${id}-details`} onClick={() => toggle("details")}>Ver detalhes <span aria-hidden="true">{openPanel === "details" ? "−" : "+"}</span></button>
      <button type="button" id={`${id}-ranking-button`} aria-expanded={openPanel === "ranking"}
        aria-controls={`${id}-ranking`} onClick={() => toggle("ranking")}>Ver ranking <span aria-hidden="true">{openPanel === "ranking" ? "−" : "+"}</span></button>
    </div>
    <div className="viewer-market-panel" id={`${id}-details`} role="region"
      aria-labelledby={`${id}-details-button`} hidden={openPanel !== "details"}>{details}</div>
    <div className="viewer-market-panel" id={`${id}-ranking`} role="region"
      aria-labelledby={`${id}-ranking-button`} hidden={openPanel !== "ranking"}>{ranking}</div>
  </div>;
}

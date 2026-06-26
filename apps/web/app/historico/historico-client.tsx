"use client";

import { useMemo, useState } from "react";

import { AppHeader, FilterChips, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { formatDate } from "@/lib/slotgain/format";
import type { HistoryEvent } from "@/lib/slotgain/types";

type AssetFilter = "ALL" | "BTC" | "SOL";
type ActionFilter = "all" | "abertura" | "gain" | "redistribuicao" | "zerar";

export function HistoricoClient({ userEmail, history, error }: { userEmail: string; history: HistoryEvent[]; error: string | null }) {
  const [asset, setAsset] = useState<AssetFilter>("ALL");
  const [action, setAction] = useState<ActionFilter>("all");

  const filtered = useMemo(
    () =>
      history.filter((item) => {
        const key = (item.strategy?.asset || item.strategy_key || "").toUpperCase();
        const actionKey = item.action.toLowerCase();
        const assetOk = asset === "ALL" || key === asset;
        const actionOk =
          action === "all" ||
          (action === "abertura" && actionKey.includes("abertura")) ||
          (action === "gain" && actionKey.includes("gain")) ||
          (action === "redistribuicao" && actionKey.includes("redistribu")) ||
          (action === "zerar" && actionKey.includes("zerar"));
        return assetOk && actionOk;
      }),
    [asset, action, history]
  );

  return (
    <MobileScreen>
      <AppHeader title="HISTORICO" subtitle={userEmail} backHref="/dashboard" />
      {error ? <section className="inline-alert dashboard-alert">Falha ao carregar historico: {error}</section> : null}
      <FilterChips
        value={asset}
        onChange={setAsset}
        options={[
          { label: "BTC", value: "BTC", count: history.filter((item) => (item.strategy?.asset || item.strategy_key)?.toUpperCase() === "BTC").length },
          { label: "SOL", value: "SOL", count: history.filter((item) => (item.strategy?.asset || item.strategy_key)?.toUpperCase() === "SOL").length },
          { label: "Todos", value: "ALL", count: history.length }
        ]}
      />
      <FilterChips
        value={action}
        onChange={setAction}
        options={[
          { label: "Abertura", value: "abertura" },
          { label: "Gain", value: "gain" },
          { label: "Redistrib.", value: "redistribuicao" },
          { label: "Zeragem", value: "zerar" },
          { label: "Todos", value: "all" }
        ]}
      />
      <SectionCard title="Operacoes" subtitle={`${filtered.length} eventos`} tone="blue">
        <div className="timeline-list">
          {filtered.map((item) => {
            const itemAsset = (item.strategy?.asset || item.strategy_key || "SG").toUpperCase();
            return (
              <article key={item.id} className={`timeline-item ${itemAsset === "SOL" ? "purple" : "gold"}`}>
                <span>{itemAsset}</span>
                <div>
                  <strong>{item.action}</strong>
                  <p>{item.detail || "Registro criado no Supabase."}</p>
                  <small>
                    {formatDate(item.event_at)}
                    {item.slot_number ? ` | Slot #${item.slot_number}` : ""}
                  </small>
                </div>
              </article>
            );
          })}
          {filtered.length === 0 ? <p className="empty-copy padded-empty">Nenhum evento neste filtro.</p> : null}
        </div>
      </SectionCard>
    </MobileScreen>
  );
}

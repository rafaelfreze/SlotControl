"use client";

import { useFormStatus } from "react-dom";

import { AppHeader, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { formatDate, formatUsdt } from "@/lib/slotgain/format";
import { saveGrowthPlanStartDate } from "./actions";
import { AssetLadderSection, type AssetLadderPlanResponse, type AssetPlanActionKeys } from "./btc-ladder-section";

type GrowthAsset = "BTC" | "SOL";

export type ProgrammedGrowthAssetPlan = {
  asset: GrowthAsset;
  monthly_goal: number;
  cumulative_goal: number;
  month_number: number;
  cycle_days?: number;
  leader_slot_id: string | null;
  leader_slot_number: number | null;
  leader_display_rank: number | null;
  leader_status: string | null;
  leader_gains: number | null;
  leader_real_gains: number | null;
  leader_added_gains: number | null;
  missing_gains: number | null;
};

export type ProgrammedGrowthPlanResponse = {
  ok: boolean;
  code?: string;
  started_at?: string;
  month_number?: number;
  elapsed_days?: number;
  cycle_days?: number;
  btc_monthly_goal?: number;
  sol_monthly_goal?: number;
  plans?: Partial<Record<GrowthAsset, ProgrammedGrowthAssetPlan>>;
};

export type GrowthContributionHistoryItem = {
  id: string;
  asset: GrowthAsset;
  month_number: number;
  cumulative_goal: number;
  slot_number: number;
  gains_before: number;
  gains_after: number;
  value_before: number | string;
  value_after: number | string;
  contributed_amount: number | string;
  note: string | null;
  created_at: string;
};

export function GrowthPlanClient({ plan, btcLadder, solLadder, history, setupError, initialNotice, initialNoticeTone, btcActionKeys, solActionKeys }: { plan: ProgrammedGrowthPlanResponse; btcLadder: AssetLadderPlanResponse; solLadder: AssetLadderPlanResponse; history: GrowthContributionHistoryItem[]; setupError: string | null; initialNotice: string | null; initialNoticeTone: "success" | "error"; btcActionKeys: AssetPlanActionKeys; solActionKeys: AssetPlanActionKeys }) {
  const notice = initialNotice;
  const noticeTone = initialNoticeTone;

  return (
    <MobileScreen>
      <AppHeader title="Plano de Crescimento" backHref="/dashboard" />
      {setupError || !plan.ok ? <section className="inline-alert dashboard-alert">Falha ao carregar o plano: {setupError || plan.code || "dados indisponíveis"}</section> : null}
      {notice ? <section className={`${noticeTone === "error" ? "inline-alert" : "form-success"} dashboard-notice`} role="status">{notice}</section> : null}

      <div id="inicio-operacao">
        <SectionCard
          className="growth-start-card"
          title="Início da operação"
          subtitle={`${plan.elapsed_days ?? 0} ${(plan.elapsed_days ?? 0) === 1 ? "dia contabilizado" : "dias contabilizados"} · base dos ciclos de 30 dias`}
          tone="neutral"
        >
          <form action={saveGrowthPlanStartDate} className="growth-start-form">
            <label>Data em que começou a operar
              <input name="startedAt" type="date" defaultValue={plan.started_at?.slice(0, 10) || ""} required />
            </label>
            <GrowthStartSubmitButton />
          </form>
          <p className="btc-ladder-help">A data recalcula apenas o calendário dos ciclos BTC e SOL. Gains, valores, posições e histórico financeiro não são alterados.</p>
        </SectionCard>
      </div>

      <AssetLadderSection asset="BTC" plan={btcLadder} actionKeys={btcActionKeys} />
      <AssetLadderSection asset="SOL" plan={solLadder} actionKeys={solActionKeys} />

      <SectionCard title="Histórico financeiro anterior" subtitle="Somente leitura" tone="neutral">
        <div className="growth-history-list">
          {history.map((item) => (
            <article className="growth-history-item" key={item.id}>
              <div><strong>{item.asset} · Mês {item.month_number}</strong><small>{formatDate(item.created_at)}</small></div>
              <span>Meta {item.cumulative_goal} · Slot #{item.slot_number}</span>
              <span>Gains {item.gains_before} → {item.gains_after}</span>
              <span>Valor {formatUsdt(Number(item.value_before))} → {formatUsdt(Number(item.value_after))}</span>
              <strong>{formatUsdt(Number(item.contributed_amount))} aportados</strong>
              {item.note ? <p>{item.note}</p> : null}
            </article>
          ))}
          {!history.length ? <p className="empty-copy padded-empty">Nenhum aporte financeiro anterior foi registrado.</p> : null}
        </div>
      </SectionCard>
    </MobileScreen>
  );
}

function GrowthStartSubmitButton() {
  const { pending } = useFormStatus();
  return <button className="btc-ladder-button neutral" type="submit" disabled={pending}>{pending ? "Salvando..." : "Salvar data"}</button>;
}

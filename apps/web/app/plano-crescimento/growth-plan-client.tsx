"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { saveGrowthPlanSettings } from "@/app/dashboard/actions";
import { AppHeader, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { formatDate, formatUsdt } from "@/lib/slotgain/format";

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

export function GrowthPlanClient({ plan, history, setupError }: { plan: ProgrammedGrowthPlanResponse; history: GrowthContributionHistoryItem[]; setupError: string | null }) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [btcGoal, setBtcGoal] = useState(String(plan.btc_monthly_goal || 7));
  const [solGoal, setSolGoal] = useState(String(plan.sol_monthly_goal || 1));
  const [isPending, startTransition] = useTransition();

  function saveGoals() {
    startTransition(async () => {
      try {
        const result = await saveGrowthPlanSettings({ btcMonthlyGoal: Number(btcGoal), solMonthlyGoal: Number(solGoal) });
        setBtcGoal(String(result.btcMonthlyGoal));
        setSolGoal(String(result.solMonthlyGoal));
        setNotice("Metas mensais salvas. A meta acumulada segue o mês atual do plano.");
        router.refresh();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Não foi possível salvar as metas.");
      }
    });
  }

  const btc = plan.plans?.BTC;
  const sol = plan.plans?.SOL;

  return (
    <MobileScreen>
      <AppHeader title="Plano de Crescimento" backHref="/dashboard" />
      {setupError || !plan.ok ? <section className="inline-alert dashboard-alert">Falha ao carregar o plano: {setupError || plan.code || "dados indisponíveis"}</section> : null}
      {notice ? <section className="form-success dashboard-notice" role="status">{notice}</section> : null}

      <SectionCard title="Crescimento programado" subtitle={`${plan.elapsed_days ?? 0} ${(plan.elapsed_days ?? 0) === 1 ? "dia" : "dias"} em operação · meta atual: ${plan.cycle_days ?? 30} dias`} tone="green">
        <p className="growth-plan-intro">A meta é cumprida ao adicionar gains somente em slots fechados. Gains reais, valores e histórico financeiro permanecem preservados.</p>
        <div className="growth-goal-grid">
          <label>Meta BTC mensal<input value={btcGoal} min="1" max="1000" step="1" inputMode="numeric" type="number" disabled={isPending} onChange={(event) => setBtcGoal(event.target.value)} /></label>
          <label>Meta SOL mensal<input value={solGoal} min="1" max="1000" step="1" inputMode="numeric" type="number" disabled={isPending} onChange={(event) => setSolGoal(event.target.value)} /></label>
        </div>
        <button className="ghost-button compact-action" type="button" disabled={isPending} onClick={saveGoals}>Salvar metas</button>
      </SectionCard>

      <GrowthAssetCard asset="BTC" plan={btc} />
      <GrowthAssetCard asset="SOL" plan={sol} />

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

function GrowthAssetCard({ asset, plan }: { asset: GrowthAsset; plan?: ProgrammedGrowthAssetPlan }) {
  return (
    <SectionCard title={`Plano ${asset}`} subtitle={`Meta acumulada: ${plan?.cumulative_goal ?? "--"} gains`} tone={asset === "BTC" ? "gold" : "purple"}>
      <div className="growth-plan-metrics">
        <div><span>Ciclo de meta</span><strong>{plan?.cycle_days ?? "--"} dias</strong></div>
        <div><span>Meta mensal</span><strong>{plan?.monthly_goal ?? "--"} gains</strong></div>
        <div><span>Fechado líder</span><strong>{plan?.leader_display_rank ? `#${plan.leader_display_rank}` : "Nenhum fechado"}</strong></div>
        <div><span>Gains totais</span><strong>{plan?.leader_gains ?? "--"}</strong></div>
        <div><span>Gains reais</span><strong>{plan?.leader_real_gains ?? "--"}</strong></div>
        <div><span>Gains adicionados</span><strong>{plan?.leader_added_gains ?? "--"}</strong></div>
        <div><span>Gains faltantes</span><strong>{plan?.missing_gains ?? "--"}</strong></div>
      </div>
      {!plan?.leader_slot_id ? <p className="settings-hint">Não há slot fechado elegível. Slots abertos e em espera nunca recebem gains adicionados.</p> : null}
      {plan?.leader_slot_id && !plan.missing_gains ? <p className="settings-hint">A meta acumulada já foi atingida.</p> : null}
      {plan?.leader_slot_id && plan.missing_gains ? <p className="settings-hint">Faltam {plan.missing_gains} gains. Abra o Fechado #{plan.leader_display_rank} em Slots e edite “Adicionar gains”.</p> : null}
    </SectionCard>
  );
}

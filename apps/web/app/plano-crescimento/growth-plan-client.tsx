"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { applyProgrammedGrowthContribution, saveGrowthPlanSettings } from "@/app/dashboard/actions";
import { AppHeader, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { formatDate, formatUsdt } from "@/lib/slotgain/format";

type GrowthAsset = "BTC" | "SOL";

export type ProgrammedGrowthAssetPlan = {
  asset: GrowthAsset;
  monthly_goal: number;
  cumulative_goal: number;
  month_number: number;
  leader_slot_id: string | null;
  leader_slot_number: number | null;
  leader_status: string | null;
  leader_gains: number | null;
  leader_value: number | string | null;
  missing_gains: number | null;
  required_contribution: number | string;
  already_applied: boolean;
};

export type ProgrammedGrowthPlanResponse = {
  ok: boolean;
  code?: string;
  started_at?: string;
  month_number?: number;
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
  const [notes, setNotes] = useState<Record<GrowthAsset, string>>({ BTC: "", SOL: "" });
  const [btcGoal, setBtcGoal] = useState(String(plan.btc_monthly_goal || 7));
  const [solGoal, setSolGoal] = useState(String(plan.sol_monthly_goal || 1));
  const [isPending, startTransition] = useTransition();

  function apply(asset: GrowthAsset) {
    startTransition(async () => {
      try {
        const result = await applyProgrammedGrowthContribution({ asset, note: notes[asset] });
        setNotice(result.message || (result.ok ? "Aporte programado aplicado com sucesso." : "Não foi possível aplicar o aporte."));
        if (result.ok) {
          setNotes((current) => ({ ...current, [asset]: "" }));
          router.refresh();
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Não foi possível aplicar o aporte.");
      }
    });
  }

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

      <SectionCard title="Crescimento programado" subtitle={`Mês atual ${plan.month_number || 1}`} tone="green">
        <p className="growth-plan-intro">Aportes são externos, aplicados somente em slots fechados. Nenhum gain, lucro histórico ou patrimônio de outro slot é movido.</p>
        <div className="growth-goal-grid">
          <label>Meta BTC mensal<input value={btcGoal} min="1" max="1000" step="1" inputMode="numeric" type="number" disabled={isPending} onChange={(event) => setBtcGoal(event.target.value)} /></label>
          <label>Meta SOL mensal<input value={solGoal} min="1" max="1000" step="1" inputMode="numeric" type="number" disabled={isPending} onChange={(event) => setSolGoal(event.target.value)} /></label>
        </div>
        <button className="ghost-button compact-action" type="button" disabled={isPending} onClick={saveGoals}>Salvar metas</button>
      </SectionCard>

      <GrowthAssetCard asset="BTC" plan={btc} note={notes.BTC} disabled={isPending} onNoteChange={(value) => setNotes((current) => ({ ...current, BTC: value }))} onApply={() => apply("BTC")} />
      <GrowthAssetCard asset="SOL" plan={sol} note={notes.SOL} disabled={isPending} onNoteChange={(value) => setNotes((current) => ({ ...current, SOL: value }))} onApply={() => apply("SOL")} />

      <SectionCard title="Histórico de aportes" subtitle="Imutável" tone="neutral">
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
          {!history.length ? <p className="empty-copy padded-empty">Nenhum aporte programado foi aplicado ainda.</p> : null}
        </div>
      </SectionCard>
    </MobileScreen>
  );
}

function GrowthAssetCard({ asset, plan, note, disabled, onNoteChange, onApply }: { asset: GrowthAsset; plan?: ProgrammedGrowthAssetPlan; note: string; disabled: boolean; onNoteChange: (value: string) => void; onApply: () => void }) {
  const required = Number(plan?.required_contribution || 0);
  const canApply = Boolean(plan?.leader_slot_id && plan.missing_gains && required > 0 && !plan.already_applied);

  return (
    <SectionCard title={`Plano ${asset}`} subtitle={`Meta acumulada: ${plan?.cumulative_goal ?? "--"} gains`} tone={asset === "BTC" ? "gold" : "purple"}>
      <div className="growth-plan-metrics">
        <div><span>Mês</span><strong>{plan?.month_number ?? "--"}</strong></div>
        <div><span>Meta mensal</span><strong>{plan?.monthly_goal ?? "--"} gains</strong></div>
        <div><span>Slot líder</span><strong>{plan?.leader_slot_number ? `#${plan.leader_slot_number}` : "Nenhum fechado"}</strong></div>
        <div><span>Gains atuais</span><strong>{plan?.leader_gains ?? "--"}</strong></div>
        <div><span>Gains faltantes</span><strong>{plan?.missing_gains ?? "--"}</strong></div>
        <div><span>Aporte necessário</span><strong>{formatUsdt(required)}</strong></div>
      </div>
      {plan?.already_applied ? <p className="settings-hint">O aporte deste ativo já foi aplicado no mês atual.</p> : null}
      {!plan?.leader_slot_id ? <p className="settings-hint">Não há slot fechado elegível. Slots abertos e em espera não recebem aporte.</p> : null}
      {plan?.leader_slot_id && !plan.missing_gains ? <p className="settings-hint">A meta acumulada já foi atingida; nenhum aporte é necessário.</p> : null}
      <label className="growth-note">Observação opcional<textarea value={note} maxLength={500} disabled={disabled || !canApply} onChange={(event) => onNoteChange(event.target.value)} placeholder="Origem ou observação do aporte" /></label>
      <button className="solid-button" type="button" disabled={disabled || !canApply} onClick={onApply}>Aplicar aporte</button>
    </SectionCard>
  );
}

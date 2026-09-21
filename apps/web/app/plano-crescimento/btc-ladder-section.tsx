"use client";

import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { SectionCard } from "@/components/app/mobile-ui";
import { formatDate } from "@/lib/slotgain/format";
import { summarizeCapitalContributions, type CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import { getLeaderGrowthTarget } from "@/lib/slotgain/growth-target";
import {
  applyAssetExternalBalance,
  applyAssetManualOperationalGains,
  cancelAssetManualOperationalGainsBatch,
  confirmAssetManualOperationalGainsBatch,
  prepareAssetManualOperationalGainsBatch,
  saveAssetGrowthConfig,
  type GrowthAsset
} from "./actions";

type Numeric = number | string;

export type AssetLadderSlotItem = {
  rank: number;
  slot_id: string;
  slot_number: number;
  status: string;
  real_gains: Numeric;
  operational_gains: Numeric;
  operational_value_usdt: Numeric;
  gain_unit_usdt?: Numeric;
  reference_difference_gains?: Numeric;
  excess_gains?: Numeric;
  deficit_gains?: Numeric;
};

export type AssetRedistributionTransferItem = {
  id?: string;
  sequence_number?: number;
  donor_slot_id?: string;
  receiver_slot_id?: string;
  donor_slot_number: number;
  receiver_slot_number: number;
  donor_status: string;
  receiver_status: string;
  donor_gain_equivalent: Numeric;
  receiver_gain_equivalent: Numeric;
  amount_usdt: Numeric;
  donor_operational_before?: Numeric;
  donor_operational_after?: Numeric;
  receiver_operational_before?: Numeric;
  receiver_operational_after?: Numeric;
};

export type AssetRedistributionPreview = {
  batch_id: string;
  status: string;
  snapshot_hash?: string;
  reference_level: Numeric;
  equity_before_usdt: Numeric;
  equity_after_usdt: Numeric;
  equity_difference_usdt: Numeric;
  total_transferred_usdt: Numeric;
  transfer_count?: number;
  ranking_before: AssetLadderSlotItem[];
  ranking_after: AssetLadderSlotItem[];
  transfers: AssetRedistributionTransferItem[];
};

export type AssetRedistributionBatchHistory = {
  batch_id: string;
  status: string;
  month_reference: string;
  reference_level: Numeric;
  total_transferred_usdt: Numeric;
  transfer_count: number;
  created_at: string;
  created_by?: string | null;
  confirmed_by?: string | null;
  completed_at?: string | null;
  transfers?: AssetRedistributionTransferItem[];
};

export type AssetExternalContributionHistory = {
  id: string;
  asset?: GrowthAsset;
  slot_id?: string;
  slot_number: number;
  amount_usdt: Numeric;
  accounting_amount_usdt?: Numeric | null;
  gain_equivalent: Numeric;
  input_mode?: "MANUAL_GAINS" | "USDT" | null;
  incorporated_in_opening?: boolean;
  source?: "CONTRIBUTION" | "SLOT_INITIAL_CAPITAL";
  operational_before?: Numeric;
  operational_after?: Numeric;
  reason: string;
  applied_by?: string | null;
  created_at: string;
  bulk_batch_id?: string | null;
  bulk_sequence?: number | null;
  bulk_slot_count?: number | null;
  bulk_total_amount_usdt?: Numeric | null;
  bulk_amount_per_slot_usdt?: Numeric | null;
  bulk_open_slot_count?: number | null;
};

export type AssetManualOperationalGainBatchItem = {
  slot_id: string;
  slot_number: number;
  status: string;
  operational_before: Numeric;
  operational_after: Numeric;
  value_before: Numeric;
  value_after: Numeric;
  amount_usdt: Numeric;
};

export type AssetManualOperationalGainBatchPreview = {
  batch_id: string;
  status: string;
  below_operational_gains: Numeric;
  operational_gains_per_slot: Numeric;
  slot_count: number;
  open_slot_count: number;
  total_amount_usdt: Numeric;
  operational_total_before: Numeric;
  operational_total_after: Numeric;
  items: AssetManualOperationalGainBatchItem[];
  expires_at: string;
  reason: string;
  created_at: string;
};

export type AssetLadderPlanResponse = {
  ok: boolean;
  asset?: GrowthAsset;
  code?: string;
  message?: string;
  monthly_goal?: number;
  started_at?: string;
  elapsed_days?: number;
  cycle_days?: number;
  month_reference?: string;
  cycle_number?: number;
  real_gains_month?: Numeric;
  real_gains_month_source?: string;
  reference_level?: Numeric | null;
  suggested_reference_level?: Numeric | null;
  available_excess_gains?: Numeric;
  available_excess_usdt?: Numeric;
  ladder?: AssetLadderSlotItem[];
  ranking?: AssetLadderSlotItem[];
  preview?: AssetRedistributionPreview | null;
  active_preview?: AssetRedistributionPreview | null;
  history?: AssetRedistributionBatchHistory[];
  batches?: AssetRedistributionBatchHistory[];
  contributions?: AssetExternalContributionHistory[];
  bulk_eligible_slot_ids?: string[];
  manual_gain_batch_preview?: AssetManualOperationalGainBatchPreview | null;
};

export type AssetPlanActionKeys = {
  prepare: string;
  confirm: string;
  contribution: string;
  balanceContribution: string;
  prepareManualGains: string;
  confirmManualGains: string;
};

function numberValue(value: Numeric | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function formatGain(value: Numeric | null | undefined) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 }).format(numberValue(value));
}

function formatLedgerUsdt(value: Numeric | null | undefined) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  }).format(numberValue(value))} USDT`;
}

function formatMonth(value?: string) {
  if (!value) return "Mês atual";
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function statusLabel(status: string) {
  return status.toLowerCase() === "aberto" ? "OPEN" : "LIVRE";
}

function batchStatusLabel(status: string) {
  const labels: Record<string, string> = {
    PREPARED: "Preparada",
    COMPLETED: "Concluída",
    CANCELLED: "Cancelada",
    STALE: "Desatualizada",
    FAILED: "Falhou"
  };
  return labels[status.toUpperCase()] || status;
}

function SubmitButton({ children, disabled = false, tone = "gold" }: { children: string; disabled?: boolean; tone?: "gold" | "neutral" | "green" }) {
  const { pending } = useFormStatus();
  return <button className={`btc-ladder-button ${tone}`} type="submit" disabled={disabled || pending}>{pending ? "Processando..." : children}</button>;
}

export function AssetLadderSection({ asset, plan, actionKeys, initialView = "gains" }: { asset: GrowthAsset; plan: AssetLadderPlanResponse; actionKeys: AssetPlanActionKeys; initialView?: "ladder" | "gains" | "balance" }) {
  const [activeView, setActiveView] = useState<"gains" | "balance">(initialView === "balance" ? "balance" : "gains");
  const [editingSetting, setEditingSetting] = useState<"goal" | null>(null);
  const [balanceScope, setBalanceScope] = useState<"single" | "all">("single");
  const [balanceAmount, setBalanceAmount] = useState("");
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [gainScope, setGainScope] = useState<"single" | "bulk">(plan.manual_gain_batch_preview ? "bulk" : "single");
  const ladder = plan.ladder || plan.ranking || [];
  const hasAuthoritativeBulkScope = Array.isArray(plan.bulk_eligible_slot_ids);
  const eligibleSlotIds = new Set(plan.bulk_eligible_slot_ids || []);
  const primarySlots = ladder.filter((slot) => hasAuthoritativeBulkScope
    ? eligibleSlotIds.has(slot.slot_id)
    : slot.slot_number >= 1 && slot.slot_number <= 25);
  const bulkSlotCount = primarySlots.length;
  const bulkOpenSlotCount = primarySlots.filter((slot) => slot.status.toLowerCase() === "aberto").length;
  const parsedBalanceAmount = Number.parseFloat(balanceAmount.replace(",", "."));
  const validBalanceAmount = Number.isFinite(parsedBalanceAmount) && parsedBalanceAmount > 0;
  const bulkTotalAmount = validBalanceAmount ? parsedBalanceAmount * bulkSlotCount : 0;
  const history = plan.history || plan.batches || [];
  const monthlyGoal = Number(plan.monthly_goal ?? (asset === "BTC" ? 7 : 1));
  const referenceCandidate = plan.reference_level ?? plan.suggested_reference_level;
  const parsedReference = numberValue(referenceCandidate);
  const referenceLevel = referenceCandidate !== null && referenceCandidate !== undefined && parsedReference > 0
    ? parsedReference
    : null;
  const cycleNumber = Math.max(1, Math.trunc(Number(plan.cycle_number || 1)));
  const leader = ladder[0] || null;
  const leaderGrowthTarget = getLeaderGrowthTarget(monthlyGoal, cycleNumber, leader ? numberValue(leader.operational_gains) : 0);
  const [manualGainSlotId, setManualGainSlotId] = useState(leader?.slot_id || "");
  const manualGainSlot = ladder.find((slot) => slot.slot_id === manualGainSlotId) || leader;
  const manualGainTarget = getLeaderGrowthTarget(monthlyGoal, cycleNumber, manualGainSlot ? numberValue(manualGainSlot.operational_gains) : 0);
  const contributionRows: CapitalContributionView[] = (plan.contributions || []).map((contribution) => ({
    asset,
    slot_id: contribution.slot_id || "",
    amount_usdt: contribution.amount_usdt,
    accounting_amount_usdt: contribution.accounting_amount_usdt,
    gain_equivalent: contribution.gain_equivalent,
    input_mode: contribution.input_mode,
    incorporated_in_opening: contribution.incorporated_in_opening,
    source: contribution.source
  }));
  const leaderContribution = leader ? summarizeCapitalContributions(contributionRows, { slotId: leader.slot_id }) : { amountUsdt: 0, gains: 0 };
  const manualGainBatch = plan.manual_gain_batch_preview || null;
  const manualGainBatchItems = manualGainBatch?.items || [];
  const manualGainBatchOpenCount = Number(manualGainBatch?.open_slot_count || 0);

  return (
    <div className="btc-plan-workspace">
      <div className="plan-mode-tabs" role="tablist" aria-label={`Funções do plano ${asset}`}>
        <button type="button" role="tab" aria-selected={activeView === "gains"} className={activeView === "gains" ? "active" : ""} onClick={() => setActiveView("gains")}>Adicionar gains</button>
        <button type="button" role="tab" aria-selected={activeView === "balance"} className={activeView === "balance" ? "active" : ""} onClick={() => setActiveView("balance")}>Aportes</button>
      </div>

      {!plan.ok ? <p className="inline-alert btc-ladder-inline-alert">{plan.message || plan.code || `O plano ${asset} está indisponível.`}</p> : null}

      {activeView === "gains" ? <SectionCard className="btc-manual-gains-card" title={`Adicionar gains ${asset}`} subtitle="Complete o líder ou ajuste qualquer slot" tone="green">
        <div className="btc-ladder-summary btc-manual-gains-summary">
          <Metric label="Meta atual do líder" value={`${formatGain(leaderGrowthTarget.targetGains)} gains`} helper={`${cycleNumber} ciclo(s) × ${monthlyGoal}`} />
          <Metric label="Líder atual" value={leader ? `Slot #${leader.slot_number} · ${formatGain(leader.operational_gains)}` : "--"} />
          <Metric label="Faltam no líder" value={leader ? `${formatGain(leaderGrowthTarget.missingGains)} gains` : "--"} />
          <Metric label="Aportes no líder" value={leader ? `+${formatGain(leaderContribution.gains)} gains` : "--"} helper={leader ? `+${formatLedgerUsdt(leaderContribution.amountUsdt)}` : undefined} />
        </div>
        <div className="plan-settings plan-gain-settings" data-testid="plan-settings">
          <PlanSettingRow
            label="Meta mensal"
            value={`${formatGain(monthlyGoal)} ${monthlyGoal === 1 ? "gain" : "gains"}`}
            editing={editingSetting === "goal"}
            onEdit={() => setEditingSetting((current) => current === "goal" ? null : "goal")}
            testId="plan-setting-goal"
          >
            <form action={saveAssetGrowthConfig} className="plan-setting-form" data-testid="plan-setting-goal-editor">
              <input type="hidden" name="asset" value={asset} />
              <input type="hidden" name="referenceLevel" value={referenceLevel ?? ""} />
              <label>Nova meta mensal<input name="monthlyGoal" type="number" min="1" max="1000" step="1" inputMode="numeric" defaultValue={monthlyGoal} required /></label>
              <button className="plan-setting-cancel" type="button" onClick={() => setEditingSetting(null)}>Cancelar</button>
              <SubmitButton>Salvar</SubmitButton>
            </form>
          </PlanSettingRow>
        </div>
        <div className="contribution-scope-toggle" role="group" aria-label="Modo de adição de gains">
          <button type="button" className={gainScope === "single" ? "active" : ""} aria-pressed={gainScope === "single"} onClick={() => setGainScope("single")}>Um slot</button>
          <button type="button" className={gainScope === "bulk" ? "active" : ""} aria-pressed={gainScope === "bulk"} onClick={() => setGainScope("bulk")}>Em massa</button>
        </div>
        {gainScope === "single" ? <form action={applyAssetManualOperationalGains} className="btc-contribution-form btc-manual-gain-form">
          <input type="hidden" name="asset" value={asset} />
          <input type="hidden" name="idempotencyKey" value={actionKeys.contribution} />
          <label>Slot
            <select name="slotId" required value={manualGainSlot?.slot_id || ""} onChange={(event) => setManualGainSlotId(event.target.value)}>
              <option value="" disabled>Escolha o slot</option>
              {ladder.map((slot) => <option value={slot.slot_id} key={slot.slot_id}>#{slot.slot_number} · {statusLabel(slot.status)} · {formatGain(slot.operational_gains)} gains</option>)}
            </select>
          </label>
          <label>Gains a adicionar<input key={`${manualGainSlot?.slot_id}:${manualGainTarget.suggestedManualGains}`} name="operationalGains" type="number" min="1" max="1000" step="1" inputMode="numeric" defaultValue={manualGainTarget.suggestedManualGains} required /></label>
          <label className="btc-contribution-reason">Observação opcional<input name="note" type="text" maxLength={500} placeholder="Ex.: completar meta desde 01/04" /></label>
          <p className="btc-ladder-help">Slots abertos e livres contam para a meta e podem receber gains. {manualGainSlot ? `Faltam ${formatGain(manualGainTarget.missingGains)} gains no Slot #${manualGainSlot.slot_number} para a meta de ${formatGain(manualGainTarget.targetGains)}.` : ""}</p>
          <SubmitButton tone="green" disabled={!plan.ok || !ladder.length}>Adicionar gains</SubmitButton>
        </form> : manualGainBatch ? <div className="manual-gain-batch-preview" data-testid="manual-gain-batch-preview">
          <div className="bulk-contribution-summary" aria-live="polite">
            <span>{manualGainBatch.slot_count} slots abaixo de {formatGain(manualGainBatch.below_operational_gains)} gains · {manualGainBatchOpenCount} OPEN · {manualGainBatch.slot_count - manualGainBatchOpenCount} LIVRES</span>
            <strong>Depositar {formatLedgerUsdt(manualGainBatch.total_amount_usdt)} para adicionar +{formatGain(manualGainBatch.operational_gains_per_slot)} gains em cada slot</strong>
          </div>
          <details className="manual-gain-batch-items">
            <summary>Conferir {manualGainBatchItems.length} slots e valores</summary>
            <div>
              {manualGainBatchItems.map((item) => <p key={item.slot_id}><strong>#{item.slot_number} · {statusLabel(item.status)}</strong><span>{formatGain(item.operational_before)} → {formatGain(item.operational_after)} gains</span><em>{formatLedgerUsdt(item.amount_usdt)}</em></p>)}
            </div>
          </details>
          <form action={confirmAssetManualOperationalGainsBatch} className="bulk-contribution-confirmation">
            <input type="hidden" name="asset" value={asset} />
            <input type="hidden" name="batchId" value={manualGainBatch.batch_id} />
            <input type="hidden" name="idempotencyKey" value={actionKeys.confirmManualGains} />
            <p>Esta prévia foi calculada no servidor e expira em {formatDate(manualGainBatch.expires_at)}. Se algum slot mudar, o lote inteiro será bloqueado antes de qualquer alteração.</p>
            <label className="bulk-contribution-checkbox"><input type="checkbox" name="confirmBulk" value="confirmed" required />Confirmo o aporte total de {formatLedgerUsdt(manualGainBatch.total_amount_usdt)}.</label>
            <SubmitButton tone="green" disabled={!plan.ok || !manualGainBatchItems.length}>Confirmar gains em massa</SubmitButton>
          </form>
          <form action={cancelAssetManualOperationalGainsBatch} className="manual-gain-batch-cancel">
            <input type="hidden" name="asset" value={asset} />
            <input type="hidden" name="batchId" value={manualGainBatch.batch_id} />
            <SubmitButton tone="neutral">Cancelar prévia</SubmitButton>
          </form>
        </div> : <form action={prepareAssetManualOperationalGainsBatch} className="btc-contribution-form" data-testid="prepare-manual-gains-batch">
          <input type="hidden" name="asset" value={asset} />
          <input type="hidden" name="idempotencyKey" value={actionKeys.prepareManualGains} />
          <label>Selecionar slots com menos de<input name="belowOperationalGains" type="number" min="1" max="1000" step="1" inputMode="numeric" defaultValue="3" required /></label>
          <label>Gains por slot<input name="operationalGains" type="number" min="1" max="1000" step="1" inputMode="numeric" defaultValue="2" required /></label>
          <label className="btc-contribution-reason">Observação opcional<input name="note" type="text" maxLength={500} placeholder="Ex.: nivelar investimento inicial" /></label>
          <SubmitButton tone="green" disabled={!plan.ok || !ladder.length}>Calcular aporte do lote</SubmitButton>
        </form>}
        <p className="btc-ladder-help">No modo em massa, “menos de 3” inclui somente 0, 1 e 2 gains. A prévia usa o capital real de cada slot {asset}, inclui OPEN e só aplica após sua confirmação. Gains reais e posições abertas permanecem intactos.</p>
      </SectionCard> : null}

      {activeView === "balance" ? <SectionCard className="btc-manual-gains-card" title={`Aportes ${asset}`} subtitle="Saldo externo separado de gains reais" tone="green">
        <form action={applyAssetExternalBalance} className="btc-contribution-form">
          <input type="hidden" name="asset" value={asset} />
          <input type="hidden" name="idempotencyKey" value={actionKeys.balanceContribution} />
          <input type="hidden" name="scope" value={balanceScope} />
          {primarySlots.map((slot) => <input key={slot.slot_id} type="hidden" name="expectedSlotIds" value={slot.slot_id} />)}
          <div className="contribution-scope-toggle" role="group" aria-label="Slots que receberão o aporte">
            <button type="button" className={balanceScope === "single" ? "active" : ""} aria-pressed={balanceScope === "single"} onClick={() => { setBalanceScope("single"); setBulkReviewOpen(false); }}>Um slot</button>
            <button type="button" className={balanceScope === "all" ? "active" : ""} aria-pressed={balanceScope === "all"} onClick={() => { setBalanceScope("all"); setBulkReviewOpen(false); }}>Todos os {bulkSlotCount}</button>
          </div>
          {balanceScope === "single" ? <label>Slot
            <select name="slotId" required defaultValue={leader?.slot_id || ""}>
              <option value="" disabled>Escolha o slot</option>
              {ladder.map((slot) => <option value={slot.slot_id} key={slot.slot_id}>#{slot.slot_number} · {statusLabel(slot.status)} · {formatGain(slot.operational_gains)} gains</option>)}
            </select>
          </label> : null}
          <label>{balanceScope === "all" ? "Valor por slot" : "Valor USDT"}<input name="amountUsdt" type="number" min="0.00000001" step="0.00000001" inputMode="decimal" placeholder="5,00" value={balanceAmount} onChange={(event) => { setBalanceAmount(event.target.value); setBulkReviewOpen(false); }} required /></label>
          <label className="btc-contribution-reason">Motivo opcional<input name="note" type="text" maxLength={500} placeholder="Ex.: aporte adicional" /></label>
          {balanceScope === "single" ? <SubmitButton tone="green" disabled={!plan.ok || !ladder.length}>Adicionar saldo</SubmitButton> : (
            <div className="bulk-contribution-action">
              <div className="bulk-contribution-summary" aria-live="polite">
                <span>{bulkSlotCount} slots · {bulkOpenSlotCount} OPEN · {bulkSlotCount - bulkOpenSlotCount} LIVRES</span>
                <strong>{validBalanceAmount ? `${bulkSlotCount} × ${formatLedgerUsdt(parsedBalanceAmount)} = ${formatLedgerUsdt(bulkTotalAmount)}` : "Informe o valor por slot"}</strong>
              </div>
              {!bulkReviewOpen ? <button className="btc-ladder-button green" type="button" disabled={!plan.ok || !bulkSlotCount || !validBalanceAmount} onClick={() => setBulkReviewOpen(true)}>Revisar aporte</button> : (
                <div className="bulk-contribution-confirmation">
                  <p>O aporte será aplicado em todos os {bulkSlotCount} slots {asset}, inclusive os {bulkOpenSlotCount} OPEN. Qualquer falha reverte o lote inteiro.</p>
                  <label className="bulk-contribution-checkbox"><input type="checkbox" name="confirmBulk" value="confirmed" required />Confirmo o total de {formatLedgerUsdt(bulkTotalAmount)}</label>
                  <SubmitButton tone="green" disabled={!plan.ok || !bulkSlotCount || !validBalanceAmount}>Confirmar aporte em todos</SubmitButton>
                </div>
              )}
            </div>
          )}
        </form>
        <p className="btc-ladder-help">Você pode usar qualquer valor positivo por slot. O saldo entra integralmente em BTC ou SOL, inclusive nos OPEN, sem criar gain nem alterar a posição atual.</p>
      </SectionCard> : null}

      <AssetLadderHistory asset={asset} batches={history} contributions={plan.contributions || []} />
    </div>
  );
}

function Metric({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return <div><span>{label}</span><strong>{value}</strong>{helper ? <small>{helper}</small> : null}</div>;
}

function PlanSettingRow({ label, value, editing, onEdit, testId, children }: { label: string; value: string; editing: boolean; onEdit: () => void; testId: string; children: ReactNode }) {
  return (
    <div className={`plan-setting-row${editing ? " editing" : ""}`} data-testid={testId}>
      <div className="plan-setting-row-summary">
        <span><small>{label}</small><strong>{value}</strong></span>
        <button type="button" onClick={onEdit} aria-expanded={editing}>{editing ? "Fechar" : "Editar"}</button>
      </div>
      {editing ? <div className="plan-setting-editor">{children}</div> : null}
    </div>
  );
}

function AssetLadderHistory({ asset, batches, contributions }: { asset: GrowthAsset; batches: AssetRedistributionBatchHistory[]; contributions: AssetExternalContributionHistory[] }) {
  const contributionsByBulkBatch = new Map<string, AssetExternalContributionHistory[]>();
  contributions.forEach((contribution) => {
    if (!contribution.bulk_batch_id) return;
    const group = contributionsByBulkBatch.get(contribution.bulk_batch_id) || [];
    group.push(contribution);
    contributionsByBulkBatch.set(contribution.bulk_batch_id, group);
  });
  const visibleContributions = contributions.filter((contribution) => {
    if (!contribution.bulk_batch_id) return true;
    return contributionsByBulkBatch.get(contribution.bulk_batch_id)?.[0]?.id === contribution.id;
  });
  const events = [
    ...batches.map((batch) => ({ kind: "batch" as const, createdAt: batch.created_at, batch })),
    ...visibleContributions.map((contribution) => ({ kind: "contribution" as const, createdAt: contribution.created_at, contribution }))
  ].sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());

  return (
    <details className="btc-history-card plan-history-drawer">
      <summary>Histórico financeiro {asset}</summary>
      <div className="btc-ladder-history">
        {events.map((event) => event.kind === "batch" ? (
          <details key={`batch-${event.batch.batch_id}`}>
            <summary>
              <span><strong>{formatMonth(event.batch.month_reference)}</strong><small>{batchStatusLabel(event.batch.status)} · {event.batch.transfer_count} transferências</small></span>
              <b>{formatLedgerUsdt(event.batch.total_transferred_usdt)}</b>
            </summary>
            <div className="btc-history-details">
              <span>Referência: {formatGain(event.batch.reference_level)} gains</span>
              <span>Preparada em: {formatDate(event.batch.created_at)}</span>
              {event.batch.created_by ? <span>Preparada por: {event.batch.created_by}</span> : null}
              {event.batch.completed_at ? <span>Concluída em: {formatDate(event.batch.completed_at)}</span> : null}
              {event.batch.confirmed_by ? <span>Confirmada por: {event.batch.confirmed_by}</span> : null}
              {(event.batch.transfers || []).map((transfer, index) => (
                <p key={transfer.id || index}>
                  #{transfer.donor_slot_number} ({statusLabel(transfer.donor_status)}) → #{transfer.receiver_slot_number} ({statusLabel(transfer.receiver_status)}) · {formatLedgerUsdt(transfer.amount_usdt)} · equivalentes {formatGain(transfer.donor_gain_equivalent)} → {formatGain(transfer.receiver_gain_equivalent)} · operacional {formatGain(transfer.donor_operational_before)} → {formatGain(transfer.donor_operational_after)} / {formatGain(transfer.receiver_operational_before)} → {formatGain(transfer.receiver_operational_after)}
                </p>
              ))}
            </div>
          </details>
        ) : event.contribution.bulk_batch_id ? (() => {
          const group = [...(contributionsByBulkBatch.get(event.contribution.bulk_batch_id || "") || [])]
            .sort((first, second) => Number(first.bulk_sequence || 0) - Number(second.bulk_sequence || 0));
          const reportedCount = Number(event.contribution.bulk_slot_count || group.length);
          const total = numberValue(event.contribution.bulk_total_amount_usdt)
            || group.reduce((sum, contribution) => sum + numberValue(contribution.accounting_amount_usdt ?? contribution.amount_usdt), 0);
          const openCount = Number(event.contribution.bulk_open_slot_count ?? 0);
          return <details key={`contribution-bulk-${event.contribution.bulk_batch_id}`}>
            <summary>
              <span><strong>Aporte em lote · {reportedCount} slots</strong><small>{formatDate(event.contribution.created_at)} · {openCount} OPEN</small></span>
              <b>{formatLedgerUsdt(total)}</b>
            </summary>
            <div className="btc-history-details">
              <span>{group.length === reportedCount ? "Lote completo" : `${group.length} de ${reportedCount} itens carregados`} · {asset}</span>
              {group.every((contribution) => contribution.incorporated_in_opening) ? <span>Incorporado ao marco inicial operacional · não entra nos novos aportes.</span> : null}
              <p>{event.contribution.reason}</p>
              {group.map((contribution) => <p key={contribution.id}>#{contribution.slot_number} · {formatLedgerUsdt(contribution.accounting_amount_usdt ?? contribution.amount_usdt)}</p>)}
            </div>
          </details>;
        })() : (
          <details key={`contribution-${event.contribution.id}`}>
            <summary>
              <span><strong>{event.contribution.source === "SLOT_INITIAL_CAPITAL" ? "Capital inicial do slot" : event.contribution.input_mode === "USDT" ? "Saldo adicionado" : "Gains adicionados"} · Slot #{event.contribution.slot_number}</strong><small>{formatDate(event.contribution.created_at)}</small></span>
              <b>{formatLedgerUsdt(event.contribution.accounting_amount_usdt ?? event.contribution.amount_usdt)}</b>
            </summary>
            <div className="btc-history-details">
              {event.contribution.incorporated_in_opening ? <span>Incorporado ao marco inicial operacional · não entra nos novos aportes ou gains adicionados.</span> : null}
              <span>{event.contribution.input_mode === "USDT" ? "Saldo informado" : "Gains operacionais"}: {event.contribution.input_mode === "USDT" ? formatLedgerUsdt(event.contribution.amount_usdt) : formatGain(event.contribution.gain_equivalent)}</span>
              <span>Operacional: {formatGain(event.contribution.operational_before)} → {formatGain(event.contribution.operational_after)}</span>
              {event.contribution.applied_by ? <span>Registrado por: {event.contribution.applied_by}</span> : null}
              <p>{event.contribution.reason}</p>
            </div>
          </details>
        ))}
        {!events.length ? <p className="empty-copy padded-empty">Nenhuma redistribuição ou ajuste manual {asset} registrado.</p> : null}
      </div>
    </details>
  );
}

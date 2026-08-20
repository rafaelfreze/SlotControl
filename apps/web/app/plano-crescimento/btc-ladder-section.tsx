"use client";

import { useFormStatus } from "react-dom";

import { SectionCard } from "@/components/app/mobile-ui";
import { formatDate, formatUsdt } from "@/lib/slotgain/format";
import { indexCapitalContributionsBySlot, summarizeCapitalContributions, type CapitalContributionView } from "@/lib/slotgain/capital-contributions";
import { getLeaderGrowthTarget } from "@/lib/slotgain/growth-target";
import {
  applyAssetExternalBalance,
  applyAssetManualOperationalGains,
  cancelAssetRedistribution,
  confirmAssetRedistribution,
  prepareAssetRedistribution,
  saveAssetMonthlyGoal,
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
  slot_id?: string;
  slot_number: number;
  amount_usdt: Numeric;
  accounting_amount_usdt?: Numeric | null;
  gain_equivalent: Numeric;
  input_mode?: "MANUAL_GAINS" | "USDT" | null;
  operational_before?: Numeric;
  operational_after?: Numeric;
  reason: string;
  applied_by?: string | null;
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
};

export type AssetPlanActionKeys = {
  prepare: string;
  confirm: string;
  contribution: string;
  balanceContribution: string;
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

function formatSignedGain(value: Numeric | null | undefined) {
  const number = numberValue(value);
  return `${number > 0 ? "+" : ""}${formatGain(number)}`;
}

function formatMonth(value?: string) {
  if (!value) return "Mês atual";
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatCycleDate(value?: string) {
  if (!value) return "data indisponível";
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(date);
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

export function AssetLadderSection({ asset, plan, actionKeys }: { asset: GrowthAsset; plan: AssetLadderPlanResponse; actionKeys: AssetPlanActionKeys }) {
  const ladder = plan.ladder || plan.ranking || [];
  const preview = plan.preview || plan.active_preview || null;
  const history = plan.history || plan.batches || [];
  const monthlyGoal = Number(plan.monthly_goal || (asset === "BTC" ? 7 : 1));
  const referenceCandidate = plan.reference_level ?? plan.suggested_reference_level;
  const parsedReference = numberValue(referenceCandidate);
  const referenceLevel = referenceCandidate !== null && referenceCandidate !== undefined && parsedReference > 0
    ? parsedReference
    : null;
  const hasExactMonthlyRealGains = !plan.real_gains_month_source || plan.real_gains_month_source.toUpperCase() === "LEDGER";
  const cycleNumber = Math.max(1, Math.trunc(Number(plan.cycle_number || 1)));
  const leader = ladder[0] || null;
  const leaderGrowthTarget = getLeaderGrowthTarget(monthlyGoal, cycleNumber, leader ? numberValue(leader.operational_gains) : 0);
  const contributionRows: CapitalContributionView[] = (plan.contributions || []).map((contribution) => ({
    asset,
    slot_id: contribution.slot_id || "",
    amount_usdt: contribution.amount_usdt,
    accounting_amount_usdt: contribution.accounting_amount_usdt,
    gain_equivalent: contribution.gain_equivalent,
    input_mode: contribution.input_mode
  }));
  const contributionBySlot = indexCapitalContributionsBySlot(contributionRows);
  const leaderContribution = leader ? summarizeCapitalContributions(contributionRows, { slotId: leader.slot_id }) : { amountUsdt: 0, gains: 0 };

  return (
    <div className="btc-plan-workspace">
      <SectionCard className="btc-manual-gains-card" title={`Adicionar gains ${asset}`} subtitle="Complete o líder ou ajuste qualquer slot" tone="green">
        <div className="btc-ladder-summary btc-manual-gains-summary">
          <Metric label="Meta atual do líder" value={`${formatGain(leaderGrowthTarget.targetGains)} gains`} helper={`${cycleNumber} ciclo(s) × ${monthlyGoal}`} />
          <Metric label="Líder atual" value={leader ? `Slot #${leader.slot_number} · ${formatGain(leader.operational_gains)}` : "--"} />
          <Metric label="Faltam no líder" value={leader ? `${formatGain(leaderGrowthTarget.missingGains)} gains` : "--"} />
          <Metric label="Aportes no líder" value={leader ? `+${formatGain(leaderContribution.gains)} gains` : "--"} helper={leader ? `+${formatLedgerUsdt(leaderContribution.amountUsdt)}` : undefined} />
        </div>
        <form action={applyAssetManualOperationalGains} className="btc-contribution-form">
          <input type="hidden" name="asset" value={asset} />
          <input type="hidden" name="idempotencyKey" value={actionKeys.contribution} />
          <label>Slot
            <select name="slotId" required defaultValue={leader?.slot_id || ""}>
              <option value="" disabled>Escolha o slot</option>
              {ladder.map((slot) => <option value={slot.slot_id} key={slot.slot_id}>#{slot.slot_number} · {statusLabel(slot.status)} · {formatGain(slot.operational_gains)} gains</option>)}
            </select>
          </label>
          <label>Gains a adicionar<input name="operationalGains" type="number" min="1" max="1000" step="1" inputMode="numeric" defaultValue={leaderGrowthTarget.suggestedManualGains} required /></label>
          <label className="btc-contribution-reason">Observação opcional<input name="note" type="text" maxLength={500} placeholder="Ex.: completar meta desde 01/04" /></label>
          <SubmitButton tone="green" disabled={!plan.ok || !ladder.length}>Adicionar gains</SubmitButton>
        </form>
        <p className="btc-ladder-help">Você informa os gains e o servidor calcula o aporte em USDT. Eles aumentam somente os gains operacionais; gains reais e posições abertas permanecem intactos.</p>
        <details className="slot-advanced-actions btc-direct-balance">
          <summary>Adicionar saldo em USDT</summary>
          <form action={applyAssetExternalBalance} className="btc-contribution-form">
            <input type="hidden" name="asset" value={asset} />
            <input type="hidden" name="idempotencyKey" value={actionKeys.balanceContribution} />
            <label>Slot
              <select name="slotId" required defaultValue={leader?.slot_id || ""}>
                <option value="" disabled>Escolha o slot</option>
                {ladder.map((slot) => <option value={slot.slot_id} key={slot.slot_id}>#{slot.slot_number} · {statusLabel(slot.status)} · {formatGain(slot.operational_gains)} gains</option>)}
              </select>
            </label>
            <label>Valor USDT<input name="amountUsdt" type="number" min="0.00000001" step="0.00000001" inputMode="decimal" placeholder="5,00" required /></label>
            <label className="btc-contribution-reason">Motivo opcional<input name="note" type="text" maxLength={500} placeholder="Ex.: aporte adicional" /></label>
            <SubmitButton tone="green" disabled={!plan.ok || !ladder.length}>Adicionar saldo</SubmitButton>
          </form>
          <p className="btc-ladder-help">O valor entra integralmente no saldo atual. Ele não cria gain; os próximos gains serão calculados sobre o novo saldo quando a próxima operação for aberta.</p>
        </details>
      </SectionCard>

      <SectionCard className="btc-ladder-main" title={`Escada ${asset}`} subtitle={`Ciclo iniciado em ${formatCycleDate(plan.month_reference)} · meta ${monthlyGoal} gains por 30 dias`} tone={asset === "BTC" ? "gold" : "purple"}>
        {!plan.ok ? <p className="inline-alert btc-ladder-inline-alert">{plan.message || plan.code || `A escada ${asset} está indisponível.`}</p> : null}
        <div className="btc-ladder-summary">
          <Metric
            label="Gains reais no ciclo"
            value={formatGain(plan.real_gains_month)}
            helper={hasExactMonthlyRealGains ? undefined : "estimado (histórico legado)"}
          />
          <Metric label="Referência assistida" value={referenceLevel === null ? "--" : `${formatGain(referenceLevel)} gains`} />
          <Metric label="Excedente disponível" value={referenceLevel === null ? "--" : `${formatGain(plan.available_excess_gains)} gains`} />
          <Metric label="Capital elegível" value={referenceLevel === null ? "--" : formatUsdt(numberValue(plan.available_excess_usdt))} />
        </div>

        <div className="btc-ladder-controls">
          <form action={saveAssetMonthlyGoal} className="btc-ladder-compact-form">
            <input type="hidden" name="asset" value={asset} />
            <label>Meta mensal {asset}<input name="monthlyGoal" type="number" min="1" max="1000" step="1" defaultValue={monthlyGoal} required /></label>
            <SubmitButton>Salvar meta</SubmitButton>
          </form>
          <form action={prepareAssetRedistribution} className="btc-ladder-compact-form">
            <input type="hidden" name="asset" value={asset} />
            <input type="hidden" name="idempotencyKey" value={actionKeys.prepare} />
            <label>Referência da escada<input name="referenceLevel" type="number" min="1" step="1" inputMode="numeric" defaultValue={referenceLevel ?? ""} placeholder="Ex.: 14" required /></label>
            <SubmitButton disabled={!plan.ok || ladder.length < 2}>Preparar redistribuição</SubmitButton>
          </form>
        </div>

        <p className="btc-ladder-help">A meta de {monthlyGoal} mede a velocidade a cada 30 dias. A referência é o nível operacional que você escolhe para equilibrar a escada; ela não cria dívida automática para cada slot.</p>
        <details className="btc-ladder-guide">
          <summary>Como fazer a redistribuição</summary>
          <ol>
            <li>Escolha uma referência operacional, por exemplo 7 ou 14 gains.</li>
            <li>Toque em Preparar redistribuição. Isso cria somente uma prévia e não altera os slots.</li>
            <li>Confira doadores, recebedores, USDT transferido e diferença patrimonial zero.</li>
            <li>Confirme para aplicar tudo em uma única transação; cancele para não alterar nada.</li>
          </ol>
          <p>Slots OPEN também podem doar. A posição aberta continua com quantidade, entrada e alvo originais.</p>
        </details>
        <LadderList asset={asset} slots={ladder} referenceLevel={referenceLevel} contributionBySlot={contributionBySlot} />
      </SectionCard>

      {preview ? <RedistributionPreview asset={asset} preview={preview} confirmIdempotencyKey={actionKeys.confirm} /> : null}

      <AssetLadderHistory asset={asset} batches={history} contributions={plan.contributions || []} />
    </div>
  );
}

function Metric({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return <div><span>{label}</span><strong>{value}</strong>{helper ? <small>{helper}</small> : null}</div>;
}

function LadderList({ asset, slots, referenceLevel, contributionBySlot = {} }: { asset: GrowthAsset; slots: AssetLadderSlotItem[]; referenceLevel: number | null; contributionBySlot?: Record<string, { amountUsdt: number; gains: number }> }) {
  const primarySlots = slots.slice(0, 5);
  const remainingSlots = slots.slice(5);
  return (
    <div className="btc-ladder-table" role="table" aria-label={`Ranking operacional ${asset}`}>
      <div className="btc-ladder-table-head" role="row">
        <span role="columnheader">Ranking</span><span role="columnheader">Status</span><span role="columnheader">Reais</span><span role="columnheader">Operacionais</span><span role="columnheader">Valor</span><span role="columnheader">Excedente/defasagem</span>
      </div>
      {primarySlots.map((slot) => <LadderRow key={slot.slot_id} slot={slot} referenceLevel={referenceLevel} contribution={contributionBySlot[slot.slot_id]} />)}
      {remainingSlots.length ? <details className="btc-ladder-more"><summary>Ver todos os {slots.length} slots</summary>{remainingSlots.map((slot) => <LadderRow key={slot.slot_id} slot={slot} referenceLevel={referenceLevel} contribution={contributionBySlot[slot.slot_id]} />)}</details> : null}
      {!slots.length ? <p className="empty-copy padded-empty">Nenhum slot {asset} disponível para montar a escada.</p> : null}
    </div>
  );
}

function LadderRow({ slot, referenceLevel, contribution }: { slot: AssetLadderSlotItem; referenceLevel: number | null; contribution?: { amountUsdt: number; gains: number } }) {
  const difference = slot.reference_difference_gains === undefined
    ? referenceLevel === null ? null : numberValue(slot.operational_gains) - referenceLevel
    : numberValue(slot.reference_difference_gains);

  return (
    <div className="btc-ladder-row" role="row">
      <span role="cell" className="btc-ladder-slot"><small>Ranking</small><strong>#{slot.rank}</strong><em>Slot {slot.slot_number}</em></span>
      <span role="cell"><small>Status</small><b className={slot.status.toLowerCase() === "aberto" ? "open" : "free"}>{statusLabel(slot.status)}</b></span>
      <span role="cell"><small>Reais</small><strong>{formatGain(slot.real_gains)}</strong></span>
      <span role="cell"><small>Operacionais</small><strong>{formatGain(slot.operational_gains)}</strong><em>+{formatGain(contribution?.gains || 0)} aportados</em></span>
      <span role="cell"><small>Valor</small><strong>{formatUsdt(numberValue(slot.operational_value_usdt))}</strong></span>
      <span role="cell"><small>Diferença</small><strong className={difference !== null && difference > 0 ? "positive" : difference !== null && difference < 0 ? "negative" : "neutral"}>{difference === null ? "--" : formatSignedGain(difference)}</strong></span>
    </div>
  );
}

function RedistributionPreview({ asset, preview, confirmIdempotencyKey }: { asset: GrowthAsset; preview: AssetRedistributionPreview; confirmIdempotencyKey: string }) {
  const parsedDifference = Number(preview.equity_difference_usdt);
  const hasValidDifference = preview.equity_difference_usdt !== null
    && preview.equity_difference_usdt !== undefined
    && Number.isFinite(parsedDifference);
  const difference = hasValidDifference ? parsedDifference : Number.NaN;
  const transfers = Array.isArray(preview.transfers) ? preview.transfers : [];
  const conserved = hasValidDifference && Math.abs(difference) <= 0.00000001;
  const prepared = preview.status.toUpperCase() === "PREPARED";
  const canConfirm = prepared && conserved && transfers.length > 0;

  return (
    <SectionCard className="btc-preview-card" title="Prévia da redistribuição" subtitle={`Referência ${formatGain(preview.reference_level)} gains`} tone="gold">
      <div className="btc-preview-summary">
        <Metric label="Patrimônio antes" value={formatUsdt(numberValue(preview.equity_before_usdt))} />
        <Metric label="Patrimônio depois" value={formatUsdt(numberValue(preview.equity_after_usdt))} />
        <Metric label="Total transferido" value={formatUsdt(numberValue(preview.total_transferred_usdt))} />
        <Metric label="Diferença" value={hasValidDifference ? formatLedgerUsdt(difference) : "Inválida"} />
      </div>
      <p className={`btc-conservation-status ${conserved ? "ok" : "blocked"}`}>{conserved ? "Conservação financeira confirmada: diferença zero." : "Confirmação bloqueada: o patrimônio não foi conservado."}</p>

      <div className="btc-preview-transfers">
        {transfers.map((transfer, index) => (
          <article key={transfer.id || `${transfer.donor_slot_number}-${transfer.receiver_slot_number}-${index}`}>
            <strong>#{transfer.donor_slot_number} → #{transfer.receiver_slot_number}</strong>
            <span>{formatGain(transfer.donor_gain_equivalent)} → {formatGain(transfer.receiver_gain_equivalent)} gains equivalentes</span>
            <b>{formatLedgerUsdt(transfer.amount_usdt)}</b>
            <small>{statusLabel(transfer.donor_status)} → {statusLabel(transfer.receiver_status)}</small>
          </article>
        ))}
        {!transfers.length ? <p className="empty-copy padded-empty">Nenhuma transferência elegível nesta referência.</p> : null}
      </div>

      <div className="btc-preview-rankings">
        <details><summary>Ranking antes</summary><LadderList asset={asset} slots={preview.ranking_before || []} referenceLevel={numberValue(preview.reference_level)} /></details>
        <details><summary>Ranking depois</summary><LadderList asset={asset} slots={preview.ranking_after || []} referenceLevel={numberValue(preview.reference_level)} /></details>
      </div>

      <div className="btc-preview-actions">
        <form action={cancelAssetRedistribution}>
          <input type="hidden" name="asset" value={asset} />
          <input type="hidden" name="batchId" value={preview.batch_id} />
          <SubmitButton tone="neutral" disabled={!prepared}>Cancelar</SubmitButton>
        </form>
        <form action={confirmAssetRedistribution}>
          <input type="hidden" name="asset" value={asset} />
          <input type="hidden" name="batchId" value={preview.batch_id} />
          <input type="hidden" name="idempotencyKey" value={confirmIdempotencyKey} />
          {preview.snapshot_hash ? <input type="hidden" name="snapshotHash" value={preview.snapshot_hash} /> : null}
          <SubmitButton disabled={!canConfirm}>Confirmar redistribuição</SubmitButton>
        </form>
      </div>
    </SectionCard>
  );
}

function AssetLadderHistory({ asset, batches, contributions }: { asset: GrowthAsset; batches: AssetRedistributionBatchHistory[]; contributions: AssetExternalContributionHistory[] }) {
  const events = [
    ...batches.map((batch) => ({ kind: "batch" as const, createdAt: batch.created_at, batch })),
    ...contributions.map((contribution) => ({ kind: "contribution" as const, createdAt: contribution.created_at, contribution }))
  ].sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());

  return (
    <SectionCard className="btc-history-card" title={`Histórico mensal ${asset}`} subtitle="Redistribuições e ajustes manuais" tone="neutral">
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
        ) : (
          <details key={`contribution-${event.contribution.id}`}>
            <summary>
              <span><strong>{event.contribution.input_mode === "USDT" ? "Saldo adicionado" : "Gains adicionados"} · Slot #{event.contribution.slot_number}</strong><small>{formatDate(event.contribution.created_at)}</small></span>
              <b>{formatLedgerUsdt(event.contribution.accounting_amount_usdt ?? event.contribution.amount_usdt)}</b>
            </summary>
            <div className="btc-history-details">
              <span>{event.contribution.input_mode === "USDT" ? "Saldo informado" : "Gains operacionais"}: {event.contribution.input_mode === "USDT" ? formatLedgerUsdt(event.contribution.amount_usdt) : formatGain(event.contribution.gain_equivalent)}</span>
              <span>Operacional: {formatGain(event.contribution.operational_before)} → {formatGain(event.contribution.operational_after)}</span>
              {event.contribution.applied_by ? <span>Registrado por: {event.contribution.applied_by}</span> : null}
              <p>{event.contribution.reason}</p>
            </div>
          </details>
        ))}
        {!events.length ? <p className="empty-copy padded-empty">Nenhuma redistribuição ou ajuste manual {asset} registrado.</p> : null}
      </div>
    </SectionCard>
  );
}

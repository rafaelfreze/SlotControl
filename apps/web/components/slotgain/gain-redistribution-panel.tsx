"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  confirmGainRedistribution,
  getGainRedistributionPreview,
  undoLastGainRedistribution
} from "@/app/dashboard/actions";
import { isOpenSlot, type RedistributionSlotStatus } from "@/lib/slotgain/redistribution";
import { formatUsdt } from "@/lib/slotgain/format";

type Asset = "BTC" | "SOL";

type SlotSummary = {
  id: string;
  slot_number: number;
  status: RedistributionSlotStatus;
  gains: number;
  gains_distribuidos: number;
};

export type GainRedistributionHistoryItem = {
  id: string;
  asset: Asset;
  action_type: "REDISTRIBUTION" | "UNDO";
  target_slot_count: number;
  total_gains_before: number;
  total_gains_after: number;
  total_reinvested_before?: number | string | null;
  total_reinvested_after?: number | string | null;
  base_reinvested?: number | string | null;
  remainder_reinvested_units?: number | null;
  algorithm_version?: string | null;
  status: "COMPLETED" | "UNDONE" | "FAILED";
  snapshot_before: PreviewSlot[];
  snapshot_after: PreviewSlot[];
  created_at: string;
};

type PreviewSlot = {
  slot_id: string;
  slot_number: number;
  status: string;
  gains_before?: number;
  gains_after?: number;
  base_value?: number;
  reinvested_profit_before?: number;
  reinvested_profit_after?: number;
  operational_slot_value_before?: number;
  operational_slot_value_after?: number;
  role?: "RECIPIENT" | "ZEROED";
  selection_reason?: "CLOSED_HIGHEST_GAIN" | "CLOSED_EXCESS_ZEROED";
};

type Preview = {
  ok: true;
  asset: Asset;
  target_slot_count: number;
  recipient_slot_count: number;
  closed_slot_count: number;
  ignored_open_slot_count: number;
  zeroed_slot_count: number;
  total_gains_before: number;
  total_gains_after: number;
  base_gain: number;
  remainder_gain: number;
  total_reinvested_before: number;
  total_reinvested_after: number;
  base_reinvested: number;
  remainder_reinvested_units: number;
  snapshot_hash: string;
  closed_slots: PreviewSlot[];
};

type ActionResult = {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
};

function isPreview(value: ActionResult): value is Preview {
  return value.ok && typeof value.snapshot_hash === "string" && Array.isArray(value.closed_slots);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function getRoleLabel(slot: PreviewSlot) {
  return slot.role === "RECIPIENT" ? "Destinatario" : "Zerado";
}

export function GainRedistributionPanel({
  asset,
  slots,
  history,
  onNotice
}: {
  asset: Asset;
  slots: SlotSummary[];
  history: GainRedistributionHistoryItem[];
  onNotice: (message: string) => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmationKeyRef = useRef<string | null>(null);
  const target = asset === "BTC" ? 15 : 6;
  const assetHistory = history.filter((item) => item.asset === asset);
  const undoCandidate = assetHistory.find((item) => item.action_type === "REDISTRIBUTION" && item.status === "COMPLETED") || null;
  const ignoredOpenSlots = useMemo(
    () => slots.filter((slot) => isOpenSlot(slot.status)).sort((first, second) => first.slot_number - second.slot_number),
    [slots]
  );

  async function openPreview() {
    setLoadingPreview(true);
    setError(null);
    const result = (await getGainRedistributionPreview(asset)) as ActionResult;
    setLoadingPreview(false);

    if (!isPreview(result)) {
      setPreview(null);
      setError(result.message || "Nao foi possivel gerar a previa.");
      return;
    }

    setPreview(result);
    confirmationKeyRef.current = crypto.randomUUID();
  }

  async function confirm() {
    if (!preview || confirming) return;

    setConfirming(true);
    setError(null);
    const result = (await confirmGainRedistribution({
      asset,
      snapshotHash: preview.snapshot_hash,
      idempotencyKey: confirmationKeyRef.current || crypto.randomUUID()
    })) as ActionResult;
    setConfirming(false);

    if (!result.ok) {
      setError(result.message || "Nao foi possivel concluir a redistribuicao.");
      if (result.code === "PREVIEW_STALE") {
        setPreview(null);
        confirmationKeyRef.current = null;
      }
      return;
    }

    setPreview(null);
    confirmationKeyRef.current = null;
    onNotice(result.message || `Capital operacional redistribuido com sucesso em slots fechados de ${asset}.`);
    router.refresh();
  }

  async function undo() {
    if (!undoCandidate || undoing) return;

    setUndoing(true);
    setError(null);
    const result = (await undoLastGainRedistribution({ asset, idempotencyKey: crypto.randomUUID() })) as ActionResult;
    setUndoing(false);

    if (!result.ok) {
      setError(result.message || "Nao foi possivel desfazer a redistribuicao.");
      return;
    }

    onNotice(result.message || "Redistribuicao desfeita com seguranca.");
    router.refresh();
  }

  return (
    <section className="section-card redistribution-card">
      <div className="redistribution-heading">
        <div>
          <p>Capital operacional</p>
          <h2>Redistribuir gains e lucro</h2>
          <small>Concentra os gains nivelados e o lucro reinvestido em ate {target} slots fechados de {asset}. Slots abertos e o historico financeiro permanecem intactos.</small>
        </div>
        <button type="button" className="solid-button" onClick={openPreview} disabled={loadingPreview || confirming}>
          {loadingPreview ? "Gerando previa..." : "Redistribuir capital"}
        </button>
      </div>

      {error ? <p className="inline-alert redistribution-error">{error}</p> : null}

      <details className="redistribution-history">
        <summary>Historico de redistribuicoes ({assetHistory.length})</summary>
        <div className="redistribution-history-list">
          {undoCandidate ? (
            <>
              <p className="redistribution-excluded">Para corrigir uma redistribuicao anterior, desfaça-a primeiro e gere uma nova previa.</p>
              <button type="button" className="ghost-button compact-action" onClick={undo} disabled={undoing}>
                {undoing ? "Desfazendo..." : "Desfazer ultima redistribuicao"}
              </button>
            </>
          ) : null}
          {assetHistory.map((item) => (
            <details key={item.id} className="redistribution-history-item">
              <summary>
                {formatDate(item.created_at)} · {item.action_type === "UNDO" ? "Desfazer" : "Redistribuicao"} · {item.total_gains_before} gains · {item.status}
              </summary>
              <p>Usuario: voce · meta: {item.target_slot_count} slots · gains: {item.total_gains_before} → {item.total_gains_after} · lucro reinvestido: {formatUsdt(Number(item.total_reinvested_before || 0))} → {formatUsdt(Number(item.total_reinvested_after || 0))}</p>
              <div className="redistribution-history-grid">
                {(item.snapshot_after || []).map((slot) => {
                  const before = item.snapshot_before.find((candidate) => candidate.slot_id === slot.slot_id);
                  return <span key={slot.slot_id}>#{slot.slot_number}: {before?.gains_before ?? "-"} → {slot.gains_after ?? "-"}</span>;
                })}
              </div>
            </details>
          ))}
          {assetHistory.length === 0 ? <p className="empty-copy">Nenhuma redistribuicao registrada para {asset}.</p> : null}
        </div>
      </details>

      {preview ? (
        <div className="redistribution-modal-backdrop" role="presentation">
          <section className="redistribution-modal" role="dialog" aria-modal="true" aria-label={`Previa de redistribuicao de ${asset}`}>
            <header>
              <div>
                <p>Previa de redistribuicao</p>
                <h2>{asset} · meta de {target} slots fechados</h2>
              </div>
              <button type="button" className="ghost-button compact-action" onClick={() => { setPreview(null); confirmationKeyRef.current = null; }} disabled={confirming}>Cancelar</button>
            </header>
            <div className="redistribution-metrics">
              <span>Fechados considerados<strong>{preview.closed_slot_count}</strong></span>
              <span>Abertos ignorados<strong>{preview.ignored_open_slot_count}</strong></span>
              <span>Destinatarios<strong>{preview.recipient_slot_count}</strong></span>
              <span>Ficarao zerados<strong>{preview.zeroed_slot_count}</strong></span>
              <span>Gains antes<strong>{preview.total_gains_before}</strong></span>
              <span>Base de gains<strong>{preview.base_gain}</strong></span>
              <span>Sobra de gains<strong>{preview.remainder_gain}</strong></span>
              <span>Gains depois<strong>{preview.total_gains_after}</strong></span>
              <span>Lucro antes<strong>{formatUsdt(preview.total_reinvested_before)}</strong></span>
              <span>Lucro base<strong>{formatUsdt(preview.base_reinvested)}</strong></span>
              <span>Unidades de sobra<strong>{preview.remainder_reinvested_units}</strong></span>
              <span>Lucro depois<strong>{formatUsdt(preview.total_reinvested_after)}</strong></span>
            </div>
            <p className="redistribution-preservation">As somas de <strong>gains_distribuidos</strong> e do <strong>lucro reinvestido</strong> dos slots fechados serao preservadas exatamente. Slots abertos nao serao alterados e <strong>slots.gains</strong> financeiro/historico nao sera alterado.</p>
            <div className="redistribution-table-wrap">
              <table className="redistribution-table">
                <thead><tr><th>Slot</th><th>Status</th><th>Papel</th><th>Gains</th><th>Lucro reinvestido</th><th>Valor operacional</th></tr></thead>
                <tbody>
                  {preview.closed_slots.map((slot) => (
                    <tr key={slot.slot_id}>
                      <td>#{slot.slot_number}</td>
                      <td>{slot.status}</td>
                      <td>{getRoleLabel(slot)}</td>
                      <td>{slot.gains_before} → {slot.gains_after}</td>
                      <td>{formatUsdt(Number(slot.reinvested_profit_before || 0))} → {formatUsdt(Number(slot.reinvested_profit_after || 0))}</td>
                      <td>{formatUsdt(Number(slot.operational_slot_value_before || slot.base_value || 0))} → {formatUsdt(Number(slot.operational_slot_value_after || slot.base_value || 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="redistribution-excluded">
              Abertos ignorados: {ignoredOpenSlots.length ? ignoredOpenSlots.map((slot) => `#${slot.slot_number} (${slot.status})`).join(", ") : "nenhum"}.
            </p>
            <footer>
              <button type="button" className="ghost-button" onClick={() => { setPreview(null); confirmationKeyRef.current = null; }} disabled={confirming}>Cancelar</button>
              <button type="button" className="solid-button" onClick={confirm} disabled={confirming}>
                {confirming ? "Redistribuindo..." : "Confirmar redistribuicao"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

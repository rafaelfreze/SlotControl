"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  confirmGainRedistribution,
  getGainRedistributionPreview,
  undoLastGainRedistribution
} from "@/app/dashboard/actions";

type Asset = "BTC" | "SOL";

type SlotSummary = {
  id: string;
  slot_number: number;
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
  selection_reason: "OPEN_SLOT" | "CLOSED_LOWEST_GAIN";
};

type Preview = {
  ok: true;
  asset: Asset;
  target_slot_count: number;
  open_slot_count: number;
  closed_slot_count: number;
  total_gains_before: number;
  total_gains_after: number;
  base_gain: number;
  remainder_gain: number;
  snapshot_hash: string;
  selected_slots: PreviewSlot[];
};

type ActionResult = {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
};

function isPreview(value: ActionResult): value is Preview {
  return value.ok && typeof value.snapshot_hash === "string" && Array.isArray(value.selected_slots);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function gainValue(slot: SlotSummary) {
  return Number.isInteger(slot.gains_distribuidos) ? slot.gains_distribuidos : slot.gains;
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
  const target = asset === "BTC" ? 15 : 6;
  const assetHistory = history.filter((item) => item.asset === asset);
  const undoCandidate = assetHistory.find((item) => item.action_type === "REDISTRIBUTION" && item.status === "COMPLETED") || null;
  const excludedSlots = useMemo(() => {
    const selectedIds = new Set(preview?.selected_slots.map((slot) => slot.slot_id) || []);
    return slots.filter((slot) => !selectedIds.has(slot.id));
  }, [preview, slots]);

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
  }

  async function confirm() {
    if (!preview || confirming) return;

    setConfirming(true);
    setError(null);
    const result = (await confirmGainRedistribution({
      asset,
      snapshotHash: preview.snapshot_hash,
      idempotencyKey: crypto.randomUUID()
    })) as ActionResult;
    setConfirming(false);

    if (!result.ok) {
      setError(result.message || "Nao foi possivel concluir a redistribuicao.");
      if (result.code === "PREVIEW_STALE") setPreview(null);
      return;
    }

    setPreview(null);
    onNotice(result.message || `Gains redistribuidos com sucesso entre ${target} slots de ${asset}.`);
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
          <p>Contador operacional</p>
          <h2>Redistribuir gains</h2>
          <small>Equilibra {target} slots de {asset} sem alterar os gains financeiros, valores, precos ou status.</small>
        </div>
        <button type="button" className="solid-button" onClick={openPreview} disabled={loadingPreview || confirming}>
          {loadingPreview ? "Gerando previa..." : "Redistribuir gains"}
        </button>
      </div>

      {error ? <p className="inline-alert redistribution-error">{error}</p> : null}

      <details className="redistribution-history">
        <summary>Historico de redistribuicoes ({assetHistory.length})</summary>
        <div className="redistribution-history-list">
          {undoCandidate ? (
            <button type="button" className="ghost-button compact-action" onClick={undo} disabled={undoing}>
              {undoing ? "Desfazendo..." : "Desfazer ultima redistribuicao"}
            </button>
          ) : null}
          {assetHistory.map((item) => (
            <details key={item.id} className="redistribution-history-item">
              <summary>
                {formatDate(item.created_at)} · {item.action_type === "UNDO" ? "Desfazer" : "Redistribuicao"} · {item.total_gains_before} gains · {item.status}
              </summary>
              <p>Usuario: voce · {item.target_slot_count} slots · total preservado: {item.total_gains_before} → {item.total_gains_after}</p>
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
                <h2>{asset} · {target} slots</h2>
              </div>
              <button type="button" className="ghost-button compact-action" onClick={() => setPreview(null)} disabled={confirming}>Cancelar</button>
            </header>
            <div className="redistribution-metrics">
              <span>Abertos incluidos<strong>{preview.open_slot_count}</strong></span>
              <span>Fechados incluidos<strong>{preview.closed_slot_count}</strong></span>
              <span>Total antes<strong>{preview.total_gains_before}</strong></span>
              <span>Base por slot<strong>{preview.base_gain}</strong></span>
              <span>Sobra<strong>{preview.remainder_gain}</strong></span>
              <span>Total depois<strong>{preview.total_gains_after}</strong></span>
            </div>
            <p className="redistribution-preservation">A soma dos gains operacionais sera preservada exatamente. Nenhum valor financeiro sera alterado.</p>
            <div className="redistribution-table-wrap">
              <table className="redistribution-table">
                <thead><tr><th>Slot</th><th>Status</th><th>Motivo</th><th>Antes</th><th>Depois</th></tr></thead>
                <tbody>
                  {preview.selected_slots.map((slot) => (
                    <tr key={slot.slot_id}>
                      <td>#{slot.slot_number}</td>
                      <td>{slot.status}</td>
                      <td>{slot.selection_reason === "OPEN_SLOT" ? "Aberto" : "Fechado com menor gain"}</td>
                      <td>{slot.gains_before}</td>
                      <td>{slot.gains_after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="redistribution-excluded">
              Fora desta redistribuicao: {excludedSlots.length ? excludedSlots.map((slot) => `#${slot.slot_number} (${gainValue(slot)})`).join(", ") : "nenhum"}.
            </p>
            <footer>
              <button type="button" className="ghost-button" onClick={() => setPreview(null)} disabled={confirming}>Cancelar</button>
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

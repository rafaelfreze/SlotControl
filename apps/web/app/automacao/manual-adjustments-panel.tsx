"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { AdjustmentEnvironment } from "@/lib/execution/manual-adjustments";
import { confirmCoinOpsManualAdjustment, previewCoinOpsManualAdjustment,
  previewCoinOpsManualReversal, reverseCoinOpsManualAdjustment,
  type AdjustmentDraft, type AdjustmentPreviewResult } from "./manual-adjustment-actions";
import "./manual-adjustments.css";

export type RecentManualAdjustment = {
  id: string; environment: AdjustmentEnvironment; asset: "BTC" | "SOL"; slot_number: number;
  kind: "MANUAL_TARGET_GAIN" | "MANUAL_CONTRIBUTION" | "REVERSAL";
  gain_units: number; currency: "USD" | "BRL"; original_amount: number | string;
  converted_amount_usdc: number | string; created_at: string; reversal_of: string | null;
  reason: string;
};
const newKey = () => crypto.randomUUID();
const numeric = (value: string) => Number(value.replace(",", "."));
const money = (value: number | string, digits = 4) => Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits });
const date = (value: string) => new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Campo_Grande" }).format(new Date(value));
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir. Confira o preview e tente novamente.";

export function ManualAdjustmentsPanel({ recent, initial }: {
  recent: RecentManualAdjustment[]; initial?: { environment: AdjustmentEnvironment; asset: "BTC" | "SOL"; slotNumber: number } | null;
}) {
  const router = useRouter();
  const [environment, setEnvironment] = useState<AdjustmentEnvironment>(initial?.environment ?? "SHADOW");
  const [asset, setAsset] = useState<"BTC" | "SOL">(initial?.asset ?? "BTC");
  const [slotNumber, setSlotNumber] = useState(initial?.slotNumber ?? 1);
  const [kind, setKind] = useState<AdjustmentDraft["kind"]>("MANUAL_TARGET_GAIN");
  const [gainUnits, setGainUnits] = useState("1");
  const [gainAmount, setGainAmount] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"USD" | "BRL">("USD");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [key, setKey] = useState(newKey);
  const [preview, setPreview] = useState<AdjustmentPreviewResult | null>(null);
  const [previewDraft, setPreviewDraft] = useState<AdjustmentDraft | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reversePreview, setReversePreview] = useState<Awaited<ReturnType<typeof previewCoinOpsManualReversal>> | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseKey, setReverseKey] = useState(newKey);
  const [pending, startTransition] = useTransition();
  const invalidate = () => { setPreview(null); setPreviewDraft(null); setDone(null); setError(null); setKey(newKey()); };
  const makeDraft = (): AdjustmentDraft => ({ environment, asset, slotNumber, kind,
    ...(kind === "MANUAL_TARGET_GAIN" ? { gainUnits: numeric(gainUnits),
      ...(gainAmount.trim() ? { explicitGainAmountUsdc: numeric(gainAmount) } : {}) }
      : { currency, amount: numeric(amount) }),
    reason: reason.trim(), note: note.trim(), idempotencyKey: key });
  const runPreview = () => {
    setError(null); setDone(null);
    const draft = makeDraft();
    startTransition(async () => {
      try {
        const result = await previewCoinOpsManualAdjustment(draft);
        setPreview(result); setPreviewDraft(draft);
      } catch (cause) { setPreview(null); setError(errorMessage(cause)); }
    });
  };
  const runConfirm = () => {
    if (!preview || !previewDraft || done) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await confirmCoinOpsManualAdjustment(previewDraft, preview);
        setDone(`Ajuste ${result.id.slice(0, 8)} registrado. Novo saldo: ${money(result.balanceAfterUsdc)} USDC.`);
        router.refresh();
      } catch (cause) { setError(errorMessage(cause)); setPreview(null); }
    });
  };
  const runReversePreview = (id: string) => {
    setReversePreview(null); setReverseReason(""); setError(null); setReverseKey(newKey());
    startTransition(async () => {
      try { setReversePreview(await previewCoinOpsManualReversal(id)); }
      catch (cause) { setError(errorMessage(cause)); }
    });
  };
  const runReverse = () => {
    if (!reversePreview) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await reverseCoinOpsManualAdjustment({ adjustmentId: reversePreview.adjustmentId,
          reason: reverseReason, idempotencyKey: reverseKey }, reversePreview.snapshot);
        setDone(`Estorno ${result.id.slice(0, 8)} registrado no ledger.`);
        setReversePreview(null);
        router.refresh();
      } catch (cause) { setError(errorMessage(cause)); }
    });
  };
  const reversedIds = new Set(recent.filter((row) => row.reversal_of).map((row) => row.reversal_of));
  return <details id="manual-adjustments" className="ma-panel" open={Boolean(initial) || undefined}>
    <summary><span><strong>Ajustes manuais por slot</strong><small>Gain para meta ou aporte · Shadow, Testnet e Real preparado</small></span><span aria-hidden="true">⌄</span></summary>
    <div className="ma-body">
      <p className="ma-notice">Ajuste de ledger, não é trade. Nenhuma transferência ou conversão é executada na Binance. Production permanece somente leitura e LIVE bloqueado.</p>
      <div className="ma-grid">
        <label>Ambiente<select value={environment} onChange={(event) => { setEnvironment(event.target.value as AdjustmentEnvironment); invalidate(); }}><option value="SHADOW">Shadow virtual</option><option value="TESTNET">Testnet fictício</option><option value="REAL">Real preparado (sem LIVE)</option></select></label>
        <label>Ativo<select value={asset} onChange={(event) => { setAsset(event.target.value as "BTC" | "SOL"); invalidate(); }}><option value="BTC">BTC</option><option value="SOL">SOL</option></select></label>
        <label>Slot físico<select value={slotNumber} onChange={(event) => { setSlotNumber(Number(event.target.value)); invalidate(); }}>{Array.from({ length: 25 }, (_, i) => <option key={i + 1} value={i + 1}>#{i + 1}</option>)}</select></label>
        <label>Ação<select value={kind} onChange={(event) => { setKind(event.target.value as AdjustmentDraft["kind"]); invalidate(); }}><option value="MANUAL_TARGET_GAIN">Adicionar gain manual</option><option value="MANUAL_CONTRIBUTION">Adicionar aporte</option></select></label>
        {kind === "MANUAL_TARGET_GAIN" ? <>
          <label>Quantidade de gains<input type="number" min="1" max="25" step="1" value={gainUnits} onChange={(event) => { setGainUnits(event.target.value); invalidate(); }} /></label>
          <label>Valor exato em USD (opcional)<input type="number" min="0.00000001" step="any" value={gainAmount} onChange={(event) => { setGainAmount(event.target.value); invalidate(); }} placeholder="Calculado pela taxa vigente" /></label>
        </> : <>
          <label>Moeda<select value={currency} onChange={(event) => { setCurrency(event.target.value as "USD" | "BRL"); invalidate(); }}><option value="USD">USD → saldo USDC</option><option value="BRL">BRL → USDC com câmbio real</option></select></label>
          <label>Valor em {currency}<input type="number" min="0.01" step="any" value={amount} onChange={(event) => { setAmount(event.target.value); invalidate(); }} /></label>
        </>}
        <label>Motivo<input maxLength={160} value={reason} onChange={(event) => { setReason(event.target.value); invalidate(); }} placeholder="Ex.: ajuste operacional" /></label>
        <label>Observação (opcional)<input maxLength={500} value={note} onChange={(event) => { setNote(event.target.value); invalidate(); }} /></label>
      </div>
      <div className="ma-actions"><button type="button" onClick={runPreview} disabled={pending}>Conferir preview</button>{preview && !done ? <button type="button" className="ma-confirm" onClick={runConfirm} disabled={pending}>Confirmar ajuste</button> : null}</div>
      {preview ? <div className="ma-preview" aria-live="polite"><strong>Preview · {preview.snapshot.entryState} · Slot físico #{slotNumber}</strong>
        <div><span>Saldo</span><b>{money(preview.preview.balanceBeforeUsdc)} → {money(preview.preview.balanceAfterUsdc)} USDC</b></div>
        <div><span>Crédito</span><b>+{money(preview.preview.convertedAmountUsdc, 8)} USDC</b></div>
        <div><span>Meta do mês</span><b>{preview.preview.monthlyBefore}/{preview.preview.monthlyTarget} → {preview.preview.monthlyAfter}/{preview.preview.monthlyTarget}{preview.preview.targetReachedAfter ? " · META BATIDA" : ""}</b></div>
        <div><span>Gains totais</span><b>{preview.preview.lifetimeBefore} → {preview.preview.lifetimeAfter}</b></div>
        {preview.preview.fx ? <div><span>Câmbio</span><b>R$ {money(preview.preview.originalAmount, 2)} ≈ {money(preview.preview.convertedAmountUsdc, 8)} USDC · {money(preview.preview.fx.rateBrlPerUsdc, 6)} BRL/USDC · Binance Spot {date(preview.preview.fx.observedAt)}</b></div> : null}
        {preview.preview.committedNotionalUsdc !== null ? <p>Posição OPEN comprometida: {money(preview.preview.committedNotionalUsdc)} USDC. Entrada, quantidade, TP e ordem atuais não mudam. O saldo ajustado vale somente na próxima operação após o fechamento.</p>
          : <p>Saldo destinado à próxima operação; nenhuma ordem é criada por este ajuste.</p>}
        {kind === "MANUAL_TARGET_GAIN" ? <p>Gain manual conta para meta/rank, separado do lucro de mercado.</p> : <p>Aporte não incrementa gain e não movimenta dinheiro automaticamente.</p>}
      </div> : null}
      {error ? <p className="ma-error" role="alert">{error}</p> : null}
      {done ? <p className="ma-success" role="status">{done} <button type="button" onClick={invalidate}>Novo ajuste</button></p> : null}
      <details className="ma-history"><summary>Histórico recente e estornos ({recent.length})</summary>
        {recent.length ? <ol>{recent.map((row) => <li key={row.id}><span>{date(row.created_at)} · {row.environment} {row.asset} #{row.slot_number}<br /><strong>{row.kind === "MANUAL_TARGET_GAIN" ? `+${row.gain_units} gain manual` : row.kind === "MANUAL_CONTRIBUTION" ? "Aporte" : "Estorno"}</strong> · {money(row.converted_amount_usdc, 8)} USDC{row.reversal_of ? ` · ref. ${row.reversal_of.slice(0, 8)}` : ""}</span>
          {row.kind !== "REVERSAL" && !reversedIds.has(row.id) ? <button type="button" disabled={pending} onClick={() => runReversePreview(row.id)}>Revisar estorno</button> : null}</li>)}</ol> : <p>Nenhum ajuste manual registrado.</p>}
        {reversePreview ? <div className="ma-preview"><strong>Preview do estorno · #{reversePreview.snapshot.physicalSlotNumber} {reversePreview.snapshot.asset}</strong>
          <div><span>Saldo</span><b>{money(reversePreview.snapshot.balanceUsdc)} → {money(reversePreview.balanceAfterUsdc)} USDC</b></div>
          <div><span>Meta do mês</span><b>{reversePreview.snapshot.monthlyGainCount} → {reversePreview.monthlyAfter}</b></div>
          <div><span>Gains totais</span><b>{reversePreview.snapshot.lifetimeGainCount} → {reversePreview.lifetimeAfter}</b></div>
          <p>O original permanece no histórico; o estorno cria um novo lançamento vinculado. Posição OPEN e ordens não mudam.</p>
          <label>Motivo do estorno<input value={reverseReason} maxLength={160} onChange={(event) => setReverseReason(event.target.value)} /></label>
          <div className="ma-actions"><button type="button" onClick={() => setReversePreview(null)}>Cancelar</button><button type="button" className="ma-confirm" disabled={pending || reverseReason.trim().length < 3} onClick={runReverse}>Confirmar estorno</button></div>
        </div> : null}
      </details>
    </div>
  </details>;
}

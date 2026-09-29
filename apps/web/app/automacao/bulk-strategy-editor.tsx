"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountSelector } from "./account-selector";
import { accountOptions } from "./account-selector-model";
import { selectBulkEngineIds } from "./bulk-strategy-selection";
import type { PremiumOperatorPresentation } from "./premium-operator";

type PreviewRow = { engineId: string; account: string; symbol: string; versionBefore: number | null;
  oldRate: number | null; newRate: number; regime: string | null; openPositions: number;
  activeTps: number; residentBuys: number; preparedBuys: number; partialBuys: number; reasons: string[] };
type Preview = { status: string; accountCount: number; engineCount: number; rows: PreviewRow[];
  previewHash: string; canApply: boolean; changed: string; preserved: string; rollbackOf: string | null };
type Progress = { batch: { id: string; status: string; rollback_of: string | null };
  engines: Array<{ trading_engine_id: string; symbol: string; status: string; error_code: string | null }>;
  counts: { selected: number; applied: number; pending: number; blocked: number; failed: number } };
type ActiveBatch = { id: string; status: string; created_at: string; admission_cursor: number;
  selected_count: number; rollback_of: string | null };

const pct = (rate: number | null) => rate === null ? "—" : `${(rate * 100).toLocaleString("pt-BR", { maximumFractionDigits: 4 })}%`;

export function BulkStrategyEditor({ operator }: { operator: PremiumOperatorPresentation }) {
  const engines = useMemo(() => operator.engines.filter((engine) => engine.environment === "REAL"), [operator.engines]);
  const options = useMemo(() => accountOptions(operator.accounts, engines), [operator.accounts, engines]);
  const shards = useMemo(() => [...new Set(operator.accounts.map((account) => account.shardId).filter((id): id is string => !!id))].sort(), [operator.accounts]);
  const [selected, setSelected] = useState<string[]>([]);
  const [percent, setPercent] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const [previewLimit, setPreviewLimit] = useState(40);
  const [progressLimit, setProgressLimit] = useState(40);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rollbackOf, setRollbackOf] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pendingAdmission, setPendingAdmission] = useState<ActiveBatch | null>(null);
  const [recentBatches, setRecentBatches] = useState<ActiveBatch[]>([]);
  const [admissionProgress, setAdmissionProgress] = useState<{ admitted: number; selected: number } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => engines.filter((engine) => `${engine.accountDisplayName} ${engine.symbol} ${engine.engineId}`
    .toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR"))), [engines, query]);
  const setScope = (ids: string[]) => { setSelected(ids); setPreview(null); setRollbackOf(null); setProgress(null); setError(""); };
  const call = useCallback(async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/coinops-bulk-strategy", { method: "POST", cache: "no-store",
      credentials: "same-origin", headers: { "content-type": "application/json",
        "x-coinops-admin-intent": "bulk-strategy" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "COINOPS_BULK_REQUEST_FAILED");
    return result;
  }, []);
  const loadProgress = useCallback(async (batchId: string) => {
    const response = await fetch(`/api/coinops-bulk-strategy?batch=${encodeURIComponent(batchId)}`,
      { cache: "no-store", credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "COINOPS_BULK_STATUS_FAILED");
    return result as Progress;
  }, []);
  const previewChange = async (rollbackId?: string) => {
    setWorking(true); setError(""); setProgress(null);
    try {
      const isRollback = !!rollbackId;
      const result = await call(isRollback ? { action: "rollback_preview", rollbackOf: rollbackId }
        : { action: "preview", engineIds: selected, postAthPercent: percent });
      setPreview(result as Preview);
      setPreviewLimit(40);
      setRollbackOf(rollbackId ?? null);
      setRequestId(crypto.randomUUID());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "COINOPS_BULK_PREVIEW_FAILED"); }
    finally { setWorking(false); }
  };
  const apply = async () => {
    if (!preview?.canApply || !requestId || working) return;
    setWorking(true); setError("");
    try {
      const payload = rollbackOf ? { action: "rollback_apply", rollbackOf,
        previewHash: preview.previewHash, requestId }
        : { action: "apply", engineIds: selected, postAthPercent: percent,
          previewHash: preview.previewHash, requestId };
      let result: { batchId: string; status: string; selected: number; admitted: number; failed: number };
      let previous = -1;
      do {
        result = await call(payload);
        if (result.admitted <= previous && result.admitted < result.selected)
          throw new Error("COINOPS_BULK_ADMISSION_STALLED");
        previous = result.admitted;
        setAdmissionProgress({ admitted: result.admitted, selected: result.selected });
        setProgress({ batch: { id: result.batchId, status: result.status, rollback_of: rollbackOf },
          engines: [], counts: { selected: result.selected, applied: 0,
            pending: result.selected - result.failed, blocked: 0, failed: result.failed } });
      } while (result.admitted < result.selected);
      setPreview(null);
      setAdmissionProgress(null);
      setPendingAdmission(null);
      setProgressLimit(40);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "COINOPS_BULK_APPLY_FAILED"); }
    finally { setWorking(false); }
  };
  useEffect(() => {
    const batchId = progress?.batch.id;
    if (!batchId || ["APPLIED", "PARTIAL", "BLOCKED_SAFE"].includes(progress.batch.status)) return;
    let stopped = false;
    const load = async () => {
      try {
        const result = await loadProgress(batchId);
        if (!stopped) setProgress(result);
      } catch (cause) { if (!stopped) setError(cause instanceof Error
        ? cause.message : "COINOPS_BULK_STATUS_UNAVAILABLE"); }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 10_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [loadProgress, progress?.batch.id, progress?.batch.status]);
  useEffect(() => {
    let stopped = false;
    const recoverVisibleState = async () => {
      try {
        const response = await fetch("/api/coinops-bulk-strategy", {
          cache: "no-store", credentials: "same-origin",
        });
        const result = await response.json() as { activeBatches?: ActiveBatch[]; recentBatches?: ActiveBatch[];
          pendingAdmissions?: ActiveBatch[]; error?: string };
        if (!response.ok) throw new Error(result.error || "COINOPS_BULK_RECOVERY_READ_FAILED");
        const latest = result.activeBatches?.[0];
        if (latest) {
          const latestProgress = await loadProgress(latest.id);
          if (!stopped) setProgress(latestProgress);
        }
        if (!stopped) setRecentBatches(result.recentBatches ?? []);
        if (!stopped) setPendingAdmission(result.pendingAdmissions?.[0] ?? null);
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : "COINOPS_BULK_RECOVERY_FAILED");
      }
    };
    void recoverVisibleState();
    return () => { stopped = true; };
  }, [loadProgress]);
  const resumeAdmission = async () => {
    if (!pendingAdmission || working) return;
    setWorking(true); setError("");
    try {
      let admitted = Number(pendingAdmission.admission_cursor), previous = -1;
      while (admitted < Number(pendingAdmission.selected_count)) {
        const resumed = await call({ action: "resume", batchId: pendingAdmission.id }) as {
          admitted: number; selected: number; failed: number };
        if (resumed.admitted <= previous && resumed.admitted < resumed.selected)
          throw new Error("COINOPS_BULK_ADMISSION_STALLED");
        previous = resumed.admitted; admitted = resumed.admitted;
        setAdmissionProgress({ admitted, selected: resumed.selected });
      }
      setPendingAdmission(null); setAdmissionProgress(null);
      setProgress(await loadProgress(pendingAdmission.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "COINOPS_BULK_RESUME_FAILED"); }
    finally { setWorking(false); }
  };
  const openBatch = async (batchId: string) => {
    setError("");
    try { setProgress(await loadProgress(batchId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "COINOPS_BULK_STATUS_UNAVAILABLE"); }
  };
  return <section className="px-bulk-editor" aria-label="Editar motores em massa">
    <details><summary>Editar motores em massa</summary>
      <p>Somente ADMIN. Prévia sem ordens; a confirmação agenda cada motor no reconciliador oficial.</p>
      {pendingAdmission ? <div className="px-bulk-progress" role="status">
        <strong>Aplicação confirmada interrompida</strong>
        <p>{pendingAdmission.admission_cursor}/{pendingAdmission.selected_count} motores admitidos. Nenhuma retomada ocorre sem sua ação.</p>
        <button type="button" disabled={working} onClick={() => void resumeAdmission()}>
          Retomar aplicação confirmada</button>
      </div> : null}
      {recentBatches.length ? <details className="px-bulk-history"><summary>Histórico de alterações</summary>
        {recentBatches.map((batch) => <div key={batch.id}>
          <span>{new Date(batch.created_at).toLocaleString("pt-BR")} · {batch.status} · {batch.selected_count} motores</span>
          <button type="button" onClick={() => void openBatch(batch.id)}>Abrir resultado</button>
          {["APPLIED", "PARTIAL"].includes(batch.status) ? <button type="button" disabled={working}
            onClick={() => void previewChange(batch.id)}>Pré-visualizar rollback</button> : null}
        </div>)}
      </details> : null}
      <div className="px-bulk-actions">
        <button type="button" onClick={() => setScope(selectBulkEngineIds(engines, operator.accounts,
          { kind: "ALL" }))}>Selecionar todos</button>
        <button type="button" onClick={() => setScope([])}>Limpar seleção</button>
        {(["BTC", "SOL"] as const).map((asset) => <button type="button" key={asset}
          onClick={() => setScope(selectBulkEngineIds(engines, operator.accounts,
            { kind: "ASSET", value: asset }))}>Somente {asset}</button>)}
        <button type="button" onClick={() => setScope(selectBulkEngineIds(engines, operator.accounts,
          { kind: "OPERATIONAL" }))}>Somente operacionais</button>
        {shards.map((shard) => <button type="button" key={shard}
          onClick={() => setScope(selectBulkEngineIds(engines, operator.accounts,
            { kind: "SHARD", value: shard }))}>{shard}</button>)}
      </div>
      <AccountSelector options={options} value="ALL" allLabel="Adicionar conta" includeAll={false}
        label="Adicionar motores de uma conta" onChange={(accountId) => setScope([...new Set([...selected,
          ...selectBulkEngineIds(engines, operator.accounts, { kind: "ACCOUNT", value: accountId })])])} />
      <label className="px-bulk-search">Pesquisar motor<input type="search" value={query} placeholder="Conta, mercado ou identificador"
        onChange={(event) => { setQuery(event.target.value); setLimit(40); }} /></label>
      <div className="px-bulk-engine-list">{filtered.slice(0, limit).map((engine) => <label key={engine.engineId}>
        <input type="checkbox" checked={selectedSet.has(engine.engineId)} onChange={(event) => setScope(event.target.checked
          ? [...selected, engine.engineId] : selected.filter((id) => id !== engine.engineId))} />
        <span>{engine.accountDisplayName} · {engine.symbol}<small>{engine.health.label}</small></span>
      </label>)}</div>
      {filtered.length > limit ? <button type="button" onClick={() => setLimit((current) => current + 40)}>Mostrar mais ({filtered.length - limit})</button> : null}
      <p>{selected.length} motor(es) selecionado(s) · {new Set(engines.filter((engine) => selectedSet.has(engine.engineId))
        .map((engine) => engine.accountId)).size} conta(s)</p>
      <label className="px-bulk-rate">Spacing pós-ATH novo (%)<input type="text" inputMode="decimal" value={percent}
        placeholder="Ex.: 5" onChange={(event) => { setPercent(event.target.value); setPreview(null); setError(""); }} /></label>
      <button type="button" disabled={working || !selected.length || !percent} onClick={() => void previewChange()}>Pré-visualizar · sem ordens</button>
      {preview ? <div className="px-bulk-preview" role="status"><h3>Prévia obrigatória</h3>
        <p>Escopo: {preview.accountCount} contas · {preview.engineCount} motores</p>
        <p><strong>O QUE SERÁ ALTERADO</strong><br />{preview.changed}</p>
        <p><strong>O QUE SERÁ PRESERVADO</strong><br />{preview.preserved}</p>
        <div className="px-bulk-preview-rows">{preview.rows.slice(0, previewLimit).map((row) => <div key={row.engineId}>
          <strong>{row.account} · {row.symbol}</strong><span>{pct(row.oldRate)} → {pct(row.newRate)} · v{row.versionBefore ?? "?"} → v{row.versionBefore === null ? "?" : row.versionBefore + 1}</span>
          <small>{row.openPositions} OPEN · {row.activeTps} TP · {row.residentBuys} BUY residente · {row.partialBuys} parcial · {row.preparedBuys} preparada · {row.regime}</small>
          {row.reasons.length ? <small className="px-warning">Não elegível: {row.reasons.join(", ")}</small> : null}
        </div>)}{preview.rows.length > previewLimit ? <button type="button"
          onClick={() => setPreviewLimit((current) => current + 40)}>Mostrar mais ({preview.rows.length - previewLimit})</button> : null}</div>
        <button type="button" disabled={working || !preview.canApply} onClick={() => void apply()}>
          Confirmar {rollbackOf ? "rollback da configuração" : "alteração em massa"}</button>
        {!preview.canApply ? <p className="px-warning">Remova os motores não elegíveis ou resolva o estado antes de confirmar.</p> : null}
      </div> : null}
      {progress ? <div className="px-bulk-progress" role="status"><h3>Batch {progress.batch.status}</h3>
        {admissionProgress ? <p>Admissão: {admissionProgress.admitted}/{admissionProgress.selected} motores processados.</p> : null}
        <p>{progress.counts.selected} selecionados · {progress.counts.applied} aplicados · {progress.counts.pending} pendentes · {progress.counts.blocked} bloqueados · {progress.counts.failed} falhas de admissão</p>
        <details><summary>Detalhes por motor</summary>{progress.engines.slice(0, progressLimit).map((item) => <p key={item.trading_engine_id}>
          {item.symbol} · {item.trading_engine_id.slice(0, 8)} · {item.status}{item.error_code ? ` · ${item.error_code}` : ""}</p>)}
          {progress.engines.length > progressLimit ? <button type="button"
            onClick={() => setProgressLimit((current) => current + 40)}>Mostrar mais ({progress.engines.length - progressLimit})</button> : null}</details>
        {progress.counts.applied > 0 ? <button type="button" disabled={working}
          onClick={() => void previewChange(progress.batch.id)}>Pré-visualizar rollback da configuração</button> : null}
      </div> : null}
      {error ? <p role="alert" className="px-warning">{error}</p> : null}
    </details>
  </section>;
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PremiumEngine } from "./premium-operator";
import type { AccountHomePreference } from "./account-home-visibility";
import "./account-pause-home-panel.css";

type PauseSnapshot = { accountId: string; hidden: boolean; canHide: boolean;
  engines: Array<{ engineId: string; symbol: string; executorShardId: string | null;
    runId: string | null; runStatus: string | null; entryEnabled: boolean }> };
const api = "/api/coinops-account-pause";

/** Account control deliberately lives outside market-specific controls. Every
 * financial request is user-confirmed and sequential, never retried on timeout. */
export function AccountPauseHomePanel({ selectedAccountId, accountName, engines, preference }: {
  selectedAccountId: string; accountName: string; engines: PremiumEngine[];
  preference?: AccountHomePreference }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const operational = engines.filter((engine) => engine.environment === "REAL" && engine.accountId === selectedAccountId
    && (engine.engineStatus === "ACTIVE" || ["ACTIVE", "PAUSED", "PREPARING"].includes(engine.status)));
  const protectedPause = operational.length > 0 && operational.every((engine) => engine.entryPauseProtected === true);
  const hasPausedEngine = operational.some((engine) => engine.status === "PAUSED");
  async function request(body?: Record<string, unknown>): Promise<PauseSnapshot> {
    const response = await fetch(body ? api : `${api}?account=${encodeURIComponent(selectedAccountId)}`, {
      method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
      signal: AbortSignal.timeout(60_000), ...(body ? { headers: { "content-type": "application/json",
        "x-coinops-admin-intent": "account-pause" }, body: JSON.stringify({ ...body, requestId: crypto.randomUUID() }) } : {}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "COINOPS_ACCOUNT_PAUSE_UNAVAILABLE");
    return payload;
  }
  async function resumeAndShow() {
    if (inFlight.current || !window.confirm(`Reativar a operação REAL de ${accountName} e reexibir a conta na tela inicial?\n\nOs motores pausados serão retomados um por vez pelo fluxo oficial, após conferir Binance, ledger, TPs e limites. As estratégias e posições existentes permanecem. Novas compras continuam exigindo saldo Spot e reserva BNB suficientes.`)) return;
    inFlight.current = true; setBusy(true); setFailed(false); setMessage("Conferindo os motores para reativar…");
    let confirmed = 0, total = 0, resumed = false;
    try {
      const snapshot = await request();
      const current = snapshot.engines;
      if (snapshot.accountId !== selectedAccountId || !Array.isArray(current) || !current.length
        || current.some((engine) => !engine.engineId || !engine.runId || !["ACTIVE", "PAUSED"].includes(engine.runStatus ?? ""))
        || new Set(current.map((engine) => engine.engineId)).size !== current.length)
        throw new Error("COINOPS_ACCOUNT_RESUME_SNAPSHOT_INVALID");
      const paused = current.filter((engine) => engine.runStatus === "PAUSED");
      total = paused.length;
      for (let index = 0; index < paused.length; index++) {
        const engine = paused[index];
        setMessage(`Reativando ${engine.symbol} · ${index + 1}/${paused.length}. Conferindo proteção e limites.`);
        // Never retry this mutation on timeout: the outcome must be read back.
        const response = await fetch("/api/coinops-engine-control", { method: "POST", cache: "no-store",
          credentials: "same-origin", signal: AbortSignal.timeout(60_000),
          headers: { "content-type": "application/json", "x-coinops-admin-intent": "engine-control" },
          body: JSON.stringify({ action: "RESUME", accountId: selectedAccountId, engineId: engine.engineId }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "COINOPS_ACCOUNT_RESUME_UNCONFIRMED");
        if (result.status !== "RESUMED" || result.cycle_id !== engine.runId)
          throw new Error("COINOPS_ACCOUNT_RESUME_UNCONFIRMED");
        confirmed++;
      }
      const verified = await request();
      if (verified.accountId !== selectedAccountId || !Array.isArray(verified.engines)
        || verified.engines.length !== current.length
        || new Set(verified.engines.map((engine) => engine.engineId)).size !== current.length
        || current.some((engine) => !verified.engines.some((item) => item.engineId === engine.engineId
          && item.runId === engine.runId && item.runStatus === "ACTIVE" && item.entryEnabled === true)))
        throw new Error("COINOPS_ACCOUNT_RESUME_READBACK_UNCONFIRMED");
      resumed = true;
      const visible = await request({ action: "SHOW", accountId: selectedAccountId });
      if (visible.accountId !== selectedAccountId || visible.hidden !== false)
        throw new Error("COINOPS_ACCOUNT_SHOW_UNCONFIRMED");
      setMessage("Operação reativada e conta reexibida na tela inicial. O worker mantém TPs e reconciliação e prepara a próxima BUY conforme estratégia, saldo e gates oficiais.");
    } catch (error) {
      setFailed(true);
      let readback = "Leitura de confirmação indisponível.";
      try {
        const current = await request();
        if (current.accountId === selectedAccountId && Array.isArray(current.engines)) {
          const active = current.engines.filter((engine) => engine.runStatus === "ACTIVE").length;
          const paused = current.engines.filter((engine) => engine.runStatus === "PAUSED").length;
          const enabled = current.engines.filter((engine) => engine.entryEnabled === true).length;
          readback = `Leitura atual: ${active} motor(es) ACTIVE e ${paused} PAUSED; ${enabled} com gates de entrada habilitados. Confira Estratégia e motores antes de repetir.`;
        }
      } catch { /* No mutation retry; an incomplete readback is never success. */ }
      setMessage(`${resumed ? "Retomada confirmada, mas a reexibição não foi confirmada." : `Reativação completa não confirmada (${confirmed}/${total} retomadas confirmadas). Motores já retomados não foram desfeitos.`} ${readback} Nenhum comando foi reenviado automaticamente. ${error instanceof Error ? error.message : "COINOPS_ACCOUNT_RESUME_UNAVAILABLE"}`);
    } finally { inFlight.current = false; setBusy(false); router.refresh(); }
  }
  async function pauseAndHide() {
    if (inFlight.current || !window.confirm(`Pausar novas compras de todos os motores de ${accountName} e ocultar esta conta da tela inicial?\n\nAs posições abertas, TPs e reconciliação continuam. A próxima BUY própria será cancelada pelo fluxo seguro. Não há venda de posições. A conta permanece no seletor e falhas de proteção continuam visíveis.`)) return;
    inFlight.current = true; setBusy(true); setFailed(false); setMessage("Conferindo os motores da conta…");
    try {
      const snapshot = await request();
      if (snapshot.accountId !== selectedAccountId || !Array.isArray(snapshot.engines))
        throw new Error("COINOPS_ACCOUNT_PAUSE_SCOPE_INVALID");
      const current = snapshot.engines;
      if (!current.length || current.some((engine) => !engine.engineId || !engine.runId
        || !["ACTIVE", "PAUSED"].includes(engine.runStatus ?? ""))
        || new Set(current.map((engine) => engine.engineId)).size !== current.length) throw new Error("COINOPS_ACCOUNT_PAUSE_NOT_READY");
      for (let index = 0; index < current.length; index++) {
        const engine = current[index];
        setMessage(`Pausando novas compras: ${engine.symbol} · ${index + 1}/${current.length}. TPs continuam protegidos.`);
        await request({ action: "PAUSE_ENGINE", accountId: selectedAccountId, engineId: engine.engineId, runId: engine.runId });
      }
      const result = await request({ action: "HIDE_PAUSED", accountId: selectedAccountId,
        expectedEngineIds: current.map((engine) => engine.engineId) });
      if (result.accountId !== selectedAccountId || result.hidden !== true)
        throw new Error("COINOPS_ACCOUNT_PAUSE_HIDE_UNCONFIRMED");
      setMessage("Novas compras pausadas. Conta oculta da tela inicial; posições e TPs continuam sob reconciliação. Acesse pelo seletor.");
    } catch (error) {
      setFailed(true); setMessage(`Pausa e ocultação não confirmadas. A conta permanece visível; confira o estado antes de repetir. ${error instanceof Error ? error.message : "COINOPS_ACCOUNT_PAUSE_UNAVAILABLE"}`);
    } finally { inFlight.current = false; setBusy(false); router.refresh(); }
  }
  async function show() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setFailed(false); setMessage("");
    try {
      const result = await request({ action: "SHOW", accountId: selectedAccountId });
      if (result.accountId !== selectedAccountId || result.hidden !== false)
        throw new Error("COINOPS_ACCOUNT_SHOW_UNCONFIRMED");
      setMessage("Conta reexibida na tela inicial. Isso não retoma novas compras; use Estratégia e motores para retomar pelo fluxo oficial.");
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Não foi possível reexibir a conta."); }
    finally { inFlight.current = false; setBusy(false); router.refresh(); }
  }
  return <section className="px-panel px-account-pause" aria-label={`Pausa e visibilidade · ${accountName}`}>
    <div><h2>{protectedPause ? "Novas compras pausadas" : "Controle da conta"}</h2>
      <p>{accountName} · {operational.length} motor(es). Posições abertas, TPs e histórico permanecem; nenhuma posição é vendida.</p>
      {preference?.hidden ? <small>Oculta da tela inicial quando a pausa e proteção estão confirmadas. Qualquer falha real volta a aparecer.</small>
        : <small>Pause novas compras e retire a conta do resumo. Acesso preservado pelo seletor acima.</small>}</div>
    <div className="px-account-pause-actions">
      {hasPausedEngine ? <button type="button" className="px-button px-button-primary" disabled={busy}
        onClick={() => void resumeAndShow()}>Reativar operação e reexibir na tela inicial</button> : null}
      <button type="button" className="px-button" disabled={busy || operational.length === 0} onClick={() => void pauseAndHide()}>
        {busy ? "Conferindo operação…" : "Pausar novas compras e ocultar da tela inicial"}</button>
      {preference?.hidden ? <button type="button" className="px-button" disabled={busy} onClick={() => void show()}>
        Reexibir na tela inicial · sem retomar compras</button> : null}
    </div>
    {message ? <p className={failed ? "px-account-pause-error" : "px-account-pause-message"} role={failed ? "alert" : "status"}>{message}</p> : null}
  </section>;
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PremiumEngine } from "./premium-operator";
import type { AccountHomePreference } from "./account-home-visibility";
import "./account-pause-home-panel.css";

type PauseSnapshot = { accountId: string; hidden: boolean; canHide: boolean;
  engines: Array<{ engineId: string; symbol: string; executorShardId: string | null;
    runId: string | null; runStatus: string | null }> };
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
      <button type="button" className="px-button" disabled={busy || operational.length === 0} onClick={() => void pauseAndHide()}>
        {busy ? "Conferindo operação…" : "Pausar novas compras e ocultar da tela inicial"}</button>
      {preference?.hidden ? <button type="button" className="px-button" disabled={busy} onClick={() => void show()}>
        Reexibir na tela inicial · sem retomar compras</button> : null}
    </div>
    {message ? <p className={failed ? "px-account-pause-error" : "px-account-pause-message"} role={failed ? "alert" : "status"}>{message}</p> : null}
  </section>;
}

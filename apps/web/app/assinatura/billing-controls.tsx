"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function BillingControls({ payable }: { payable: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"sync" | "checkout" | null>(null), [error, setError] = useState("");
  async function run(operation: "sync" | "checkout") {
    if (busy) return;
    setBusy(operation); setError("");
    try {
      const response = await fetch("/api/assinatura", { method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-coinops-billing-intent": "owner" }, body: JSON.stringify({ operation }) });
      const value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.error);
      if (operation === "checkout" && typeof value.url === "string") window.location.assign(value.url);
      else router.refresh();
    } catch (e) { setError(e instanceof Error && e.message === "billing_no_open_charge" ? "Não há cobrança aberta no momento." : "Não foi possível concluir. Tente novamente ou fale com a OnPlay."); }
    finally { setBusy(null); }
  }
  return <div className="saas-billing-controls"><button className="button secondary" disabled={!!busy} onClick={() => run("sync")}>{busy === "sync" ? "Atualizando…" : "Atualizar assinatura"}</button>{payable && <button className="button" disabled={!!busy} onClick={() => run("checkout")}>{busy === "checkout" ? "Abrindo…" : "Ver cobrança e pagar"}</button>}{error && <p role="alert">{error}</p>}</div>;
}

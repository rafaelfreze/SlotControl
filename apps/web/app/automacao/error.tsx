"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { claimAutomationReadRecovery, planAutomationReadRecovery } from "./automation-read-recovery";

export default function AutomationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [attempt, setAttempt] = useState<number | "manual" | null>(null);
  const timer = useRef<number | undefined>();
  const refreshing = useRef(false);
  const previousError = useRef(error);
  const sawPending = useRef(false);
  useEffect(() => {
    if (isPending) { sawPending.current = true; return; }
    if (previousError.current !== error || sawPending.current) refreshing.current = false;
    previousError.current = error; sawPending.current = false;
    // A new failed RSC response can retain this component and the same digest.
    // Rearm the in-flight guard, never the persisted episode attempt budget.
  }, [error, isPending]);
  const refresh = useCallback(() => {
    if (refreshing.current || isPending) return;
    refreshing.current = true;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    // Next 14's boundary reset only clears client error state. Refresh also
    // requests a fresh RSC GET instead of rendering the cached failed payload.
    startTransition(() => { router.refresh(); reset(); });
  }, [router, reset, startTransition, isPending]);
  useEffect(() => {
    const schedule = () => {
      if (refreshing.current || isPending || timer.current !== undefined || !window.navigator.onLine
        || document.visibilityState !== "visible") return;
      let plan: ReturnType<typeof planAutomationReadRecovery>;
      try { plan = planAutomationReadRecovery(window.sessionStorage, window.location.pathname, error.digest); }
      catch { return; }
      if (!plan) return;
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        if (!window.navigator.onLine || document.visibilityState !== "visible") return;
        let claimed = false;
        try { claimed = claimAutomationReadRecovery(window.sessionStorage, window.location.pathname, error.digest); }
        catch { return; }
        if (!claimed) return;
        setAttempt(plan.attempt); refresh();
      }, plan.delay);
    };
    schedule();
    window.addEventListener("online", schedule);
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      window.removeEventListener("online", schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [error, isPending, refresh]);

  return <main style={{ minHeight: "100vh", padding: "clamp(24px, 5vw, 64px)", background: "#07121d", color: "#e9f4ff" }}>
    <section role="alert" style={{ maxWidth: 560, margin: "15vh auto 0", padding: 28,
      border: "1px solid #31516a", borderRadius: 18, background: "#0c1e2d" }}>
      <h1 style={{ marginTop: 0 }}>Automação temporariamente indisponível</h1>
      <p>A leitura do painel falhou. O estado operacional não está confirmado nesta tela; não interprete dados anteriores como atuais.</p>
      <p>O executor opera no servidor, independentemente desta página.</p>
      {attempt !== null ? <p role="status">{attempt === "manual" ? "Solicitando uma nova leitura do painel…"
        : `Reconectando o painel · tentativa ${attempt} de 2…`}</p> : null}
      <button type="button" disabled={isPending} onClick={() => { setAttempt("manual"); refresh(); }} style={{ minHeight: 44, marginTop: 12, padding: "0 20px",
        border: "1px solid #3bb8ff", borderRadius: 10, background: "#12334c", color: "#e9f4ff", cursor: "pointer" }}>
        Tentar novamente
      </button>
    </section>
  </main>;
}

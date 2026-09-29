"use client";

import { useEffect } from "react";

export default function AutomationError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // A PWA resumed after a transient server failure can keep this boundary on
    // screen even after Production recovers. Retry once per tab, never in a
    // loop; a persistent failure remains explicit and keeps the manual action.
    const key = "coinops-automation-auto-retry-v1";
    try {
      if (window.sessionStorage.getItem(key) === "1") return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Storage can be unavailable in a restricted browser context. Keep the
      // explicit manual retry instead of risking an unbounded remount loop.
      return;
    }

    let timer: number | undefined;
    const retry = () => reset();
    if (window.navigator.onLine) timer = window.setTimeout(retry, 600);
    else window.addEventListener("online", retry, { once: true });

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("online", retry);
    };
  }, [reset]);

  return <main style={{ minHeight: "100vh", padding: "clamp(24px, 5vw, 64px)", background: "#07121d", color: "#e9f4ff" }}>
    <section role="alert" style={{ maxWidth: 560, margin: "15vh auto 0", padding: 28,
      border: "1px solid #31516a", borderRadius: 18, background: "#0c1e2d" }}>
      <h1 style={{ marginTop: 0 }}>Automação temporariamente indisponível</h1>
      <p>A leitura do painel falhou. O estado operacional não está confirmado nesta tela; não interprete dados anteriores como atuais.</p>
      <p>O executor opera no servidor, independentemente desta página.</p>
      <button type="button" onClick={reset} style={{ minHeight: 44, marginTop: 12, padding: "0 20px",
        border: "1px solid #3bb8ff", borderRadius: 10, background: "#12334c", color: "#e9f4ff", cursor: "pointer" }}>
        Tentar novamente
      </button>
    </section>
  </main>;
}

"use client";

export default function AutomationError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
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

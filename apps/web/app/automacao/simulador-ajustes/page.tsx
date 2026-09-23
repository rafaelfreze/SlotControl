import { redirect } from "next/navigation";

import { simulateManualAdjustments } from "@/lib/execution/manual-adjustment-simulator";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import "../simulador-ath/simulator.css";

export const metadata = { title: "Simulador de ajustes | CoinOps" };
export const dynamic = "force-dynamic";

export default async function ManualAdjustmentsSimulatorPage() {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId()) throw new Error("COINOPS_MANUAL_SIM_SCOPE_INVALID");
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) redirect("/login");
  const scenarios = simulateManualAdjustments();
  return <main className="ath-simulator"><header><a href="/automacao">← Automação</a>
    <span>COINOPS · FASE 4.4 · LAB ISOLADO</span><h1>Simulador de ajustes manuais</h1>
    <p>Cenários contábeis determinísticos A–J. Não consulta exchange, não registra gain/aporte e não altera Shadow, Testnet ou Production.</p>
  </header><section className="ath-sim-panel"><h2>{scenarios.filter((item) => item.passed).length}/{scenarios.length} cenários aprovados</h2>
    <ol>{scenarios.map((item) => <li key={item.code} style={{ marginBottom: 16, lineHeight: 1.5 }}>
      <strong>{item.passed ? "✓" : "✕"} {item.code}</strong> — {item.evidence}</li>)}</ol>
    <p className="ath-sim-foot">Prova determinística de regras; execução SQL, concorrência e operação publicada exigem validação própria. Sem operação financeira real.</p>
  </section></main>;
}

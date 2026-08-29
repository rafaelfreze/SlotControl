"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { loadOfficialMonitoring } from "@/lib/coinops-monitoring/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

const revalidateMonitoringPaths = () => {
  for (const path of [
    "/dashboard",
    "/slots",
    "/plano-crescimento",
    "/plano-crescimento/baseline",
    "/plano-crescimento/relatorios",
    "/historico"
  ]) {
    revalidatePath(path);
  }
};

const activationErrorMessage = (error: unknown) => {
  const code = error instanceof Error ? error.message : String(error || "");

  if (code.includes("ALREADY_ACTIVE")) return "O monitoramento oficial já está ativo.";
  if (code.includes("STATE_CHANGED") || code.includes("HASH_MISMATCH")) {
    return "O estado operacional mudou após a prévia. Nenhum dado foi alterado; revise o snapshot atualizado antes de ativar.";
  }
  if (code.includes("FUNDED_SLOT_WITHOUT_ECONOMIC_TRACE")) {
    return "Existem slots financiados sem trilha econ\u00f4mica audit\u00e1vel. O baseline n\u00e3o foi ativado.";
  }
  if (code.includes("PREVIEW_NOT_READY")) {
    return "A pr\u00e9via possui pend\u00eancias de integridade. Revise os bloqueios antes de ativar o baseline.";
  }
  if (code.includes("PRICE_FEED") || code.includes("PRICE_INVALID")) {
    return "Os preços de referência não puderam ser validados. Nenhum dado foi alterado.";
  }

  return "Não foi possível ativar o baseline oficial. Nenhum dado financeiro foi alterado.";
};

export async function activateOfficialMonitoring() {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    const monitoring = await loadOfficialMonitoring({ includeDetailedPreview: true });
    const preview = monitoring.preview;
    const context = monitoring.activationContext;

    if (monitoring.overview.active || preview?.already_active) {
      throw new Error("COINOPS_BASELINE_ALREADY_ACTIVE");
    }
    if (monitoring.error) throw new Error(monitoring.error);
    if (!preview?.ok || !preview.account || !preview.state_hash || !context) {
      throw new Error("COINOPS_BASELINE_DETAILED_PREVIEW_REQUIRED");
    }
    if (preview.ready !== true || preview.errors.length > 0) {
      throw new Error(`COINOPS_BASELINE_PREVIEW_NOT_READY:${preview.errors.join(",")}`);
    }

    const { data, error } = await supabase.rpc("activate_official_monitoring_baseline", {
      p_idempotency_key: randomUUID(),
      p_btc_price: context.btcPrice,
      p_sol_price: context.solPrice,
      p_btc_ath: context.officialBtcAth,
      p_expected_state_hash: preview.state_hash
    });

    if (error) throw error;
    if (!(data as { ok?: boolean } | null)?.ok) {
      throw new Error("COINOPS_BASELINE_ACTIVATION_FAILED");
    }
  } catch (error) {
    redirect(`/plano-crescimento?notice=${encodeURIComponent(activationErrorMessage(error))}&tone=error`);
  }

  revalidateMonitoringPaths();
  redirect(`/plano-crescimento?notice=${encodeURIComponent("Monitoramento oficial ativado com snapshot imutável e ciclo 1 iniciado.")}&tone=success`);
}

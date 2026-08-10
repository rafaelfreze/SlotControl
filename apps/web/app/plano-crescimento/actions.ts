"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

type RpcResult = {
  batch_id?: string | null;
  status?: string | null;
  transfer_count?: number | null;
  contribution_id?: string | null;
  slot_number?: number | null;
  amount_usdt?: number | string | null;
  gain_equivalent?: number | string | null;
  operational_after?: number | string | null;
  stale_preview_count?: number | null;
};

export type GrowthAsset = "BTC" | "SOL";

type GrowthStartRpcResult = {
  started_at?: string | null;
  stale_preview_count?: number | null;
};

async function getAuthenticatedClient() {
  if (!isSupabaseConfigured()) {
    redirect("/login?setup=missing-env");
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
}

function formText(formData: FormData, name: string) {
  return String(formData.get(name) || "").trim();
}

function formNumber(formData: FormData, name: string) {
  return Number.parseFloat(formText(formData, name).replace(",", "."));
}

function formAsset(formData: FormData): GrowthAsset {
  const asset = formText(formData, "asset").toUpperCase();
  if (asset !== "BTC" && asset !== "SOL") {
    planRedirect("Ativo inválido. Recarregue o Plano e tente novamente.", { tone: "error" });
  }
  return asset;
}

function idempotencyKey(formData: FormData) {
  const provided = formText(formData, "idempotencyKey");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(provided)) {
    planRedirect("A intenção financeira expirou. Recarregue o Plano antes de tentar novamente.", { tone: "error" });
  }
  return provided;
}

function planRedirect(message: string, options?: { batchId?: string | null; tone?: "success" | "error" }): never {
  const params = new URLSearchParams({
    notice: message,
    tone: options?.tone || "success"
  });
  if (options?.batchId) {
    params.set("batch", options.batchId);
  }
  redirect(`/plano-crescimento?${params.toString()}`);
}

function rpcMessage(code: string | undefined, fallback: string) {
  const messages: Record<string, string> = {
    COINOPS_GROWTH_REFERENCE_MUST_BE_POSITIVE: "Informe uma referência operacional maior que zero.",
    COINOPS_GROWTH_BATCH_STALE: "A escada mudou depois da prévia. Prepare uma nova redistribuição.",
    COINOPS_GROWTH_PREVIEW_EQUITY_MISMATCH: "A prévia não conservou o patrimônio e foi bloqueada.",
    COINOPS_GROWTH_CONFIRM_EQUITY_MISMATCH: "A confirmação não conservou o patrimônio e foi revertida.",
    COINOPS_GROWTH_BATCH_NOT_PREPARED: "Esta prévia não está mais disponível para confirmação.",
    COINOPS_GROWTH_BATCH_NOT_FOUND: "A prévia não existe mais ou pertence a outro escopo.",
    COINOPS_GROWTH_BATCH_EXPIRED: "A prévia expirou. Prepare uma nova redistribuição.",
    COINOPS_GROWTH_MONTH_ALREADY_COMPLETED: "Já existe uma redistribuição confirmada neste ciclo.",
    COINOPS_BTC_REFERENCE_INVALID: "Informe uma referência operacional BTC maior que zero.",
    COINOPS_BTC_REFERENCE_MUST_BE_POSITIVE: "Informe uma referência operacional BTC maior que zero.",
    COINOPS_BTC_NO_TRANSFERS: "A escada já está equilibrada nessa referência; não há transferência a preparar.",
    COINOPS_BTC_BATCH_STALE: "A escada mudou depois da prévia. Prepare uma nova redistribuição.",
    COINOPS_BTC_EQUITY_MISMATCH: "A conservação do patrimônio falhou e a redistribuição foi bloqueada.",
    COINOPS_BTC_PREVIEW_EQUITY_MISMATCH: "A prévia não conservou o patrimônio e foi bloqueada.",
    COINOPS_BTC_CONSERVATION_FAILED: "A conservação do patrimônio falhou e a redistribuição foi bloqueada.",
    COINOPS_BTC_CONFIRM_EQUITY_MISMATCH: "A confirmação não conservou o patrimônio e foi revertida.",
    COINOPS_BTC_BATCH_NOT_PREPARED: "Esta prévia não está mais disponível para confirmação.",
    COINOPS_BTC_BATCH_NOT_FOUND: "A prévia BTC não existe mais ou pertence a outro escopo.",
    COINOPS_BTC_BATCH_EXPIRED: "A prévia expirou. Prepare uma nova redistribuição.",
    COINOPS_BTC_MONTH_ALREADY_COMPLETED: "Já existe uma redistribuição BTC confirmada neste ciclo.",
    COINOPS_BTC_CONTRIBUTION_INVALID: "Informe um aporte externo maior que zero e um motivo.",
    COINOPS_CONTRIBUTION_AMOUNT_MUST_BE_POSITIVE: "Informe um valor de aporte externo maior que zero.",
    COINOPS_CONTRIBUTION_REASON_INVALID: "Informe um motivo válido para o aporte externo.",
    COINOPS_MANUAL_GAINS_MUST_BE_POSITIVE_INTEGER: "Informe uma quantidade inteira de gains maior que zero.",
    COINOPS_MANUAL_GAINS_TOO_LARGE_FOR_SINGLE_ADJUSTMENT: "A quantidade é muito alta para um único ajuste. Divida os gains em dois lançamentos.",
    COINOPS_MANUAL_GAINS_EXACT_AMOUNT_NOT_FOUND: "Não foi possível converter os gains em um aporte financeiro exato.",
    COINOPS_IDEMPOTENCY_CONFLICT: "Esta intenção financeira já foi usada com dados diferentes.",
    COINOPS_SCOPE_NOT_FOUND: "Não foi possível identificar a conta CoinOps ativa.",
    COINOPS_ACTIVE_INTERNAL_MEMBERSHIP_REQUIRED: "A conta não possui acesso CoinOps ativo.",
    COINOPS_TENANT_CONTEXT_AMBIGUOUS: "Há mais de um contexto CoinOps ativo; a operação foi bloqueada por segurança.",
    COINOPS_GROWTH_PLAN_START_DATE_INVALID: "Informe uma data inicial válida.",
    COINOPS_GROWTH_PLAN_START_DATE_FUTURE: "A data inicial da operação não pode estar no futuro."
  };
  if (!code) return fallback;
  const key = Object.keys(messages).find((candidate) => code.includes(candidate));
  return key ? messages[key] : fallback;
}

export async function prepareAssetRedistribution(formData: FormData) {
  const asset = formAsset(formData);
  const referenceLevel = formNumber(formData, "referenceLevel");
  if (!Number.isFinite(referenceLevel) || referenceLevel <= 0) {
    planRedirect(`Informe uma referência operacional ${asset} maior que zero.`, { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("prepare_asset_ladder_redistribution", {
    p_asset: asset,
    p_reference_level: referenceLevel,
    p_idempotency_key: idempotencyKey(formData)
  });
  if (error) {
    planRedirect(rpcMessage(error.message, `Não foi possível preparar a redistribuição ${asset}.`), { tone: "error" });
  }

  const result = data as RpcResult | null;
  if (!result?.batch_id) {
    planRedirect("A escada já está equilibrada nessa referência; não há transferência a preparar.");
  }

  revalidatePath("/plano-crescimento");
  planRedirect(`Prévia pronta com ${Number(result.transfer_count || 0)} transferência(s).`, { batchId: result.batch_id });
}

export async function confirmAssetRedistribution(formData: FormData) {
  const asset = formAsset(formData);
  const batchId = formText(formData, "batchId");
  if (!batchId) {
    planRedirect(`Prévia ${asset} inválida.`, { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("confirm_asset_ladder_redistribution", {
    p_asset: asset,
    p_batch_id: batchId,
    p_idempotency_key: idempotencyKey(formData)
  });
  if (error) {
    planRedirect(rpcMessage(error.message, `A redistribuição ${asset} não foi confirmada.`), { batchId, tone: "error" });
  }

  const result = data as RpcResult | null;
  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/plano-crescimento");
  planRedirect(result?.status === "COMPLETED" ? `Redistribuição ${asset} confirmada e patrimônio conservado.` : `Redistribuição ${asset} já estava confirmada.`);
}

export async function cancelAssetRedistribution(formData: FormData) {
  const asset = formAsset(formData);
  const batchId = formText(formData, "batchId");
  if (!batchId) {
    planRedirect(`Prévia ${asset} inválida.`, { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { error } = await supabase.rpc("cancel_asset_ladder_redistribution", {
    p_asset: asset,
    p_batch_id: batchId
  });
  if (error) {
    planRedirect(rpcMessage(error.message, `A prévia ${asset} não pôde ser cancelada.`), { batchId, tone: "error" });
  }

  revalidatePath("/plano-crescimento");
  planRedirect(`Prévia ${asset} cancelada sem alterar os slots.`);
}

export async function applyAssetManualOperationalGains(formData: FormData) {
  const asset = formAsset(formData);
  const slotId = formText(formData, "slotId");
  const operationalGains = formNumber(formData, "operationalGains");
  const note = formText(formData, "note") || "Completar meta operacional do ciclo";
  if (!slotId || !Number.isFinite(operationalGains) || operationalGains <= 0 || operationalGains !== Math.trunc(operationalGains) || operationalGains > 1000) {
    planRedirect("Informe o slot e uma quantidade inteira de gains maior que zero.", { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("apply_asset_manual_operational_gains", {
    p_asset: asset,
    p_slot_id: slotId,
    p_operational_gains: operationalGains,
    p_reason: note,
    p_idempotency_key: idempotencyKey(formData)
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "Os gains operacionais não puderam ser adicionados."), { tone: "error" });
  }

  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/plano-crescimento");

  const result = data as RpcResult | null;
  const gainsAdded = Number(result?.gain_equivalent ?? operationalGains);
  const amountUsdt = Number(result?.amount_usdt ?? 0);
  const slotNumber = Number(result?.slot_number ?? 0);
  const stalePreviewCount = Number(result?.stale_preview_count ?? 0);
  const gainLabel = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 8 }).format(gainsAdded);
  const amountLabel = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(amountUsdt);
  const staleNotice = stalePreviewCount > 0 ? " A prévia anterior foi invalidada; prepare outra." : "";
  planRedirect(`${gainLabel} gains operacionais adicionados${slotNumber > 0 ? ` ao Slot #${slotNumber}` : ""}. Aporte calculado: ${amountLabel} USDT. Gains reais não foram alterados.${staleNotice}`);
}

export async function saveAssetMonthlyGoal(formData: FormData) {
  const asset = formAsset(formData);
  const monthlyGoal = Math.trunc(formNumber(formData, "monthlyGoal"));
  if (!Number.isFinite(monthlyGoal) || monthlyGoal < 1 || monthlyGoal > 1000) {
    planRedirect(`A meta mensal ${asset} deve ser um inteiro entre 1 e 1000.`, { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { error } = await supabase.rpc("update_growth_plan_goal", {
    p_asset: asset,
    p_monthly_goal: monthlyGoal
  });
  if (error) {
    planRedirect(rpcMessage(error.message, `Não foi possível salvar a meta mensal ${asset}.`), { tone: "error" });
  }

  revalidatePath("/dashboard");
  revalidatePath("/plano-crescimento");
  planRedirect(`Meta mensal ${asset} salva e auditada.`);
}

export async function saveGrowthPlanStartDate(formData: FormData) {
  const startedAt = formText(formData, "startedAt");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startedAt)) {
    planRedirect("Informe uma data inicial válida.", { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("update_growth_plan_started_at", {
    p_started_at: startedAt
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "Não foi possível salvar a data inicial da operação."), { tone: "error" });
  }

  revalidatePath("/dashboard");
  revalidatePath("/plano-crescimento");

  const result = data as GrowthStartRpcResult | null;
  const stalePreviewCount = Number(result?.stale_preview_count || 0);
  planRedirect(stalePreviewCount > 0
    ? "Data inicial salva. As prévias anteriores foram invalidadas; prepare outras com o novo ciclo."
    : "Data inicial da operação salva. Os ciclos foram recalculados sem alterar gains ou histórico."
  );
}

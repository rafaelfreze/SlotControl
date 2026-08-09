"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

type RpcResult = {
  batch_id?: string | null;
  status?: string | null;
  transfer_count?: number | null;
  contribution_id?: string | null;
};

type GrowthGoalRpcResult = {
  btc_monthly_goal?: number | null;
  sol_monthly_goal?: number | null;
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
    COINOPS_IDEMPOTENCY_CONFLICT: "Esta intenção financeira já foi usada com dados diferentes.",
    COINOPS_SCOPE_NOT_FOUND: "Não foi possível identificar a conta CoinOps ativa.",
    COINOPS_ACTIVE_INTERNAL_MEMBERSHIP_REQUIRED: "A conta não possui acesso CoinOps ativo.",
    COINOPS_TENANT_CONTEXT_AMBIGUOUS: "Há mais de um contexto CoinOps ativo; a operação foi bloqueada por segurança."
  };
  if (!code) return fallback;
  const key = Object.keys(messages).find((candidate) => code.includes(candidate));
  return key ? messages[key] : fallback;
}

export async function prepareBtcRedistribution(formData: FormData) {
  const referenceLevel = formNumber(formData, "referenceLevel");
  if (!Number.isFinite(referenceLevel) || referenceLevel <= 0) {
    planRedirect("Informe uma referência operacional BTC maior que zero.", { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("prepare_btc_ladder_redistribution", {
    p_reference_level: referenceLevel,
    p_idempotency_key: idempotencyKey(formData)
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "Não foi possível preparar a redistribuição BTC."), { tone: "error" });
  }

  const result = data as RpcResult | null;
  if (!result?.batch_id) {
    planRedirect("A escada já está equilibrada nessa referência; não há transferência a preparar.");
  }

  revalidatePath("/plano-crescimento");
  planRedirect(`Prévia pronta com ${Number(result.transfer_count || 0)} transferência(s).`, { batchId: result.batch_id });
}

export async function confirmBtcRedistribution(formData: FormData) {
  const batchId = formText(formData, "batchId");
  if (!batchId) {
    planRedirect("Prévia BTC inválida.", { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("confirm_btc_ladder_redistribution", {
    p_batch_id: batchId,
    p_idempotency_key: idempotencyKey(formData)
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "A redistribuição BTC não foi confirmada."), { batchId, tone: "error" });
  }

  const result = data as RpcResult | null;
  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/plano-crescimento");
  planRedirect(result?.status === "COMPLETED" ? "Redistribuição BTC confirmada e patrimônio conservado." : "Redistribuição BTC já estava confirmada.");
}

export async function cancelBtcRedistribution(formData: FormData) {
  const batchId = formText(formData, "batchId");
  if (!batchId) {
    planRedirect("Prévia BTC inválida.", { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { error } = await supabase.rpc("cancel_btc_ladder_redistribution", {
    p_batch_id: batchId
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "A prévia BTC não pôde ser cancelada."), { batchId, tone: "error" });
  }

  revalidatePath("/plano-crescimento");
  planRedirect("Prévia BTC cancelada sem alterar os slots.");
}

export async function applyBtcExternalContribution(formData: FormData) {
  const slotId = formText(formData, "slotId");
  const amountUsdt = formNumber(formData, "amountUsdt");
  const note = formText(formData, "note");
  if (!slotId || !Number.isFinite(amountUsdt) || amountUsdt <= 0 || !note) {
    planRedirect("Informe slot, valor positivo e motivo do aporte externo.", { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { error } = await supabase.rpc("apply_btc_external_contribution", {
    p_slot_id: slotId,
    p_amount_usdt: amountUsdt,
    p_reason: note,
    p_idempotency_key: idempotencyKey(formData)
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "O aporte externo BTC não pôde ser aplicado."), { tone: "error" });
  }

  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/plano-crescimento");
  planRedirect("Aporte externo registrado sem alterar os gains reais.");
}

export async function saveBtcMonthlyGoal(formData: FormData) {
  const monthlyGoal = Math.trunc(formNumber(formData, "btcMonthlyGoal"));
  if (!Number.isFinite(monthlyGoal) || monthlyGoal < 1 || monthlyGoal > 1000) {
    planRedirect("A meta mensal BTC deve ser um inteiro entre 1 e 1000.", { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { error } = await supabase.rpc("update_growth_plan_goal", {
    p_asset: "BTC",
    p_monthly_goal: monthlyGoal
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "Não foi possível salvar a meta mensal BTC."), { tone: "error" });
  }

  revalidatePath("/dashboard");
  revalidatePath("/plano-crescimento");
  planRedirect("Meta mensal BTC salva e auditada.");
}

export async function saveSolMonthlyGoal(input: { solMonthlyGoal: number }) {
  const solMonthlyGoal = Math.trunc(input.solMonthlyGoal);
  if (!Number.isFinite(solMonthlyGoal) || solMonthlyGoal < 1 || solMonthlyGoal > 1000) {
    throw new Error("A meta mensal SOL deve ser um inteiro entre 1 e 1000.");
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("update_growth_plan_goal", {
    p_asset: "SOL",
    p_monthly_goal: solMonthlyGoal
  });
  if (error) {
    throw new Error("Não foi possível salvar a meta mensal SOL.");
  }

  revalidatePath("/dashboard");
  revalidatePath("/plano-crescimento");
  const result = data as GrowthGoalRpcResult | null;
  return { solMonthlyGoal: Number(result?.sol_monthly_goal || solMonthlyGoal) };
}

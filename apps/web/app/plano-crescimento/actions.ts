"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

type RpcResult = {
  ok?: boolean | null;
  code?: string | null;
  batch_id?: string | null;
  status?: string | null;
  transfer_count?: number | null;
  slot_count?: number | null;
  open_slot_count?: number | null;
  free_slot_count?: number | null;
  amount_per_slot_usdt?: number | string | null;
  total_amount_usdt?: number | string | null;
  contribution_id?: string | null;
  slot_number?: number | null;
  amount_usdt?: number | string | null;
  gain_equivalent?: number | string | null;
  operational_gains_per_slot?: number | string | null;
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

function planRedirect(message: string, options?: {
  batchId?: string | null;
  tone?: "success" | "error";
  asset?: GrowthAsset;
  view?: "ladder" | "gains" | "balance";
}): never {
  const params = new URLSearchParams({
    notice: message,
    tone: options?.tone || "success"
  });
  if (options?.batchId) {
    params.set("batch", options.batchId);
  }
  if (options?.asset) {
    params.set("asset", options.asset);
  }
  if (options?.view) {
    params.set("view", options.view);
  }
  redirect(`/plano-crescimento?${params.toString()}`);
}

function rpcMessage(code: string | undefined, fallback: string) {
  const messages: Record<string, string> = {
    COINOPS_GROWTH_REFERENCE_MUST_BE_POSITIVE_INTEGER: "Informe uma referência operacional inteira e maior que zero.",
    COINOPS_GROWTH_REFERENCE_MUST_BE_POSITIVE: "Informe uma referência operacional maior que zero.",
    COINOPS_GROWTH_REFERENCE_DIFFERS_FROM_SAVED_CONFIG: "A referência mudou. Salve a configuração do ativo antes de preparar a redistribuição.",
    COINOPS_GROWTH_OPERATIONAL_STATE_MUST_BE_WHOLE_FOR_SLOT: "A escada contém um nível fracionado e foi bloqueada para correção segura.",
    COINOPS_GROWTH_BATCH_STALE: "A escada mudou depois da prévia. Prepare uma nova redistribuição.",
    COINOPS_GROWTH_PREVIEW_EQUITY_MISMATCH: "A prévia não conservou o patrimônio e foi bloqueada.",
    COINOPS_GROWTH_CONFIRM_EQUITY_MISMATCH: "A confirmação não conservou o patrimônio e foi revertida.",
    COINOPS_GROWTH_BATCH_NOT_PREPARED: "Esta prévia não está mais disponível para confirmação.",
    COINOPS_GROWTH_BATCH_NOT_FOUND: "A prévia não existe mais ou pertence a outro escopo.",
    COINOPS_GROWTH_BATCH_EXPIRED: "A prévia expirou. Prepare uma nova redistribuição.",
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
    COINOPS_BTC_CONTRIBUTION_INVALID: "Informe um aporte externo maior que zero e um motivo.",
    COINOPS_CONTRIBUTION_AMOUNT_MUST_BE_POSITIVE: "Informe um valor de aporte externo maior que zero.",
    COINOPS_CONTRIBUTION_AMOUNT_INVALID: "Informe um valor de saldo maior que zero.",
    COINOPS_CONTRIBUTION_REASON_INVALID: "Informe um motivo válido para o aporte externo.",
    COINOPS_ACTIVE_BASELINE_REQUIRED: "Ative o monitoramento oficial antes de usar o aporte em todos os slots.",
    COINOPS_BULK_CONTRIBUTION_SLOT_COUNT_INVALID: "A quantidade de slots do lote é inválida. Recarregue o Plano.",
    COINOPS_BULK_CONTRIBUTION_SCOPE_CHANGED: "A lista de slots mudou depois da revisão. Recarregue o Plano e confira o lote novamente.",
    COINOPS_BULK_CONTRIBUTION_INCOMPLETE: "O lote anterior não foi concluído e permaneceu sem efeito. Recarregue o Plano.",
    COINOPS_BULK_CONTRIBUTION_BATCH_POSTCONDITION_FAILED: "O lote não passou na reconciliação e foi totalmente revertido.",
    COINOPS_BULK_CONTRIBUTION_ITEM_POSTCONDITION_FAILED: "Um slot não preservou seu estado e o lote foi totalmente revertido.",
    COINOPS_BULK_CONTRIBUTION_CYCLE_POSTCONDITION_FAILED: "O lote alteraria a fila operacional e foi totalmente revertido.",
    COINOPS_MANUAL_GAINS_MUST_BE_POSITIVE_INTEGER: "Informe uma quantidade inteira de gains maior que zero.",
    COINOPS_MANUAL_GAINS_TOO_LARGE_FOR_SINGLE_ADJUSTMENT: "A quantidade é muito alta para um único ajuste. Divida os gains em dois lançamentos.",
    COINOPS_MANUAL_GAINS_EXACT_AMOUNT_NOT_FOUND: "Não foi possível converter os gains em um aporte financeiro exato.",
    COINOPS_MANUAL_GAINS_RESULT_OUT_OF_RANGE: "O saldo calculado ficou fora do limite permitido. Divida os gains em lançamentos menores.",
    COINOPS_MANUAL_GAINS_BATCH_THRESHOLD_INVALID: "Informe um limite inteiro de gains entre 1 e 1000.",
    COINOPS_MANUAL_GAINS_BATCH_EMPTY: "Nenhum slot elegível ficou abaixo desse limite. Ajuste o filtro e gere outra prévia.",
    COINOPS_MANUAL_GAINS_BATCH_PREVIEW_INVALID: "A prévia do lote não passou na conferência financeira.",
    COINOPS_MANUAL_GAINS_BATCH_NOT_FOUND: "A prévia de gains não existe mais ou pertence a outro escopo.",
    COINOPS_MANUAL_GAINS_BATCH_NOT_PREPARED: "Esta prévia de gains não está mais disponível. Gere uma nova antes de confirmar.",
    COINOPS_MANUAL_GAINS_BATCH_EXPIRED: "A prévia de gains expirou. Gere uma nova antes de confirmar.",
    COINOPS_MANUAL_GAINS_BATCH_STALE: "Um slot mudou depois da prévia. Nenhum gain foi aplicado; gere uma nova prévia.",
    COINOPS_MANUAL_GAINS_BATCH_ITEM_POSTCONDITION_FAILED: "A conferência de um slot falhou e o lote inteiro foi revertido.",
    COINOPS_MANUAL_GAINS_BATCH_POSTCONDITION_FAILED: "A conferência do lote falhou e nenhum gain foi aplicado.",
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
  if (!Number.isInteger(referenceLevel) || referenceLevel <= 0) {
    planRedirect(`Informe uma referência operacional ${asset} inteira e maior que zero.`, { tone: "error" });
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

export async function prepareAssetManualOperationalGainsBatch(formData: FormData) {
  const asset = formAsset(formData);
  const belowOperationalGains = formNumber(formData, "belowOperationalGains");
  const operationalGains = formNumber(formData, "operationalGains");
  const note = formText(formData, "note") || `Ajuste operacional em massa ${asset}`;
  if (
    !Number.isInteger(belowOperationalGains)
    || belowOperationalGains < 1
    || belowOperationalGains > 1000
    || !Number.isInteger(operationalGains)
    || operationalGains < 1
    || operationalGains > 1000
  ) {
    planRedirect("Informe o limite e a quantidade como números inteiros maiores que zero.", { asset, view: "gains", tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("prepare_asset_manual_operational_gains_batch", {
    p_asset: asset,
    p_below_operational_gains: belowOperationalGains,
    p_operational_gains_per_slot: operationalGains,
    p_reason: note,
    p_idempotency_key: idempotencyKey(formData)
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "Não foi possível calcular a prévia de gains em massa."), { asset, view: "gains", tone: "error" });
  }

  const result = data as RpcResult | null;
  if (!result?.ok || !result.batch_id) {
    planRedirect(rpcMessage(result?.code || undefined, "A prévia de gains não ficou disponível."), { asset, view: "gains", tone: "error" });
  }

  revalidatePath("/plano-crescimento");
  planRedirect(`Prévia pronta: ${Number(result.slot_count || 0)} slots ${asset} receberão +${operationalGains} gains. Confira o aporte antes de confirmar.`, {
    batchId: result.batch_id,
    asset,
    view: "gains"
  });
}

export async function confirmAssetManualOperationalGainsBatch(formData: FormData) {
  const asset = formAsset(formData);
  const batchId = formText(formData, "batchId");
  if (!batchId || formText(formData, "confirmBulk") !== "confirmed") {
    planRedirect("Revise a prévia e confirme o aporte antes de aplicar os gains em massa.", { asset, view: "gains", tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { data, error } = await supabase.rpc("confirm_asset_manual_operational_gains_batch", {
    p_asset: asset,
    p_batch_id: batchId,
    p_idempotency_key: idempotencyKey(formData)
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "Os gains em massa não puderam ser aplicados."), { asset, view: "gains", tone: "error" });
  }

  const result = data as RpcResult | null;
  if (!result?.ok || result.status !== "COMPLETED") {
    planRedirect(rpcMessage(result?.code || undefined, "A prévia mudou e os gains não foram aplicados."), { asset, view: "gains", tone: "error" });
  }

  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/plano-crescimento");
  revalidatePath("/historico");
  const totalAmount = Number(result.total_amount_usdt || 0);
  const totalLabel = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(totalAmount);
  planRedirect(`Lote concluído: ${Number(result.slot_count || 0)} slots ${asset} receberam +${Number(result.operational_gains_per_slot || 0)} gains operacionais cada. Aporte calculado: ${totalLabel} USDT. Gains reais e posições foram preservados.`, {
    asset,
    view: "gains"
  });
}

export async function cancelAssetManualOperationalGainsBatch(formData: FormData) {
  const asset = formAsset(formData);
  const batchId = formText(formData, "batchId");
  if (!batchId) {
    planRedirect("Prévia de gains inválida.", { asset, view: "gains", tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { error } = await supabase.rpc("cancel_asset_manual_operational_gains_batch", {
    p_asset: asset,
    p_batch_id: batchId
  });
  if (error) {
    planRedirect(rpcMessage(error.message, "A prévia de gains não pôde ser cancelada."), { asset, view: "gains", tone: "error" });
  }

  revalidatePath("/plano-crescimento");
  planRedirect(`Prévia de gains ${asset} cancelada sem alterar nenhum slot.`, { asset, view: "gains" });
}

export async function applyAssetExternalBalance(formData: FormData) {
  const asset = formAsset(formData);
  const scope = formText(formData, "scope") || "single";
  const slotId = formText(formData, "slotId");
  const amountUsdt = formNumber(formData, "amountUsdt");
  const isBulk = scope === "all";
  const note = formText(formData, "note") || (isBulk ? `Aporte externo em todos os slots ${asset}` : "Aporte externo em USDT");
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    planRedirect("Informe um valor USDT por slot maior que zero.", { tone: "error" });
  }
  if (scope !== "single" && scope !== "all") {
    planRedirect("O escopo do aporte é inválido. Recarregue o Plano.", { tone: "error" });
  }
  if (!isBulk && !slotId) {
    planRedirect("Escolha o slot que receberá o saldo.", { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const financialIntent = idempotencyKey(formData);
  let data: unknown;
  let error: { message?: string } | null;
  if (isBulk) {
    const expectedSlotIds = formData.getAll("expectedSlotIds")
      .map((value) => String(value).trim())
      .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
    const uniqueExpectedSlotIds = [...new Set(expectedSlotIds)];
    const confirmed = formText(formData, "confirmBulk") === "confirmed";
    if (
      uniqueExpectedSlotIds.length <= 0
      || uniqueExpectedSlotIds.length > 25
      || uniqueExpectedSlotIds.length !== formData.getAll("expectedSlotIds").length
      || !confirmed
    ) {
      planRedirect("Revise e confirme o total do aporte antes de aplicar em todos os slots.", { tone: "error" });
    }
    const response = await supabase.rpc("apply_asset_external_contribution_batch", {
      p_asset: asset,
      p_amount_per_slot_usdt: amountUsdt,
      p_expected_slot_ids: uniqueExpectedSlotIds,
      p_reason: note,
      p_idempotency_key: financialIntent
    });
    data = response.data;
    error = response.error;
  } else {
    const response = await supabase.rpc("apply_asset_external_contribution", {
      p_asset: asset,
      p_slot_id: slotId,
      p_amount_usdt: amountUsdt,
      p_reason: note,
      p_idempotency_key: financialIntent
    });
    data = response.data;
    error = response.error;
  }
  if (error) {
    planRedirect(rpcMessage(error.message, "O saldo externo não pôde ser adicionado."), { tone: "error" });
  }

  revalidatePath("/dashboard");
  revalidatePath("/slots");
  revalidatePath("/plano-crescimento");
  revalidatePath("/historico");

  const result = data as RpcResult | null;
  if (isBulk) {
    const slotCount = Number(result?.slot_count ?? 0);
    const openSlotCount = Number(result?.open_slot_count ?? 0);
    const totalAmount = Number(result?.total_amount_usdt ?? amountUsdt * slotCount);
    const totalLabel = new Intl.NumberFormat("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 8
    }).format(totalAmount);
    const stalePreviewCount = Number(result?.stale_preview_count ?? 0);
    const staleNotice = stalePreviewCount > 0
      ? " A prévia anterior foi invalidada; prepare outra."
      : "";
    planRedirect(`Lote concluído: ${totalLabel} USDT adicionados em ${slotCount} slots ${asset}, incluindo ${openSlotCount} OPEN. Gains e posições foram preservados.${staleNotice}`);
  }

  const amount = Number(result?.amount_usdt ?? amountUsdt);
  const slotNumber = Number(result?.slot_number ?? 0);
  const stalePreviewCount = Number(result?.stale_preview_count ?? 0);
  const amountLabel = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8
  }).format(amount);
  const staleNotice = stalePreviewCount > 0
    ? " A prévia anterior foi invalidada; prepare outra."
    : "";
  planRedirect(`Saldo de ${amountLabel} USDT adicionado${slotNumber > 0 ? ` ao Slot #${slotNumber}` : ""}. Gains reais e operacionais não foram alterados.${staleNotice}`);
}

export async function saveAssetGrowthConfig(formData: FormData) {
  const asset = formAsset(formData);
  const monthlyGoal = Math.trunc(formNumber(formData, "monthlyGoal"));
  const referenceLevel = formNumber(formData, "referenceLevel");
  if (!Number.isFinite(monthlyGoal) || monthlyGoal < 1 || monthlyGoal > 1000) {
    planRedirect(`A meta mensal ${asset} deve ser um inteiro entre 1 e 1000.`, { tone: "error" });
  }
  if (!Number.isInteger(referenceLevel) || referenceLevel <= 0) {
    planRedirect(`A referência ${asset} deve ser um inteiro maior que zero.`, { tone: "error" });
  }

  const { supabase } = await getAuthenticatedClient();
  const { error } = await supabase.rpc("update_growth_plan_config", {
    p_asset: asset,
    p_monthly_goal: monthlyGoal,
    p_ladder_reference: referenceLevel
  });
  if (error) {
    planRedirect(rpcMessage(error.message, `Não foi possível salvar a configuração ${asset}.`), { tone: "error" });
  }

  revalidatePath("/dashboard");
  revalidatePath("/plano-crescimento");
  planRedirect(`Meta e referência ${asset} salvas e auditadas sem alterar o outro ativo.`);
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

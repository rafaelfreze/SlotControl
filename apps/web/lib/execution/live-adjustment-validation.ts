/** Shared input validation only; never reads or changes the financial ledger. */
export function getLiveAdjustmentReasonError(reason: unknown):
  "COINOPS_ADJUSTMENT_REASON_REQUIRED" | "COINOPS_ADJUSTMENT_REASON_INVALID" | null {
  if (reason == null || (typeof reason === "string" && !reason.trim()))
    return "COINOPS_ADJUSTMENT_REASON_REQUIRED";
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.trim().length > 160)
    return "COINOPS_ADJUSTMENT_REASON_INVALID";
  return null;
}

export function liveAdjustmentErrorMessage(code: string): string {
  switch (code) {
    case "COINOPS_ADJUSTMENT_REASON_REQUIRED":
      return "Preencha o motivo do ajuste para auditoria (3 a 160 caracteres).";
    case "COINOPS_ADJUSTMENT_REASON_INVALID":
      return "O motivo do ajuste deve ter de 3 a 160 caracteres, sem contar espaços nas extremidades.";
    case "COINOPS_ADJUSTMENT_INPUT_INVALID":
      return "Revise a conta, a moeda e os dados do ajuste antes de pré-visualizar.";
    default:
      return code;
  }
}

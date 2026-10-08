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
    case "COINOPS_ADJUSTMENT_STATUS_UNAVAILABLE":
    case "COINOPS_ADJUSTMENT_LEDGER_UNHEALTHY":
      return `Não foi possível carregar contas e ledger completos. Nenhum ajuste foi realizado. Tente carregar novamente. (${code})`;
    case "COINOPS_ADJUSTMENT_AUTH_REQUIRED":
      return "A sessão expirou. Entre novamente para acessar os ajustes.";
    case "COINOPS_ADJUSTMENT_ADMIN_DENIED":
      return "Somente o operador autorizado e ativo pode acessar os ajustes.";
    default:
      return code;
  }
}

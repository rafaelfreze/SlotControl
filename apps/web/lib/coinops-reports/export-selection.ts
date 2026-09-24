type Environment = "ALL" | "SHADOW" | "TESTNET" | "REAL";
type Selection = { account: string; engine: string; environment: Environment };

/** Presentation guard only. Never changes account, engine or currency; the
 * authenticated report API remains responsible for authorization. */
export function reportExportSelectionReason(selection: Selection, target: Environment): string | null {
  if (selection.engine === "ALL") return null;
  if (selection.account !== "ALL" && selection.environment !== "ALL"
    && target === selection.environment) return null;
  return "Este motor pertence a outro ambiente. Para exportar esse conteúdo, escolha explicitamente o ambiente e o motor desejados nos filtros e clique em Aplicar filtros. Candles completos exigem um motor Shadow.";
}

export type FinancialValueTone = "negative" | "positive" | "neutral";

export function getFinancialValueTone(value: number | string | null | undefined): FinancialValueTone {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue === 0) return "neutral";
  return numericValue < 0 ? "negative" : "positive";
}

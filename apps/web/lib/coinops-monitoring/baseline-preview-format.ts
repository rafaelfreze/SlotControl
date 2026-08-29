export function formatOptionalDecimal(value: unknown, maximumFractionDigits = 2) {
  if (value === null || value === undefined || value === "") return "—";

  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits }).format(number);
}

import type { SlotStatus, SlotView } from "./types";

export function formatUsdt(value: number) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)} USDT`;
}

export function formatPercent(value: number | string) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  }).format(Number(value || 0) * 100);
}

export function formatDecimal(value: number | string) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

export function getCurrentValue(slot: Pick<SlotView, "base_value" | "gain_rate" | "gains">) {
  return Number(slot.base_value || 0) * Math.pow(1 + Number(slot.gain_rate || 0), Number(slot.gains || 0));
}

export function getOpenMarketMetrics(
  slot: Pick<SlotView, "status" | "base_value" | "gain_rate" | "gains" | "preco_entrada" | "preco_atual" | "preco_alvo">
) {
  const valorSlot = getCurrentValue(slot);
  const precoEntrada = Number(slot.preco_entrada || 0);
  const precoAtual = Number(slot.preco_atual || 0);
  const precoAlvo = Number(slot.preco_alvo || (precoEntrada > 0 ? precoEntrada * (1 + Number(slot.gain_rate || 0)) : 0));
  const hasPrices = slot.status === "aberto" && precoEntrada > 0 && precoAtual > 0;
  const valorMarcado = hasPrices ? valorSlot * (precoAtual / precoEntrada) : valorSlot;
  const resultadoAbertoUsdt = hasPrices ? valorMarcado - valorSlot : 0;
  const resultadoAbertoPercentual = hasPrices ? (precoAtual / precoEntrada - 1) * 100 : 0;
  const distanciaAteGainPercentual = hasPrices && precoAlvo > 0 ? (precoAlvo / precoAtual - 1) * 100 : 0;

  return {
    precoEntrada,
    precoAtual,
    precoAlvo,
    valorSlot,
    valorMarcado,
    resultadoAbertoUsdt,
    resultadoAbertoPercentual,
    distanciaAteGainPercentual,
    hasPrices
  };
}

export function getMarkedSlotValue(slot: SlotView) {
  return slot.status === "aberto" ? getOpenMarketMetrics(slot).valorMarcado : getCurrentValue(slot);
}

export function formatSignedUsdt(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatUsdt(value)}`;
}

export function formatSignedPercent(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)}%`;
}

export function getStatusLabel(status: SlotStatus) {
  const labels = {
    zerado: "Zerado",
    aberto: "Aberto",
    gain: "Gain",
    hold: "Hold"
  };

  return labels[status] || status;
}

export function formatDate(value: string | null) {
  if (!value) {
    return "Nunca";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Data invalida";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

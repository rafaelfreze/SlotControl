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

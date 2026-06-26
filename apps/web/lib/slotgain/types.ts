export type StrategyView = {
  id: string;
  key: string;
  title: string;
  display_name: string;
  asset: string;
  base_value: number | string;
  gain_rate: number | string;
  drop_percent: number | string;
  restart_amount: number;
  sort_order: number;
};

export type SlotStatus = "zerado" | "aberto" | "gain" | "hold";

export type SlotView = {
  id: string;
  strategy_id: string;
  status: SlotStatus;
  gains: number;
  base_value: number | string;
  gain_rate: number | string;
  preco_entrada: number | string | null;
  preco_atual: number | string | null;
  preco_alvo: number | string | null;
  slot_number: number;
  sort_order: number;
  notes: string;
  updated_at: string | null;
  strategy?: StrategyView | null;
};

export type HistoryEvent = {
  id: string;
  action: string;
  detail: string;
  event_at: string;
  strategy_key: string | null;
  slot_number: number | null;
  strategy?: Pick<StrategyView, "asset" | "key"> | null;
};

export type SlotRow = Omit<SlotView, "strategy"> & {
  strategies?: StrategyView | StrategyView[] | null;
};

export function normalizeSlot(slot: SlotRow): SlotView {
  const isOpen = slot.status === "aberto";

  return {
    ...slot,
    preco_entrada: isOpen ? slot.preco_entrada : null,
    preco_atual: isOpen ? slot.preco_atual : null,
    preco_alvo: isOpen ? slot.preco_alvo : null,
    strategy: Array.isArray(slot.strategies) ? slot.strategies[0] || null : slot.strategies || null
  };
}

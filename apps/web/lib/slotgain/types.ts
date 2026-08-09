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
  real_gains: number;
  added_gains: number;
  operational_gains: number | string;
  redistribution_received_usdt: number | string;
  redistribution_sent_usdt: number | string;
  base_value: number | string;
  realized_profit: number | string;
  growth_contribution: number | string;
  operational_slot_value: number | string;
  position_notional_usdt: number | string | null;
  position_gain_unit_usdt: number | string | null;
  accounting_version: number;
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
  user_id?: string | null;
  action: string;
  detail: string;
  event_at: string;
  created_at?: string | null;
  strategy_id: string | null;
  slot_id: string | null;
  strategy_key: string | null;
  slot_number: number | null;
  strategy?: Pick<StrategyView, "asset" | "key"> | null;
};

export type SlotRow = Omit<SlotView, "strategy"> & {
  strategies?: StrategyView | StrategyView[] | null;
};

export function normalizeSlot(slot: SlotRow): SlotView {
  const keepsPrices = slot.status === "aberto" || slot.status === "hold";

  return {
    ...slot,
    operational_gains: slot.operational_gains ?? slot.gains,
    redistribution_received_usdt: slot.redistribution_received_usdt ?? 0,
    redistribution_sent_usdt: slot.redistribution_sent_usdt ?? 0,
    position_notional_usdt: slot.position_notional_usdt ?? null,
    position_gain_unit_usdt: slot.position_gain_unit_usdt ?? null,
    accounting_version: slot.accounting_version ?? 0,
    preco_entrada: keepsPrices ? slot.preco_entrada : null,
    preco_atual: slot.status === "aberto" ? slot.preco_atual : null,
    preco_alvo: keepsPrices ? slot.preco_alvo : null,
    strategy: Array.isArray(slot.strategies) ? slot.strategies[0] || null : slot.strategies || null
  };
}

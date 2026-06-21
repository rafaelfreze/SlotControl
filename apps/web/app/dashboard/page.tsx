import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DashboardClient, type HistoryEvent, type SlotView, type StrategyView } from "./dashboard-client";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Dashboard"
};

type SlotRow = Omit<SlotView, "strategy"> & {
  strategies?: StrategyView | StrategyView[] | null;
};

function normalizeSlot(slot: SlotRow): SlotView {
  return {
    ...slot,
    strategy: Array.isArray(slot.strategies) ? slot.strategies[0] || null : slot.strategies || null
  };
}

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    redirect("/login?setup=missing-env");
  }

  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [strategiesResponse, slotsResponse, historyResponse] = await Promise.all([
    supabase
      .from("strategies")
      .select(
        "id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,redistribution_target,sort_order"
      )
      .order("sort_order", { ascending: true }),
    supabase
      .from("slots")
      .select(
        "id,strategy_id,status,gains,base_value,gain_rate,slot_number,sort_order,notes,updated_at,strategies(id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,redistribution_target,sort_order)"
      )
      .order("sort_order", { ascending: true }),
    supabase
      .from("history_events")
      .select("id,action,detail,event_at,strategy_key,slot_number")
      .order("event_at", { ascending: false })
      .limit(80)
  ]);

  const setupError = strategiesResponse.error || slotsResponse.error || historyResponse.error;

  return (
    <DashboardClient
      userEmail={user.email || "Usuario"}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      history={(historyResponse.data ?? []) as HistoryEvent[]}
      setupError={setupError?.message || null}
    />
  );
}

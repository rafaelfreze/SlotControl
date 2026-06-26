import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { normalizeSlot, type SlotRow, type StrategyView } from "@/lib/slotgain/types";
import { RedistribuirClient } from "./redistribuir-client";

export const metadata: Metadata = { title: "Redistribuir" };

export default async function RedistribuirPage({ searchParams }: { searchParams?: { asset?: string; notice?: string } }) {
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

  const [strategiesResponse, slotsResponse] = await Promise.all([
    supabase
      .from("strategies")
      .select("id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,redistribution_target,sort_order")
      .order("sort_order", { ascending: true }),
    supabase
      .from("slots")
      .select(
        "id,strategy_id,status,gains,base_value,gain_rate,preco_entrada,preco_atual,preco_alvo,slot_number,sort_order,notes,updated_at,strategies(id,key,title,display_name,asset,base_value,gain_rate,drop_percent,restart_amount,redistribution_target,sort_order)"
      )
      .order("sort_order", { ascending: true })
  ]);

  return (
    <RedistribuirClient
      userEmail={user.email || "Usuario"}
      strategies={(strategiesResponse.data ?? []) as StrategyView[]}
      slots={((slotsResponse.data ?? []) as unknown as SlotRow[]).map(normalizeSlot)}
      initialAsset={searchParams?.asset || null}
      setupError={(strategiesResponse.error || slotsResponse.error)?.message || null}
      notice={searchParams?.notice || null}
    />
  );
}

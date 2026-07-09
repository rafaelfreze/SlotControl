import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import type { HistoryEvent } from "@/lib/slotgain/types";
import { HistoricoClient } from "./historico-client";

export const metadata: Metadata = { title: "Historico" };

export default async function HistoricoPage() {
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

  const { data, error } = await supabase
    .from("history_events")
    .select("id,action,detail,event_at,strategy_id,slot_id,strategy_key,slot_number,strategies(asset,key)")
    .order("event_at", { ascending: false })
    .limit(1000);

  const history = ((data ?? []) as Array<HistoryEvent & { strategies?: HistoryEvent["strategy"] | HistoryEvent["strategy"][] }>).map(
    (item) => ({
      ...item,
      strategy: Array.isArray(item.strategies) ? item.strategies[0] || null : item.strategies || null
    })
  );

  return <HistoricoClient userEmail={user.email || "Usuario"} history={history} error={error?.message || null} />;
}

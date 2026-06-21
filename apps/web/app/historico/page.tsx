import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app/app-shell";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { formatDate } from "@/lib/slotgain/format";
import type { HistoryEvent } from "@/lib/slotgain/types";

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
    .select("id,action,detail,event_at,strategy_key,slot_number")
    .order("event_at", { ascending: false })
    .limit(120);

  const history = (data ?? []) as HistoryEvent[];

  return (
    <AppShell userEmail={user.email || "Usuario"}>
      {error ? <section className="inline-alert dashboard-alert">Falha ao carregar historico: {error.message}</section> : null}

      <article className="panel-card history-page-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Historico</p>
            <h2>Acoes registradas</h2>
          </div>
          <span>{history.length}</span>
        </div>
        <div className="history-list">
          {history.map((item) => (
            <div key={item.id} className="history-item compact-history-item">
              <strong>{item.action}</strong>
              <span>{item.detail || "Registro criado no Supabase."}</span>
              <small>{formatDate(item.event_at)}</small>
            </div>
          ))}
          {history.length === 0 ? <p className="empty-copy">Sem historico ainda.</p> : null}
        </div>
      </article>
    </AppShell>
  );
}

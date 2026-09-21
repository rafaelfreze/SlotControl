import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DesktopEmptyState, DesktopKpiCard, DesktopPanel, DesktopWorkspace } from "@/components/app/desktop-workspace";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Automação" };

type IntentRow = {
  id: string;
  asset: string;
  slot_id: string;
  side: string;
  quantity: number | string;
  observed_market_price: number | string;
  strategy_reason: string;
  status: string;
  created_at: string;
};

function displayNumber(value: number | string | null | undefined, digits = 4) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString("pt-BR", { maximumFractionDigits: digits }) : "—";
}

export default async function AutomationPage() {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [connectionResponse, engineResponse, assetResponse, intentsResponse] = await Promise.all([
    supabase.from("exchange_connections").select("connection_status,last_reconciled_at").eq("exchange", "BINANCE_SPOT").maybeSingle(),
    supabase.from("execution_engine_settings").select("execution_mode,global_kill_switch").maybeSingle(),
    supabase.from("execution_asset_settings").select("asset,automation_enabled,kill_switch"),
    supabase.from("exchange_order_intents").select("id,asset,slot_id,side,quantity,observed_market_price,strategy_reason,status,created_at").order("created_at", { ascending: false }).limit(12)
  ]);

  const connection = connectionResponse.data;
  const engine = engineResponse.data;
  const assets = assetResponse.data || [];
  const intentRows = (intentsResponse.data || []) as IntentRow[];
  const assetStatus = (asset: "BTC" | "SOL") => assets.find((row) => row.asset === asset);
  const globalKillSwitch = engine?.global_kill_switch ?? true;

  return (
    <DesktopWorkspace title="Automação / Exchange" subtitle="Infraestrutura de execução preparada em modo seguro" userLabel={user.email || "Usuário"}>
      <div className="desktop-kpi-grid">
        <DesktopKpiCard label="Modo" value={engine?.execution_mode || "SHADOW"} helper="LIVE indisponível nesta fase" tone="info" />
        <DesktopKpiCard label="Binance Spot" value={connection?.connection_status === "CONNECTED" ? "Conectada" : "Não conectada"} helper={connection?.last_reconciled_at ? `Reconciliação: ${new Date(connection.last_reconciled_at).toLocaleString("pt-BR")}` : "Sem credenciais armazenadas"} />
        <DesktopKpiCard label="Kill switch global" value={globalKillSwitch ? "ATIVO" : "Liberado p/ Shadow"} helper={globalKillSwitch ? "Falha fechada: nenhum intent novo" : "Ainda sem execução real"} tone={globalKillSwitch ? "positive" : "info"} />
      </div>

      <DesktopPanel eyebrow="ATIVOS" title="Controles por estratégia">
        <div className="desktop-kpi-grid">
          {(["BTC", "SOL"] as const).map((asset) => {
            const setting = assetStatus(asset);
            const off = !setting?.automation_enabled || setting.kill_switch !== false;
            return <DesktopKpiCard key={asset} label={asset} value={off ? "Automação OFF" : "Shadow ativo"} helper={off ? "Kill switch por ativo ou automação desabilitada" : "Somente registro de intenção"} tone={off ? "neutral" : "info"} />;
          })}
        </div>
        <p className="muted-text">A fase atual não aceita chaves de saque, senha, 2FA, seed, nem cria/cancela ordens. Uma futura conexão read-only deve reconciliar saldo, ordens, fills e trades antes de qualquer decisão de LIVE.</p>
      </DesktopPanel>

      <DesktopPanel eyebrow="AUDITORIA" title="Últimas intenções Shadow">
        {intentsResponse.error ? <DesktopEmptyState title="Não foi possível carregar as intenções"><span>{intentsResponse.error.message}</span></DesktopEmptyState> : null}
        {!intentsResponse.error && intentRows.length === 0 ? <DesktopEmptyState title="Nenhuma intenção registrada"><span>O motor permanece fail-closed até uma configuração Shadow explícita e segura.</span></DesktopEmptyState> : null}
        {intentRows.length ? <div className="desktop-table-wrap"><table><thead><tr><th>Ativo</th><th>Lado</th><th>Slot</th><th>Preço</th><th>Quantidade</th><th>Motivo</th><th>Status</th></tr></thead><tbody>{intentRows.map((intent) => <tr key={intent.id}><td>{intent.asset}</td><td>{intent.side}</td><td>{intent.slot_id.slice(0, 8)}</td><td>{displayNumber(intent.observed_market_price, 2)}</td><td>{displayNumber(intent.quantity, 8)}</td><td>{intent.strategy_reason}</td><td>{intent.status}</td></tr>)}</tbody></table></div> : null}
      </DesktopPanel>
    </DesktopWorkspace>
  );
}

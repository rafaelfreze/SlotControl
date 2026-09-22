import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DesktopEmptyState, DesktopKpiCard, DesktopPanel, DesktopWorkspace } from "@/components/app/desktop-workspace";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Automação" };
export const dynamic = "force-dynamic";

type IntentRow = { id: string; asset: string; slot_id: string; side: string; quantity: number | string; observed_market_price: number | string; strategy_reason: string; status: string; created_at: string };
type ReconciliationRunRow = { id: string; status: string; completed_at: string | null; summary: { MATCH?: number; EXPECTED_ONLY?: number; EXCHANGE_ONLY?: number; QUANTITY_MISMATCH?: number; PRICE_MISMATCH?: number; STATUS_MISMATCH?: number; balances?: Array<{ asset: string; free: number; locked: number; total: number }> } | null };

function displayNumber(value: number | string | null | undefined, digits = 4) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric.toLocaleString("pt-BR", { maximumFractionDigits: digits }) : "—"; }
function displayDate(value: string | null | undefined) { return value ? new Date(value).toLocaleString("pt-BR") : "—"; }

export default async function AutomationPage() {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const [connectionResponse, engineResponse, assetResponse, intentsResponse, runsResponse] = await Promise.all([
    supabase.from("exchange_connections").select("connection_status,last_reconciled_at,last_synced_at,last_error_code,api_key_masked").eq("exchange", "BINANCE_SPOT").maybeSingle(),
    supabase.from("execution_engine_settings").select("execution_mode,global_kill_switch").maybeSingle(),
    supabase.from("execution_asset_settings").select("asset,automation_enabled,kill_switch"),
    supabase.from("exchange_order_intents").select("id,asset,slot_id,side,quantity,observed_market_price,strategy_reason,status,created_at").order("created_at", { ascending: false }).limit(12),
    supabase.from("exchange_reconciliation_runs").select("id,status,completed_at,summary").order("created_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  const connection = connectionResponse.data;
  const engine = engineResponse.data;
  const assets = assetResponse.data || [];
  const intentRows = (intentsResponse.data || []) as IntentRow[];
  const latestRun = runsResponse.data as ReconciliationRunRow | null;
  const balanceFor = (asset: string) => latestRun?.summary?.balances?.find((balance) => balance.asset === asset);
  const globalKillSwitch = engine?.global_kill_switch ?? true;
  const mismatches = (latestRun?.summary?.EXPECTED_ONLY || 0) + (latestRun?.summary?.EXCHANGE_ONLY || 0) + (latestRun?.summary?.QUANTITY_MISMATCH || 0) + (latestRun?.summary?.PRICE_MISMATCH || 0) + (latestRun?.summary?.STATUS_MISMATCH || 0);
  return <DesktopWorkspace title="Automação / Exchange" subtitle="Binance Spot em leitura segura e CoinOps em Shadow" userLabel={user.email || "Usuário"}>
    <div className="desktop-kpi-grid">
      <DesktopKpiCard label="Modo CoinOps" value={engine?.execution_mode || "SHADOW"} helper="LIVE bloqueado estruturalmente" tone="info" />
      <DesktopKpiCard label="Binance Spot" value={connection?.connection_status === "READ_ONLY" || connection?.connection_status === "CONNECTED" ? "Conectada" : connection?.connection_status === "ERROR" ? "Erro" : "Desconectada"} helper={connection?.api_key_masked ? `API somente leitura ${connection.api_key_masked}` : "Credenciais apenas no servidor"} tone={connection?.connection_status === "ERROR" ? "negative" : "neutral"} />
      <DesktopKpiCard label="Última sincronização" value={displayDate(connection?.last_synced_at || connection?.last_reconciled_at)} helper={connection?.last_error_code ? `Código: ${connection.last_error_code}` : "Somente GET na Binance"} />
      <DesktopKpiCard label="Trading CoinOps" value="BLOQUEADO" helper="Não há create/cancel/transfer/withdraw" tone="positive" />
    </div>
    <DesktopPanel eyebrow="BINANCE" title="Saldos reconciliados"><div className="desktop-kpi-grid">{(["BTC", "SOL", "USDT"] as const).map((asset) => { const balance = balanceFor(asset); return <DesktopKpiCard key={asset} label={asset} value={displayNumber(balance?.total, 8)} helper={`Livre ${displayNumber(balance?.free, 8)} · Bloqueado ${displayNumber(balance?.locked, 8)}`} />; })}</div></DesktopPanel>
    <DesktopPanel eyebrow="COINOPS" title="Controles Shadow"><div className="desktop-kpi-grid"><DesktopKpiCard label="Kill switch global" value={globalKillSwitch ? "ATIVO" : "Liberado p/ Shadow"} helper={globalKillSwitch ? "Falha fechada: nenhum intent novo" : "Ainda sem execução real"} tone={globalKillSwitch ? "positive" : "info"} />{(["BTC", "SOL"] as const).map((asset) => { const setting = assets.find((row) => row.asset === asset); const off = !setting?.automation_enabled || setting.kill_switch !== false; return <DesktopKpiCard key={asset} label={`${asset} Automation`} value={off ? "OFF" : "SHADOW"} helper={off ? "Automação desabilitada ou kill switch ativo" : "Somente intenção auditável"} tone={off ? "neutral" : "info"} />; })}</div></DesktopPanel>
    <DesktopPanel eyebrow="RECONCILIAÇÃO" title="Binance real versus CoinOps Shadow">{!latestRun ? <DesktopEmptyState title="Nenhuma reconciliação executada"><span>A sincronização só é iniciada pelo cron protegido quando uma conexão read-only é configurada no servidor.</span></DesktopEmptyState> : <div className="desktop-kpi-grid"><DesktopKpiCard label="Última execução" value={latestRun.status} helper={displayDate(latestRun.completed_at)} tone={latestRun.status === "COMPLETED" ? "positive" : latestRun.status === "FAILED" ? "negative" : "info"} /><DesktopKpiCard label="Matches" value={String(latestRun.summary?.MATCH || 0)} helper="Somente correlação determinística" /><DesktopKpiCard label="Divergências" value={String(mismatches)} helper="Nunca corrige slots automaticamente" tone={mismatches ? "info" : "positive"} /><DesktopKpiCard label="Não correlacionados" value={String(latestRun.summary?.EXCHANGE_ONLY || 0)} helper="Trades antigos permanecem Exchange-only" /></div>}</DesktopPanel>
    <DesktopPanel eyebrow="AUDITORIA" title="Últimas intenções Shadow">{intentsResponse.error ? <DesktopEmptyState title="Não foi possível carregar as intenções"><span>{intentsResponse.error.message}</span></DesktopEmptyState> : null}{!intentsResponse.error && intentRows.length === 0 ? <DesktopEmptyState title="Nenhuma intenção registrada"><span>O motor permanece fail-closed até uma configuração Shadow explícita e segura.</span></DesktopEmptyState> : null}{intentRows.length ? <div className="desktop-table-wrap"><table><thead><tr><th>Data</th><th>Ativo</th><th>Lado</th><th>Slot</th><th>Preço</th><th>Quantidade</th><th>Motivo</th><th>Status</th></tr></thead><tbody>{intentRows.map((intent) => <tr key={intent.id}><td>{displayDate(intent.created_at)}</td><td>{intent.asset}</td><td>{intent.side}</td><td>{intent.slot_id.slice(0, 8)}</td><td>{displayNumber(intent.observed_market_price, 2)}</td><td>{displayNumber(intent.quantity, 8)}</td><td>{intent.strategy_reason}</td><td>{intent.status}</td></tr>)}</tbody></table></div> : null}</DesktopPanel>
  </DesktopWorkspace>;
}

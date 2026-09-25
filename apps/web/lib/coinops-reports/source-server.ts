import "server-only";

import { createClient } from "@/lib/supabase/server";
import { loadLiveProductionSnapshot } from "@/lib/execution/live-preparation-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema, getSupabaseEnv } from "@/lib/supabase/env";
import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { selectedReportEngines } from "./engine-report-scope";
import type { createServiceRoleClient } from "@/lib/supabase/service-role";
import { resolveEngineContext } from "@/lib/execution/operator-context";
import {
  readScopedPages, ReportSourceError, validateReportScope,
  type RawReportSources, type ReportFilters, type ReportReadClient, type ReportScope, type SourceDefinition, type SourceRow,
} from "./source-contract";

const MAX_SOURCE_ROWS = 50_000;
const MAX_AUDIT_CANDLES = 100_000;
const CANDLE_COLUMNS = "id,config_id,cycle_id,symbol,candle_open_at,candle_close_at,open_price,high_price,low_price,close_price,created_at";
const ENGINE_TABLES = new Set(["robot_v1_configs", "robot_v1_cycles", "robot_v1_slots", "robot_v1_slot_operations",
  "robot_v1_slot_accounts", "robot_v1_slot_profit_credits", "robot_v1_audit_events", "robot_v1_market_candles",
  "robot_v1_testnet_runs", "robot_v1_testnet_slots", "robot_v1_testnet_orders", "robot_v1_testnet_events",
  "robot_v1_live_preparations", "robot_v1_live_slot_accounts", "robot_v1_live_runs", "robot_v1_live_slots", "robot_v1_live_orders",
  "robot_v1_live_fills", "robot_v1_live_events", "robot_v1_ath_profiles", "robot_v1_ath_events", "robot_v1_manual_adjustments",
  "robot_v1_monthly_slot_gains", "robot_v1_strategy_decisions", "robot_v1_live_alerts", "robot_v1_real_prepared_slot_accounts"]);
ENGINE_TABLES.add("robot_v1_live_adjustment_items");

function assertFilters(filters: ReportFilters) {
  const start = Date.parse(filters.start); const end = Date.parse(filters.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86_400_000
    || !filters.assets.length || !filters.environments.length
    || filters.assets.some((asset) => !["BTC", "SOL"].includes(asset))
    || filters.environments.some((environment) => !["SHADOW", "TESTNET", "REAL"].includes(environment))) {
    throw new ReportSourceError("COINOPS_REPORT_FILTERS_INVALID", 422);
  }
}

/** Uses the signed-in user's anonymous-key client: RLS stays active throughout. */
async function authenticatedContext(): Promise<{ client: ReportReadClient; scope: ReportScope }> {
  const { supabaseUrl } = getSupabaseEnv();
  if (getSupabaseDataSchema() !== "coinops" || new URL(supabaseUrl).hostname !== "otdfpmsegjxpqrzisfmi.supabase.co") {
    throw new ReportSourceError("COINOPS_REPORT_BACKEND_INVALID");
  }
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new ReportSourceError("COINOPS_REPORT_SCOPE_INVALID", 403);
  const client = createClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) throw new ReportSourceError("COINOPS_REPORT_AUTH_REQUIRED", 401);
  // This relation is already protected by CoinOps membership/owner RLS. The
  // tenant comes from server configuration, never query strings or form data.
  const { data, error } = await client.from("strategies").select("product_id,tenant_id,user_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).limit(2);
  const rows = data ?? [];
  const productId = rows[0]?.product_id;
  if (error || typeof productId !== "string" || rows.some((row) => row.product_id !== productId || row.tenant_id !== tenantId || row.user_id !== user.id)) {
    throw new ReportSourceError("COINOPS_REPORT_SCOPE_UNAVAILABLE", 403);
  }
  return { client: client as unknown as ReportReadClient, scope: validateReportScope({ productId, tenantId, userId: user.id }) };
}

function source(columns: string, order: string[], options: Partial<SourceDefinition> = {}): SourceDefinition {
  return { columns, order, ...options };
}
function ids(rows: SourceRow[], key = "id") { return rows.flatMap((row) => typeof row[key] === "string" ? [row[key] as string] : []); }

export async function loadRawReportSources(filters: ReportFilters): Promise<RawReportSources> {
  assertFilters(filters);
  const { client, scope } = await authenticatedContext();
  const registry = await loadOperatorRegistry(client as unknown as ReturnType<typeof createServiceRoleClient>,
    { product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId });
  const reportEngines = selectedReportEngines(registry, filters);
  const engineIds = reportEngines.map((engine) => engine.id);
  const generatedAt = new Date().toISOString();
  const sources: Record<string, SourceRow[]> = {};
  const caps = await client.from("account_quote_caps").select("operator_id,exchange_account_id,quote_asset,hard_cap_quote")
    .eq("operator_id", registry.operator.id).in("exchange_account_id", registry.accounts.map((account) => account.id)).range(0, 999);
  if (caps.error || !Array.isArray(caps.data) || caps.data.length === 1000) throw new Error("COINOPS_REPORT_ACCOUNT_CAP_UNAVAILABLE");
  sources.account_quote_caps = caps.data as SourceRow[];
  const incompleteSources: string[] = [];
  const warnings: string[] = [];
  const until = new Date(Math.min(Date.parse(filters.end), Date.parse(generatedAt))).toISOString();
  const withShadow = filters.environments.includes("SHADOW");
  const withTestnet = filters.environments.includes("TESTNET");
  const withReal = filters.environments.includes("REAL");

  async function load(table: string, definition: SourceDefinition, maximum = MAX_SOURCE_ROWS) {
    if (ENGINE_TABLES.has(table)) definition = { ...definition, engineIds };
    if (["robot_v1_live_global_caps", "robot_v1_live_preparation_events", "report_runtime_observations"].includes(table))
      definition = { ...definition, accountIds: [...new Set(reportEngines.map((engine) => engine.exchange_account_id))] };
    const rows: SourceRow[] = [];
    sources[table] = rows;
    try {
      for await (const page of readScopedPages(client, scope, table, definition, filters)) {
        if (rows.length + page.length > maximum) {
          rows.push(...page.slice(0, maximum - rows.length));
          incompleteSources.push(`${table}:row_limit_${maximum}`);
          warnings.push(`A fonte ${table} ultrapassou ${maximum} registros; reduza o período para uma auditoria integral.`);
          break;
        }
        rows.push(...page);
      }
    } catch (error) {
      if (error instanceof ReportSourceError && error.status === 403) throw error;
      incompleteSources.push(`${table}:unavailable`);
      warnings.push(`Não foi possível ler integralmente a fonte ${table}. Ausência de registros não significa ausência de atividade.`);
    }
    return rows;
  }

  const [configs, cycles, runs, liveRuns] = await Promise.all([
    load("robot_v1_configs", source("id,strategy_version,asset,symbol,execution_mode,capital_usdc,slot_count,kill_switch,pause_new_entries,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,shadow_test_started_at,shadow_test_target_end_at,last_candle_open_at,last_market_price,last_market_observed_at,last_engine_at,last_engine_error,grid_status,grid_error,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl,created_at,updated_at", ["id"], { assetColumn: "asset" })),
    withShadow ? load("robot_v1_cycles", source("id,strategy_version,config_id,asset,symbol,execution_mode,status,anchor_price,slot_notional_usdc,capital_usdc,gain_rate,entry_spacing,entry_regime,ath_transition_key,ath_period_key,config_version,config_snapshot,completion_reason,started_at,completed_at,created_at,updated_at", ["started_at", "id"], { assetColumn: "asset", time: "started_at", until })) : Promise.resolve([]),
    withTestnet ? load("robot_v1_testnet_runs", source("id,strategy_version,asset,symbol,status,anchor_price,slot_notional_usdc,gain_rate,entry_spacing,entry_regime,ath_transition_key,ath_period_key,config_version,config_snapshot,next_capital_usdc,next_gain_rate,next_entry_spacing,last_reconciled_at,last_error,created_at,updated_at,previous_run_id,completed_at,completion_reason,terminal_fill_client_order_id,reset_idempotency_key,reset_started_at,reset_completed_at,recovery_source", ["created_at", "id"], { assetColumn: "asset", time: "created_at", until })) : Promise.resolve([]),
    withReal ? load("robot_v1_live_runs", source("id,asset,symbol,status,anchor_price,slot_notional_brl,gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version,ath_transition_key,ath_period_key,previous_run_id,reset_idempotency_key,completed_at,last_reconciled_at,last_error,created_at,updated_at", ["created_at", "id"], { assetColumn: "asset", time: "created_at", until })) : Promise.resolve([]),
  ]);
  const configIds = ids(configs); const cycleIds = ids(cycles); const runIds = ids(runs);
  const relatedConfigs = { column: "config_id", ids: configIds };
  const relatedCycles = { column: "cycle_id", ids: cycleIds };
  const relatedRuns = { column: "run_id", ids: runIds };
  const relatedLiveRuns = { column: "run_id", ids: ids(liveRuns) };
  const tasks: Array<() => Promise<SourceRow[]>> = [];
  tasks.push(() => load("robot_v1_ath_profiles", source("id,environment,asset,config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,next_config_version,next_gain_rate,next_normal_spacing_rate,next_post_ath_spacing_rate,regime,ath_price,previous_ath,ath_observed_at,ath_source,ath_verified_at,ath_history_candle_count,ath_floor_reference,ath_floor_source,ath_floor_defined_at,transition_key,transition_observed_at,created_at,updated_at", ["environment", "asset"], { environmentColumn: true, assetColumn: "asset" })));
  if (withReal) {
    const selectedAccountIds = [...new Set(reportEngines.map((engine) => engine.exchange_account_id))];
    tasks.push(() => load("robot_v1_live_adjustment_batches", source("id,operator_id,exchange_account_id,request_id,kind,quote_asset,origin_currency,origin_amount,amount_quote,fx_rate,fx_observed_at,evidence,reason,reversal_of,created_at", ["created_at", "id"],
      { related: { column: "exchange_account_id", ids: selectedAccountIds }, time: "created_at", until })));
    tasks.push(() => load("robot_v1_live_adjustment_items", source("id,batch_id,symbol,slot_number,physical_slot_id,amount_quote,gain_units,balance_before,balance_after,monthly_before,monthly_after,lifetime_before,lifetime_after,open_at_time,position_committed_quote,operation_sequence,period_key,created_at", ["created_at", "id"],
      { time: "created_at", until })));
    tasks.push(() => load("robot_v1_live_preparations", source("asset,symbol,quote_asset,slot_count,monthly_target,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl,compounding_enabled,single_active_entry,initial_market_enabled,local_reentry_enabled,kill_switch,live_enabled,config_version,updated_at", ["asset"], { assetColumn: "asset" })));
    tasks.push(() => load("robot_v1_live_global_caps", source("max_total_live_exposure_brl,config_version,updated_at", ["updated_at"])));
    tasks.push(() => load("robot_v1_live_slot_accounts", source("asset,slot_number,quote_asset,balance_brl,market_pnl_brl,manual_gain_brl,contribution_brl,fees_brl,balance_quote,market_pnl_quote,manual_gain_quote,contribution_quote,fees_quote,gain_count,dust_quantity,dust_cost_brl,updated_at", ["asset", "slot_number"], { assetColumn: "asset" })));
    tasks.push(() => load("robot_v1_live_preparation_events", source("id,asset,config_version,event_type,snapshot,observed_at", ["observed_at", "id"], { time: "observed_at", until })));
  }
  tasks.push(() => load("robot_v1_ath_events", source("id,profile_id,environment,asset,event_key,event_type,cycle_id,details,observed_at", ["observed_at", "id"], { environmentColumn: true, assetColumn: "asset", time: "observed_at", until })));
  if (withShadow || withTestnet || withReal) tasks.push(() => load("robot_v1_strategy_decisions", source("id,environment,asset,decision_id,strategy_version,cycle_id,slot_id,operation_id,operation_sequence,action_type,target_price,target_notional,priority,reason,expected_next_state,observed_next_state,created_at,dispatched_at,exchange_ack_at,completed_at,result,error,latency_ms,root_cause,resolved_by_version", ["created_at", "id"], { assetColumn: "asset", environmentColumn: true, time: "created_at", until })));
  if (withShadow || withTestnet || withReal) tasks.push(() => load("robot_v1_monthly_slot_gains", source("environment,asset,slot_number,physical_slot_id,source_id,credited_at,effective_gain_at,evidence_basis,period_key,timezone,gain_units", ["effective_gain_at", "source_id"],
    { assetColumn: "asset", environmentColumn: true, time: "effective_gain_at", until })));
  tasks.push(() => load("robot_v1_manual_adjustments", source("id,environment,asset,slot_number,physical_slot_id,kind,gain_units,currency,original_amount,fx_rate,fx_source,fx_observed_at,converted_amount_usdc,balance_before_usdc,balance_after_usdc,monthly_before,monthly_after,lifetime_before,lifetime_after,period_key,open_position_at_time,position_committed_notional_usdc,effective_for_next_operation,reason,note,created_by,reversal_of,idempotency_key,strategy_version,config_version,created_at", ["created_at", "id"],
    { assetColumn: "asset", environmentColumn: true, time: "created_at", until })));
  tasks.push(() => load("report_runtime_observations", source("id,observation_version,event_key,environment,asset,symbol,source,observed_at,started_at,finished_at,status,error_code,metrics,app_commit_sha,created_at", ["observed_at", "id"], { environmentColumn: true, time: "observed_at", from: filters.start, until })));
  if (withShadow) tasks.push(
    () => load("robot_v1_slots", source("id,cycle_id,slot_number,logical_level,operation_sequence,symbol,allocation_usdc,entry_state,entry_origin,operational_rank,post_ath_group,post_ath_group_rank,config_version,config_snapshot,armed_at,missed_at,buy_price,requested_quantity,executed_quantity,average_fill_price,buy_status,take_profit_price,take_profit_status,status,buy_client_order_id,sell_client_order_id,buy_exchange_order_id,sell_exchange_order_id,buy_fee,sell_fee,realized_quote_pnl,idempotency_key,observed_at,buy_trigger_price,buy_trigger_observed_price,buy_triggered_at,tp_trigger_observed_price,tp_triggered_at,created_at,updated_at", ["cycle_id", "slot_number"], { related: relatedCycles })),
    // Include later closures: an operation closed after the cutoff was still an
    // open position then, even if its mutable physical slot has since recycled.
    () => load("robot_v1_slot_operations", source("id,cycle_id,slot_id,physical_slot_number,logical_level,operation_sequence,symbol,allocation_usdc,entry_price,executed_quantity,take_profit_price,config_version,config_snapshot,buy_client_order_id,sell_client_order_id,opened_at,closed_at,gross_quote_pnl,estimated_quote_fees,net_quote_pnl,created_at", ["closed_at", "id"], { related: relatedCycles })),
    () => load("robot_v1_slot_accounts", source("config_id,slot_number,initial_balance_usdc,balance_usdc,gain_count,gross_profit_usdc,fees_usdc,net_profit_usdc,manual_gain_usdc,contribution_usdc,last_operation_id,created_at,updated_at", ["config_id", "slot_number"], { related: relatedConfigs })),
    // Credits can be backfilled after the operation date. Keep them, then join
    // to the immutable operation's closed_at when reporting the chosen period.
    () => load("robot_v1_slot_profit_credits", source("operation_id,config_id,slot_number,previous_balance_usdc,net_profit_usdc,new_balance_usdc,credited_at", ["credited_at", "operation_id"], { related: relatedConfigs })),
  );
  // Configuration controls are shared evidence for Shadow and Testnet. Loading
  // their preceding history is necessary to reconstruct rules effective at start.
  tasks.push(() => load("robot_v1_audit_events", source("id,config_id,cycle_id,slot_id,event_type,previous_state,next_state,observed_at,idempotency_key,created_at", ["observed_at", "id"], { related: relatedConfigs, time: "observed_at", until })));
  if (withShadow || withTestnet) tasks.push(() => load("robot_v1_market_candles", source(CANDLE_COLUMNS, ["candle_open_at", "id"], {
    assetColumn: "symbol", time: "candle_open_at", from: filters.start, until, related: relatedConfigs,
  }), MAX_AUDIT_CANDLES));
  if (withTestnet) tasks.push(
    () => load("robot_v1_testnet_slots", source("id,run_id,slot_number,entry_state,target_buy_price,balance_usdc,gain_count,net_profit_usdc,manual_gain_usdc,contribution_usdc,missed_at,operation_sequence,entry_origin,operational_rank,post_ath_group,post_ath_group_rank,entry_reference_price,last_take_profit_price,last_credited_sell_client_order_id,created_at,updated_at", ["run_id", "slot_number"], { related: relatedRuns })),
    () => load("robot_v1_testnet_orders", source("id,run_id,slot_id,slot_number,side,purpose,revision,operation_sequence,client_order_id,exchange_order_id,status,requested_quantity,requested_quote,price,config_version,config_snapshot,executed_quantity,cumulative_quote,fee_base,fee_quote,fee_other,trades_reconciled,submission_guarded_at,created_at,updated_at", ["created_at", "id"], { related: relatedRuns, time: "created_at", until })),
    () => load("robot_v1_testnet_events", source("id,run_id,event_key,event_type,slot_number,details,observed_at", ["observed_at", "id"], { related: relatedRuns, time: "observed_at", until })),
  );
  if (withReal) tasks.push(
    () => load("robot_v1_live_slots", source("id,run_id,slot_number,entry_state,target_buy_price,entry_reference_price,operation_sequence,entry_origin,operational_rank,post_ath_group,post_ath_group_rank,position_quantity,position_committed_brl,position_committed_quote,missed_at,last_take_profit_price,last_credited_sell_client_order_id,created_at,updated_at", ["run_id", "slot_number"], { related: relatedLiveRuns })),
    () => load("robot_v1_live_orders", source("id,run_id,slot_id,slot_number,operation_sequence,side,purpose,revision,client_order_id,exchange_order_id,status,requested_quantity,requested_quote,price,reserved_notional_brl,reserved_notional_quote,executed_quantity,cumulative_quote,fee_base,fee_quote,fee_other,trades_reconciled,submission_guarded_at,strategy_decision_id,config_version,config_snapshot,created_at,updated_at", ["created_at", "id"], { related: relatedLiveRuns, time: "created_at", until })),
    () => load("robot_v1_live_events", source("id,run_id,event_key,event_type,slot_number,details,observed_at", ["observed_at", "id"], { related: relatedLiveRuns, time: "observed_at", until })),
    () => load("robot_v1_live_alerts", source("id,asset,alert_key,severity,code,details,first_seen_at,last_seen_at,resolved_at", ["last_seen_at", "id"], { time: "last_seen_at", until })),
    () => load("robot_v1_real_prepared_slot_accounts", source("asset,slot_number,balance_usdc,manual_gain_usdc,contribution_usdc,gain_count,created_at,updated_at", ["asset", "slot_number"], { assetColumn: "asset" })),
    () => load("exchange_connections", source("id,exchange,connection_status,last_reconciled_at,last_synced_at,last_error_code,created_at,updated_at", ["id"])),
    () => load("exchange_reconciliation_runs", source("id,connection_id,execution_mode,status,idempotency_key,summary,error_code,started_at,completed_at,created_at,updated_at", ["started_at", "id"], { time: "started_at", from: filters.start, until })),
    () => load("exchange_reconciliation_items", source("id,run_id,classification,entity_type,intent_id,exchange_reference,symbol,details,created_at", ["created_at", "id"], { time: "created_at", from: filters.start, until, reconciliationDivergencesOnly: true })),
    () => load("exchange_order_intents", source("id,strategy_id,slot_id,cycle_id,exchange,execution_mode,asset,symbol,side,quantity,expected_notional_usdt,reference_price,target_price,observed_market_price,observed_at,strategy_reason,strategy_regime,status,idempotency_key,exchange_order_id,last_error_code,created_at,updated_at", ["created_at", "id"], { assetColumn: "asset", time: "created_at", from: filters.start, until })),
    () => load("execution_engine_settings", source("id,execution_mode,global_kill_switch,max_order_notional_usdt,max_daily_notional_usdt,max_market_age_seconds,created_at,updated_at", ["id"])),
    () => load("execution_asset_settings", source("id,asset,automation_enabled,kill_switch,max_order_notional_usdt,max_daily_notional_usdt,created_at,updated_at", ["id"], { assetColumn: "asset" })),
  );
  // Bound simultaneous requests; pagination itself is sequential and stable.
  let taskIndex = 0;
  await Promise.all(Array.from({ length: Math.min(5, tasks.length) }, async () => {
    while (taskIndex < tasks.length) { const task = tasks[taskIndex++]; await task(); }
  }));
  if (withReal) await load("robot_v1_live_fills", source("id,order_id,symbol,exchange_trade_id,quantity,quote_quantity,commission,commission_asset,commission_brl,fee_fx_source,fee_fx_observed_at,filled_at,collected_at", ["filled_at", "id"],
    { related: { column: "order_id", ids: ids(sources.robot_v1_live_orders || []) }, assetColumn: "symbol", time: "filled_at", until }));
  if (withReal) {
    sources.live_market_snapshot = [];
    const grouped = new Map<string, typeof reportEngines>();
    for (const engine of reportEngines.filter((engine) => engine.environment === "REAL" && engine.status === "ACTIVE")) {
      const key = `${engine.exchange_account_id}:${engine.quote_asset}`;
      grouped.set(key, [...(grouped.get(key) ?? []), engine]);
    }
    // One account/quote snapshot, not one polling loop per panel/engine.
    for (const engines of grouped.values()) {
      const contexts = engines.map((engine) => resolveEngineContext(registry, { environment: "REAL",
        exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.id }));
      const live = await loadLiveProductionSnapshot(contexts).catch(() => null);
      if (live) sources.live_market_snapshot.push({ observed_at: live.observedAt, source: live.source,
        operator_id: contexts[0]!.operator_id, exchange_account_id: contexts[0]!.exchange_account_id,
        environment: "REAL", quote_asset: contexts[0]!.quote_asset, markets: live.markets,
        available_quote: live.quoteFree, locked_quote: live.quoteLocked,
        available_brl: live.brlFree, locked_brl: live.brlLocked, balance_observed_at: live.balanceObservedAt, permission: live.permissions });
      else { incompleteSources.push(`live_market_snapshot:${contexts[0]!.exchange_account_id}:unavailable`);
        warnings.push("Consulta GET da conta Production indisponível; preço e saldo não foram inferidos."); }
    }
  }
  if (withShadow) {
    const firstEngineObservation = sources.report_runtime_observations.find((row) => row.source === "SHADOW_ENGINE");
    if (!firstEngineObservation || Date.parse(String(firstEngineObservation.started_at)) > Date.parse(filters.start) + 300_000) incompleteSources.push("shadow_engine_execution_history:before_first_observation_unavailable");
    warnings.push("Estados atuais de configurações, slots e contas são snapshots coletados na geração. Operações e eventos imutáveis reconstroem o período; campos históricos sem evidência permanecem indisponíveis.");
    warnings.push("O histórico individual de execuções do Shadow começa com a Fase 3.9. Antes da primeira observação existem somente o checkpoint e eventos DATA_GAP; intervalos sem negociação não comprovam falha do cron.");
  }
  if (withTestnet) {
    if (!sources.report_runtime_observations.some((row) => row.source === "TESTNET_DIAGNOSTIC")) incompleteSources.push("testnet_account_balances:no_snapshot_in_period");
    incompleteSources.push("testnet_user_stream:continuous_connection_history_not_persisted");
    warnings.push("Snapshots de saldos e permissões Testnet são preservados desde a Fase 3.9 quando o diagnóstico existente é executado na Automação. Não há reconstrução de saldos livres anteriores nem conexão contínua USER_STREAM; exportar não consulta a exchange Testnet.");
    warnings.push("Candles persistidos são do mercado Production usados pelo Shadow; não comprovam execução nem travessia de preço no mercado Binance Testnet.");
  }
  if (withReal) {
    incompleteSources.push("production_http_write_log:not_persisted");
    warnings.push("O banco não mantém um log de cada requisição HTTP Production. O relatório distingue a guarda READ-ONLY do código e a ausência de ordens CoinOps do histórico manual observado na exchange.");
    warnings.push("Política de tamanho: reconciliação inclui detalhes de QUANTITY_MISMATCH, PRICE_MISMATCH, STATUS_MISMATCH e UNKNOWN. MATCH, EXPECTED_ONLY e EXCHANGE_ONLY permanecem contados no resumo de cada execução; linhas externas repetidas não são duplicadas no pacote.");
  }
  return { sources, incompleteSources, warnings, generatedAt, scope, registry };
}

/** Separate full 1m download: bounded period, page-sized memory, no row truncation. */
export async function* iterateReportCandles(filters: ReportFilters): AsyncGenerator<SourceRow[]> {
  assertFilters(filters);
  const { client, scope } = await authenticatedContext();
  const registry = await loadOperatorRegistry(client as unknown as ReturnType<typeof createServiceRoleClient>,
    { product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId });
  const engines = selectedReportEngines(registry, { ...filters, environments: ["SHADOW"] });
  const engineIds = engines.map((engine) => engine.id);
  const until = new Date(Math.min(Date.parse(filters.end), Date.now())).toISOString();
  for await (const rows of readScopedPages(client, scope, "robot_v1_market_candles", source(CANDLE_COLUMNS, ["candle_open_at", "id"], {
    assetColumn: "symbol", time: "candle_open_at", from: filters.start, until, engineIds,
  }), filters)) yield rows.map((row) => {
    const engine = engines.find((candidate) => candidate.id === row.trading_engine_id);
    if (!engine || row.exchange_account_id !== engine.exchange_account_id) throw new Error("COINOPS_REPORT_ENGINE_MISMATCH");
    return { ...row, environment: "SHADOW", quote_asset: engine.quote_asset,
      account_display_name: registry.accounts.find((account) => account.id === engine.exchange_account_id)?.display_name ?? null };
  });
}

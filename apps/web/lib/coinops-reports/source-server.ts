import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema, getSupabaseEnv } from "@/lib/supabase/env";
import {
  readScopedPages, ReportSourceError, validateReportScope,
  type RawReportSources, type ReportFilters, type ReportReadClient, type ReportScope, type SourceDefinition, type SourceRow,
} from "./source-contract";

const MAX_SOURCE_ROWS = 50_000;
const MAX_AUDIT_CANDLES = 100_000;
const CANDLE_COLUMNS = "id,config_id,cycle_id,symbol,candle_open_at,candle_close_at,open_price,high_price,low_price,close_price,created_at";

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
  const generatedAt = new Date().toISOString();
  const sources: Record<string, SourceRow[]> = {};
  const incompleteSources: string[] = [];
  const warnings: string[] = [];
  const until = new Date(Math.min(Date.parse(filters.end), Date.parse(generatedAt))).toISOString();
  const withShadow = filters.environments.includes("SHADOW");
  const withTestnet = filters.environments.includes("TESTNET");
  const withReal = filters.environments.includes("REAL");

  async function load(table: string, definition: SourceDefinition, maximum = MAX_SOURCE_ROWS) {
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

  const [configs, cycles, runs] = await Promise.all([
    load("robot_v1_configs", source("id,strategy_version,asset,symbol,execution_mode,capital_usdc,slot_count,kill_switch,pause_new_entries,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,shadow_test_started_at,shadow_test_target_end_at,last_candle_open_at,last_market_price,last_market_observed_at,last_engine_at,last_engine_error,grid_status,grid_error,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl,created_at,updated_at", ["id"], { assetColumn: "asset" })),
    withShadow ? load("robot_v1_cycles", source("id,strategy_version,config_id,asset,symbol,execution_mode,status,anchor_price,slot_notional_usdc,capital_usdc,gain_rate,entry_spacing,entry_regime,ath_transition_key,ath_period_key,config_version,config_snapshot,completion_reason,started_at,completed_at,created_at,updated_at", ["started_at", "id"], { assetColumn: "asset", time: "started_at", until })) : Promise.resolve([]),
    withTestnet ? load("robot_v1_testnet_runs", source("id,strategy_version,asset,symbol,status,anchor_price,slot_notional_usdc,gain_rate,entry_spacing,entry_regime,ath_transition_key,ath_period_key,config_version,config_snapshot,next_capital_usdc,next_gain_rate,next_entry_spacing,last_reconciled_at,last_error,created_at,updated_at,previous_run_id,completed_at,completion_reason,terminal_fill_client_order_id,reset_idempotency_key,reset_started_at,reset_completed_at,recovery_source", ["created_at", "id"], { assetColumn: "asset", time: "created_at", until })) : Promise.resolve([]),
  ]);
  const configIds = ids(configs); const cycleIds = ids(cycles); const runIds = ids(runs);
  const relatedConfigs = { column: "config_id", ids: configIds };
  const relatedCycles = { column: "cycle_id", ids: cycleIds };
  const relatedRuns = { column: "run_id", ids: runIds };
  const tasks: Array<() => Promise<SourceRow[]>> = [];
  tasks.push(() => load("robot_v1_ath_profiles", source("id,environment,asset,config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,next_config_version,next_gain_rate,next_normal_spacing_rate,next_post_ath_spacing_rate,regime,ath_price,previous_ath,ath_observed_at,ath_source,ath_verified_at,ath_history_candle_count,ath_floor_reference,ath_floor_source,ath_floor_defined_at,transition_key,transition_observed_at,created_at,updated_at", ["environment", "asset"], { environmentColumn: true, assetColumn: "asset" })));
  tasks.push(() => load("robot_v1_ath_events", source("id,profile_id,environment,asset,event_key,event_type,cycle_id,details,observed_at", ["observed_at", "id"], { environmentColumn: true, assetColumn: "asset", time: "observed_at", until })));
  if (withShadow || withTestnet) tasks.push(() => load("robot_v1_strategy_decisions", source("id,environment,asset,decision_id,strategy_version,cycle_id,slot_id,operation_id,operation_sequence,action_type,target_price,target_notional,priority,reason,expected_next_state,observed_next_state,created_at,dispatched_at,exchange_ack_at,completed_at,result,error,latency_ms,root_cause,resolved_by_version", ["created_at", "id"], { assetColumn: "asset", environmentColumn: true, time: "created_at", until })));
  if (withShadow || withTestnet) tasks.push(() => load("robot_v1_monthly_slot_gains", source("environment,asset,slot_number,physical_slot_id,source_id,credited_at,effective_gain_at,evidence_basis,period_key,timezone", ["effective_gain_at", "source_id"],
    { assetColumn: "asset", environmentColumn: true, time: "effective_gain_at", until })));
  tasks.push(() => load("report_runtime_observations", source("id,observation_version,event_key,environment,asset,symbol,source,observed_at,started_at,finished_at,status,error_code,metrics,app_commit_sha,created_at", ["observed_at", "id"], { environmentColumn: true, time: "observed_at", from: filters.start, until })));
  if (withShadow) tasks.push(
    () => load("robot_v1_slots", source("id,cycle_id,slot_number,logical_level,operation_sequence,symbol,allocation_usdc,entry_state,entry_origin,operational_rank,post_ath_group,post_ath_group_rank,config_version,config_snapshot,armed_at,missed_at,buy_price,requested_quantity,executed_quantity,average_fill_price,buy_status,take_profit_price,take_profit_status,status,buy_client_order_id,sell_client_order_id,buy_exchange_order_id,sell_exchange_order_id,buy_fee,sell_fee,realized_quote_pnl,idempotency_key,observed_at,buy_trigger_price,buy_trigger_observed_price,buy_triggered_at,tp_trigger_observed_price,tp_triggered_at,created_at,updated_at", ["cycle_id", "slot_number"], { related: relatedCycles })),
    // Include later closures: an operation closed after the cutoff was still an
    // open position then, even if its mutable physical slot has since recycled.
    () => load("robot_v1_slot_operations", source("id,cycle_id,slot_id,physical_slot_number,logical_level,operation_sequence,symbol,allocation_usdc,entry_price,executed_quantity,take_profit_price,config_version,config_snapshot,buy_client_order_id,sell_client_order_id,opened_at,closed_at,gross_quote_pnl,estimated_quote_fees,net_quote_pnl,created_at", ["closed_at", "id"], { related: relatedCycles })),
    () => load("robot_v1_slot_accounts", source("config_id,slot_number,initial_balance_usdc,balance_usdc,gain_count,gross_profit_usdc,fees_usdc,net_profit_usdc,last_operation_id,created_at,updated_at", ["config_id", "slot_number"], { related: relatedConfigs })),
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
    () => load("robot_v1_testnet_slots", source("id,run_id,slot_number,entry_state,target_buy_price,balance_usdc,gain_count,net_profit_usdc,missed_at,operation_sequence,entry_origin,operational_rank,post_ath_group,post_ath_group_rank,entry_reference_price,last_take_profit_price,last_credited_sell_client_order_id,created_at,updated_at", ["run_id", "slot_number"], { related: relatedRuns })),
    () => load("robot_v1_testnet_orders", source("id,run_id,slot_id,slot_number,side,purpose,revision,operation_sequence,client_order_id,exchange_order_id,status,requested_quantity,requested_quote,price,config_version,config_snapshot,executed_quantity,cumulative_quote,fee_base,fee_quote,fee_other,trades_reconciled,created_at,updated_at", ["created_at", "id"], { related: relatedRuns, time: "created_at", until })),
    () => load("robot_v1_testnet_events", source("id,run_id,event_key,event_type,slot_number,details,observed_at", ["observed_at", "id"], { related: relatedRuns, time: "observed_at", until })),
  );
  if (withReal) tasks.push(
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
  if (withShadow) {
    const firstEngineObservation = sources.report_runtime_observations.find((row) => row.source === "SHADOW_ENGINE");
    if (!firstEngineObservation || Date.parse(String(firstEngineObservation.started_at)) > Date.parse(filters.start) + 300_000) incompleteSources.push("shadow_engine_execution_history:before_first_observation_unavailable");
    warnings.push("Estados atuais de configurações, slots e contas são snapshots coletados na geração. Operações e eventos imutáveis reconstroem o período; campos históricos sem evidência permanecem indisponíveis.");
    warnings.push("O histórico individual de execuções do Shadow começa com a Fase 3.9. Antes da primeira observação existem somente o checkpoint e eventos DATA_GAP; intervalos sem negociação não comprovam falha do cron.");
  }
  if (withTestnet) {
    if (!sources.report_runtime_observations.some((row) => row.source === "TESTNET_DIAGNOSTIC")) incompleteSources.push("testnet_account_balances:no_snapshot_in_period");
    incompleteSources.push("testnet_user_stream:continuous_connection_history_not_persisted");
    warnings.push("Snapshots de saldos e permissões Testnet são preservados desde a Fase 3.9 quando o diagnóstico existente é executado na Automação. Não há reconstrução de saldos livres anteriores nem conexão contínua USER_STREAM; exportar não consulta a exchange.");
    warnings.push("Candles persistidos são do mercado Production usados pelo Shadow; não comprovam execução nem travessia de preço no mercado Binance Testnet.");
  }
  if (withReal) {
    incompleteSources.push("production_http_write_log:not_persisted", "solbrl_exchange_filters:not_persisted");
    warnings.push("O banco não mantém um log de cada requisição HTTP Production. O relatório distingue a guarda READ-ONLY do código e a ausência de ordens CoinOps do histórico manual observado na exchange.");
    warnings.push("Política de tamanho: reconciliação inclui detalhes de QUANTITY_MISMATCH, PRICE_MISMATCH, STATUS_MISMATCH e UNKNOWN. MATCH, EXPECTED_ONLY e EXCHANGE_ONLY permanecem contados no resumo de cada execução; linhas externas repetidas não são duplicadas no pacote.");
  }
  return { sources, incompleteSources, warnings, generatedAt, scope };
}

/** Separate full 1m download: bounded period, page-sized memory, no row truncation. */
export async function* iterateReportCandles(filters: ReportFilters): AsyncGenerator<SourceRow[]> {
  assertFilters(filters);
  const { client, scope } = await authenticatedContext();
  const until = new Date(Math.min(Date.parse(filters.end), Date.now())).toISOString();
  yield* readScopedPages(client, scope, "robot_v1_market_candles", source(CANDLE_COLUMNS, ["candle_open_at", "id"], {
    assetColumn: "symbol", time: "candle_open_at", from: filters.start, until,
  }), filters);
}

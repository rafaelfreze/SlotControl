import type { createServiceRoleClient } from "../supabase/service-role";
import { setTimeout as wait } from "node:timers/promises";
import { validateEnginePlan, type EnginePlanInput } from "./operator-engine-plan.ts";
import { loadEngineAdmissionOptions } from "./engine-admission-router-server.ts";
import { operatorConnectionAdmin, operatorConnectionSnapshot, type OperatorExchangeSnapshot } from "./operator-executor-admin.ts";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { engineAppendAvailableCapital, engineAppendPreviewHash } from "./engine-append-allocation.ts";
import { buildLiveSizing, parseLiveRules } from "./live-preparation.ts";
import { collectAccountOrderBudget, previewAccountOrderBudget } from "./account-order-budget-server.ts";
import { ensureAccountExecutionPolicy } from "./account-execution-policy-server.ts";
import { allocationSnapshotFingerprint, confirmedEngineCapitalExposure, type AllocationSlot, type AllocationOrder } from "./engine-append-exposure.ts";
type Service = ReturnType<typeof createServiceRoleClient>;
export type AppendPlanInput = EnginePlanInput & { shardId: string; previewHash?: string };
type Allocated = { id: string; symbol: string; legacy_compatible: boolean; hard_cap_quote: number | string; executor_shard_id: string };
const unknown = "COINOPS_ENGINE_APPEND_ALLOCATION_UNKNOWN";
function sqlPlan(plan: ReturnType<typeof validateEnginePlan>, shardId: string) {
  return { quote: plan.quote, capital: plan.capital, shardId, engines: plan.engines.map((engine) => ({
    asset: engine.asset, capital: engine.capital, gain: engine.gain, spacing: engine.spacing,
    postAth: engine.postAth, monthlyTarget: engine.monthlyTarget })) };
}
export async function allocatedCapital(service: Service, operatorId: string, accountId: string,
  quote: string, snapshot: OperatorExchangeSnapshot) {
  const [raw, cap, runs] = await Promise.all([
    completeLedgerRead<Allocated>((start, end) => service.from("trading_engines")
      .select("id,symbol,legacy_compatible,hard_cap_quote,executor_shard_id").eq("operator_id", operatorId).eq("exchange_account_id", accountId)
      .eq("environment", "REAL").eq("quote_asset", quote).order("id").range(start, end), unknown),
    service.from("account_quote_caps").select("hard_cap_quote").eq("operator_id", operatorId)
      .eq("exchange_account_id", accountId).eq("quote_asset", quote).maybeSingle(),
    completeLedgerRead<{ id: string; trading_engine_id: string }>((start, end) => service.from("robot_v1_live_runs")
      .select("id,trading_engine_id").eq("operator_id", operatorId).eq("exchange_account_id", accountId)
      .eq("quote_asset", quote).in("status", ["ACTIVE", "PAUSED", "PREPARING"]).order("id").range(start, end), unknown),
  ]);
  if (cap.error || new Set(runs.map((run) => run.trading_engine_id)).size !== runs.length) throw new Error(unknown);
  const inventory = raw.map((engine) => ({ id: engine.id, cap: Number(engine.hard_cap_quote), shard: engine.executor_shard_id }));
  const allSlots: AllocationSlot[] = [], allOrders: AllocationOrder[] = [];
  const runById = new Map(runs.map((run) => [run.id, run]));
  for (let offset = 0; offset < runs.length; offset += 200) {
    const selected = runs.slice(offset, offset + 200).map((run) => run.id);
    const [slots, orders] = await Promise.all([
      completeLedgerRead<AllocationSlot>((start, end) =>
        service.from("robot_v1_live_slots").select("id,run_id,trading_engine_id,operation_sequence,position_quantity,position_committed_brl")
          .eq("operator_id", operatorId).eq("exchange_account_id", accountId).in("run_id", selected).order("id").range(start, end), unknown),
      completeLedgerRead<AllocationOrder>((start, end) =>
        service.from("robot_v1_live_orders").select("id,run_id,slot_id,trading_engine_id,operation_sequence,client_order_id,exchange_order_id,side,purpose,executed_quantity,cumulative_quote,fee_base,fee_quote,trades_reconciled")
          .eq("operator_id", operatorId).eq("exchange_account_id", accountId)
          .in("run_id", selected).order("id").range(start, end), unknown),
    ]);
    if ([...slots, ...orders].some((row) => runById.get(row.run_id)?.trading_engine_id !== row.trading_engine_id)) throw new Error(unknown);
    allSlots.push(...slots); allOrders.push(...orders);
  }
  const free = snapshot.balances.find((balance) => balance.asset === quote)?.free;
  if (free === undefined) throw new Error(unknown);
  const accountCap = Number(cap.data?.hard_cap_quote ?? 0);
  const exposure = confirmedEngineCapitalExposure(raw, allSlots, allOrders, snapshot);
  return { inventory, accountCap, free, ...engineAppendAvailableCapital(free, accountCap, inventory, exposure) };
}

export async function previewEngineAppend(service: Service, operatorId: string, input: AppendPlanInput,
  deadline = Date.now() + 50_000) {
  const plan = validateEnginePlan(input);
  if (plan.quote === "USDC" || !/^executor-[0-9]{2,4}$/.test(input.shardId)) throw new Error("COINOPS_ENGINE_MARKET_DENIED");
  const options = await loadEngineAdmissionOptions(service, operatorId, plan.accountId, plan.engines.length);
  const selected = options.find((option) => option.shardId === input.shardId);
  if (selected?.capacityCode !== "CAPACITY_OK") throw new Error("COINOPS_CAPACITY_REQUIRED");
  if (selected.credential !== "VALIDATED") throw new Error("COINOPS_BINANCE_CREDENTIAL_SHARD_VALIDATION_REQUIRED");
  // Read all symbols for this quote, even when adding another same-symbol
  // engine, to distinguish actual shared wallet holds from spare allocation.
  const symbols = [...new Set([`BTC${plan.quote}`, `SOL${plan.quote}`])];
  const snapshot = await operatorConnectionSnapshot(operatorId, plan.accountId, input.shardId, plan.quote, symbols);
  const allocation = await allocatedCapital(service, operatorId, plan.accountId, plan.quote, snapshot);
  if (allocation.availableCapital + 1e-8 < plan.capital) throw new Error("COINOPS_ENGINE_BALANCE_INSUFFICIENT");
  // Balance and open-orders endpoints are not atomic. Bracket the ledger read:
  // changing holds/fills/balances fail closed, never mix two wallet instants.
  const confirmed = await operatorConnectionSnapshot(operatorId, plan.accountId, input.shardId, plan.quote, symbols);
  if (allocationSnapshotFingerprint(snapshot) !== allocationSnapshotFingerprint(confirmed))
    throw new Error("COINOPS_ENGINE_APPEND_SNAPSHOT_CHANGED");
  const newSymbols = plan.engines.map((engine) => engine.symbol);
  let budget: Awaited<ReturnType<typeof previewAccountOrderBudget>> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    await collectAccountOrderBudget(service, operatorId, plan.accountId, input.shardId, newSymbols, fetch,
      { deadline, minimumValidityMs: 4000 });
    budget = await previewAccountOrderBudget(service, operatorId, plan.accountId, newSymbols);
    if (budget.code !== "ACCOUNT_ORDER_BUDGET_UNKNOWN" || budget.reason !== "interval expired or invalid"
      || attempt === 1 || Date.now() + 5500 >= deadline) break;
    await wait(5500); // Fresh GET after a crossed window, never reuse expired evidence.
  }
  if (!budget) throw new Error("COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN");
  if (budget.code !== "PASS") throw new Error(`COINOPS_${budget.code}`);
  const engines = plan.engines.map((engine) => {
    const market = snapshot.markets.find((row) => row.symbol === engine.symbol)!;
    const sizing = buildLiveSizing(parseLiveRules(market.rules), market.price, { asset: engine.asset,
      symbol: engine.symbol, quote_asset: plan.quote, slot_count: 25, gain_rate: engine.gain,
      normal_spacing_rate: engine.spacing, post_ath_spacing_rate: engine.postAth, regime: "NORMAL",
      monthly_target: engine.monthlyTarget, configured_live_capital_brl: engine.capital,
      max_order_notional_brl: engine.capital, max_total_exposure_brl: engine.capital, config_version: 1,
      live_enabled: false, updated_at: snapshot.observed_at }, allocation.accountCap + plan.capital,
    market.observed_at, Date.now(), { engineCap: engine.capital, orderCap: engine.capital,
      accountCap: allocation.accountCap + plan.capital, quoteAsset: plan.quote });
    return { ...engine, validSlots: sizing.validSlots, minimumCapital: sizing.minimumCapitalBrl,
      currentPrice: market.price, minNotional: sizing.rules.minNotional,
      firstEntry: sizing.slots.find((slot) => slot.operationalRank === 1)?.entryPriceBrl,
      firstTp: sizing.slots.find((slot) => slot.operationalRank === 1)?.tpPriceBrl,
      nextBuy: sizing.slots.find((slot) => slot.operationalRank === 2)?.entryPriceBrl };
  });
  const configuration = sqlPlan(plan, input.shardId);
  const previewHash = engineAppendPreviewHash(configuration, allocation.accountCap, allocation.inventory);
  if (input.previewHash && input.previewHash !== previewHash) throw new Error("COINOPS_ENGINE_APPEND_PREVIEW_CHANGED");
  const saved = await service.from("account_engine_append_previews").upsert({ exchange_account_id: plan.accountId,
    operator_id: operatorId, request_id: plan.requestId, input: configuration, preview_hash: previewHash,
    observed_at: snapshot.observed_at, expected_account_cap: allocation.accountCap,
    engine_inventory: allocation.inventory, available_capital: allocation.availableCapital }, { onConflict: "exchange_account_id,request_id" });
  if (saved.error) throw new Error("COINOPS_ENGINE_APPEND_PREVIEW_UNAVAILABLE");
  return { accountId: plan.accountId, quote: plan.quote, capital: plan.capital, shardId: input.shardId,
    executorIp: selected.ip, observedAt: snapshot.observed_at, free: allocation.free,
    allocatedCapital: allocation.allocatedCapital, availableCapital: allocation.availableCapital,
    capacity: selected, budget, previewHash, engines,
    status: engines.every((engine) => engine.validSlots === 25) ? "PREVIEW_NO_ORDER" : "NOT_EXECUTABLE" };
}

export async function synchronizeAppendedEngines(service: Service, operatorId: string, accountId: string, requestId: string) {
  const check = await service.from("account_onboarding_checks").select("evidence")
    .eq("operator_id", operatorId).eq("exchange_account_id", accountId).eq("idempotency_key", `engine-append:${requestId}`).single();
  const saved = check.data?.evidence;
  if (check.error || !saved?.result?.length || !saved.shardId || !saved.input?.quote) throw new Error("COINOPS_ENGINE_APPEND_SYNC_PENDING");
  const engines = await completeLedgerRead<{ id: string; executor_shard_id: string }>((start, end) => service.from("trading_engines")
    .select("id,executor_shard_id").eq("operator_id", operatorId).eq("exchange_account_id", accountId)
    .eq("environment", "REAL").order("id").range(start, end), "COINOPS_ENGINE_APPEND_SYNC_PENDING");
  // Only numeric shared-account metadata, on every host. No per-engine cap,
  // strategy, flags, credentials or order modification on an installed engine.
  const cap = await service.from("account_quote_caps").select("hard_cap_quote").eq("operator_id", operatorId)
    .eq("exchange_account_id", accountId).eq("quote_asset", saved.input.quote).single();
  if (cap.error || !(Number(cap.data?.hard_cap_quote) > 0)) throw new Error("COINOPS_ENGINE_APPEND_SYNC_PENDING");
  for (const shard of [...new Set(engines.map((engine) => engine.executor_shard_id))].sort()) {
    await operatorConnectionAdmin(operatorId, accountId, shard, "/v1/admin/account-cap",
      { quote_asset: saved.input.quote, account_cap_quote: Number(cap.data!.hard_cap_quote) }, "SHARED_CAP");
  }
  const target = await import("./executor-shards-server.ts").then((module) => module.resolveExecutorForConnection(operatorId, accountId, saved.shardId));
  const ids = saved.result.map((row: { engineId: string }) => row.engineId);
  const rows = await service.from("trading_engines").select("id,symbol,base_asset,quote_asset,hard_cap_quote,executor_shard_id,config")
    .eq("operator_id", operatorId).eq("exchange_account_id", accountId).eq("environment", "REAL").in("id", ids);
  if (rows.error || rows.data?.length !== ids.length || rows.data.some((engine) => engine.executor_shard_id !== saved.shardId))
    throw new Error("COINOPS_ENGINE_APPEND_SYNC_PENDING");
  const result = await operatorConnectionAdmin<{ registered_engines: number; status: string; trading_enabled: boolean }>(
    operatorId, accountId, saved.shardId, "/v1/admin/registry-append", { engines: rows.data.map((engine) => ({
      operator_id: operatorId, exchange_account_id: accountId, trading_engine_id: engine.id, environment: "REAL",
      symbol: engine.symbol, base_asset: engine.base_asset, quote_asset: engine.quote_asset,
      status: "INACTIVE", execution_allowed: false, kill_switch: true, account_kill_switch: true, global_kill_switch: true,
      is_legacy_default: false, legacy_ownership: false, hard_cap_quote: Number(engine.hard_cap_quote),
      account_cap_quote: Number(cap.data!.hard_cap_quote), max_order_quote: Number(engine.config.max_order_quote),
      credential_ref: target.credentialRef, executor_profile: "coinops-fixed-ip" })) }, "REGISTRY");
  if (result.registered_engines !== ids.length || result.status !== "INACTIVE" || result.trading_enabled !== false)
    throw new Error("COINOPS_ENGINE_APPEND_SYNC_PENDING");
  return { status: "INACTIVE", engines: saved.result, requestId };
}

export async function provisionEngineAppend(service: Service, operatorId: string, input: AppendPlanInput) {
  const plan = validateEnginePlan(input), configuration = sqlPlan(plan, input.shardId);
  const existing = await service.from("account_onboarding_checks").select("evidence")
    .eq("operator_id", operatorId).eq("exchange_account_id", plan.accountId)
    .eq("idempotency_key", `engine-append:${plan.requestId}`).maybeSingle();
  if (existing.error) throw new Error("COINOPS_ENGINE_APPEND_STATUS_UNKNOWN");
  if (existing.data) {
    if (JSON.stringify(existing.data.evidence.input) !== JSON.stringify(configuration)) {
      // JSONB key ordering is not JS ordering. Compare semantic object values.
      const saved = existing.data.evidence.input;
      if (saved.quote !== configuration.quote || saved.capital !== configuration.capital || saved.shardId !== configuration.shardId
        || JSON.stringify(saved.engines.map((engine: Record<string, unknown>) => [engine.asset, engine.capital, engine.gain, engine.spacing, engine.postAth, engine.monthlyTarget]))
          !== JSON.stringify(configuration.engines.map((engine) => [engine.asset, engine.capital, engine.gain, engine.spacing, engine.postAth, engine.monthlyTarget])))
        throw new Error("COINOPS_PLAN_REPLAY_MISMATCH");
    }
    return synchronizeAppendedEngines(service, operatorId, plan.accountId, plan.requestId);
  }
  if (!/^[a-f0-9]{64}$/.test(input.previewHash ?? "")) throw new Error("COINOPS_ENGINE_APPEND_PREVIEW_REQUIRED");
  const deadline = Date.now() + 50_000;
  await ensureAccountExecutionPolicy(service, operatorId, plan.accountId, input.shardId, plan.requestId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const preview = await previewEngineAppend(service, operatorId, input, deadline);
    if (preview.status !== "PREVIEW_NO_ORDER") throw new Error("COINOPS_ENGINE_SLOT_NOT_EXECUTABLE");
    // The public preview persisted allocation after its budget check. Refresh
    // LAST, immediately before the serialized SQL gate, not before extra RPCs.
    await collectAccountOrderBudget(service, operatorId, plan.accountId, input.shardId,
      plan.engines.map(engine => engine.symbol), fetch, { deadline, minimumValidityMs: 4000 });
    const created = await service.rpc("append_operator_engine_plan", { p_operator_id: operatorId, p_account_id: plan.accountId,
      p_shard_id: input.shardId, p_quote_asset: plan.quote, p_authorized_capital: plan.capital,
      p_engines: configuration.engines, p_request_id: plan.requestId });
    if (!created.error) break;
    // Only an explicit RAISE from the pre-insert budget gate proves rollback.
    // Never retry a timeout/network/unknown commit. Same UUID and full wallet,
    // hash, capacity and budget revalidation on the one permitted retry.
    if (created.error.code === "P0001" && created.error.message === "COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN"
      && attempt === 0 && Date.now() + 5500 < deadline) { await wait(5500); continue; }
    throw new Error(/^(?:COINOPS|EXECUTOR)_[A-Z0-9_]+$/.test(created.error.message)
      ? created.error.message : "COINOPS_ENGINE_APPEND_FAILED");
  }
  return synchronizeAppendedEngines(service, operatorId, plan.accountId, plan.requestId);
}

import type { LiveExecutorState } from "./live-executor-transport.ts";
import { LIVE_BNB_FEE_MINIMUM_EXCLUSIVE } from "./live-bnb-fee-balance.ts";
import { configuredEngineSlotCount, hasCompletePhysicalSlotSet, MIN_ENGINE_SLOT_COUNT, MAX_ENGINE_SLOT_COUNT } from "./engine-slot-topology.ts";

type Value = string | number | null;
type Owned = { operator_id: string; exchange_account_id: string; trading_engine_id: string };
export type AccountFundingInput = {
  operatorId: string; accountId: string; accountName: string; now?: number;
  engines: Array<{ id: string; operator_id: string; exchange_account_id: string; environment: string;
    quote_asset: string; symbol: string; executor_shard_id?: string | null; status: string; hard_cap_quote: Value; orderPrefix?: string;
    slot_count?: number; config?: unknown }>;
  runs: Array<Owned & { id: string; status: string; last_reconciled_at: string | null; last_error?: string | null }>;
  slotAccounts: Array<Owned & { slot_number: number; balance_quote: Value; dust_cost_quote?: Value }>;
  slots: Array<Owned & { id: string; run_id: string; slot_number: number; position_quantity: Value; position_committed_quote: Value }>;
  orders: Array<Owned & { run_id: string; symbol: string; side: string; status: string; client_order_id: string;
    exchange_order_id: string | null; requested_quantity: Value; executed_quantity: Value;
    reserved_notional_quote: Value; cumulative_quote: Value; price: Value; trades_reconciled?: boolean }>;
  pending: Array<{ trading_engine_id: string; amount_quote: Value }>;
  states: LiveExecutorState[];
};
/** Public read-only evidence from this funding observation, not an order command. */
export type FundingResidentBuy = { engineId: string; runId: string; executorShardId: string;
  clientOrderId: string; exchangeOrderId: string; price: number; quantity: number; executedQuantity: number; reservedQuote: number };
export type FundingSummary = { accountId: string; accountName: string; currency: string; engineCount: number; slotCount: number;
  engineSlotCounts?: number[];
  status: "COVERED" | "SHORTFALL" | "INCOMPLETE"; observedAt: string | null; ledgerTarget: number | null;
  pending: number | null; configuredCap: number | null; positionCost: number | null; buyReserved: number | null;
  spotFree: number | null; spotLocked: number | null; cashRequired: number | null; deficit: number | null;
  coverage: number | null; bnbFree: number | null; bnbStatus: "AVAILABLE" | "LOW" | "UNKNOWN"; issues: string[];
  residentBuys?: FundingResidentBuy[] };

const SCALE = BigInt("1000000000000"), ZERO = BigInt(0);
/** Keep ledger precision, reject missing/negative amounts instead of treating them as zero. */
function decimal(value: Value | undefined): bigint {
  if (value === null || value === undefined || value === "" || typeof value === "number" && !Number.isFinite(value))
    throw new Error("INVALID_AMOUNT");
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match || Math.abs(Number(match[3] ?? 0)) > 100) throw new Error("INVALID_AMOUNT");
  const shift = 12 + Number(match[3] ?? 0) - (match[2]?.length ?? 0), digits = BigInt(match[1] + (match[2] ?? ""));
  return shift >= 0 ? digits * BigInt(10) ** BigInt(shift) : digits / BigInt(10) ** BigInt(-shift);
}
const amount = (value: bigint) => Number(value) / Number(SCALE);
const positive = (value: bigint) => value < ZERO ? ZERO : value;
const fresh = (at: string | null, now: number, age: number) => at !== null && Number.isFinite(Date.parse(at))
  && Date.parse(at) - now <= 2_000 && now - Date.parse(at) <= age;
const fullSlots = (rows: Array<{ slot_number: number }>, count: number) =>
  hasCompletePhysicalSlotSet(rows.map((row) => row.slot_number), count);

/** Informative principal coverage, NEVER a trading/admission decision. Wallet is counted once per account/currency.
 * No future TP proceeds, Earn balance, external locked cash or marked-to-market profit funds the remaining grid. */
export function buildAccountFunding(input: AccountFundingInput): FundingSummary[] {
  const now = input.now ?? Date.now();
  const engines = input.engines.filter((engine) => engine.environment === "REAL");
  const ids = new Set(engines.map((engine) => engine.id));
  if (ids.size !== engines.length || engines.some((engine) => engine.operator_id !== input.operatorId
    || engine.exchange_account_id !== input.accountId)) throw new Error("COINOPS_FUNDING_SCOPE_MISMATCH");
  for (const row of [...input.runs, ...input.slotAccounts, ...input.slots, ...input.orders])
    if (row.operator_id !== input.operatorId || row.exchange_account_id !== input.accountId || !ids.has(row.trading_engine_id))
      throw new Error("COINOPS_FUNDING_SCOPE_MISMATCH");
  for (const row of [...input.slots, ...input.orders])
    if (!input.runs.some((run) => run.id === row.run_id && run.trading_engine_id === row.trading_engine_id))
      throw new Error("COINOPS_FUNDING_RUN_SCOPE_MISMATCH");
  if (input.pending.some((row) => !ids.has(row.trading_engine_id))) throw new Error("COINOPS_FUNDING_SCOPE_MISMATCH");
  return [...new Set(engines.map((engine) => engine.quote_asset))].sort().map((currency) => {
    const group = engines.filter((engine) => engine.quote_asset === currency), issues: string[] = [];
    const result: FundingSummary = { accountId: input.accountId, accountName: input.accountName, currency,
      engineCount: group.length, slotCount: group.reduce((sum, engine) => sum + configuredEngineSlotCount(engine), 0),
      engineSlotCounts: group.map((engine) => configuredEngineSlotCount(engine)), status: "INCOMPLETE", observedAt: null,
      ledgerTarget: null, pending: null, configuredCap: null, positionCost: null, buyReserved: null,
      spotFree: null, spotLocked: null, cashRequired: null, deficit: null, coverage: null,
      bnbFree: null, bnbStatus: "UNKNOWN", issues };
    try {
      const observations = input.states.filter((state) => state.quote_asset === currency);
      if (!observations.length || observations.some((state) => state.operator_id !== input.operatorId
        || state.exchange_account_id !== input.accountId || !group.some((engine) => engine.id === state.trading_engine_id
          && engine.symbol === state.symbol) || !fresh(state.observed_at, now, 30_000))) throw new Error("SPOT_STALE_OR_UNAVAILABLE");
      const wallet = (asset: string) => observations.map((state) => {
        const rows = state.balances.filter((row) => row.asset === asset);
        if (rows.length !== 1) throw new Error("SPOT_ASSET_UNAVAILABLE");
        return { free: decimal(rows[0].free), locked: decimal(rows[0].locked) };
      });
      const quotes = wallet(currency), quote = quotes[0];
      if (quotes.some((row) => row.free !== quote.free || row.locked !== quote.locked)) throw new Error("SPOT_CHANGED_DURING_OBSERVATION");
      result.observedAt = observations.map((state) => state.observed_at).sort()[0];
      result.spotFree = amount(quote.free); result.spotLocked = amount(quote.locked);
      try {
        const fees = wallet("BNB"), bnb = fees[0];
        if (fees.some((row) => row.free !== bnb.free)) throw new Error("BNB_CHANGED_DURING_OBSERVATION");
        result.bnbFree = amount(bnb.free);
        result.bnbStatus = result.bnbFree > LIVE_BNB_FEE_MINIMUM_EXCLUSIVE ? "AVAILABLE" : "LOW";
      } catch { issues.push("BNB_UNAVAILABLE"); }
      let target = ZERO, pending = ZERO, cost = ZERO, reserve = ZERO, cap = ZERO;
      const residentKeys = new Set<string>(), residentBuys: FundingResidentBuy[] = [];
      for (const engine of group) {
        if (!engine.executor_shard_id) throw new Error("ENGINE_SHARD_UNAVAILABLE");
        const runs = input.runs.filter((run) => run.trading_engine_id === engine.id && ["ACTIVE", "PAUSED", "PREPARING"].includes(run.status));
        if (runs.length !== 1 || runs[0].last_error || !fresh(runs[0].last_reconciled_at, now, 180_000)) throw new Error("ENGINE_RECONCILIATION_INCOMPLETE");
        const run = runs[0], ledger = input.slotAccounts.filter((row) => row.trading_engine_id === engine.id);
        const slots = input.slots.filter((row) => row.trading_engine_id === engine.id && row.run_id === run.id);
        const slotCount = configuredEngineSlotCount(engine);
        if (!fullSlots(ledger, slotCount) || !fullSlots(slots, slotCount)) throw new Error("PHYSICAL_SLOTS_INCOMPLETE");
        const ownCost = slots.reduce((sum, slot) => sum + decimal(slot.position_committed_quote), ZERO);
        const ownTarget = ledger.reduce((sum, slot) => sum + decimal(slot.balance_quote), ZERO);
        if (ownCost > ownTarget) throw new Error("POSITION_COST_EXCEEDS_ALLOCATION");
        target += ownTarget; cost += ownCost; cap += decimal(engine.hard_cap_quote);
        pending += input.pending.filter((row) => row.trading_engine_id === engine.id).reduce((sum, row) => sum + decimal(row.amount_quote), ZERO);
        const orders = input.orders.filter((row) => row.trading_engine_id === engine.id && row.run_id === run.id);
        if (orders.some((order) => ["UNKNOWN", "SUBMITTING", "PENDING_CANCEL", "PREPARED"].includes(order.status)
          || order.trades_reconciled === false && decimal(order.executed_quantity) > ZERO)) throw new Error("ORDER_OUTCOME_AMBIGUOUS");
        const state = observations.find((item) => item.symbol === engine.symbol);
        if (!state) throw new Error("MARKET_OBSERVATION_MISSING");
        const bases = state.balances.filter((row) => row.asset === state.filters.baseAsset);
        const baseEngines = engines.filter((row) => row.symbol === `${state.filters.baseAsset}${row.quote_asset}`);
        const currentIds = new Set(input.runs.filter((row) => baseEngines.some((item) => item.id === row.trading_engine_id)
          && ["ACTIVE", "PAUSED", "PREPARING"].includes(row.status)).map((row) => row.id));
        const ownedBase = input.slots.filter((row) => currentIds.has(row.run_id))
          .reduce((sum, row) => sum + decimal(row.position_quantity), ZERO);
        if (bases.length !== 1 || ownedBase > decimal(bases[0].free) + decimal(bases[0].locked)) throw new Error("POSITION_WALLET_MISMATCH");
        // Also check SELL identities/quantities: a fill during this observation is not a cash shortage proof.
        for (const order of orders.filter((row) => ["NEW", "PARTIALLY_FILLED"].includes(row.status))) {
          const key = `${engine.symbol}:${order.client_order_id}`;
          if (residentKeys.has(key)) throw new Error("ORDER_OWNERSHIP_AMBIGUOUS");
          residentKeys.add(key);
          const candidates = state.open_orders.filter((row) => row.clientOrderId === order.client_order_id);
          const resident = candidates[0];
          if (!engine.orderPrefix || !order.client_order_id.startsWith(engine.orderPrefix)
            || candidates.length !== 1 || !order.exchange_order_id || order.symbol !== engine.symbol
            || resident.id !== order.exchange_order_id || resident.symbol !== engine.symbol
            || resident.side !== order.side || resident.status !== order.status
            || decimal(resident.executedQuantity) !== decimal(order.executed_quantity)
            || decimal(resident.originalQuantity) !== decimal(order.requested_quantity)) throw new Error("ORDER_LEDGER_OBSERVATION_MISMATCH");
          if (order.side === "BUY") {
            if (decimal(resident.price) !== decimal(order.price)) throw new Error("BUY_PRICE_MISMATCH");
            const logical = positive(decimal(order.reserved_notional_quote) - decimal(order.cumulative_quote));
            const physical = positive(decimal(resident.originalQuantity) - decimal(resident.executedQuantity)) * decimal(resident.price) / SCALE;
            const reserved = logical < physical ? logical : physical;
            reserve += reserved;
            residentBuys.push({ engineId: engine.id, runId: run.id, executorShardId: engine.executor_shard_id,
              clientOrderId: order.client_order_id, exchangeOrderId: order.exchange_order_id,
              price: amount(decimal(resident.price)), quantity: amount(decimal(resident.originalQuantity)),
              executedQuantity: amount(decimal(resident.executedQuantity)), reservedQuote: amount(reserved) });
          }
        }
      }
      // A read-only valuation cannot repair or adopt an order that appeared
      // between snapshots. Check both directions, including older-run residents.
      for (const state of observations) for (const resident of state.open_orders) {
        const owners = group.filter((engine) => engine.symbol === resident.symbol
          && engine.orderPrefix && resident.clientOrderId?.startsWith(engine.orderPrefix));
        if (!owners.length) continue; // External orders never contribute coverage.
        if (owners.length !== 1 || !resident.clientOrderId
          || !residentKeys.has(`${resident.symbol}:${resident.clientOrderId}`)) throw new Error("UNATTRIBUTED_OWNED_RESIDENT");
      }
      if (reserve > quote.locked || cost + reserve > target + pending) throw new Error("RESERVATION_OBSERVATION_MISMATCH");
      result.ledgerTarget = amount(target); result.pending = amount(pending); result.configuredCap = amount(cap);
      result.positionCost = amount(cost); result.buyReserved = amount(reserve);
      const required = positive(target + pending - cost - reserve), deficit = positive(required - quote.free);
      result.cashRequired = amount(required); result.deficit = amount(deficit); result.coverage = amount(cost + reserve + quote.free);
      result.status = deficit > ZERO ? "SHORTFALL" : "COVERED";
      // Publish only after the complete observation (including reverse ownership
      // and aggregate reservation checks) succeeded. Never expose partial proof.
      result.residentBuys = residentBuys;
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "FUNDING_OBSERVATION_UNAVAILABLE");
    }
    return result;
  });
}

export const BRL_FUNDING_RESUME_OBSERVATION_LIMIT = 50;

/** Administrative observation only: never funding, order permission or a gate.
 * Keep the actual SHORTFALL/deficit. Every BUY still needs its full Spot amount,
 * BNB, ownership and all canonical safety checks; other currencies never inherit BRL tolerance. */
export function fundingResumeToleranceObservation(row: FundingSummary, now = Date.now()): string | null {
  const counts = row.engineSlotCounts;
  const topologyComplete = counts === undefined ? row.slotCount === row.engineCount * 25
    : counts.length === row.engineCount && counts.every((count) => Number.isSafeInteger(count)
      && count >= MIN_ENGINE_SLOT_COUNT && count <= MAX_ENGINE_SLOT_COUNT)
      && counts.reduce((sum, count) => sum + count, 0) === row.slotCount;
  if (row.currency !== "BRL" || row.status !== "SHORTFALL" || row.issues.length
    || !fresh(row.observedAt, now, 30_000) || !Number.isFinite(now)
    || !Number.isSafeInteger(row.engineCount) || row.engineCount <= 0 || !Number.isSafeInteger(row.slotCount)
    || row.slotCount < row.engineCount * MIN_ENGINE_SLOT_COUNT || row.slotCount > row.engineCount * MAX_ENGINE_SLOT_COUNT
    || !topologyComplete
    || row.bnbStatus === "UNKNOWN"
    || [row.ledgerTarget, row.pending, row.configuredCap, row.positionCost, row.buyReserved,
      row.spotFree, row.spotLocked, row.cashRequired, row.deficit, row.coverage, row.bnbFree]
      .some((value) => value === null || !Number.isFinite(value) || value < 0)
    || row.deficit! <= 0 || row.deficit! > BRL_FUNDING_RESUME_OBSERVATION_LIMIT) return null;
  return "Diferença de principal dentro da tolerância administrativa de R$ 50,00. Essa diferença para a grade completa, sozinha, não impede solicitar a reativação manual. Cada nova BUY continua exigindo saldo Spot integral, reserva BNB e todas as verificações de segurança. Não acrescenta saldo nem autoriza ordens.";
}

export function fundingClientMessage(row: FundingSummary, now = Date.now()): string {
  const money = (value: number | null) => value === null ? "não apurado" : `${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${row.currency}`;
  if (row.status === "INCOMPLETE") return `${row.accountName}: a verificação de saldo da operação completa está incompleta. Atualize os dados antes de indicar um valor de reposição. Nenhuma ordem foi alterada.`;
  const observation = fundingResumeToleranceObservation(row, now);
  return `${row.accountName}: verificação Spot em ${row.observedAt}. Para ${row.engineCount} motor(es) e ${row.slotCount} slots, a alocação atual é ${money(row.ledgerTarget)}, com ${money(row.pending)} em aportes pendentes. Já estão aplicados ${money(row.positionCost)} em posições e ${money(row.buyReserved)} em BUY residentes próprias. O caixa livre necessário para o restante é ${money(row.cashRequired)}; há ${money(row.spotFree)} disponível no Spot. ${row.status === "SHORTFALL" ? `Faltam ${money(row.deficit)} de principal para cobrir toda essa alocação.` : "O principal da alocação está coberto neste snapshot."}${observation ? ` ${observation}` : ""} BNB livre: ${row.bnbFree === null ? "não apurado" : row.bnbFree.toLocaleString("pt-BR", { maximumFractionDigits: 8 })}; ${row.bnbStatus === "LOW" ? "reserva abaixo do mínimo técnico." : "taxas futuras não estão provisionadas nesta conta de principal."} Saldo Earn não é caixa Spot; não houve cancelamento nem alteração de estratégia. Este diagnóstico não garante rentabilidade nem autoriza ordens.`;
}

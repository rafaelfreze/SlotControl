import { monthlyPeriodKey } from "../execution/monthly-slot-policy.ts";
import type { AuditDatasets } from "./report-engine.ts";
import type { AuditRow } from "./trigger-audit.ts";

const s = (value: unknown) => typeof value === "string" ? value : "";
const n = (value: unknown) => Number(value ?? 0);
const at = (value: unknown) => Date.parse(s(value));
type Status = "PASS" | "WARNING" | "FAIL";

/** Checks state exactly what persisted evidence can prove. A period without a
 * month rollover or a missing source is WARNING, never synthetic success. */
export function buildMonthlyGoalChecks(data: AuditDatasets, source: Record<string, AuditRow[]>, incomplete: string[], generatedAt: string): AuditRow[] {
  const checks: AuditRow[] = [], period = monthlyPeriodKey(generatedAt);
  const missing = (...names: string[]) => incomplete.some((item) => names.some((name) => item === name || item.startsWith(`${name}:`)));
  const add = (code: string, status: Status, explanation: string, scope: AuditRow) => checks.push({ code, status, explanation, ...scope });
  for (const environment of ["SHADOW", "TESTNET"] as const) for (const asset of ["BTC", "SOL"] as const) {
    const rows = data.monthly_goals.filter((row) => row.environment === environment && row.asset === asset);
    if (!rows.length) continue;
    const current = rows.filter((row) => row.period_key === period), scope = { environment, asset, period_key: period };
    const credits = (environment === "SHADOW" ? source.robot_v1_slot_profit_credits ?? [] : source.robot_v1_testnet_events ?? [])
      .filter((row) => environment === "SHADOW" ? source.robot_v1_configs?.some((config) => config.id === row.config_id && config.asset === asset)
        : row.event_type === "SLOT_CLOSED" && n((row.details as AuditRow | undefined)?.profitUsdc) > 0
          && source.robot_v1_testnet_runs?.some((run) => run.id === row.run_id && run.asset === asset));
    const sourceMissing = !Object.hasOwn(source, "robot_v1_monthly_slot_gains")
      || missing("robot_v1_monthly_slot_gains", environment === "SHADOW" ? "robot_v1_slot_profit_credits" : "robot_v1_testnet_events",
        environment === "SHADOW" ? "robot_v1_slot_operations" : "robot_v1_testnet_orders");
    const entrySourceMissing = sourceMissing || missing("robot_v1_strategy_decisions", ...(environment === "SHADOW"
      ? ["robot_v1_slots", "robot_v1_cycles", "robot_v1_configs"]
      : ["robot_v1_testnet_runs"]));
    const eventSourceMissing = entrySourceMissing || missing(environment === "SHADOW" ? "robot_v1_audit_events" : "robot_v1_testnet_events");
    const effectiveAt = (credit: AuditRow) => {
      if (environment === "SHADOW") return source.robot_v1_slot_operations?.find((operation) => operation.id === credit.operation_id)?.closed_at;
      const details = (credit.details ?? {}) as AuditRow;
      const sell = [...(source.robot_v1_testnet_orders ?? [])].filter((order) => order.run_id === credit.run_id
        && n(order.slot_number) === n(credit.slot_number) && order.side === "SELL" && order.purpose === "TP" && order.status === "FILLED"
        && (!details.operationSequence || n(order.operation_sequence) === n(details.operationSequence)))
        .sort((a, b) => n(b.revision) - n(a.revision))[0];
      const fill = source.robot_v1_testnet_events?.find((event) => event.run_id === credit.run_id
        && event.event_type === "TESTNET_FILL_OBSERVED" && ((event.details ?? {}) as AuditRow).clientOrderId === sell?.client_order_id);
      return ((fill?.details ?? {}) as AuditRow).filledAt ?? credit.observed_at;
    };
    const actualFor = (row: AuditRow) => credits.filter((credit) => n(credit.slot_number) === n(row.physical_slot_number)
      && Number.isFinite(at(effectiveAt(credit))) && monthlyPeriodKey(s(effectiveAt(credit))) === row.period_key);
    const fallback = current.some((row) => row.gain_time_basis === "TESTNET_CREDIT_FALLBACK");
    add("MONTHLY_GAIN_COUNT_RECONCILES", !current.length || sourceMissing || fallback ? "WARNING" : current.every((row) => n(row.monthly_gain_count) === actualFor(row).length) ? "PASS" : "FAIL",
      "Contador mensal confrontado com créditos/fechamentos confirmados, por slot físico e período.", scope);
    const reached = current.filter((row) => row.monthly_target_reached === true);
    // A monthly target reached before 4.2 cannot retroactively make a 4.1
    // reentry invalid. The first persisted 4.2 decision is the earliest
    // verifiable enforcement point for this engine/asset.
    const adoptionTimes = (source.robot_v1_strategy_decisions ?? []).filter((decision) => decision.environment === environment
      && decision.asset === asset && decision.strategy_version === "4.2")
      .map((decision) => at(decision.created_at)).filter(Number.isFinite);
    const adoptedAt = adoptionTimes.length ? Math.min(...adoptionTimes) : NaN;
    const legacyTarget = reached.some((row) => {
      const credit = actualFor(row).sort((a, b) => at(environment === "SHADOW" ? a.credited_at : a.observed_at)
        - at(environment === "SHADOW" ? b.credited_at : b.observed_at))[n(row.monthly_gain_target) - 1];
      return credit && at(environment === "SHADOW" ? credit.credited_at : credit.observed_at) < adoptedAt;
    });
    const reachedAt = (row: AuditRow) => actualFor(row).sort((a, b) => at(environment === "SHADOW" ? a.credited_at : a.observed_at)
      - at(environment === "SHADOW" ? b.credited_at : b.observed_at))[n(row.monthly_gain_target) - 1];
    const badEntry = reached.some((row) => {
      const credit = reachedAt(row), threshold = Math.max(at(environment === "SHADOW" ? credit?.credited_at : credit?.observed_at), adoptedAt);
      if (!Number.isFinite(threshold)) return false;
      return environment === "TESTNET"
        ? (source.robot_v1_testnet_orders ?? []).some((order) => order.side === "BUY"
          && n(order.slot_number) === n(row.physical_slot_number) && at(order.created_at) > threshold
          && source.robot_v1_testnet_runs?.some((run) => run.id === order.run_id && run.asset === asset))
        : (source.robot_v1_slot_operations ?? []).some((operation) => n(operation.physical_slot_number) === n(row.physical_slot_number)
          && at(operation.opened_at) > threshold && source.robot_v1_cycles?.some((cycle) => cycle.id === operation.cycle_id
            && source.robot_v1_configs?.some((config) => config.id === cycle.config_id && config.asset === asset)))
          || (source.robot_v1_slots ?? []).some((slot) => n(slot.slot_number) === n(row.physical_slot_number)
            && at(slot.buy_triggered_at) > threshold && source.robot_v1_cycles?.some((cycle) => cycle.id === slot.cycle_id
              && source.robot_v1_configs?.some((config) => config.id === cycle.config_id && config.asset === asset)));
    });
    add("TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY", !current.length || entrySourceMissing || !Number.isFinite(adoptedAt) || reached.some((row) => !reachedAt(row)) ? "WARNING" : badEntry ? "FAIL" : "PASS",
      `Após o crédito que bateu a meta sob 4.2, não pode haver nova BUY; posição OPEN conserva o TP.${legacyTarget ? " Meta anterior à adoção 4.2: entradas legadas preservadas, sem retroatividade." : ""}`, scope);
    const badReentry = reached.some((row) => {
      const credit = reachedAt(row), threshold = Math.max(at(environment === "SHADOW" ? credit?.credited_at : credit?.observed_at), adoptedAt);
      if (!Number.isFinite(threshold)) return false;
      return environment === "TESTNET" ? (source.robot_v1_testnet_events ?? []).some((event) => event.event_type === "SLOT_REENTRY_PLANNED"
        && n(event.slot_number) === n(row.physical_slot_number) && at(event.observed_at) > threshold
        && source.robot_v1_testnet_runs?.some((run) => run.id === event.run_id && run.asset === asset))
        : (source.robot_v1_audit_events ?? []).some((event) => event.event_type === "SLOT_REENTRY_PLANNED"
          && at(event.observed_at) > threshold && source.robot_v1_slots?.some((slot) => slot.id === event.slot_id
            && n(slot.slot_number) === n(row.physical_slot_number) && source.robot_v1_cycles?.some((cycle) => cycle.id === slot.cycle_id
              && source.robot_v1_configs?.some((config) => config.id === cycle.config_id && config.asset === asset))));
    });
    add("TARGET_REACHED_SLOT_HAS_NO_REENTRY", !current.length || eventSourceMissing || !Number.isFinite(adoptedAt) || reached.some((row) => !reachedAt(row)) ? "WARNING" : badReentry ? "FAIL" : "PASS",
      `Nenhuma reentrada local é planejada após a meta sob 4.2.${legacyTarget ? " Reentradas legadas anteriores à adoção permanecem no histórico." : ""}`, scope);
    const history = rows.filter((row) => row.period_key !== period);
    const priorReached = history.filter((row) => row.monthly_target_reached === true);
    const restored = priorReached.every((previous) => current.some((row) => row.physical_slot_number === previous.physical_slot_number
      && n(row.monthly_gain_count) < n(row.monthly_gain_target) && row.eligible_for_new_entry === true));
    add("NEW_MONTH_REENABLES_SLOT", !current.length || !priorReached.length || sourceMissing || !restored ? "WARNING" : "PASS",
      "Reabilitação é comprovada quando o período anterior atingiu a meta e o snapshot atual mostra o slot elegível; se já bateu a nova meta, falta snapshot da virada.", scope);
    const regressed = rows.some((row) => rows.some((earlier) => earlier.physical_slot_number === row.physical_slot_number
      && s(earlier.period_key) < s(row.period_key) && n(earlier.lifetime_gain_count) > n(row.lifetime_gain_count)));
    add("LIFETIME_GAIN_NEVER_RESETS", sourceMissing ? "WARNING" : regressed ? "FAIL" : "PASS",
      "Lifetime não diminui entre períodos; o mês muda sem apagar fatos históricos.", scope);
    const sorted = [...current].filter((row) => row.eligible_for_new_entry === true).sort((a, b) => n(a.operational_rank) - n(b.operational_rank));
    const correctRank = sorted.every((row, index) => n(row.operational_rank) === index + 1
      && (!index || n(sorted[index - 1]!.lifetime_gain_count) > n(row.lifetime_gain_count)
        || n(sorted[index - 1]!.lifetime_gain_count) === n(row.lifetime_gain_count)
          && n(sorted[index - 1]!.physical_slot_number) < n(row.physical_slot_number)));
    add("RANK_DESCENDING_BY_LIFETIME_GAINS", !current.length || sourceMissing ? "WARNING" : correctRank ? "PASS" : "FAIL",
      "Fila elegível ordenada por lifetime decrescente, desempate pelo slot físico.", scope);
    add("RANK_EXCLUDES_TARGET_REACHED", !current.length || sourceMissing ? "WARNING" : current.every((row) => row.monthly_target_reached !== true || row.operational_rank == null) ? "PASS" : "FAIL",
      "META BATIDA fica fora da fila; OPEN continua visível separadamente.", scope);
    const identities = new Map<number, Set<string>>();
    for (const row of rows) {
      const id = n(row.physical_slot_number);
      identities.set(id, (identities.get(id) ?? new Set<string>()).add(s(row.physical_slot_id)));
    }
    add("PHYSICAL_SLOT_ID_IMMUTABLE", sourceMissing ? "WARNING" : identities.size === 25 && [...identities.values()].every((ids) => ids.size === 1 && ![...ids][0]?.includes("UNVERIFIED")) ? "PASS" : "FAIL",
      "Identidade física estável em todos os períodos e 25 slots distintos.", scope);
    const single = data.checks.find((row) => row.environment === environment && row.asset === asset && row.code === "SINGLE_ACTIVE_ENTRY");
    add("SINGLE_ACTIVE_ENTRY_PRESERVED", (single?.status as Status) ?? "WARNING", "Mesmo limite de uma BUY ativa da auditoria operacional.", scope);
    const price = data.checks.find((row) => row.environment === environment && row.asset === asset && row.code === "PRIORITY_REENTRY_MUST_BE_ARMED_BEFORE_LOWER_LEVEL");
    add("PRICE_PRIORITY_PRESERVED", (price?.status as Status) ?? "WARNING", "Prioridade de preço/reentrada prevalece sobre rank físico; evidência de mercado incompleta não vira PASS.", scope);
  }
  for (const asset of ["BTC", "SOL"] as const) {
    const shadow = data.monthly_goals.filter((row) => row.environment === "SHADOW" && row.asset === asset && row.period_key === period);
    const testnet = data.monthly_goals.filter((row) => row.environment === "TESTNET" && row.asset === asset && row.period_key === period);
    if (!shadow.length && !testnet.length) continue;
    add("SHADOW_TESTNET_MONTHLY_TARGET_PARITY", shadow.length !== 25 || testnet.length !== 25 ? "WARNING"
      : shadow.every((row) => n(row.monthly_gain_target) === n(testnet[0]?.monthly_gain_target)) ? "PASS" : "FAIL",
      "Meta mensal por ativo é a mesma nos dois adaptadores da Strategy Engine; contadores permanecem independentes.", { asset, environment: "SHADOW/TESTNET", period_key: period });
  }
  return checks;
}

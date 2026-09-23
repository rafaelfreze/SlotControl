import { auditMonthlyEntryEvidence, hasMonthlyTargetPolicy } from "./monthly-entry-evidence.ts";
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
    const credits = (source.robot_v1_monthly_slot_gains ?? []).filter((row) => row.environment === environment && row.asset === asset);
    const sourceMissing = !Object.hasOwn(source, "robot_v1_monthly_slot_gains")
      || missing("robot_v1_monthly_slot_gains", environment === "SHADOW" ? "robot_v1_slot_profit_credits" : "robot_v1_testnet_events",
        environment === "SHADOW" ? "robot_v1_slot_operations" : "robot_v1_testnet_orders");
    const entrySourceMissing = sourceMissing || missing("robot_v1_strategy_decisions", ...(environment === "SHADOW"
      ? ["robot_v1_slots", "robot_v1_cycles", "robot_v1_configs"]
      : ["robot_v1_testnet_runs"]));
    const eventSourceMissing = entrySourceMissing || missing(environment === "SHADOW" ? "robot_v1_audit_events" : "robot_v1_testnet_events");
    const actualFor = (row: AuditRow) => credits.filter((credit) => n(credit.slot_number) === n(row.physical_slot_number)
      && credit.period_key === row.period_key && Number.isFinite(at(credit.effective_gain_at)));
    const fallback = current.some((row) => row.gain_time_basis === "TESTNET_CREDIT_FALLBACK");
    add("MONTHLY_GAIN_COUNT_RECONCILES", !current.length || sourceMissing || fallback ? "WARNING" : current.every((row) =>
      n(row.monthly_gain_count) === actualFor(row).reduce((total, credit) => total + n(credit.gain_units ?? 1), 0)) ? "PASS" : "FAIL",
      "Contador mensal confrontado com fatos de mercado e ajustes manuais assinados, por slot físico e período.", scope);
    const adoptionTimes = (source.robot_v1_strategy_decisions ?? []).filter((decision) => decision.environment === environment
      && decision.asset === asset && hasMonthlyTargetPolicy(decision.strategy_version))
      .map((decision) => at(decision.created_at)).filter(Number.isFinite);
    const adoptedAt = adoptionTimes.length ? Math.min(...adoptionTimes) : NaN;
    const ownShadowCycle = (id: unknown) => source.robot_v1_cycles?.some((cycle) => cycle.id === id
      && source.robot_v1_configs?.some((config) => config.id === cycle.config_id && config.asset === asset));
    const ownTestnetRun = (id: unknown) => source.robot_v1_testnet_runs?.some((run) => run.id === id && run.asset === asset);
    const entries = environment === "TESTNET"
      ? (source.robot_v1_testnet_orders ?? []).filter((order) => order.side === "BUY" && ownTestnetRun(order.run_id))
        .map((order) => ({ slot: n(order.slot_number), at: order.created_at }))
      : [...(source.robot_v1_slot_operations ?? []).filter((operation) => ownShadowCycle(operation.cycle_id))
        .map((operation) => ({ slot: n(operation.physical_slot_number), at: operation.opened_at })),
      ...(source.robot_v1_slots ?? []).filter((slot) => slot.buy_triggered_at && ownShadowCycle(slot.cycle_id))
        .map((slot) => ({ slot: n(slot.slot_number), at: slot.buy_triggered_at }))];
    const reentries = environment === "TESTNET"
      ? (source.robot_v1_testnet_events ?? []).filter((event) => event.event_type === "SLOT_REENTRY_PLANNED" && ownTestnetRun(event.run_id))
        .map((event) => ({ slot: n(event.slot_number), at: event.observed_at }))
      : (source.robot_v1_audit_events ?? []).filter((event) => event.event_type === "SLOT_REENTRY_PLANNED" && ownShadowCycle(event.cycle_id))
        .map((event) => ({ slot: n(source.robot_v1_slots?.find((slot) => slot.id === event.slot_id)?.slot_number), at: event.observed_at }));
    const entryStatus = auditMonthlyEntryEvidence({ events: entries, credits, goals: rows, adoptedAt });
    const reentryStatus = auditMonthlyEntryEvidence({ events: reentries, credits, goals: rows, adoptedAt });
    add("TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY", !current.length || entrySourceMissing ? "WARNING" : entryStatus,
      "Saldo mensal assinado no instante de cada BUY, após adoção da política 4.2+. Estorno posterior não apaga violação; estorno anterior pode reabilitar.", scope);
    add("TARGET_REACHED_SLOT_HAS_NO_REENTRY", !current.length || eventSourceMissing ? "WARNING" : reentryStatus,
      "Reentrada confrontada com créditos e estornos conhecidos naquele instante; histórico pré-4.2 não é reclassificado retroativamente.", scope);
    const history = rows.filter((row) => row.period_key !== period);
    const priorReached = history.filter((row) => row.monthly_target_reached === true);
    const restored = priorReached.every((previous) => current.some((row) => row.physical_slot_number === previous.physical_slot_number
      && n(row.monthly_gain_count) < n(row.monthly_gain_target) && row.eligible_for_new_entry === true));
    add("NEW_MONTH_REENABLES_SLOT", !current.length || !priorReached.length || sourceMissing || !restored ? "WARNING" : "PASS",
      "Reabilitação é comprovada quando o período anterior atingiu a meta e o snapshot atual mostra o slot elegível; se já bateu a nova meta, falta snapshot da virada.", scope);
    let lifetimeEvidenceMissing = false;
    const regressed = rows.some((row) => rows.some((earlier) => {
      if (earlier.physical_slot_number !== row.physical_slot_number || s(earlier.period_key) >= s(row.period_key)
        || n(earlier.lifetime_gain_count) <= n(row.lifetime_gain_count)) return false;
      const start = at(earlier.next_reset_at), end = Math.min(at(row.next_reset_at), at(generatedAt));
      const own = credits.filter((credit) => n(credit.slot_number) === n(row.physical_slot_number));
      if (!Number.isFinite(start) || !Number.isFinite(end) || own.some((credit) =>
        !Number.isFinite(at(credit.effective_gain_at)) || !Number.isFinite(n(credit.gain_units ?? 1)))) {
        lifetimeEvidenceMissing = true;
        return false;
      }
      // Period snapshots use effective time (not collection time). Reversals
      // must quantitatively explain the decline, including intervening gains.
      const interval = own.filter((credit) => at(credit.effective_gain_at) >= start && at(credit.effective_gain_at) < end);
      const legitimateNegative = interval.every((credit) => n(credit.gain_units ?? 1) >= 0
        || credit.evidence_basis === "MANUAL_GAIN_REVERSAL");
      const expected = n(earlier.lifetime_gain_count) + interval.reduce((total, credit) => total + n(credit.gain_units ?? 1), 0);
      return !legitimateNegative || expected !== n(row.lifetime_gain_count);
    }));
    add("LIFETIME_GAIN_NEVER_RESETS", sourceMissing ? "WARNING" : regressed ? "FAIL" : lifetimeEvidenceMissing ? "WARNING" : "PASS",
      "Lifetime não zera na virada; toda redução deve reconciliar exatamente com créditos e estornos assinados entre os snapshots.", scope);
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
      : [...shadow, ...testnet].every((row) => n(row.monthly_gain_target) === (asset === "BTC" ? 7 : 2))
        && [shadow, testnet].every((rows) => new Set(rows.map((row) => n(row.physical_slot_number))).size === 25
          && rows.every((row) => Number.isInteger(n(row.physical_slot_number)) && n(row.physical_slot_number) >= 1 && n(row.physical_slot_number) <= 25)) ? "PASS" : "FAIL",
      "Meta mensal por ativo é a mesma nos dois adaptadores da Strategy Engine; contadores permanecem independentes.", { asset, environment: "SHADOW/TESTNET", period_key: period });
  }
  return checks;
}

import { monthlyPeriodKey, nextMonthlyResetAt, physicalSlotIdentity, rankMonthlySlots } from "../execution/monthly-slot-policy.ts";
import type { AuditRow } from "./trigger-audit.ts";
import type { AuditFilters } from "./report-engine.ts";

const count = (value: unknown) => Number(value ?? 0);
const string = (value: unknown) => typeof value === "string" ? value : "";
const nextKey = (key: string) => {
  const year = Number(key.slice(0, 4)), month = Number(key.slice(5));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
};

/** Monthly facts come only from the immutable, owner-scoped credit ledger.
 * Historical balances/entry states are deliberately null when no snapshot
 * at that period end exists; never project today's balance into the past. */
export function buildMonthlyAuditRows(args: {
  filters: AuditFilters; observationEnd: string; generatedAt: string; incomplete: boolean;
  credits: AuditRow[]; configs: AuditRow[]; cycles: AuditRow[]; shadowSlots: AuditRow[];
  shadowAccounts: AuditRow[]; runs: AuditRow[]; testnetSlots: AuditRow[];
}): AuditRow[] {
  const { filters, observationEnd, generatedAt, incomplete, credits, configs, cycles,
    shadowSlots, shadowAccounts, runs, testnetSlots } = args;
  const first = monthlyPeriodKey(filters.start), last = monthlyPeriodKey(new Date(Date.parse(observationEnd) - 1));
  const generatedPeriod = monthlyPeriodKey(generatedAt);
  const output: AuditRow[] = [];
  for (let period = first; period <= last; period = nextKey(period)) {
    const nextReset = nextMonthlyResetAt(`${period}-15T12:00:00Z`);
    const cutoff = Math.min(Date.parse(observationEnd), Date.parse(nextReset));
    for (const environment of filters.environments.filter((item) => item !== "REAL")) for (const asset of filters.assets) {
      const config = configs.find((row) => row.asset === asset);
      const activeCycle = [...cycles].filter((row) => row.config_id === config?.id && !row.completed_at).sort((a, b) => string(b.started_at).localeCompare(string(a.started_at)))[0];
      const run = [...runs].filter((row) => row.asset === asset && (row.status === "ACTIVE" || row.status === "PAUSED"))
        .sort((a, b) => string(b.created_at).localeCompare(string(a.created_at)))[0]
        ?? [...runs].filter((row) => row.asset === asset).sort((a, b) => string(b.created_at).localeCompare(string(a.created_at)))[0];
      if (environment === "SHADOW" && !config || environment === "TESTNET" && !runs.some((row) => row.asset === asset)) continue;
      const productId = string((environment === "SHADOW" ? config : run)?.product_id);
      const current = period === generatedPeriod && cutoff >= Date.parse(generatedAt) - 1_000;
      const scopedCredits = credits.filter((row) => row.environment === environment && row.asset === asset && Date.parse(string(row.effective_gain_at)) < cutoff);
      const inputs = Array.from({ length: 25 }, (_, index) => {
        const slotNumber = index + 1;
        const facts = scopedCredits.filter((row) => count(row.slot_number) === slotNumber);
        const gainUnits = (rows: AuditRow[]) => rows.reduce((total, row) => total + count(row.gain_units ?? 1), 0);
        const currentFacts = facts.filter((row) => row.period_key === period);
        const marketFacts = facts.filter((row) => !["MANUAL_TARGET_GAIN", "MANUAL_GAIN_REVERSAL"].includes(string(row.evidence_basis)));
        const manualFacts = facts.filter((row) => ["MANUAL_TARGET_GAIN", "MANUAL_GAIN_REVERSAL"].includes(string(row.evidence_basis)));
        const account = environment === "SHADOW" ? shadowAccounts.find((row) => row.config_id === config?.id && count(row.slot_number) === slotNumber) : null;
        const slot = environment === "SHADOW" ? shadowSlots.find((row) => row.cycle_id === activeCycle?.id && count(row.slot_number) === slotNumber)
          : testnetSlots.find((row) => row.run_id === run?.id && count(row.slot_number) === slotNumber);
        const balance = environment === "SHADOW" ? Number(account?.balance_usdc) : Number(slot?.balance_usdc);
        const physicalSlotId = productId ? physicalSlotIdentity(environment, {
          productId, tenantId: string((environment === "SHADOW" ? config : run)?.tenant_id),
          userId: string((environment === "SHADOW" ? config : run)?.user_id), asset,
          configId: string(config?.id)
        }, slotNumber) : string(facts[0]?.physical_slot_id) || `${environment}:${asset}:UNVERIFIED:${slotNumber}`;
        return { physicalSlotNumber: slotNumber, physicalSlotId,
          lifetimeGainCount: gainUnits(facts), monthlyGainCount: incomplete ? null : gainUnits(currentFacts),
          marketGainCount: gainUnits(marketFacts), manualGainCount: gainUnits(manualFacts),
          monthlyMarketGainCount: gainUnits(currentFacts.filter((row) => marketFacts.includes(row))),
          monthlyManualGainCount: gainUnits(currentFacts.filter((row) => manualFacts.includes(row))),
          balanceUsdc: current && Number.isFinite(balance) && balance > 0 ? balance : 1,
          entryState: current ? string(slot?.entry_state ?? slot?.status) || "UNKNOWN" : "UNKNOWN",
          currentBalance: current && Number.isFinite(balance) && balance > 0 ? balance : null,
          cycleId: current ? string((environment === "SHADOW" ? activeCycle : run)?.id) || null : null,
          strategyVersion: current ? (environment === "SHADOW" ? activeCycle?.strategy_version : run?.strategy_version) ?? null : null
        };
      });
      const ranked = rankMonthlySlots(asset, `${period}-15T12:00:00Z`, inputs);
      for (const status of ranked) {
        const raw = inputs[status.physicalSlotNumber - 1]!;
        output.push({ environment, asset, symbol: `${asset}USDC`, cycle_id: raw.cycleId,
          physical_slot_number: status.physicalSlotNumber, physical_slot_id: status.physicalSlotId,
          operational_rank: status.operationalRank, lifetime_gain_count: status.lifetimeGainCount,
          monthly_gain_count: status.monthlyGainCount, monthly_gain_target: status.monthlyGainTarget,
          market_gain_count: status.marketGainCount, manual_gain_count: status.manualGainCount,
          monthly_market_gain_count: status.monthlyMarketGainCount, monthly_manual_gain_count: status.monthlyManualGainCount,
          monthly_target_reached: status.monthlyTargetReached, period_key: period, timezone: status.timezone,
          eligible_for_new_entry: status.eligibleForNewEntry, blocked_reason: status.blockedReason,
          status: status.monthlyTargetReached ? "META BATIDA" : status.blockedReason ? "EVIDÊNCIA INCOMPLETA" : "ELEGÍVEL",
          current_balance: raw.currentBalance, entry_state: raw.entryState,
          next_action: raw.entryState === "OPEN" || raw.entryState === "TP_ACTIVE" ? "AGUARDAR_TP"
            : status.monthlyTargetReached ? "AGUARDAR_PROXIMO_MES"
            : status.blockedReason ? "RECONCILIAR_EVIDENCIA"
            : raw.entryState === "MISSED" ? "AGUARDAR_PROXIMO_CICLO" : "AGUARDAR_OPORTUNIDADE_DE_PRECO",
          next_reset_at: nextReset, strategy_version: raw.strategyVersion,
          gain_time_basis: incomplete ? null : scopedCredits.some((credit) => ["MANUAL_TARGET_GAIN", "MANUAL_GAIN_REVERSAL"].includes(string(credit.evidence_basis))
            && count(credit.slot_number) === status.physicalSlotNumber && credit.period_key === period)
            ? "MARKET_TP_AND_MANUAL_LEDGER_CREDIT_TIME" : scopedCredits.some((credit) => credit.evidence_basis === "TESTNET_CREDIT_FALLBACK"
            && count(credit.slot_number) === status.physicalSlotNumber && credit.period_key === period)
            ? "TESTNET_CREDIT_FALLBACK" : "CONFIRMED_TP_TIME",
          evidence_basis: incomplete ? "MONTHLY_LEDGER_INCOMPLETE" : "IMMUTABLE_CREDIT_LEDGER; CURRENT_BALANCE_ONLY_WHEN_CURRENT_SNAPSHOT",
          source: "robot_v1_monthly_slot_gains" });
      }
    }
  }
  return output;
}

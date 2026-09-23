import { buildPostAthQueue } from "../execution/ath-regime.ts";
import { MONTHLY_SLOT_TARGET, monthlyPeriodKey } from "../execution/monthly-slot-policy.ts";
import type { AuditRow } from "./trigger-audit.ts";
import type { AuditDatasets } from "./report-engine.ts";

type Status = "PASS" | "WARNING" | "FAIL";
const n = (value: unknown) => value === null || value === undefined ? NaN : Number(value);
const s = (value: unknown) => typeof value === "string" ? value : "";
const obj = (value: unknown): AuditRow => value && typeof value === "object" && !Array.isArray(value) ? value as AuditRow : {};
const close = (left: unknown, right: unknown) => Number.isFinite(n(left)) && Number.isFinite(n(right))
  && Math.abs(n(left) - n(right)) < 1e-8;
const sameRank = (left: unknown, right: unknown) => left == null && right == null || close(left, right);

/** Source-backed current state and historical events. Unobserved market paths
 * are WARNING, never a synthetic PASS from a unit test or an empty table. */
export function buildAthAudit(data: AuditDatasets, source: Record<string, AuditRow[]>,
  incomplete: string[], generatedAt: string): { rows: AuditRow[]; checks: AuditRow[] } {
  const rows: AuditRow[] = [], checks: AuditRow[] = [];
  const missing = (name: string) => incomplete.some((item) => item === name || item.startsWith(`${name}:`));
  const add = (code: string, status: Status, explanation: string, scope: AuditRow) =>
    checks.push({ code, status, explanation, ...scope, evidence: "persisted CoinOps 4.3 profile/cycle/slot/event snapshot" });
  const profiles = source.robot_v1_ath_profiles ?? [];
  const events = source.robot_v1_ath_events ?? [];
  for (const profile of profiles) {
    const environment = s(profile.environment), asset = s(profile.asset);
    if (!["BTC", "SOL"].includes(asset) || !["SHADOW", "TESTNET", "REAL"].includes(environment)) continue;
    const scope = { environment, asset, config_version: profile.config_version };
    const cycleSource = environment === "SHADOW" ? source.robot_v1_cycles ?? []
      : environment === "TESTNET" ? source.robot_v1_testnet_runs ?? [] : [];
    const cycles = cycleSource.filter((cycle) => cycle.asset === asset);
    const latest = [...cycles].sort((left, right) => s(right.started_at ?? right.created_at)
      .localeCompare(s(left.started_at ?? left.created_at)))[0];
    const cycleId = latest?.id ?? null;
    const rawSlots = environment === "SHADOW" ? source.robot_v1_slots ?? [] : source.robot_v1_testnet_slots ?? [];
    const slots = rawSlots.filter((slot) => (slot.cycle_id ?? slot.run_id) === cycleId);
    const ownEvents = events.filter((event) => event.profile_id === profile.id);
    const activeGroup = slots.filter((slot) => slot.post_ath_group === "PRIMARY");
    const reserveGroup = slots.filter((slot) => slot.post_ath_group === "RESERVE");
    rows.push({ ...scope, cycle_id: cycleId, row_type: "PROFILE", regime: profile.regime,
      gain_pct: n(profile.gain_rate) * 100, normal_spacing_pct: n(profile.normal_spacing_rate) * 100,
      post_ath_spacing_pct: n(profile.post_ath_spacing_rate) * 100,
      next_config_version: profile.next_config_version, ath_price: profile.ath_price,
      ath_observed_at: profile.ath_observed_at, ath_source: profile.ath_source,
      ath_verified_at: profile.ath_verified_at, ath_history_candle_count: profile.ath_history_candle_count,
      floor_reference: profile.ath_floor_reference, floor_source: profile.ath_floor_source,
      transition_key: profile.transition_key, primary_size: activeGroup.length,
      reserve_size: reserveGroup.length, simulation_id: null,
      evidence_basis: "CURRENT_PROFILE_AND_CYCLE_SNAPSHOT; simulation is isolated and not persisted" });
    for (const slot of slots) rows.push({ ...scope, cycle_id: cycleId, row_type: "SLOT",
      physical_slot_number: slot.slot_number, physical_slot_id: slot.id,
      operational_rank: slot.operational_rank, post_ath_group: slot.post_ath_group,
      post_ath_group_rank: slot.post_ath_group_rank, entry_origin: slot.entry_origin,
      entry_state: slot.entry_state, status: slot.status, balance_usdc: slot.balance_usdc,
      config_snapshot: slot.config_snapshot ?? null, evidence_basis: "CURRENT_PHYSICAL_SLOT" });
    for (const event of ownEvents) rows.push({ ...scope, cycle_id: event.cycle_id,
      row_type: "TRANSITION_EVENT", event_key: event.event_key, event_type: event.event_type,
      observed_at: event.observed_at, transition_reason: obj(event.details).reason ?? null,
      details: event.details, evidence_basis: "IMMUTABLE_ATH_EVENT" });
    const enough = !missing("robot_v1_ath_profiles") && !missing("robot_v1_ath_events");
    const profileValid = [profile.gain_rate, profile.normal_spacing_rate, profile.post_ath_spacing_rate]
      .every((value) => Number.isFinite(n(value)) && n(value) >= .001 && n(value) <= .2);
    add("ENVIRONMENT_CONFIG_ISOLATED", !enough ? "WARNING" : profiles.filter((item) =>
      item.environment === environment && item.asset === asset).length === 1 ? "PASS" : "FAIL",
    "Perfil único por ambiente e ativo no escopo autenticado.", scope);
    const fresh = s(profile.ath_source).includes("CONFIRMED_1D_FULL_HISTORY")
      && n(profile.ath_history_candle_count) > 0 && Number.isFinite(Date.parse(s(profile.ath_verified_at)))
      && Date.parse(generatedAt) - Date.parse(s(profile.ath_verified_at)) <= 24 * 3_600_000;
    add("ATH_SOURCE_FRESH", !enough || !profile.ath_verified_at ? "WARNING" : fresh ? "PASS" : "FAIL",
      "ATH exige histórico diário completo confirmado e verificação recente; ticker 24h não basta.", scope);
    const eventKeys = ownEvents.map((event) => s(event.event_key));
    add("ATH_TRANSITION_IDEMPOTENT", !enough ? "WARNING" :
      new Set(eventKeys).size === eventKeys.length ? "PASS" : "FAIL",
      "Chaves de eventos ATH não se repetem neste perfil.", scope);
    const snapshot = obj(latest?.config_snapshot);
    const hasSnapshot = latest && latest.config_version !== null && Object.keys(snapshot).length > 0;
    add("CONFIG_SNAPSHOT_MATCHES_EXECUTION", !hasSnapshot || missing(environment === "SHADOW" ? "robot_v1_cycles" : "robot_v1_testnet_runs")
      ? "WARNING" : close(snapshot.gain_rate, latest.gain_rate) ? "PASS" : "FAIL",
      "Gain executado deve coincidir com o snapshot do ciclo; ciclos históricos sem snapshot ficam indeterminados.", scope);
    add("GAIN_PCT_MATCHES_CONFIG", !profileValid || !hasSnapshot
      || n(latest.config_version) !== n(profile.config_version) ? "WARNING" :
      close(latest.gain_rate, profile.gain_rate) ? "PASS" : "FAIL",
    "Comparação condicionada à mesma versão de configuração.", scope);
    for (const [code, field, regime] of [
      ["NORMAL_SPACING_MATCHES_CONFIG", "normal_spacing_rate", "NORMAL"],
      ["POST_ATH_SPACING_MATCHES_CONFIG", "post_ath_spacing_rate", "POST_ATH"],
    ]) add(code, !hasSnapshot || latest.entry_regime !== regime ? "WARNING" :
      close(latest.entry_spacing, snapshot[field]) ? "PASS" : "FAIL",
      "Spacing atual é comparado ao snapshot do ciclo no regime observado.", scope);
    if (environment === "REAL") {
      const realOrders = (source.exchange_order_intents ?? []).filter((order) => order.asset === asset
        && (order.exchange_order_id || ["LIVE", "REAL"].includes(s(order.execution_mode))));
      add("LIVE_CONFIG_DOES_NOT_ENABLE_LIVE", missing("exchange_order_intents") ? "WARNING"
        : realOrders.length ? "FAIL" : "WARNING",
      "Ausência de intent real não comprova guarda HTTP histórica; LIVE permanece bloqueado por contrato de runtime.", scope);
      continue;
    }
    const monthly = data.monthly_goals.filter((row) => row.environment === environment && row.asset === asset
      && row.cycle_id === cycleId);
    const currentMonth = monthly.filter((row) => row.period_key === monthlyPeriodKey(generatedAt));
    let expected: ReturnType<typeof buildPostAthQueue> | null = null;
    if (profile.regime === "POST_ATH" && currentMonth.length === 25 && slots.length === 25) {
      try { expected = buildPostAthQueue(asset as "BTC" | "SOL", currentMonth.map((row) => ({
        physicalSlotId: s(row.physical_slot_id), physicalSlotNumber: n(row.physical_slot_number),
        lifetimeGainCount: n(row.lifetime_gain_count), monthlyGainCount: row.monthly_gain_count === null ? null : n(row.monthly_gain_count),
        entryState: s(slots.find((slot) => n(slot.slot_number) === n(row.physical_slot_number))?.entry_state),
        blocked: row.blocked_reason === "GAIN_EVIDENCE_INCOMPLETE" }))); } catch { expected = null; }
    }
    // Groups are a transition snapshot. Once a slot fills/closes, the current
    // monthly eligibility is no longer the selection basis from that instant.
    const groupComparable = slots.every((slot) => ["PLANNED", "PENDING", "ARMED", "NONE"].includes(s(slot.entry_state)));
    const mapped = expected?.every((item) => {
      const slot = slots.find((row) => n(row.slot_number) === item.physicalSlotNumber);
      return slot && slot.post_ath_group === item.postAthGroup
        && sameRank(slot.post_ath_group_rank, item.postAthGroupRank)
        && sameRank(slot.operational_rank, item.operationalRank);
    });
    add("POST_ATH_PRIMARY_SELECTS_TOP_15", profile.regime !== "POST_ATH" || !expected || !groupComparable ? "WARNING"
      : mapped ? "PASS" : "FAIL", "Seleciona até 15 maiores lifetime gains elegíveis sem renumerar slot físico.", scope);
    const primary = expected?.filter((item) => item.postAthGroup === "PRIMARY").sort((a, b) => a.postAthGroupRank! - b.postAthGroupRank!) ?? [];
    const reserve = expected?.filter((item) => item.postAthGroup === "RESERVE").sort((a, b) => a.postAthGroupRank! - b.postAthGroupRank!) ?? [];
    add("POST_ATH_PRIMARY_EXECUTES_ASCENDING_WITHIN_TOP15", !expected || !groupComparable ? "WARNING" :
      primary.every((item, index) => index === 0 || primary[index - 1]!.lifetimeGainCount <= item.lifetimeGainCount) && mapped ? "PASS" : "FAIL",
      "Ordem planejada crescente; execução futura sem fills permanece fora deste check.", scope);
    add("POST_ATH_RESERVE_EXECUTES_DESCENDING", !expected || !groupComparable ? "WARNING" :
      reserve.every((item, index) => index === 0 || reserve[index - 1]!.lifetimeGainCount >= item.lifetimeGainCount) && mapped ? "PASS" : "FAIL",
      "Ordem planejada decrescente; liberação requer esgotamento do Primary.", scope);
    add("TARGET_REACHED_EXCLUDED_FROM_ATH_GROUPS", !expected || !groupComparable ? "WARNING" :
      expected.filter((item) => item.monthlyGainCount !== null && item.monthlyGainCount >= MONTHLY_SLOT_TARGET[asset as "BTC" | "SOL"])
        .every((item) => item.postAthGroup === null) && mapped ? "PASS" : "FAIL",
      "Meta mensal batida exclui novas entradas sem apagar gains históricos.", scope);
    add("PHYSICAL_SLOT_IMMUTABLE", slots.length !== 25 ? "WARNING" :
      new Set(slots.map((slot) => n(slot.slot_number))).size === 25 ? "PASS" : "FAIL",
      "Os 25 números físicos atuais são únicos; histórico anterior depende do ledger.", scope);
    const carry = (from: string, to: string) => {
      const existing = data.checks.find((check) => check.code === from && check.environment === environment
        && check.asset === asset);
      add(to, existing?.status === "PASS" || existing?.status === "FAIL" ? existing.status as Status : "WARNING",
        `Compartilha evidência com ${from}; ausência de prova continua WARNING.`, scope);
    };
    carry("PRICE_PRIORITY_PRESERVED", "PRICE_PRIORITY_PRESERVED_ATH");
    carry("SINGLE_ACTIVE_ENTRY_PRESERVED", "SINGLE_ACTIVE_ENTRY_PRESERVED_ATH");
    carry("TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY", "MONTHLY_TARGET_PRESERVED");
    add("GLOBAL_RESET_PRESERVES_REGIME", "WARNING",
      "Exige ciclo reiniciado após ATH com snapshot de regime; evento isolado é insuficiente.", scope);
    add("FLOOR_RESTORES_NORMAL", !ownEvents.some((event) => event.event_type === "ATH_FLOOR_REACHED")
      ? "WARNING" : profile.regime === "NORMAL" ? "PASS" : "WARNING",
      "Sem floor observado, não há retorno real a certificar.", scope);
  }
  add("ATH_SIMULATION_DETERMINISTIC", "WARNING",
    "Simulações são isoladas e não persistidas no relatório; executar os testes determinísticos no build.", {});
  return { rows, checks };
}

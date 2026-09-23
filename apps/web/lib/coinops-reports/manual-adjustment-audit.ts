import type { AuditDatasets } from "./report-engine.ts";
import type { AuditRow } from "./trigger-audit.ts";

type Status = "PASS" | "WARNING" | "FAIL";
const n = (value: unknown) => Number(value ?? 0);
const s = (value: unknown) => typeof value === "string" ? value : "";
const close = (a: unknown, b: unknown) => Number.isFinite(n(a)) && Number.isFinite(n(b)) && Math.abs(n(a) - n(b)) < 1e-7;

/** A source-backed check must stay WARNING when the operation has not happened.
 * Unit/simulator evidence is separate from persisted production evidence. */
export function buildManualAdjustmentChecks(data: AuditDatasets, sources: Record<string, AuditRow[]>,
  incomplete: string[], generatedAt: string): AuditRow[] {
  const checks: AuditRow[] = [];
  const rows = sources.robot_v1_manual_adjustments ?? [];
  const facts = sources.robot_v1_monthly_slot_gains ?? [];
  const sourceMissing = !Object.hasOwn(sources, "robot_v1_manual_adjustments")
    || incomplete.some((item) => item.startsWith("robot_v1_manual_adjustments:"));
  const monthlyMissing = !Object.hasOwn(sources, "robot_v1_monthly_slot_gains")
    || incomplete.some((item) => item.startsWith("robot_v1_monthly_slot_gains:"));
  const add = (code: string, status: Status, explanation: string, scope: AuditRow = {}) =>
    checks.push({ code, status, explanation, evidence: "coinops.robot_v1_manual_adjustments + mensal + snapshot; sem operação Binance", ...scope });
  const originals = new Map(rows.map((row) => [s(row.id), row]));
  const gains = rows.filter((row) => row.kind === "MANUAL_TARGET_GAIN" || row.kind === "REVERSAL"
    && originals.get(s(row.reversal_of))?.kind === "MANUAL_TARGET_GAIN");
  const contributions = rows.filter((row) => row.kind === "MANUAL_CONTRIBUTION" || row.kind === "REVERSAL"
    && originals.get(s(row.reversal_of))?.kind === "MANUAL_CONTRIBUTION");
  const reversals = rows.filter((row) => row.kind === "REVERSAL");
  const has = rows.length > 0 && !sourceMissing;
  const factFor = (row: AuditRow) => facts.find((fact) => fact.source_id === row.id && fact.environment === row.environment
    && fact.asset === row.asset && n(fact.slot_number) === n(row.slot_number));
  add("MANUAL_GAIN_RECONCILES", !has || monthlyMissing || !gains.length ? "WARNING"
    : gains.every((row) => n(factFor(row)?.gain_units) === n(row.gain_units)
      && factFor(row)?.evidence_basis === (row.kind === "REVERSAL" ? "MANUAL_GAIN_REVERSAL" : "MANUAL_TARGET_GAIN")) ? "PASS" : "FAIL",
  "Cada gain manual e estorno tem fato mensal assinado, no mesmo ambiente, ativo e slot.");
  add("MANUAL_GAIN_COUNTS_TOWARD_TARGET", !has || monthlyMissing || !gains.length || !data.monthly_goals.length ? "WARNING"
    : data.monthly_goals.every((row) => n(row.monthly_gain_count) === n(row.monthly_market_gain_count) + n(row.monthly_manual_gain_count)) ? "PASS" : "FAIL",
  "Meta mensal soma mercado e manual; ausência de ajuste observado não prova exercício da regra.");
  add("MANUAL_GAIN_DISTINGUISHED_FROM_MARKET", !has || !gains.length || !data.gains.some((row) => row.gain_source === "MANUAL") ? "WARNING"
    : data.gains.filter((row) => row.gain_source === "MANUAL").every((row) => close(row.net_gain, 0)
      && n(row.gain_units) !== 0 && row.operation_id == null) ? "PASS" : "FAIL",
  "Gain manual aparece em linha própria, sem P&L ou operação de mercado fictícia.");
  add("CONTRIBUTION_DOES_NOT_INCREMENT_GAIN", !has || !contributions.length ? "WARNING"
    : contributions.every((row) => n(row.gain_units) === 0 && n(row.monthly_before) === n(row.monthly_after)
      && n(row.lifetime_before) === n(row.lifetime_after)) ? "PASS" : "FAIL",
  "Aporte e respectivo estorno alteram só capital, nunca contadores de gain.");
  const open = rows.filter((row) => row.open_position_at_time === true);
  add("OPEN_POSITION_UNCHANGED_BY_ADJUSTMENT", !has || !open.length ? "WARNING"
    : open.every((row) => n(row.position_committed_notional_usdc) > 0) ? "WARNING" : "FAIL",
  "O ledger registra notional comprometido sem atualizar ordem/posição; snapshot posterior da mesma posição é necessário para prova temporal completa.");
  const futureOps = rows.filter((row) => data.operations.some((operation) => operation.environment === row.environment
    && operation.asset === row.asset && n(operation.physical_slot_number) === n(row.slot_number)
    && Date.parse(s(operation.opened_at)) > Date.parse(s(row.created_at))));
  add("NEXT_OPERATION_USES_ADJUSTED_BALANCE", !has || !futureOps.length ? "WARNING" : "WARNING",
  "A próxima operação deve usar saldo reconciliado. Atribuição exata requer sequência completa de créditos/fechamentos; não se infere de um snapshot.");
  const targetCheck = data.checks.find((row) => row.code === "TARGET_REACHED_SLOT_HAS_NO_NEW_ENTRY" && row.status === "FAIL");
  add("TARGET_REACHED_BLOCKS_FUTURE_ENTRY", !has || !gains.length ? "WARNING" : targetCheck ? "FAIL" : "WARNING",
  "A meta inclui ganho manual; aguardar decisão futura observável após o crédito para provar bloqueio.");
  const rankCheck = data.checks.find((row) => row.code === "RANK_DESCENDING_BY_LIFETIME_GAINS" && row.status === "FAIL");
  add("RANK_RECALCULATES_AFTER_MANUAL_GAIN", !has || !gains.length ? "WARNING" : rankCheck ? "FAIL" : "WARNING",
  "Rank futuro usa lifetime total; decisão posterior ao ajuste é necessária para prova operacional.");
  const brl = rows.filter((row) => row.currency === "BRL");
  add("FX_SOURCE_VALID", !has || !brl.length ? "WARNING"
    : brl.every((row) => row.fx_source === "BINANCE_SPOT_USDCBRL_ASK" && Number.isFinite(n(row.fx_rate)) && n(row.fx_rate) > 0
      && Number.isFinite(Date.parse(s(row.fx_observed_at)))
      && Date.parse(s(row.kind === "REVERSAL" ? originals.get(s(row.reversal_of))?.created_at : row.created_at)) - Date.parse(s(row.fx_observed_at)) >= -10_000
      && Date.parse(s(row.kind === "REVERSAL" ? originals.get(s(row.reversal_of))?.created_at : row.created_at)) - Date.parse(s(row.fx_observed_at)) <= 120_000
      && close(row.converted_amount_usdc, Math.round(n(row.original_amount) / n(row.fx_rate) * 1e8) / 1e8)) ? "PASS" : "FAIL",
  "BRL usa ask USDC/BRL público fresco no ajuste original; reversal preserva a cotação e o valor originais, sem nova conversão.");
  const keys = rows.map((row) => `${row.product_id}:${row.tenant_id}:${row.user_id}:${row.idempotency_key}`);
  add("ADJUSTMENT_IDEMPOTENT", !has ? "WARNING" : new Set(keys).size === keys.length ? "PASS" : "FAIL",
  "Chaves de idempotência distintas no escopo; retries não criam segunda linha.");
  add("REVERSAL_AUDITABLE", !has || !reversals.length ? "WARNING"
    : reversals.every((row) => { const original = originals.get(s(row.reversal_of));
      return original && original.kind !== "REVERSAL" && close(n(row.converted_amount_usdc) + n(original.converted_amount_usdc), 0)
        && n(row.gain_units) === -n(original.gain_units) && row.environment === original.environment
        && row.asset === original.asset && n(row.slot_number) === n(original.slot_number); }) ? "PASS" : "FAIL",
  "Estorno é linha imutável vinculada ao original, com valor e gain_units de sinal contrário.");
  const shadowBalanced = (sources.robot_v1_slot_accounts ?? []).every((row) => close(row.balance_usdc,
    n(row.initial_balance_usdc) + n(row.net_profit_usdc) + n(row.manual_gain_usdc) + n(row.contribution_usdc)));
  const realBalanced = (sources.robot_v1_real_prepared_slot_accounts ?? []).every((row) => close(row.balance_usdc,
    n(row.manual_gain_usdc) + n(row.contribution_usdc)));
  add("LEDGER_BALANCE_RECONCILES", !has ? "WARNING" : rows.every((row) => close(row.balance_after_usdc,
    n(row.balance_before_usdc) + n(row.converted_amount_usdc))) && shadowBalanced && realBalanced ? "PASS" : "FAIL",
  "Saldo = capital inicial + P&L líquido realizado + gains manuais financeiros + aportes − estornos; sem P&L aberto.");
  add("ENVIRONMENT_ISOLATED", !has ? "WARNING"
    : rows.every((row) => s(row.physical_slot_id).startsWith(`${row.environment}:`)
      && ["SHADOW", "TESTNET", "REAL"].includes(s(row.environment))) ? "PASS" : "FAIL",
  "Identidade física e escopo do ajuste incluem ambiente, ativo, usuário e slot.");
  const realOrders = (sources.exchange_order_intents ?? []).filter((row) => ["LIVE", "REAL"].includes(s(row.execution_mode))
    && ["SUBMITTED", "NEW", "FILLED", "PARTIALLY_FILLED", "CANCELED"].includes(s(row.status)));
  add("PRODUCTION_NO_FINANCIAL_ACTION", realOrders.length ? "FAIL" : "WARNING",
  realOrders.length ? "Há intenção de ordem real persistida; investigar." : "Nenhuma intenção real foi encontrada no recorte persistido; HTTP externo não tem trilha completa, logo não há prova absoluta de zero ação.",
  { environment: "REAL", generated_at: generatedAt });
  return checks;
}

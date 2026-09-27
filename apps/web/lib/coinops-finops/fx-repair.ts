import { convertBrl, money, sumKnown } from "./model.ts";
import type { FinopsDashboard, FinopsService, FxQuote } from "./types";

export function missingFinopsFx(capital: FinopsDashboard["capital"], services: FinopsService[], fx: FxQuote[]): string[] {
  const currencies = new Set(capital.accounts.filter(row => row.monitored !== null).map(row => row.currency));
  for (const row of services.filter(row => row.enabled && row.allocationPercent !== null
    && (row.projectedOriginal !== null || row.actualMonthCost !== null))) currencies.add(row.currency);
  return [...currencies].filter(currency => convertBrl(1, currency, fx) === null).sort();
}

export function nextFinopsFxRepair(lastAttemptAt: string, now: Date): string | null {
  const observed = Date.parse(lastAttemptAt);
  if (!Number.isFinite(observed) || observed > now.getTime() + 60_000) throw new Error("COINOPS_FINOPS_SYNC_TIME_INVALID");
  const next = observed + 60_000;
  return next > now.getTime() ? new Date(next).toISOString() : null;
}

/** Pure revaluation of an immutable observation. Never reads balances/providers,
 * changes native capital or pretends the prior wallet/telemetry was recollected. */
export function revalueFinopsFx(previous: FinopsDashboard, quotes: FxQuote[], now: Date): FinopsDashboard {
  const fx = [...previous.fx.filter(old => !quotes.some(quote => quote.base === old.base && quote.quote === old.quote)), ...quotes];
  const services = previous.services.map(row => {
    const allocated = (value: number | null) => value === null || row.allocationPercent === null ? null : value * row.allocationPercent / 100;
    const shared = row.origin === "RATEIO_ESTIMADO" || row.allocationPercent !== null && row.allocationPercent < 100;
    const projectedBrl = convertBrl(allocated(row.projectedOriginal), row.currency, fx);
    const actualBrl = shared || row.origin !== "REAL" ? null : convertBrl(allocated(row.actualMonthCost), row.currency, fx);
    return { ...row, projectedBrl, actualBrl, recurringBrl: convertBrl(allocated(row.recurringMonthly), row.currency, fx),
      estimatedBrl: shared || projectedBrl === null ? null : actualBrl === null ? projectedBrl : money(Math.max(0, projectedBrl - actualBrl)),
      allocatedBrl: shared ? projectedBrl : null };
  });
  const enabled = services.filter(row => row.enabled), actual = sumKnown(enabled.map(row => row.actualBrl)), projected = sumKnown(enabled.map(row => row.projectedBrl));
  const knownMonthly = enabled.some(row => row.projectedBrl !== null) ? projected.known : null;
  const capitalByCurrency: Record<string, number | null> = {};
  for (const currency of new Set(previous.capital.accounts.map(row => row.currency)))
    capitalByCurrency[currency] = sumKnown(previous.capital.accounts.filter(row => row.currency === currency).map(row => row.monitored)).total;
  // Existing snapshots may report capitalComplete=false solely because FX was
  // missing; their native rows are the evidence, not that converted-total flag.
  const nativeComplete = previous.summary.nativeCapitalComplete ?? (previous.summary.capitalComplete
    || previous.capital.accounts.length > 0 && previous.capital.accounts.every(row => row.complete)
      && new Set(previous.capital.accounts.map(row => row.accountId)).size >= previous.summary.accounts
      && !previous.capital.notes.some(note => /^(?:NO_REAL_MARKET|WALLET_UNAVAILABLE|LEDGER_INCOMPLETE):/.test(note)));
  const converted = sumKnown(Object.entries(capitalByCurrency).map(([currency, amount]) => convertBrl(amount, currency, fx)));
  const complete = nativeComplete && converted.complete;
  const executors = previous.executors.map(row => {
    const own = enabled.filter(cost => cost.shardId === row.id);
    const monthlyBrl = own.length ? sumKnown(own.map(cost => cost.projectedBrl)).total : null;
    return { ...row, monthlyBrl, costPerAccountBrl: monthlyBrl === null || !row.accounts ? null : money(monthlyBrl / row.accounts),
      costPerEngineBrl: monthlyBrl === null || !row.engines ? null : money(monthlyBrl / row.engines) };
  });
  const missing = missingFinopsFx(previous.capital, services, fx);
  const unrelatedFailure = previous.alerts.some(alert => alert.code === "BILLING_SYNC_FAILED" && !alert.message.startsWith("Cotação BRL ausente para:"));
  return { ...previous, capturedAt: now.toISOString(), externalCapturedAt: previous.externalCapturedAt ?? previous.capturedAt,
    syncStatus: missing.length || !complete || enabled.some(row => row.projectedBrl === null || row.syncStatus === "FAILED") || unrelatedFailure ? "PARTIAL" : "OK",
    services, fx, executors, history: [], alerts: [],
    summary: { ...previous.summary, nativeCapitalComplete: nativeComplete, capitalByCurrency, capitalComplete: complete,
      capitalBrl: complete ? converted.total : null, actualBrl: actual.total, projectedBrl: projected.total,
      knownActualBrl: actual.known, knownProjectedBrl: projected.known, monthlyEstimatedBrl: knownMonthly,
      costPerAccountBrl: knownMonthly === null || !previous.summary.accounts ? null : money(knownMonthly / previous.summary.accounts),
      costPerEngineBrl: knownMonthly === null || !previous.summary.engines ? null : money(knownMonthly / previous.summary.engines),
      knownRealBrl: enabled.some(row => row.actualBrl !== null) ? actual.known : null,
      estimatedBrl: enabled.some(row => row.estimatedBrl !== null) ? sumKnown(enabled.map(row => row.estimatedBrl)).known : null,
      allocatedBrl: enabled.some(row => row.allocatedBrl !== null) ? sumKnown(enabled.map(row => row.allocatedBrl)).known : null,
      unavailableServices: enabled.filter(row => row.projectedBrl === null).length },
    sources: [...previous.sources.filter(source => !source.startsWith("FX_REPAIR:")),
      `FX_REPAIR: somente conversão atualizada; capital e telemetria preservados da coleta ${previous.externalCapturedAt ?? previous.capturedAt}.`] };
}

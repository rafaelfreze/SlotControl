export type AuditRow = Record<string, unknown>;
export type TriggerWindow = {
  environment: string; asset: string; symbol: string; cycleId: string; slot: number | null;
  operationId?: string | null; type: "BUY" | "TP"; price: number; armedAt: string;
  endedAt: string; observedAt?: string | null; observedAction?: string | null;
  pairedTarget?: number | null;
};
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
const numeric = (value: unknown) => value === null || value === undefined || value === "" ? NaN : Number(value);

/** An armed Shadow trigger may be checked with OHLC, but never a planned level.
 * Production candles do not prove Testnet fills or intrabar ordering. */
export function auditTriggerWindows(windows: TriggerWindow[], candles: AuditRow[], options: { complete: boolean; eventsComplete?: boolean; start: string; end: string; confirmationDelayMs?: number }): AuditRow[] {
  const indexed = new Map<string, AuditRow[]>();
  for (const candle of candles) { const key = String(candle.symbol); if (!indexed.has(key)) indexed.set(key, []); indexed.get(key)!.push(candle); }
  for (const rows of indexed.values()) rows.sort((a, b) => time(a.candle_open_at) - time(b.candle_open_at));
  const lowerBound = (rows: AuditRow[], value: number) => { let low = 0, high = rows.length; while (low < high) { const middle = (low + high) >>> 1; if (time(rows[middle]!.candle_open_at) < value) low = middle + 1; else high = middle; } return low; };
  return windows.map((window) => {
    const indexedRows = indexed.get(window.symbol) ?? [];
    const intervalStart = Math.max(time(window.armedAt), time(options.start));
    const intervalEnd = Math.min(time(window.endedAt), time(options.end));
    const evidence = indexedRows.slice(lowerBound(indexedRows, intervalStart), lowerBound(indexedRows, intervalEnd));
    const cross = evidence.find((candle) => window.type === "BUY" ? numeric(candle.low_price) <= window.price : numeric(candle.high_price) >= window.price);
    const observed = Boolean(window.observedAt && time(window.observedAt) >= time(window.armedAt) && time(window.observedAt) <= time(window.endedAt));
    const ambiguous = Boolean(cross && window.type === "BUY" && window.pairedTarget && numeric(cross.high_price) >= window.pairedTarget);
    const comparable = window.environment === "SHADOW";
    const firstExpectedOpen = Math.ceil(intervalStart / 60_000) * 60_000;
    const lastExpectedOpen = Math.floor((intervalEnd - 60_000) / 60_000) * 60_000;
    const fullyCovered = options.complete && evidence.length > 0 && time(evidence[0]!.candle_open_at) <= firstExpectedOpen
      && time(evidence.at(-1)!.candle_open_at) >= lastExpectedOpen
      && evidence.every((candle, index) => index === 0 || time(candle.candle_open_at) - time(evidence[index - 1]!.candle_open_at) <= 60_000);
    const pending = cross && !observed && time(options.end) - time(cross.candle_close_at ?? cross.candle_open_at) < (options.confirmationDelayMs ?? 300_000);
    const result = !comparable ? "INCOMPARABLE_MARKET" : ambiguous ? "AMBIGUOUS" : cross ? observed ? "OBSERVED" : options.eventsComplete === false ? "INCOMPLETE" : pending ? "PENDING_ENGINE_WINDOW" : "MISSING_ACTION" : observed ? "OBSERVED_WITHOUT_CANDLE" : fullyCovered ? "NOT_CROSSED" : "INCOMPLETE";
    return {
      timestamp: cross?.candle_open_at ?? window.armedAt, environment: window.environment, asset: window.asset, symbol: window.symbol,
      cycle_id: window.cycleId, active_cycle: window.cycleId, slot: window.slot, active_slot: window.slot,
      operation_id: window.operationId ?? null, trigger_type: window.type, trigger_price: window.price,
      armed_at: window.armedAt, ended_at: window.endedAt, candle_open_at: cross?.candle_open_at ?? null,
      candle_close_at: cross?.candle_close_at ?? null, open: cross?.open_price ?? null, high: cross?.high_price ?? null,
      low: cross?.low_price ?? null, close: cross?.close_price ?? null, first_cross_at: cross?.candle_open_at ?? null,
      next_buy_trigger: window.type === "BUY" ? window.price : null, tp_trigger: window.type === "TP" ? window.price : window.pairedTarget ?? null,
      buy_expected: window.type === "BUY" && comparable && Boolean(cross), buy_observed: window.type === "BUY" && observed,
      tp_expected: window.type === "TP" && comparable && Boolean(cross), tp_observed: window.type === "TP" && observed,
      expected_action: `${window.type}_TRIGGERED`, observed_action: window.observedAction ?? null, observed_at: window.observedAt ?? null,
      latency_ms: cross && observed ? Math.max(0, time(window.observedAt) - time(cross.candle_close_at ?? cross.candle_open_at)) : null,
      trigger_result: result, result, missed_level: result === "MISSING_ACTION", ambiguity: ambiguous,
      candle_coverage_complete: fullyCovered, events_coverage_complete: options.eventsComplete !== false,
      notes: !comparable ? "Candles Production não comprovam execução Testnet; ordens e eventos da exchange são a evidência."
        : ambiguous ? "BUY e TP cruzados na mesma vela; OHLC não informa a ordem intrabar."
        : result === "MISSING_ACTION" ? "O mercado cruzou o gatilho armado e não foi encontrada ação correspondente na evidência disponível."
        : result === "INCOMPLETE" ? "Cobertura de candles/eventos insuficiente para concluir se houve ação ausente."
        : result === "PENDING_ENGINE_WINDOW" ? "Cruzamento recente ainda dentro da janela de processamento de 5 minutos do motor."
        : "Latência usa o fim da vela, não o instante desconhecido do cruzamento intrabar."
    };
  });
}

export function auditExecutionGaps(timestamps: string[], expectedIntervalMs: number, options: { start: string; end: string; source: string; environment: string; asset?: string; includeEdges?: boolean }): AuditRow[] {
  const ordered = [...new Set(timestamps)].map(Date.parse).filter(Number.isFinite).filter((value) => value >= time(options.start) && value < time(options.end)).sort((a, b) => a - b);
  const rows: AuditRow[] = [];
  const values = options.includeEdges && ordered.length ? [time(options.start), ...ordered, time(options.end)] : ordered;
  for (let index = 1; index < values.length; index++) {
    const previous = values[index - 1]!, next = values[index]!;
    if (next - previous > expectedIntervalMs * 2) rows.push({
      timestamp: new Date(previous).toISOString(), environment: options.environment, asset: options.asset ?? null,
      code: "EXECUTION_GAP", severity: "WARNING", source: options.source, expected_interval_ms: expectedIntervalMs,
      gap_ms: next - previous, gap_end: new Date(next).toISOString(), expected_behavior: `Intervalo esperado de ${expectedIntervalMs / 60_000} minuto(s).`,
      observed_behavior: `Intervalo de ${Math.round((next - previous) / 60_000)} minuto(s) entre evidências.`,
      message: "Gap na evidência persistida; investigar pausas, indisponibilidade ou falha do motor.", resolved: null
    });
  }
  return rows;
}

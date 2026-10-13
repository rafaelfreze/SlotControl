import type { AuditRow } from "./trigger-audit.ts";

const text = (value: unknown) => String(value ?? "");
const object = (value: unknown): AuditRow => value && typeof value === "object" && !Array.isArray(value) ? value as AuditRow : {};
const numeric = (value: unknown) => value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const identity = ["operator_id", "exchange_account_id", "trading_engine_id", "executor_shard_id"] as const;
const belongs = (row: AuditRow, run: AuditRow) => row.run_id === run.id && identity.every((field) => row[field] === run[field]);

/** Minimal persisted pause proof. No credentials, free-form payloads or nested
 * objects cross this allowlist, and no missing counter is converted to zero. */
export function pausedProtectionDetails(value: unknown): AuditRow {
  const source = object(value), result: AuditRow = {};
  for (const field of ["protection_verified"] as const) if (typeof source[field] === "boolean") result[field] = source[field];
  for (const field of ["quantity_step", "open_positions", "resident_buy_count", "canceled_buy_count"] as const)
    if (source[field] !== undefined) result[field] = numeric(source[field]);
  for (const field of ["source", "next", "strategy_version"] as const)
    if (typeof source[field] === "string" && /^[A-Za-z0-9_.:\- ]{1,100}$/.test(source[field] as string)) result[field] = source[field];
  return result;
}

/** Confronts persisted current run/order evidence and an explicit protection
 * attestation only. PASS is not present Binance health, permission to hide an
 * account, admission or permission to resume trading. No source is collected. */
export function auditPausedEntryEvidence(rows: AuditRow[], incompleteSources: readonly string[]): AuditRow[] {
  const incomplete = incompleteSources.some((source) => /^robot_v1_live_(runs|slots|orders|events)(:|$)/.test(source));
  return rows.filter((row) => row.row_type === "RUN" && row.status === "PAUSED").map((run) => {
    const orders = rows.filter((row) => row.row_type === "ORDER" && belongs(row, run));
    const events = rows.filter((row) => row.row_type === "EVENT" && belongs(row, run)
      && ["LIVE_PAUSED", "RECONCILED"].includes(text(row.event_type)))
      .sort((left, right) => text(left.observed_at).localeCompare(text(right.observed_at)));
    const proof = events.at(-1), details = object(proof?.details);
    const residentBuy = orders.some((row) => row.side === "BUY" && ["NEW", "PARTIALLY_FILLED"].includes(text(row.status)));
    const pending = orders.some((row) => ["PREPARED", "UNKNOWN", "SUBMITTING", "PENDING_CANCEL"].includes(text(row.status))
      || (numeric(row.executed_quantity) ?? 0) > 0 && row.trades_reconciled !== true);
    const missing = !proof || !proof.id || !Number.isFinite(Date.parse(text(proof.observed_at)))
      || details.protection_verified !== true || numeric(details.quantity_step) === null
      || numeric(details.open_positions) === null || numeric(details.resident_buy_count) === null;
    const broken = residentBuy || details.protection_verified === false
      || numeric(details.resident_buy_count) !== null && numeric(details.resident_buy_count)! !== 0
      || numeric(details.quantity_step) !== null && numeric(details.quantity_step)! <= 0
      || numeric(details.open_positions) !== null && (!Number.isInteger(numeric(details.open_positions)!)
        || numeric(details.open_positions)! < 0 || numeric(details.open_positions)! > 25);
    return { code: "PAUSED_ENTRY_PROTECTION_EVIDENCE", status: broken ? "FAIL" : incomplete || missing || pending ? "WARNING" : "PASS",
      environment: "REAL", asset: run.asset, symbol: run.symbol, cycle_id: run.id, ...Object.fromEntries(identity.map((field) => [field, run[field]])),
      evidence_scope: "PERSISTED_PAUSE_ATTESTATION_AND_ORDER_LEDGER_NOT_CURRENT_BINANCE",
      explanation: broken ? "Pausa persistida contradiz ausência de BUY residente ou prova positiva de proteção; não autoriza ocultação/retomada."
        : incomplete || missing || pending ? "Prova de pausa ausente/incompleta ou ordem/fill ainda inconclusivo. Não certificar proteção, ocultação ou saúde por ausência de erro."
          : "Pausa e proteção explicitamente atestadas no evento persistido, sem BUY residente/inconclusiva no ledger. TP/fills/gains antigos seguem o fluxo normal. PASS não comprova Binance atual, freshness, saúde global nem libera ocultação/retomada.",
      observed: { event_id: proof?.id ?? null, event_type: proof?.event_type ?? null,
        observed_at: proof?.observed_at ?? null, protection: pausedProtectionDetails(details) },
      evidence: "robot_v1_live_runs + robot_v1_live_orders + robot_v1_live_events; GET-only existing sources" };
  });
}

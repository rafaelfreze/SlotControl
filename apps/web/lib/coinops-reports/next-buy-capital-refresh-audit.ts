import type { AuditRow } from "./trigger-audit.ts";

const text = (value: unknown) => String(value ?? "");
const number = (value: unknown) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const details = (row: AuditRow): AuditRow => row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details as AuditRow : {};
const equal = (a: unknown, b: unknown) => number(a) !== null && number(b) !== null && Math.abs(number(a)! - number(b)!) <= 1e-10;
const present = (value: unknown) => value !== undefined && value !== null && value !== "";
const scopeFields = ["operator_id", "exchange_account_id", "trading_engine_id", "run_id", "slot_number"] as const;
const sameScope = (a: AuditRow, b: AuditRow) => scopeFields.every((key) => a[key] === b[key]);
const planned = "NEXT_BUY_CAPITAL_REFRESH_PLANNED";
const confirmed = "NEXT_BUY_CAPITAL_REFRESH_CONFIRMED";

/** Certifies only the persisted replacement chain, never current exchange health.
 * A crashed/planned transition remains WARNING; missing evidence cannot pass. */
export function auditNextBuyCapitalRefresh(rows: AuditRow[], incompleteSources: readonly string[]): AuditRow[] {
  const events = rows.filter((row) => row.row_type === "EVENT" && [planned, confirmed].includes(text(row.event_type)));
  const sourcesMissing = incompleteSources.some((source) => /^robot_v1_live_(events|orders)(:|$)/.test(source));
  if (!events.length) return [{ code: "NEXT_BUY_CAPITAL_REFRESH_AUDIT", status: "WARNING", environment: "REAL",
    evidence_scope: "PERSISTED_REFRESH_EVENTS_AND_ORDER_LEDGER_NOT_CURRENT_BINANCE",
    explanation: "Nenhum refresh de capital da NEXT BUY observado; ausência de evento não comprova execução nem necessidade de substituição." }];
  const groups = new Map<string, AuditRow[]>();
  for (const event of events) {
    const key = JSON.stringify([...scopeFields.map((field) => event[field]), details(event).refresh_key ?? `missing:${event.id}`]);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.values()].map((group) => {
    const plan = group.find((row) => row.event_type === planned), done = group.find((row) => row.event_type === confirmed);
    const reference = done ?? plan!, p = plan ? details(plan) : {}, d = done ? details(done) : {};
    const missing: string[] = [], broken: string[] = [];
    if (!plan) missing.push("plano");
    if (!done) missing.push("confirmação");
    if (sourcesMissing) missing.push("fonte incompleta");
    if (group.filter((row) => row.event_type === planned).length > 1 || group.filter((row) => row.event_type === confirmed).length > 1) broken.push("evento duplicado para a mesma chave");
    for (const [name, event, payload] of [["plano", plan, p], ["confirmação", done, d]] as const) {
      if (!event) continue;
      for (const field of scopeFields) if (!present(event[field])) missing.push(`${name}.${field}`);
      for (const field of ["refresh_key", "old_client_order_id", "new_client_order_id", "quote_asset", "operation_sequence"]) {
        if (!present(payload[field])) missing.push(`${name}.${field}`);
      }
      for (const field of ["old_quantity", "new_quantity", "price", "old_notional_quote", "new_notional_quote", "slot_balance_quote"]) {
        if (number(payload[field]) === null) missing.push(`${name}.${field}`);
        else if (number(payload[field])! <= 0) broken.push(`${name}.${field} não positivo`);
      }
      if (!Array.isArray(payload.capital_sources) || !payload.capital_sources.length) missing.push(`${name}.capital_sources`);
      if (present(payload.old_client_order_id) && payload.old_client_order_id === payload.new_client_order_id) broken.push("IDs antigo e novo iguais");
    }
    if (plan && done) {
      for (const field of ["old_client_order_id", "new_client_order_id", "quote_asset", "operation_sequence"]) {
        if (present(p[field]) && present(d[field]) && p[field] !== d[field]) broken.push(`plano/confirmação divergentes: ${field}`);
      }
      for (const field of ["old_quantity", "new_quantity", "price", "old_notional_quote", "new_notional_quote", "slot_balance_quote"]) {
        if (number(p[field]) !== null && number(d[field]) !== null && !equal(p[field], d[field])) broken.push(`plano/confirmação divergentes: ${field}`);
      }
      if (Date.parse(text(done.observed_at)) < Date.parse(text(plan.observed_at))) broken.push("confirmação anterior ao plano");
    }
    if (done) {
      if (!present(d.old_status)) missing.push("status anterior confirmado");
      else if (d.old_status !== "CANCELED") broken.push("ordem anterior não cancelada");
      if (number(d.old_executed_quantity) === null) missing.push("quantidade executada anterior");
      else if (!equal(d.old_executed_quantity, 0)) broken.push("ordem anterior teve fill");
      if (!present(d.new_status)) missing.push("status novo confirmado");
      else if (!["NEW", "PARTIALLY_FILLED", "FILLED"].includes(text(d.new_status))) broken.push("nova ordem sem confirmação válida");
      if (!Number.isFinite(Date.parse(text(d.exchange_reconciled_at)))) missing.push("horário de reconciliação");
      for (const [prefix, clientId, quantity] of [["old", d.old_client_order_id, d.old_quantity], ["new", d.new_client_order_id, d.new_quantity]] as const) {
        const order = rows.find((row) => row.row_type === "ORDER" && sameScope(row, done) && present(clientId) && row.client_order_id === clientId);
        if (!order) { missing.push(`ledger da ordem ${prefix}`); continue; }
        if (order.side !== "BUY" || order.purpose !== "ENTRY") broken.push(`ordem ${prefix} não é NEXT BUY`);
        if (!present(order.operation_sequence)) missing.push(`sequência ${prefix}`);
        else if (present(d.operation_sequence) && !equal(order.operation_sequence, d.operation_sequence)) broken.push(`sequência ${prefix} divergente`);
        for (const [field, value] of [["requested_quantity", quantity], ["price", d.price]] as const) {
          if (number(order[field]) === null) missing.push(`ordem ${prefix}.${field}`);
          else if (number(value) !== null && !equal(order[field], value)) broken.push(`ordem ${prefix}.${field} divergente`);
        }
        if (prefix === "old") {
          if (!present(order.status) || number(order.executed_quantity) === null || !present(order.trades_reconciled)) missing.push("cancelamento e trades do ledger anterior");
          else if (order.status !== "CANCELED" || !equal(order.executed_quantity, 0) || order.trades_reconciled !== true) broken.push("ledger anterior não comprova cancelamento zero-fill reconciliado");
        }
      }
    }
    return { code: "NEXT_BUY_CAPITAL_REFRESH_AUDIT", status: broken.length ? "FAIL" : missing.length ? "WARNING" : "PASS",
      environment: "REAL", asset: reference.asset, cycle_id: reference.run_id, slot_number: reference.slot_number,
      refresh_key: details(reference).refresh_key ?? null,
      evidence_scope: "PERSISTED_REFRESH_EVENTS_AND_ORDER_LEDGER_NOT_CURRENT_BINANCE",
      explanation: broken.length ? `Divergência comprovada: ${[...new Set(broken)].join("; ")}.`
        : missing.length ? `Transição pendente ou evidência insuficiente: ${[...new Set(missing)].join("; ")}.`
          : "Plano e confirmação ligados às duas ordens do mesmo run/slot/operação: cancelamento antigo zero-fill reconciliado, preço preservado e quantidades previstas. Não certifica estado Binance atual nem ausência global de alteração de TP.",
    };
  });
}

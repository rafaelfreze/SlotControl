import { fundingResumeToleranceObservation, type FundingResidentBuy, type FundingSummary } from "../../lib/execution/account-funding.ts";
import type { PremiumEngine } from "./premium-operator";

export type FundingPresentationEngine = Pick<PremiumEngine, "engineId" | "accountId" | "currency" | "environment"
  | "engineStatus" | "killSwitch" | "status" | "health" | "alerts" | "activeIssueCount" | "lastCheck"
  | "cycleId" | "executorShardId" | "nextCount" | "orders">;
type Presentation = { tone: "covered" | "observation" | "warning"; label: string };

export function fundingSnapshotStale(summary: FundingSummary, now: number): boolean {
  const at = summary.observedAt === null ? NaN : Date.parse(summary.observedAt);
  return !Number.isFinite(now) || !Number.isFinite(at) || at - now > 2_000 || now - at > 30_000;
}

/** Presentation only, never an admission/dispatch guard. A small whole-grid
 * difference is not the same as missing Spot for a BUY. Without current engine
 * evidence and an already-funded resident BUY, retain attention rather than
 * predict the next Strategy Engine decision or certify cash that is absent. */
function residentBuyConfirmed(engine: FundingPresentationEngine, proof: FundingResidentBuy | undefined, now: number): boolean {
  const at = engine.lastCheck === null ? NaN : Date.parse(engine.lastCheck);
  if (engine.engineStatus !== "ACTIVE" || engine.status !== "ACTIVE" || engine.killSwitch
    || !engine.health.healthy || engine.alerts.length || engine.activeIssueCount !== 0
    || !engine.cycleId || !engine.executorShardId || !Number.isFinite(at)
    || at - now > 2_000 || now - at > 180_000 || engine.nextCount !== 1) return false;
  if (engine.orders.some((order) => ["PREPARED", "UNKNOWN", "SUBMITTING", "PENDING_CANCEL"].includes(order.status)
    || (order.executedQuantity ?? 0) > 0 && (!order.raw || typeof order.raw !== "object"
      || (order.raw as Record<string, unknown>).trades_reconciled !== true))) return false;
  const buys = engine.orders.filter((order) => order.side === "BUY" && order.resident);
  if (buys.length !== 1) return false;
  const buy = buys[0];
  return Boolean(proof && proof.engineId === engine.engineId && proof.runId === engine.cycleId
    && proof.executorShardId === engine.executorShardId && proof.clientOrderId === buy.id
    && proof.exchangeOrderId === buy.exchangeId && proof.price === buy.price
    && proof.quantity === buy.quantity && proof.executedQuantity === buy.executedQuantity
    && Number.isFinite(proof.reservedQuote) && proof.reservedQuote > 0
    && buy.id && buy.exchangeId && ["NEW", "PARTIALLY_FILLED"].includes(buy.status)
    && buy.price !== null && Number.isFinite(buy.price) && buy.price > 0
    && buy.quantity !== null && Number.isFinite(buy.quantity) && buy.quantity > 0
    && buy.executedQuantity !== null && Number.isFinite(buy.executedQuantity)
    && buy.executedQuantity >= 0 && buy.executedQuantity < buy.quantity
    && proof.reservedQuote <= (buy.quantity - buy.executedQuantity) * buy.price + 1e-8);
}

export function fundingPresentation(summary: FundingSummary, engines: FundingPresentationEngine[], now: number,
  readError = false): Presentation {
  if (readError) return { tone: "warning", label: "SALDO NÃO CONFIRMADO NESTA CONSULTA" };
  if (fundingSnapshotStale(summary, now)) return { tone: "warning", label: "LEITURA ANTIGA / NÃO CONFIRMADA" };
  if (summary.status === "INCOMPLETE") return { tone: "warning", label: "VERIFICAÇÃO INCOMPLETA" };
  if (summary.bnbStatus !== "AVAILABLE") return { tone: "warning", label: summary.bnbStatus === "LOW"
    ? "RESERVA BNB INSUFICIENTE" : "RESERVA BNB NÃO CONFIRMADA" };
  if (summary.status === "COVERED") return { tone: "covered", label: "PRINCIPAL COBERTO" };
  if (!fundingResumeToleranceObservation(summary, now)) return { tone: "warning", label: "FALTA SALDO SPOT" };
  // Use the full account/currency roster, never the UI's market-filtered list.
  const own = engines.filter((engine) => engine.environment === "REAL" && engine.accountId === summary.accountId
    && engine.currency === summary.currency);
  const proofs = summary.residentBuys;
  if (!(summary.buyReserved! > 0) || own.length !== summary.engineCount
    || new Set(own.map((engine) => engine.engineId)).size !== own.length
    || !proofs || proofs.length !== own.length || new Set(proofs.map((proof) => proof.engineId)).size !== own.length
    || own.some((engine) => !engine.engineId
      || !residentBuyConfirmed(engine, proofs.find((proof) => proof.engineId === engine.engineId), now)))
    return { tone: "warning", label: "PRÓXIMA BUY / OPERAÇÃO NÃO CONFIRMADA" };
  return { tone: "observation", label: "OBSERVAÇÃO · DIFERENÇA ATÉ R$50" };
}

import type { createServiceRoleClient } from "../supabase/service-role";
import type { StrategyDecision } from "./strategy-engine";

type Service = ReturnType<typeof createServiceRoleClient>;
type Scope = { product_id: string; tenant_id: string; user_id: string };
type Environment = "SHADOW" | "TESTNET" | "REAL";
const conflict = "product_id,tenant_id,user_id,environment,decision_id";

function query(service: Service, scope: Scope, environment: Environment, id: string) {
  return service.from("robot_v1_strategy_decisions").select("decision_id,created_at,result")
    .eq("product_id", scope.product_id).eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id)
    .eq("environment", environment).eq("decision_id", id).single();
}

/** Durable intent precedes every adapter dispatch. Retry retains the original
 * creation timestamp, rather than backdating decisions to a historical fill. */
export async function persistStrategyDecision(service: Service, scope: Scope, environment: Environment, decision: StrategyDecision, operationSequence?: number) {
  const { created_at: observationTime, ...intent } = decision;
  void observationTime;
  const { error } = await service.from("robot_v1_strategy_decisions").upsert({
    product_id: scope.product_id, tenant_id: scope.tenant_id, user_id: scope.user_id,
    environment, ...intent, operation_sequence: operationSequence ?? null,
  }, { onConflict: conflict, ignoreDuplicates: true });
  if (error) throw new Error("COINOPS_STRATEGY_DECISION_PERSIST_FAILED");
  const saved = await query(service, scope, environment, decision.decision_id);
  if (saved.error || !saved.data) throw new Error("COINOPS_STRATEGY_DECISION_READ_FAILED");
  return saved.data as { decision_id: string; created_at: string; result: string };
}

async function update(service: Service, scope: Scope, environment: Environment, id: string, values: Record<string, unknown>, onlyUndispatched = false) {
  let mutation = service.from("robot_v1_strategy_decisions").update(values)
    .eq("product_id", scope.product_id).eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id)
    .eq("environment", environment).eq("decision_id", id).neq("result", "COMPLETED");
  if (onlyUndispatched) mutation = mutation.is("dispatched_at", null);
  const { error } = await mutation;
  if (error) throw new Error("COINOPS_STRATEGY_DECISION_UPDATE_FAILED");
}

export async function dispatchStrategyDecision(service: Service, scope: Scope, environment: Environment, id: string) {
  await update(service, scope, environment, id, { dispatched_at: new Date().toISOString(), result: "DISPATCHED", error: null }, true);
}

export async function completeStrategyDecision(service: Service, scope: Scope, environment: Environment, id: string, observed: Record<string, unknown>, exchangeAck = false) {
  const saved = await query(service, scope, environment, id);
  if (saved.error || !saved.data) throw new Error("COINOPS_STRATEGY_DECISION_READ_FAILED");
  const now = new Date();
  await update(service, scope, environment, id, {
    result: "COMPLETED", completed_at: now.toISOString(), error: null,
    ...(exchangeAck ? { exchange_ack_at: now.toISOString() } : {}),
    observed_next_state: observed, latency_ms: Math.max(0, now.getTime() - Date.parse(saved.data.created_at)),
  });
}

export async function failStrategyDecision(service: Service, scope: Scope, environment: Environment, id: string, error: string) {
  await update(service, scope, environment, id, { result: "FAILED", error: /^[A-Z][A-Z0-9_]{1,100}$/.test(error) ? error : "COINOPS_STRATEGY_DISPATCH_FAILED" });
}

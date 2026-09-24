import "server-only";

import { createHash } from "node:crypto";

import { createServiceRoleClient } from "@/lib/supabase/service-role";

import { readLegacyProductionReconciliation } from "./live-executor-transport";
import { reconcileShadowWithExchange, type ReconciliationIntent } from "./reconciliation";

type ConnectionRow = { id: string; product_id: string; tenant_id: string; user_id: string; exchange: "BINANCE_SPOT"; connection_status: string };
type IntentRow = { id: string; idempotency_key: string; symbol: string; side: "BUY" | "SELL"; quantity: number | string; observed_market_price: number | string; status: string };

function asNumber(value: number | string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("COINOPS_RECONCILIATION_NUMERIC_INVALID");
  return number;
}

function reconciliationKey(connectionId: string, now: Date) {
  const minuteWindow = Math.floor(now.getTime() / (5 * 60 * 1000));
  return createHash("sha256").update(`coinops-binance-readonly-v1|${connectionId}|${minuteWindow}`).digest("hex");
}

function sanitizedErrorCode(error: unknown) {
  if (error instanceof Error && /^EXECUTOR_[A-Z0-9_]+$/.test(error.message)) return error.message;
  return "COINOPS_RECONCILIATION_FAILED";
}

/**
 * Processes only the connection explicitly pinned by an environment reference.
 * Binance signed GETs are issued exclusively by the fixed-IP executor. The
 * Vercel deployment never uses its historical Binance key after IP whitelisting.
 */
export async function runConfiguredBinanceReadOnlyReconciliation(now = new Date()) {
  const connectionId = process.env.COINOPS_BINANCE_CONNECTION_ID?.trim();
  if (!connectionId) return { status: "NOT_CONFIGURED" as const, processed: 0 };

  const supabase = createServiceRoleClient();
  const { data: connection, error: connectionError } = await supabase
    .from("exchange_connections")
    .select("id,product_id,tenant_id,user_id,exchange,connection_status")
    .eq("id", connectionId)
    .eq("exchange", "BINANCE_SPOT")
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection) return { status: "CONNECTION_NOT_FOUND" as const, processed: 0 };
  const scopedConnection = connection as ConnectionRow;

  const runKey = reconciliationKey(scopedConnection.id, now);
  const { data: run, error: runError } = await supabase
    .from("exchange_reconciliation_runs")
    .upsert({
      product_id: scopedConnection.product_id,
      tenant_id: scopedConnection.tenant_id,
      user_id: scopedConnection.user_id,
      connection_id: scopedConnection.id,
      execution_mode: "SHADOW",
      status: "RUNNING",
      idempotency_key: runKey,
      started_at: now.toISOString()
    }, { onConflict: "connection_id,idempotency_key", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (runError) throw runError;
  if (!run?.id) return { status: "ALREADY_RUNNING_OR_COMPLETED" as const, processed: 0 };

  try {
    const [snapshot, intentResponse] = await Promise.all([
      readLegacyProductionReconciliation(),
      supabase.from("exchange_order_intents")
        .select("id,idempotency_key,symbol,side,quantity,observed_market_price,status")
        .eq("product_id", scopedConnection.product_id)
        .eq("tenant_id", scopedConnection.tenant_id)
        .eq("user_id", scopedConnection.user_id)
        .order("created_at", { ascending: false })
        .limit(200)
    ]);
    if (intentResponse.error) throw intentResponse.error;

    const intents: ReconciliationIntent[] = ((intentResponse.data || []) as IntentRow[]).map((intent) => ({
      id: intent.id,
      idempotencyKey: intent.idempotency_key,
      symbol: intent.symbol,
      side: intent.side,
      quantity: asNumber(intent.quantity),
      observedMarketPrice: asNumber(intent.observed_market_price),
      status: intent.status
    }));
    const reconciliation = reconcileShadowWithExchange({
      intents,
      orders: snapshot.orders,
      trades: snapshot.trades,
      balances: snapshot.account.balances
    });
    const relevantBalances = snapshot.account.balances.filter((balance) => ["BTC", "SOL", "USDT", "BRL"].includes(balance.asset));

    const { error: itemError } = await supabase.from("exchange_reconciliation_items").insert(reconciliation.items.map((item) => ({
      run_id: run.id,
      product_id: scopedConnection.product_id,
      tenant_id: scopedConnection.tenant_id,
      user_id: scopedConnection.user_id,
      classification: item.classification,
      entity_type: item.entityType,
      intent_id: item.intentId,
      exchange_reference: item.exchangeReference,
      symbol: item.symbol,
      details: item.details
    })));
    if (itemError) throw itemError;

    const completedAt = new Date().toISOString();
    const [{ error: completeError }, { error: connectionUpdateError }] = await Promise.all([
      supabase.from("exchange_reconciliation_runs").update({
        status: "COMPLETED",
        completed_at: completedAt,
        summary: {
          ...reconciliation.summary,
          balances: relevantBalances,
          capabilities: {
            readEnabled: snapshot.capabilities.readEnabled,
            tradingEnabled: snapshot.capabilities.tradingEnabled,
            withdrawalsEnabled: snapshot.capabilities.withdrawalsEnabled,
            ipRestricted: snapshot.capabilities.ipRestricted
          },
          filters: snapshot.filters,
          prices: snapshot.prices
        }
      }).eq("id", run.id),
      supabase.from("exchange_connections").update({
        connection_status: "READ_ONLY",
        credential_reference: "FIXED_IP_EXECUTOR:SIGNED_GET",
        last_reconciled_at: completedAt,
        last_synced_at: completedAt,
        last_error_code: null
      }).eq("id", scopedConnection.id)
    ]);
    if (completeError) throw completeError;
    if (connectionUpdateError) throw connectionUpdateError;
    return { status: "COMPLETED" as const, processed: 1, runId: run.id, summary: reconciliation.summary };
  } catch (error) {
    const errorCode = sanitizedErrorCode(error);
    await Promise.all([
      supabase.from("exchange_reconciliation_runs").update({ status: "FAILED", completed_at: new Date().toISOString(), error_code: errorCode }).eq("id", run.id),
      supabase.from("exchange_connections").update({ connection_status: "ERROR", last_error_code: errorCode }).eq("id", scopedConnection.id)
    ]);
    return { status: "FAILED" as const, processed: 1, errorCode };
  }
}

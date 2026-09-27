import "server-only";

import { randomUUID } from "node:crypto";
import { createClient } from "../supabase/server";
import { createServiceRoleClient } from "../supabase/service-role";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "../supabase/env";
import { isIdentity } from "../execution/operator-context";
import { assessShardCapacity, DEFAULT_CAPACITY_POLICY } from "../coinops-capacity/capacity-manager";
import { asShardMetrics } from "../coinops-capacity/capacity-server";
import { loadFinopsCapital } from "./capital-server";
import { finopsCapitalRows } from "./capital";
import { convertBrl, enrichService, FINOPS_SOURCE_NOTES, FINOPS_SYNC_INTERVAL_MS, knownNumber, money, nextFinopsExternalSync, periodAt, requireFinopsOwnership, sumKnown, validateManualService } from "./model";
import { fetchDigitalOceanCosts, fetchFinopsFx, fetchVercelProjectCosts } from "./providers";
import type { FinopsDashboard, FinopsExecutor, FinopsHistory, FinopsScope, FinopsService, FxQuote } from "./types";

type Service = ReturnType<typeof createServiceRoleClient>;
type DbRow = Record<string, unknown>;
type Query = PromiseLike<{ data: unknown[] | null; error: unknown }> & { range(from: number, to: number): Query };
type Shard = { id: string; egress_ipv4: string; enabled: boolean; binance_limit_per_min: number; admission_ratio: number };
const SIX_HOURS = FINOPS_SYNC_INTERVAL_MS;
const PROJECT_ID = "prj_GNCqXG8MVG2ePgU3y6vuosz06GoR";
const TEAM_ID = "team_TsMRvSDiP35TCEkVAI9ZAld6";
const safeCode = (error: unknown) => error instanceof Error && /^(?:COINOPS_)?FINOPS_[A-Z0-9_]+$/.test(error.message)
  ? error.message : "COINOPS_FINOPS_SYNC_FAILED";

function serviceClient() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId()) throw new Error("COINOPS_FINOPS_SCOPE_INVALID");
  return createServiceRoleClient();
}
function assertScope(scope: FinopsScope) {
  if (![scope.operatorId, scope.tenantId, scope.userId].every(isIdentity)
    || scope.tenantId !== getCoinOpsServiceTenantId()) throw new Error("ADMIN_REQUIRED");
}
async function readAll<T>(factory: () => Query): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; offset < 100_000; offset += 500) {
    const result = await factory().range(offset, offset + 499);
    if (result.error || !result.data) throw new Error("COINOPS_FINOPS_READ_FAILED");
    all.push(...result.data as T[]);
    if (result.data.length < 500) return all;
  }
  throw new Error("COINOPS_FINOPS_ROW_LIMIT");
}
const scoped = (service: Service, table: string, scope: FinopsScope) => service.from(table).select("*")
  .eq("tenant_id", scope.tenantId).eq("operator_id", scope.operatorId);

/** Auth identity + existing operator ownership are required; metadata alone never grants ADMIN. */
export async function requireFinopsAdmin(): Promise<FinopsScope> {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId()) throw new Error("COINOPS_FINOPS_SCOPE_INVALID");
  const auth = createClient();
  const { data: { user }, error } = await auth.auth.getUser();
  if (error || !user) throw new Error("AUTH_REQUIRED");
  if (user.app_metadata?.coinops_role === "VIEWER") throw new Error("ADMIN_REQUIRED");
  const tenantId = getCoinOpsServiceTenantId()!;
  const operator = await auth.from("operators").select("id,tenant_id,user_id,status")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").maybeSingle();
  if (operator.error || !operator.data || operator.data.user_id !== user.id) throw new Error("ADMIN_REQUIRED");
  return requireFinopsOwnership({ id: user.id, role: user.app_metadata?.coinops_role }, operator.data, tenantId);
}

function emptyDashboard(now: Date): FinopsDashboard {
  return { capturedAt: null, period: periodAt(now), syncStatus: "UNAVAILABLE",
    summary: { accounts: 0, engines: 0, executors: 0, capitalBrl: null, capitalByCurrency: {}, actualBrl: null,
      projectedBrl: null, knownActualBrl: 0, knownProjectedBrl: 0, costPerAccountBrl: null, costPerEngineBrl: null,
      unavailableServices: 0, capitalComplete: false, monthlyEstimatedBrl: null, knownRealBrl: null, estimatedBrl: null,
      allocatedBrl: null, costTotalsByCurrency: {} }, capital: { accounts: [], markets: [], notes: ["Primeira sincronização ainda não concluída; contagens e valores indisponíveis."] },
    executors: [], services: [], fx: [], history: [], alerts: [], sources: FINOPS_SOURCE_NOTES };
}

function historyRow(row: { period: string; captured_at: string; payload: FinopsDashboard }, current: string): FinopsHistory {
  const payload = row.payload;
  const byProvider: Record<string, number | null> = {};
  for (const provider of new Set(payload.services.map((service) => service.provider)))
    byProvider[provider] = sumKnown(payload.services.filter((service) => service.provider === provider && service.enabled).map((service) => service.projectedBrl)).total;
  return { period: row.period, capturedAt: row.captured_at, accounts: payload.summary.accounts,
    engines: payload.summary.engines, executors: payload.summary.executors, actualBrl: payload.summary.actualBrl,
    projectedBrl: payload.summary.projectedBrl, knownProjectedBrl: payload.summary.knownProjectedBrl,
    capitalBrl: payload.summary.capitalBrl, costPerAccountBrl: payload.summary.costPerAccountBrl,
    costPerEngineBrl: payload.summary.costPerEngineBrl, byProvider, fx: payload.fx,
    completeness: payload.summary.unavailableServices ? "PARTIAL" : "COMPLETE", closed: row.period < current };
}

/** Page loads only persisted observations; never provider, executor or Binance requests. */
export async function loadFinopsDashboard(scope: FinopsScope): Promise<FinopsDashboard> {
  assertScope(scope);
  const service = serviceClient(), now = new Date();
  const [latest, history, alerts, state] = await Promise.all([
    scoped(service, "finops_snapshots", scope).order("captured_at", { ascending: false }).limit(1).maybeSingle(),
    service.rpc("finops_monthly_history", { p_tenant_id: scope.tenantId, p_operator_id: scope.operatorId }),
    scoped(service, "finops_alerts", scope).is("resolved_at", null).order("last_seen_at", { ascending: false }).limit(100),
    scoped(service, "finops_sync_state", scope).maybeSingle(),
  ]);
  if (latest.error || history.error || alerts.error || state.error) throw new Error("COINOPS_FINOPS_READ_FAILED");
  const data = latest.data?.payload as FinopsDashboard | undefined;
  const result = data && data.summary && Array.isArray(data.services) ? data : emptyDashboard(now);
  return { ...result, syncStatus: state.data?.last_status === "FAILED" ? "FAILED" : !result.capturedAt ? "UNAVAILABLE"
    : now.getTime() - Date.parse(result.capturedAt) > SIX_HOURS + 30 * 60_000 ? "STALE" : result.syncStatus,
    history: ((history.data ?? []) as Array<{ period: string; captured_at: string; payload: FinopsDashboard }>)
      .filter((row) => row.payload?.summary && Array.isArray(row.payload?.services)).map((row) => historyRow(row, periodAt(now))),
    alerts: (alerts.data ?? []).map((alert) => ({ id: alert.id, code: alert.code, serviceId: alert.service_id,
      message: alert.message, firstSeenAt: alert.first_seen_at, lastSeenAt: alert.last_seen_at })) };
}

async function inventory(service: Service, scope: FinopsScope, shards: Shard[], now: Date) {
  const rows = shards.map((shard) => ({ tenant_id: scope.tenantId, operator_id: scope.operatorId,
    service_key: `executor:${shard.id}`, provider: "DigitalOcean", name: `Executor ${shard.id.split("-")[1]}`,
    shard_id: shard.id, currency: "USD", allocation_percent: 100, cost_period: periodAt(now), origin: "INDISPONIVEL",
    source_mode: "DOCUMENTED", billing_mode: "DIGITALOCEAN", enabled: shard.enabled,
    source_note: "Executor descoberto no registry oficial. Plano, preço e extras aguardam evidência do provedor.", sync_status: "UNAVAILABLE" }));
  const shared = [
    { service_key: "supabase:otdfpmsegjxpqrzisfmi", provider: "Supabase", name: "Supabase · OnPlay Platform compartilhada", billing_mode: "MANUAL",
      source_note: "Projeto oficial compartilhado otdfpmsegjxpqrzisfmi, schema coinops. Plano/cobrança/rateio não confirmados; não equivale a custo zero." },
    { service_key: `vercel:${PROJECT_ID}`, provider: "Vercel", name: "Vercel · CoinOps/cripto", billing_mode: "VERCEL",
      source_note: "Projeto cripto da equipe compartilhada. Custo de plano/seats requer rateio explícito; custos com ProjectId exato podem vir da API." },
  ].map((row) => ({ ...row, tenant_id: scope.tenantId, operator_id: scope.operatorId, currency: "USD",
    allocation_percent: null, cost_period: periodAt(now), origin: "INDISPONIVEL", source_mode: "DOCUMENTED",
    sync_status: "UNAVAILABLE", enabled: true }));
  const insert = await service.from("finops_services").upsert([...rows, ...shared], { onConflict: "operator_id,service_key", ignoreDuplicates: true });
  if (insert.error) throw new Error("COINOPS_FINOPS_INVENTORY_FAILED");
  const saved = await readAll<DbRow>(() => scoped(service, "finops_services", scope).order("id"));
  for (const row of saved.filter((item) => item.shard_id)) {
    const registered = shards.find((shard) => shard.id === row.shard_id);
    if (row.enabled !== Boolean(registered?.enabled)) {
      const changed = await service.from("finops_services").update({ enabled: Boolean(registered?.enabled), updated_at: now.toISOString() })
        .eq("tenant_id", scope.tenantId).eq("operator_id", scope.operatorId).eq("id", row.id);
      if (changed.error) throw new Error("COINOPS_FINOPS_INVENTORY_FAILED");
    }
  }
  return saved;
}

type FinancialAlert = { code: string; serviceId: string | null; message: string };
async function refreshProviders(service: Service, scope: FinopsScope, shards: Shard[], rows: DbRow[], now: Date) {
  const alerts: FinancialAlert[] = [];
  const save = async (row: DbRow, patch: DbRow) => {
    const result = await service.from("finops_services").update({ ...patch, updated_at: now.toISOString() })
      .eq("tenant_id", scope.tenantId).eq("operator_id", scope.operatorId).eq("id", row.id);
    if (result.error) throw new Error("COINOPS_FINOPS_PROVIDER_SAVE_FAILED");
  };
  const token = process.env.FINOPS_DIGITALOCEAN_TOKEN;
  if (token) {
    try {
      const costs = await fetchDigitalOceanCosts(token, shards.map((shard) => ({ id: shard.id, ip: String(shard.egress_ipv4) })));
      for (const row of rows.filter((item) => item.billing_mode === "DIGITALOCEAN")) {
        const cost = costs.find((item) => item.shardId === row.shard_id);
        if (!cost) { await save(row, { sync_status: "FAILED" }); alerts.push({ code: "BILLING_SYNC_FAILED", serviceId: String(row.id), message: "Recurso do executor não identificado na resposta DigitalOcean." }); continue; }
        if (knownNumber(row.recurring_monthly) !== null && Number(row.recurring_monthly) !== cost.monthlyUsd)
          alerts.push({ code: "EXECUTOR_COST_CHANGE", serviceId: String(row.id), message: "A tarifa mensal do recurso mudou. Confira o plano e a evidência do provedor." });
        await save(row, { plan: cost.plan, region: cost.region, resource_id: cost.resourceId, currency: "USD",
          recurring_monthly: cost.monthlyUsd, unit_price: cost.unitPrice, quantity: cost.quantity,
          pricing_date: cost.pricingDate.slice(0, 10), origin: "ESTIMADO", source_mode: "API", source_note: cost.evidence + " " + cost.notes.join(" "),
          source_url: cost.sourceUrl, synced_at: cost.observedAt, sync_status: "OK", usage: cost.usage, cost_period: periodAt(now) });
      }
    } catch (error) {
      for (const row of rows.filter((item) => item.billing_mode === "DIGITALOCEAN")) {
        await save(row, { sync_status: "FAILED" });
        alerts.push({ code: "BILLING_SYNC_FAILED", serviceId: String(row.id), message: `DigitalOcean: ${safeCode(error)}. Última evidência preservada.` });
      }
    }
  }
  const vercelToken = process.env.FINOPS_VERCEL_TOKEN;
  const vercel = rows.find((row) => row.billing_mode === "VERCEL");
  if (vercelToken && vercel) {
    try {
      const cost = await fetchVercelProjectCosts(vercelToken, { teamId: TEAM_ID, projectId: PROJECT_ID,
        from: `${periodAt(now)}T00:00:00.000Z`, to: now.toISOString() });
      // Project-tagged consumption is additive to the still-unattributed shared plan.
      // Keep that shared plan unknown and store exact attributable charges as a separate line.
      const result = await service.from("finops_services").upsert({ tenant_id: scope.tenantId, operator_id: scope.operatorId,
        service_key: `vercel-usage:${PROJECT_ID}`, provider: "Vercel", name: "Vercel · consumo atribuído ao projeto",
        currency: cost.currency, recurring_monthly: null, actual_month_cost: cost.monthToDate,
        allocation_percent: 100, cost_period: periodAt(now), origin: cost.monthToDate === null ? "INDISPONIVEL" : "REAL",
        source_mode: "API", billing_mode: "VERCEL", source_url: cost.sourceUrl, source_note: cost.notes.join(" "),
        synced_at: cost.observedAt, sync_status: cost.monthToDate === null ? "UNAVAILABLE" : "OK", usage: cost.usage,
        enabled: true, updated_at: now.toISOString() }, { onConflict: "operator_id,service_key" });
      if (result.error) throw new Error("COINOPS_FINOPS_PROVIDER_SAVE_FAILED");
    } catch (error) {
      for (const row of rows.filter((item) => item.billing_mode === "VERCEL")) await save(row, { sync_status: "FAILED" });
      alerts.push({ code: "BILLING_SYNC_FAILED", serviceId: String(vercel.id), message: `Vercel: ${safeCode(error)}. Nenhum custo zero presumido.` });
    }
  }
  // Removing a billing token cannot make prior API consumption look current.
  for (const row of rows.filter((item) => item.source_mode === "API" && item.billing_mode !== "MANUAL"
    && (item.billing_mode === "VERCEL" ? !vercelToken : item.billing_mode === "DIGITALOCEAN" ? !token : false))) {
    await save(row, { sync_status: "UNAVAILABLE" });
    alerts.push({ code: "BILLING_SYNC_FAILED", serviceId: String(row.id), message: "Integração automática sem credencial server-side; última tarifa preservada como estimativa, consumo atual indisponível." });
  }
  return alerts;
}

async function persistAlerts(service: Service, scope: FinopsScope, alerts: FinancialAlert[], now: Date, resolveAbsent: boolean) {
  for (const alert of alerts) {
    const result = await service.from("finops_alerts").upsert({ tenant_id: scope.tenantId, operator_id: scope.operatorId,
      alert_key: `${alert.code}:${alert.serviceId ?? "PLATFORM"}:${periodAt(now)}`, service_id: alert.serviceId,
      code: alert.code, message: alert.message, last_seen_at: now.toISOString(), resolved_at: null }, { onConflict: "operator_id,alert_key" });
    if (result.error) throw new Error("COINOPS_FINOPS_ALERT_SAVE_FAILED");
  }
  if (resolveAbsent) {
    const open = await readAll<DbRow>(() => scoped(service, "finops_alerts", scope).is("resolved_at", null).order("id"));
    const active = new Set(alerts.map((alert) => `${alert.code}:${alert.serviceId ?? "PLATFORM"}:${periodAt(now)}`));
    for (const prior of open.filter((row) => !active.has(String(row.alert_key)))) {
      const result = await service.from("finops_alerts").update({ resolved_at: now.toISOString() })
        .eq("id", prior.id).eq("tenant_id", scope.tenantId).eq("operator_id", scope.operatorId).is("resolved_at", null);
      if (result.error) throw new Error("COINOPS_FINOPS_ALERT_SAVE_FAILED");
    }
  }
}

function buildExecutors(shards: Shard[], samples: DbRow[], services: FinopsService[], capital: FinopsDashboard["capital"], now: Date): FinopsExecutor[] {
  return shards.map((shard) => {
    const sample = samples.find((row) => row.shard_id === shard.id);
    const assessment = assessShardCapacity(sample && shard.enabled ? asShardMetrics(sample) : null,
      { ...DEFAULT_CAPACITY_POLICY, binanceLimitPerMinute: Number(shard.binance_limit_per_min), admissionRatio: Number(shard.admission_ratio) }, now.getTime());
    const costs = services.filter((row) => row.shardId === shard.id && row.enabled);
    const currencies = [...new Set(costs.map((row) => row.currency))];
    const total = costs.length ? sumKnown(costs.map((row) => row.projectedBrl)).total : null;
    const ownAccounts = new Set(capital.accounts.filter((row) => row.shardId === shard.id).map((row) => row.accountId)).size;
    const ownEngines = capital.markets.filter((row) => row.shardId === shard.id).length;
    const cost = costs[0];
    return { id: shard.id, name: `Executor ${shard.id.split("-")[1]}`, ip: String(shard.egress_ipv4), enabled: shard.enabled,
      provider: cost?.provider ?? null, region: cost?.region ?? null, plan: cost?.plan ?? null,
      accounts: ownAccounts, engines: ownEngines, cpuPercent: knownNumber(sample?.cpu_percent), ramMb: knownNumber(sample?.ram_used_mb),
      weightCurrent: knownNumber(sample?.binance_weight_current), weightLimit: Number(shard.binance_limit_per_min),
      pressurePercent: assessment.binancePercent, headroomPercent: assessment.binancePercent === null ? null : Math.max(0, money(100 - assessment.binancePercent)),
      backlog: knownNumber(sample?.scheduler_backlog), heartbeatAt: typeof sample?.heartbeat_at === "string" ? sample.heartbeat_at : null,
      status: assessment.state, monthlyOriginal: currencies.length === 1 ? sumKnown(costs.map((row) => row.projectedOriginal)).total : null,
      currency: currencies.length === 1 ? currencies[0]! : null, monthlyBrl: total,
      costPerAccountBrl: total === null || ownAccounts === 0 ? null : money(total / ownAccounts),
      costPerEngineBrl: total === null || ownEngines === 0 ? null : money(total / ownEngines),
      needsCapacity: ["WARNING", "CAPACITY_LIMIT"].includes(assessment.state), scaleRecommendation: assessment.action };
  });
}

export async function syncFinops(scope: FinopsScope, options: { refreshExternal?: boolean; force?: boolean } = {}) {
  assertScope(scope);
  const service = serviceClient(), owner = randomUUID(), now = new Date();
  const claim = await service.rpc("finops_claim_sync", { p_tenant_id: scope.tenantId, p_operator_id: scope.operatorId, p_owner: owner });
  if (claim.error) throw new Error("COINOPS_FINOPS_SYNC_LOCK_FAILED");
  if (claim.data !== true) return { status: "IN_PROGRESS" };
  try {
    const previous = await loadFinopsDashboard(scope);
    const slotKey = `SIX_HOUR:${Math.floor(now.getTime() / SIX_HOURS)}`;
    if (options.refreshExternal !== false) {
      const state = await scoped(service, "finops_sync_state", scope).maybeSingle();
      if (state.error) throw new Error("COINOPS_FINOPS_READ_FAILED");
      const nextSyncAt = nextFinopsExternalSync(state.data?.last_external_synced_at ?? null, now);
      if (nextSyncAt) return { status: "FRESH", nextSyncAt };
    }
    const [shards, samples] = await Promise.all([
      readAll<Shard>(() => service.from("executor_shards").select("id,egress_ipv4,enabled,binance_limit_per_min,admission_ratio").order("id")),
      readAll<DbRow>(() => service.from("executor_capacity_samples").select("*").order("shard_id")),
    ]);
    const priorServices = await inventory(service, scope, shards, now);
    const alerts = options.refreshExternal === false ? [] : await refreshProviders(service, scope, shards, priorServices, now);
    let fx: FxQuote[] = previous.fx;
    if (options.refreshExternal !== false) {
      try { fx = await fetchFinopsFx(now); }
      catch (error) { fx = []; alerts.push({ code: "BILLING_SYNC_FAILED", serviceId: null, message: `Conversão cambial: ${safeCode(error)}. Valores originais preservados.` }); }
    }
    const rows = await readAll<DbRow>(() => scoped(service, "finops_services", scope).order("id"));
    const services = rows.map((row) => enrichService(row, fx, now));
    let capital = previous.capital, accounts = previous.summary.accounts, engines = previous.summary.engines, capitalComplete = previous.summary.capitalComplete;
    if (options.refreshExternal !== false || !previous.capturedAt) {
      try {
        const raw = await loadFinopsCapital(service, { operatorId: scope.operatorId, tenantId: scope.tenantId, refreshWallets: options.refreshExternal !== false });
        capital = finopsCapitalRows(raw); accounts = raw.counts.activeAccounts; engines = raw.counts.activeEngines;
        capitalComplete = raw.accounts.every((account) => account.currencies.length > 0 && account.currencies.every((row) => row.complete));
      } catch (error) {
        capital = { accounts: [], markets: [], notes: [`Capital indisponível nesta sincronização: ${safeCode(error)}.`] };
        capitalComplete = false;
        alerts.push({ code: "BILLING_SYNC_FAILED", serviceId: null, message: "Não foi possível atualizar o capital monitorado. Trading permanece independente." });
      }
    }
    const capitalByCurrency: Record<string, number | null> = {};
    for (const currency of new Set(capital.accounts.map((row) => row.currency)))
      capitalByCurrency[currency] = sumKnown(capital.accounts.filter((row) => row.currency === currency).map((row) => row.monitored)).total;
    const convertedCapital = sumKnown(Object.entries(capitalByCurrency).map(([currency, amount]) => convertBrl(amount, currency, fx)));
    capitalComplete = capitalComplete && convertedCapital.complete;
    const enabledServices = services.filter((row) => row.enabled);
    const actual = sumKnown(enabledServices.map((row) => row.actualBrl)), projected = sumKnown(enabledServices.map((row) => row.projectedBrl));
    const costTotalsByCurrency: Record<string, number | null> = {};
    for (const currency of new Set(enabledServices.map((row) => row.currency))) {
      const values = enabledServices.filter((row) => row.currency === currency)
        .map((row) => row.projectedOriginal === null || row.allocationPercent === null ? null : row.projectedOriginal * row.allocationPercent / 100);
      costTotalsByCurrency[currency] = values.some((value) => value !== null) ? sumKnown(values).known : null;
    }
    const knownMonthly = enabledServices.some((row) => row.projectedBrl !== null) ? projected.known : null;
    const executors = buildExecutors(shards, samples, services, capital, now);
    if (previous.summary.knownProjectedBrl > 0 && projected.known > previous.summary.knownProjectedBrl * 1.2)
      alerts.push({ code: "COST_INCREASE", serviceId: null, message: "Subtotal mensal conhecido aumentou mais de 20% em relação ao snapshot anterior. Verifique serviços, tarifas e câmbio." });
    for (const row of enabledServices) {
      if (row.usage.some((metric) => metric.used !== null && metric.limit !== null && metric.limit > 0 && metric.used / metric.limit >= .8))
        alerts.push({ code: "SERVICE_LIMIT_WARNING", serviceId: row.id, message: "Consumo informado alcançou 80% do limite contratado deste serviço." });
      if (row.actualMonthCost !== null && row.recurringMonthly !== null && row.recurringMonthly > 0 && row.actualMonthCost > row.recurringMonthly * 1.25)
        alerts.push({ code: "UNEXPECTED_COST", serviceId: row.id, message: "Cobrança conhecida ultrapassa a recorrência em mais de 25%; verificar consumo variável e extras." });
    }
    const payload: FinopsDashboard = { capturedAt: now.toISOString(), period: periodAt(now), syncStatus: alerts.some((alert) => alert.code === "BILLING_SYNC_FAILED") ? "PARTIAL" : "OK",
      summary: { accounts, engines, executors: shards.filter((row) => row.enabled).length,
        capitalBrl: capitalComplete ? convertedCapital.total : null, capitalByCurrency, capitalComplete,
        actualBrl: actual.total, projectedBrl: projected.total, knownActualBrl: actual.known, knownProjectedBrl: projected.known,
        costPerAccountBrl: knownMonthly === null || accounts === 0 ? null : money(knownMonthly / accounts),
        costPerEngineBrl: knownMonthly === null || engines === 0 ? null : money(knownMonthly / engines),
        unavailableServices: enabledServices.filter((row) => row.projectedBrl === null).length,
        monthlyEstimatedBrl: knownMonthly,
        knownRealBrl: enabledServices.some((row) => row.actualBrl !== null) ? actual.known : null,
        estimatedBrl: enabledServices.some((row) => row.estimatedBrl !== null) ? sumKnown(enabledServices.map((row) => row.estimatedBrl)).known : null,
        allocatedBrl: enabledServices.some((row) => row.allocatedBrl !== null) ? sumKnown(enabledServices.map((row) => row.allocatedBrl)).known : null, costTotalsByCurrency },
      capital, executors, services, fx, history: [], alerts: [], sources: [...FINOPS_SOURCE_NOTES,
        "DigitalOcean: tarifa do recurso associado ao IP; faturamento pago não inferido.", "Supabase e Vercel compartilhados: rateio obrigatório antes de atribuir a despesa total ao CoinOps."],
      growth: [10, 50, 100].map((additionalAccounts) => ({ additionalAccounts, additionalEngines: additionalAccounts * 2,
        estimatedExecutors: null, incrementalBrl: null,
        reason: "Cenário ilustrativo de 2 motores por conta. Quantidade de novos executores depende do custo incremental medido e headroom, não de limite fixo de usuários. Tarifa de plano conhecido está no card de infraestrutura." })) };
    await persistAlerts(service, scope, alerts, now, options.refreshExternal !== false);
    const snapshot = await service.rpc("finops_finish_sync", { p_tenant_id: scope.tenantId, p_operator_id: scope.operatorId,
      p_owner: owner, p_snapshot_key: options.refreshExternal === false ? `MANUAL:${owner}` : slotKey,
      p_external: options.refreshExternal !== false, p_payload: payload });
    if (snapshot.error) throw new Error("COINOPS_FINOPS_SNAPSHOT_SAVE_FAILED");
    return { status: payload.syncStatus, services: services.length, capturedAt: payload.capturedAt };
  } catch (error) {
    await service.from("finops_sync_state").update({ last_status: "FAILED", last_error: safeCode(error) })
      .eq("tenant_id", scope.tenantId).eq("operator_id", scope.operatorId).eq("lease_owner", owner);
    throw error;
  } finally {
    await service.from("finops_sync_state").update({ lease_owner: null, lease_until: null })
      .eq("tenant_id", scope.tenantId).eq("operator_id", scope.operatorId).eq("lease_owner", owner);
  }
}

export async function saveFinopsManualService(scope: FinopsScope, input: Record<string, unknown>) {
  assertScope(scope);
  const parsed = validateManualService(input), service = serviceClient(), now = new Date();
  const saved = await service.from("finops_services").update({ plan: parsed.plan, currency: parsed.currency,
    ...("billingPeriodStart" in parsed ? { billing_period_start: parsed.billingPeriodStart, billing_period_end: parsed.billingPeriodEnd } : {}),
    recurring_monthly: parsed.recurringMonthly, actual_month_cost: parsed.actualMonthCost,
    variable_month_to_date: parsed.variableMonthToDate, allocation_percent: parsed.allocationPercent,
    cost_period: periodAt(now), origin: parsed.origin, source_mode: "MANUAL", billing_mode: "MANUAL",
    source_note: parsed.sourceNote, source_url: null, synced_at: now.toISOString(), sync_status: "MANUAL",
    updated_by: scope.userId, updated_at: now.toISOString() }).eq("id", parsed.serviceId)
    .eq("tenant_id", scope.tenantId).eq("operator_id", scope.operatorId).select("id").maybeSingle();
  if (saved.error || !saved.data) throw new Error("COINOPS_FINOPS_MANUAL_SAVE_FAILED");
  await syncFinops(scope, { refreshExternal: false, force: true });
  return { ok: true };
}

export async function syncAllFinops() {
  const service = serviceClient(), tenantId = getCoinOpsServiceTenantId()!;
  const operators = await readAll<{ id: string; user_id: string }>(() => service.from("operators").select("id,user_id")
    .eq("tenant_id", tenantId).eq("status", "ACTIVE").order("id"));
  const results: Array<{ operatorId: string; status: string }> = [];
  for (const operator of operators) {
    try { results.push({ operatorId: operator.id, ...(await syncFinops({ operatorId: operator.id, tenantId, userId: operator.user_id })) }); }
    catch (error) { results.push({ operatorId: operator.id, status: safeCode(error) }); }
  }
  return { results };
}

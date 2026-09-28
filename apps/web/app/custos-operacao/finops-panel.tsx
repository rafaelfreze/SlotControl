"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { FinopsDashboard, FinopsExecutor, FinopsService, FinopsCapitalRow, FinancialOrigin } from "@/lib/coinops-finops/types";
import { PremiumBrand, PremiumIcon } from "../automacao/premium-primitives";

const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value)
  ? "Indisponível" : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(value);
const percent = (value: number | null | undefined) => value == null ? "Indisponível" : `${number(value)}%`;
const money = (value: number | null | undefined, currency = "BRL") => value == null || !Number.isFinite(value)
  ? "Indisponível" : currency === "BRL" || currency === "USD"
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value)
    : `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)} ${currency}`;
const instant = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Campo_Grande", dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Sem sincronização";
const utcInput = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString().slice(0, 16) : "";
const providerPeriod = (service: FinopsService) => service.billingPeriodStart && service.billingPeriodEnd
  ? `${new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }).format(new Date(service.billingPeriodStart))} → ${new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }).format(new Date(service.billingPeriodEnd))} (UTC)`
  : "Mês calendário (UTC)";
const periodLabel = (period: string) => /^\d{4}-\d{2}$/.test(period.slice(0, 7))
  ? new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${period.slice(0, 7)}-01T12:00:00Z`)) : period;
const labels: Record<string, string> = { HEALTHY: "Saudável", OBSERVE: "Observar", WARNING: "Atenção", CAPACITY_LIMIT: "Limite de capacidade", OFFLINE: "Offline", CAPACITY_UNKNOWN: "Sem telemetria", ACTIVE: "Ativo", INACTIVE: "Inativo", OK: "Atualizado", PARTIAL: "Atualização parcial", STALE: "Atualização pendente", FAILED: "Falha na sincronização", UNAVAILABLE: "Indisponível", MANUAL: "Manual" };

function Origin({ value }: { value: FinancialOrigin }) {
  return <span className={`fo-origin fo-origin--${value === "REAL" ? "real" : value === "RATEIO_ESTIMADO" ? "manual" : value === "ESTIMADO" ? "projected" : "unknown"}`}>{value.replace("RATEIO_ESTIMADO", "RATEIO ESTIMADO").replace("INDISPONIVEL", "INDISPONÍVEL")}</span>;
}
function Stat({ label, value, note, accent = false }: { label: string; value: ReactNode; note?: ReactNode; accent?: boolean }) {
  return <article className={`fo-stat${accent ? " fo-stat--accent" : ""}`}><span>{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</article>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
function NativeAmounts({ amounts }: { amounts: Record<string, number | null> }) {
  const entries = Object.entries(amounts);
  return entries.length ? <span className="fo-native">{entries.map(([currency, value]) => <span key={currency}>{money(value, currency)}</span>)}</span> : <span>Indisponível</span>;
}
function capitalByCurrency(rows: FinopsCapitalRow[]) {
  const result: Record<string, number | null> = {};
  for (const row of rows) {
    if (row.monitored === null || result[row.currency] === null) result[row.currency] = null;
    else result[row.currency] = (result[row.currency] ?? 0) + row.monitored;
  }
  return result;
}

function ManualServiceForm({ service, onSaved }: { service: FinopsService; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error: boolean; message: string } | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = (key: string) => { const value = String(form.get(key) ?? "").trim(); return value === "" ? null : Number(value); };
    const billingStart = String(form.get("billingPeriodStart") ?? ""), billingEnd = String(form.get("billingPeriodEnd") ?? "");
    const periodChanged = billingStart !== utcInput(service.billingPeriodStart) || billingEnd !== utcInput(service.billingPeriodEnd);
    setBusy(true); setResult(null);
    try {
      const response = await fetch("/api/coinops-finops", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        serviceId: service.id, provider: service.provider, name: service.name, shardId: service.shardId,
        plan: String(form.get("plan") ?? "").trim(), currency: String(form.get("currency")),
        recurringMonthly: amount("recurringMonthly"), actualMonthCost: amount("actualMonthCost"),
        variableMonthToDate: amount("variableMonthToDate"), allocationPercent: amount("allocationPercent"),
        sourceNote: String(form.get("sourceNote") ?? "").trim(), origin: String(form.get("origin")),
        // Omit unchanged dates to preserve the original precision and provider period.
        ...(periodChanged ? { billingPeriodStart: billingStart ? `${billingStart}:00.000Z` : null,
          billingPeriodEnd: billingEnd ? `${billingEnd}:00.000Z` : null } : {}),
      }) });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        const messages: Record<string, string> = {
          COINOPS_FINOPS_REAL_EVIDENCE_REQUIRED: "Para registrar custo realizado, selecione Real e informe a origem da cobrança. Para uma estimativa, deixe o realizado vazio.",
          COINOPS_FINOPS_REAL_AMOUNT_REQUIRED: "Informe o custo realizado comprovado ou selecione uma classificação estimada.",
          COINOPS_FINOPS_ALLOCATION_REQUIRED: "Informe a parcela percentual atribuída ao CoinOps para salvar o rateio.",
          COINOPS_FINOPS_SOURCE_REQUIRED: "Descreva a origem dos valores e o critério de rateio.",
          COINOPS_FINOPS_INVALID_AMOUNT: "Confira os valores: até duas casas decimais para custos e rateio entre 0 e 100%. Somente o realizado pode incluir crédito negativo.",
          COINOPS_FINOPS_BILLING_PERIOD_INVALID: "Informe início e fim do ciclo, com o fim posterior ao início, ou deixe ambos vazios para usar o mês calendário.",
        };
        throw new Error(response.status === 401 || response.status === 403
          ? "Acesso administrativo indisponível. Entre novamente."
          : messages[failure?.error ?? ""] ?? "Não foi possível salvar. Confira os valores e tente novamente.");
      }
      setResult({ error: false, message: "Configuração manual salva. O resumo será atualizado." });
      onSaved();
    } catch (error) {
      setResult({ error: true, message: error instanceof Error ? error.message : "Falha ao salvar." });
    } finally { setBusy(false); }
  }
  return <details className="fo-manual"><summary>Configurar custo manual</summary><form onSubmit={save}>
    <p>Fonte de entrada: <b>MANUAL</b>. Classifique o valor pela evidência disponível. Campo vazio significa indisponível.</p>
    <div className="fo-form-grid">
      <label>Plano<input name="plan" defaultValue={service.plan ?? ""} maxLength={150} placeholder="Plano contratado" /></label>
      <label>Moeda<select name="currency" defaultValue={service.currency}><option value="USD">USD · dólar</option><option value="BRL">BRL · real</option></select></label>
      <label>Qualidade da evidência<select name="origin" defaultValue={service.actualMonthCost !== null ? "REAL" : ["REAL", "RATEIO_ESTIMADO"].includes(service.origin) ? service.origin : "ESTIMADO"}><option value="ESTIMADO">Estimado · preço ou plano conhecido</option><option value="REAL">Real · cobrança comprovada</option><option value="RATEIO_ESTIMADO">Rateio estimado · serviço compartilhado</option></select></label>
      <label>Recorrência mensal<input name="recurringMonthly" type="number" min="0" step="0.01" defaultValue={service.recurringMonthly ?? ""} placeholder="Não informado" /></label>
      <label>Custo realizado neste mês<input name="actualMonthCost" type="number" min="-1000000" step="0.01" defaultValue={service.actualMonthCost ?? ""} placeholder="Não informado" /></label>
      <label>Consumo variável no mês<input name="variableMonthToDate" type="number" min="0" step="0.01" defaultValue={service.variableMonthToDate ?? ""} placeholder="Não informado" /></label>
      <label>Parcela atribuída ao CoinOps (%)<input name="allocationPercent" type="number" min="0" max="100" step="0.0001" defaultValue={service.allocationPercent ?? ""} placeholder="Não informado" /></label>
      <label>Início do ciclo do fornecedor (UTC)<input name="billingPeriodStart" type="datetime-local" step="60" defaultValue={utcInput(service.billingPeriodStart)} /></label>
      <label>Fim do ciclo do fornecedor (UTC)<input name="billingPeriodEnd" type="datetime-local" step="60" defaultValue={utcInput(service.billingPeriodEnd)} /></label>
    </div>
    <label>Origem e critério de rateio<textarea name="sourceNote" required maxLength={1000} rows={3} defaultValue={service.sourceNote} placeholder="Ex.: fatura do fornecedor, período e parcela de uso do CoinOps." /></label>
    <p className="fo-help">Informe valores do serviço na moeda original, antes do rateio. Consumo variável deve excluir a recorrência mensal. O realizado é a cobrança conhecida, não a previsão.</p>
    <p className="fo-help">Ciclo do fornecedor em UTC. Deixe ambas as datas vazias para usar o mês calendário; datas não alteradas preservam o período existente.</p>
    <button className="fo-button" type="submit" disabled={busy}>{busy ? "Salvando…" : "Salvar configuração manual"}</button>
    {result ? <p role={result.error ? "alert" : "status"} className={result.error ? "fo-error" : "fo-success"}>{result.message}</p> : null}
  </form></details>;
}

function ExecutorCard({ executor, capital }: { executor: FinopsExecutor; capital: FinopsCapitalRow[] }) {
  const hasMetrics = executor.pressurePercent !== null;
  return <article className="fo-resource">
    <header><div className="fo-resource-title"><PremiumIcon name="server" /><div><h3>{executor.name}</h3><small>{executor.accounts} contas · {executor.engines} motores</small></div></div><span className={`fo-status ${executor.status === "HEALTHY" ? "fo-status--good" : "fo-status--attention"}`}>{labels[executor.status] ?? executor.status}</span></header>
    <div className="fo-resource-price"><strong>{money(executor.monthlyOriginal, executor.currency ?? "BRL")}<small>/mês</small></strong>{executor.currency && executor.currency !== "BRL" ? <span>{money(executor.monthlyBrl)} convertido</span> : null}</div>
    <div className="fo-utilization"><span>Pressão Binance <b>{hasMetrics ? `${number(executor.pressurePercent)}%` : "Indisponível"}</b></span><div className="fo-progress" role="img" aria-label={hasMetrics ? `Pressão Binance: ${number(executor.pressurePercent)} por cento` : "Pressão Binance indisponível"}><i style={{ width: `${Math.max(0, Math.min(100, executor.pressurePercent ?? 0))}%` }} /></div><small>Peso atual: {number(executor.weightCurrent, 0)} / {number(executor.weightLimit, 0)} por minuto</small></div>
    <dl className="fo-facts"><Field label="CPU">{executor.cpuPercent === null ? "Indisponível" : `${number(executor.cpuPercent)}%`}</Field><Field label="RAM">{executor.ramMb === null ? "Indisponível" : `${number(executor.ramMb, 0)} MB`}</Field><Field label="Fila">{executor.backlog === null ? "Indisponível" : executor.backlog === 0 ? "Normal" : `${executor.backlog} pendentes`}</Field><Field label="Custo / conta">{money(executor.costPerAccountBrl)}</Field><Field label="Custo / motor">{money(executor.costPerEngineBrl)}</Field></dl>
    <details className="fo-detail"><summary>Informações do executor</summary><dl className="fo-facts"><Field label="IP fixo">{executor.ip}</Field><Field label="Provedor">{executor.provider ?? "Indisponível"}</Field><Field label="Região">{executor.region ?? "Indisponível"}</Field><Field label="Plano">{executor.plan ?? "Indisponível"}</Field><Field label="Heartbeat">{instant(executor.heartbeatAt)}</Field><Field label="Capital monitorado"><NativeAmounts amounts={capitalByCurrency(capital)} /></Field></dl></details>
  </article>;
}

export function FinopsPanel({ data: initialData, homeHref = "/automacao?view=live" }: { data: FinopsDashboard; homeHref?: string }) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  useEffect(() => setData(initialData), [initialData]);
  const syncInFlight = useRef(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ error: boolean; message: string } | null>(null);
  const [period, setPeriod] = useState("1");
  const [accountLimit, setAccountLimit] = useState(10);
  const [marketLimit, setMarketLimit] = useState(10);
  const history = useMemo(() => {
    const rows = [...data.history].sort((a, b) => b.period.localeCompare(a.period));
    if (period === "all") return rows;
    const months = Number(period), current = new Date(`${data.period.slice(0, 7)}-01T12:00:00Z`);
    current.setUTCMonth(current.getUTCMonth() - months + 1);
    return rows.filter((row) => row.period.slice(0, 7) >= current.toISOString().slice(0, 7));
  }, [data.history, data.period, period]);
  const summary = data.summary;
  const available = data.capturedAt !== null;
  const monthlyEstimate = !available ? null : summary.monthlyEstimatedBrl !== undefined ? summary.monthlyEstimatedBrl
    : data.services.some((service) => service.enabled && service.projectedBrl !== null) ? summary.knownProjectedBrl : null;
  const realKnown = !available ? null : summary.knownRealBrl !== undefined ? summary.knownRealBrl
    : data.services.some((service) => service.enabled && service.origin === "REAL" && service.actualBrl !== null) ? summary.knownActualBrl : null;
  const growth = data.growth ?? [10, 50, 100].map((additionalAccounts) => ({ additionalAccounts,
    additionalEngines: 0, estimatedExecutors: null, incrementalBrl: null,
    reason: "Dimensionamento depende do custo incremental medido dos novos motores e da capacidade disponível. Não há número fixo de contas por executor." }));
  const needsCapacity = data.executors.filter((item) => item.needsCapacity);
  const referenceExecutor = data.executors.find((item) => item.enabled && item.monthlyBrl !== null);
  async function sync() {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true); setSyncResult(null);
    try {
      const response = await fetch("/api/coinops-finops", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "SYNC" }) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "Acesso administrativo indisponível. Entre novamente."
        : "A atualização não foi concluída. O último snapshot permanece disponível; tente novamente mais tarde.");
      const result = await response.json() as { status?: string; nextSyncAt?: string; nextOperationalSyncAt?: string };
      // Await the committed snapshot before announcing success. router.refresh()
      // is not awaitable and can leave the old numbers visible after the toast.
      const latest = await fetch("/api/coinops-finops", { cache: "no-store", credentials: "same-origin" });
      if (!latest.ok) throw new Error("A coleta foi solicitada, mas não foi possível carregar o resultado. Os valores exibidos ainda são os anteriores; tente atualizar novamente.");
      const dashboard = await latest.json() as FinopsDashboard;
      if (!dashboard || !dashboard.summary || typeof dashboard.period !== "string"
        || !(dashboard.capturedAt === null || typeof dashboard.capturedAt === "string")
        || !dashboard.summary.capitalByCurrency
        || ![dashboard.services, dashboard.history, dashboard.executors, dashboard.fx, dashboard.alerts, dashboard.sources,
          dashboard.capital?.accounts, dashboard.capital?.markets, dashboard.capital?.notes].every(Array.isArray))
        throw new Error("Resposta incompleta. Os valores anteriores foram preservados.");
      setData(dashboard);
      const message = result.status === "FRESH" ? `Último snapshot recarregado. ${result.nextOperationalSyncAt ? `Nova coleta operacional a partir de ${instant(result.nextOperationalSyncAt)} (proteção de 60 segundos).` : "Coleta dentro do intervalo mínimo."}`
        : result.status === "IN_PROGRESS" ? "Já existe uma atualização em andamento. Aguarde a conclusão."
        : result.status === "PARTIAL" ? "Snapshot atualizado parcialmente. Consulte os avisos e a origem de cada valor."
        : result.status === "OPERATIONAL_UPDATED" ? "Capital e infraestrutura consultados agora. Custos dos fornecedores e câmbio mantêm sua própria data de coleta."
        : "Dados atualizados e snapshot registrado.";
      setSyncResult({ error: false, message });
    } catch (error) {
      setSyncResult({ error: true, message: error instanceof Error ? error.message : "Falha ao atualizar os dados." });
    } finally { syncInFlight.current = false; setSyncing(false); }
  }
  return <div className="fo-app" data-testid="finops-admin">
    <header className="fo-topbar"><PremiumBrand /><span className="fo-admin-label">ADMIN</span><a className="fo-back fo-button" href={homeHref} aria-label="Voltar ao Início mantendo conta e mercado"><PremiumIcon name="home" />Início</a></header>
    <main>
      <section className="fo-heading"><div><span className="fo-eyebrow">GESTÃO DA PLATAFORMA</span><h1>Custos &amp; Operação</h1><p>Capital acompanhado, resultados das estratégias e custos do CoinOps, cada um no seu lugar.</p></div><div className="fo-period"><strong>{periodLabel(data.period)}</strong><button className="fo-button" type="button" disabled={syncing} onClick={() => void sync()}>{syncing ? "Atualizando…" : "Atualizar dados"}</button><div className="fo-freshness"><small>Coleta de capital e infraestrutura: {instant(data.operationalCapturedAt ?? data.externalCapturedAt ?? data.capturedAt)}</small><small>Coleta de fornecedores: {instant(data.externalCapturedAt ?? data.capturedAt)}</small><span>{data.syncStatus === "OK" ? "Snapshot disponível · confira a data das fontes" : labels[data.syncStatus] ?? data.syncStatus}</span></div><small className="fo-refresh-help">Atualizar consulta capital e infraestrutura agora (intervalo mínimo de 60s). Fornecedores: a cada 6h. Falhas permanecem indicadas, sem alterar o trading.</small></div></section>
      {syncResult ? <p className={`fo-sync-result ${syncResult.error ? "fo-error" : ""}`} role={syncResult.error ? "alert" : "status"}>{syncResult.message}</p> : null}
      {!available ? <p className="fo-empty">A primeira sincronização ainda não foi concluída. Use “Atualizar dados” para criar o snapshot inicial. Os campos abaixo permanecerão indisponíveis até essa coleta.</p> : null}
      <div className="fo-principle"><PremiumIcon name="shield" /><p>O capital das contas Binance pertence aos usuários. <strong>Ele não é receita da plataforma.</strong> Valores em moedas diferentes só são consolidados com cotação identificada.</p></div>
      <section className="fo-summary" aria-label="Resumo financeiro e operacional">
        <Stat label="Capital total monitorado" value={money(summary.capitalBrl)} accent note={<><NativeAmounts amounts={summary.capitalByCurrency} />{!summary.capitalComplete ? <span className="fo-attention">Consolidação incompleta</span> : null}</>} />
        <Stat label="Custo mensal estimado" value={money(monthlyEstimate)} note={<>{summary.costTotalsByCurrency ? <NativeAmounts amounts={summary.costTotalsByCurrency} /> : null}<span>{summary.unavailableServices ? `${summary.unavailableServices} serviço(s) pendente(s) · total parcial` : "Previsão operacional · não é cobrança"}</span></>} />
        <Stat label="Contas ativas" value={number(available ? summary.accounts : null, 0)} note="Contas Production" />
        <Stat label="Motores ativos" value={number(available ? summary.engines : null, 0)} note="Motores Production" />
        <Stat label="Executores ativos" value={number(available ? summary.executors : null, 0)} note="Registry oficial" />
        <Stat label="Custo médio / conta" value={money(summary.costPerAccountBrl)} note={summary.unavailableServices ? "Estimativa parcial / contas ativas" : "Projeção mensal / contas ativas"} />
      </section>
      <section className="fo-projection-row" aria-label="Projeção de custos"><div><span>Projeção no fechamento</span><strong>{money(summary.projectedBrl)}</strong><span className="fo-origin fo-origin--projected">PROJETADO</span></div><div><span>Custo médio / motor{summary.unavailableServices ? " · parcial" : ""}</span><strong>{money(summary.costPerEngineBrl)}</strong></div><p>{!available ? "Sem snapshot financeiro disponível." : summary.projectedBrl === null ? `Subtotal projetado conhecido: ${money(monthlyEstimate)}. ${summary.unavailableServices} serviço(s) sem dados suficientes.` : "Recorrência + consumo variável conhecido, com rateio quando informado. Não é cobrança confirmada."}</p></section>
      <section className="fo-evidence" aria-label="Qualidade dos dados financeiros">
        <div><Origin value="REAL" /><strong>{money(realKnown)}</strong><small>Cobrança comprovada no mês</small></div>
        <div><Origin value="ESTIMADO" /><strong>{money(available ? summary.estimatedBrl : null)}</strong><small>Planos e preços conhecidos</small></div>
        <div><Origin value="RATEIO_ESTIMADO" /><strong>{money(available ? summary.allocatedBrl : null)}</strong><small>Parcela dos serviços compartilhados</small></div>
      </section>
      {data.alerts.length ? <details className="fo-alerts"><summary><span>{data.alerts.length} aviso(s) financeiro(s)</span><span>Ver detalhes</span></summary><ul>{data.alerts.map((alert) => <li key={alert.id}><strong>{alert.code}</strong><span>{alert.message}</span><small>Desde {instant(alert.firstSeenAt)}</small></li>)}</ul></details> : null}
      <nav className="fo-section-nav" aria-label="Seções de Custos & Operação"><a href="#infraestrutura">Infraestrutura</a><a href="#servicos">Serviços</a><a href="#capacidade-custo">Capacidade × custo</a><a href="#historico">Histórico</a><a href="#detalhamento">Detalhamento</a></nav>

      <section id="infraestrutura" className="fo-section"><div className="fo-section-heading"><div><h2>Infraestrutura</h2><p>Custos e capacidade separados por executor.</p></div><span>{data.executors.length} registrado(s)</span></div><div className="fo-resource-grid">{data.executors.map((executor) => <ExecutorCard key={executor.id} executor={executor} capital={data.capital.accounts.filter((row) => row.shardId === executor.id)} />)}</div>{!data.executors.length ? <p className="fo-empty">Nenhum executor disponível no snapshot.</p> : null}</section>

      <section id="servicos" className="fo-section"><div className="fo-section-heading"><div><h2>Serviços</h2><p>Somente serviços identificados na arquitetura. Valores indisponíveis não são tratados como zero.</p></div></div><div className="fo-service-list">{data.services.map((service) => <article className={`fo-service${!service.enabled ? " fo-service--disabled" : ""}`} key={service.id}>
        <header><div><h3>{service.name}</h3><small>{service.provider} · {service.plan ?? "Plano não informado"}{!service.enabled ? " · Desativado" : ""}</small></div><Origin value={service.origin} /></header>
        <p className="fo-service-source">Origem: {service.sourceMode === "DOCUMENTED" ? "DOCUMENTADA" : service.sourceMode ?? (service.syncStatus === "MANUAL" ? "MANUAL" : "Não informada")}</p>
        <dl className="fo-service-costs"><Field label="Realizado do serviço">{money(service.actualMonthCost, service.currency)}<small>CoinOps: {money(service.actualBrl)}</small></Field><Field label="Mensal projetado do serviço">{money(service.projectedOriginal, service.currency)}<small>CoinOps: {money(service.projectedBrl)}</small></Field><Field label="Recorrência / mês">{money(service.recurringMonthly, service.currency)}<small>{service.allocationPercent === null ? "Rateio indisponível" : `${number(service.allocationPercent, 4)}% atribuído ao CoinOps`}</small></Field></dl>
        <details className="fo-detail"><summary>Consumo, origem e configuração</summary><p className="fo-source">{service.sourceNote || "Origem ainda não informada."}</p><p className="fo-help">Período do fornecedor: {providerPeriod(service)}</p><small>Sincronização: {instant(service.syncedAt)} · {labels[service.syncStatus] ?? service.syncStatus}</small>{service.sourceUrl ? <a className="fo-source-link" href={service.sourceUrl} target="_blank" rel="noreferrer">Consultar origem ↗</a> : null}<div className="fo-usage-list">{service.usage.length ? service.usage.map((usage, index) => <div key={`${usage.label}-${index}`}><span>{usage.label}</span><strong>{number(usage.used)} / {number(usage.limit)} {usage.unit}</strong></div>) : <p className="fo-help">Consumo e limites automáticos indisponíveis para este serviço.</p>}</div><ManualServiceForm key={`${service.id}-${service.syncedAt}`} service={service} onSaved={() => router.refresh()} /></details>
      </article>)}</div>{!data.services.length ? <p className="fo-empty">O inventário aparecerá após a primeira sincronização server-side.</p> : null}</section>

      <section id="capacidade-custo" className="fo-section"><div className="fo-section-heading"><div><h2>Capacidade × custo</h2><p>Expansão orientada pelas métricas do Capacity Manager. A margem bruta Binance não desconta a reserva de recovery e não autoriza novas contas.</p></div></div><div className="fo-capacity-list">{data.executors.map((executor) => <article key={executor.id}><div><strong>{executor.name}</strong><span>{executor.needsCapacity ? "Nova capacidade necessária" : "Acompanhar margem de operação"}</span></div><dl><Field label="Margem bruta Binance">{percent(executor.headroomPercent)}</Field><Field label="Direção">{executor.scaleRecommendation ?? "Sem recomendação registrada"}</Field><Field label="Mensal atual">{money(executor.monthlyBrl)}</Field></dl></article>)}</div>{needsCapacity.length ? <p className="fo-capacity-note">{referenceExecutor ? `Impacto mensal de referência para um executor equivalente: +${money(referenceExecutor.monthlyBrl)} (PROJETADO, baseado em ${referenceExecutor.name}). O valor depende do plano escolhido.` : "Impacto mensal adicional indisponível: informe o custo de um plano equivalente para estimar a expansão."} Nenhum recurso será provisionado por esta tela.</p> : null}</section>
      <details className="fo-detail fo-capital-detail"><summary>Cenários de crescimento</summary><p className="fo-help">Estimativas de planejamento. Cada admissão continua sujeita ao Capacity Manager e às métricas recentes do executor.</p><div className="fo-growth-grid">{growth.map((scenario) => <article key={scenario.additionalAccounts}><strong>+{scenario.additionalAccounts} contas</strong>{scenario.additionalEngines > 0 ? <small>{scenario.additionalEngines} novos motores considerados</small> : null}<dl className="fo-facts"><Field label="Executores adicionais">{scenario.estimatedExecutors === null ? "A dimensionar" : number(scenario.estimatedExecutors, 0)}</Field><Field label="Impacto mensal estimado">{scenario.incrementalBrl === null ? "A dimensionar" : `+${money(scenario.incrementalBrl)}`}</Field></dl><p>{scenario.reason}</p></article>)}</div></details>

      <section id="historico" className="fo-section"><div className="fo-section-heading"><div><h2>Histórico</h2><p>Cada mês conserva sua cotação e suas fontes. Meses em aberto podem ser atualizados.</p></div></div><div className="fo-range" role="group" aria-label="Período do histórico">{[["1", "Mês atual"], ["3", "3 meses"], ["6", "6 meses"], ["12", "12 meses"], ["all", "Tudo"]].map(([value, label]) => <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}</div><div className="fo-history-list">{history.map((row) => <article key={row.period}><header><strong>{periodLabel(row.period)}</strong><span>{row.closed ? "Fechado" : "Em aberto"}</span></header><dl className="fo-facts"><Field label="Realizado">{money(row.actualBrl)}</Field><Field label="Projetado">{money(row.projectedBrl)}</Field><Field label="Capital monitorado">{money(row.capitalBrl)}</Field><Field label="Contas / motores / executores">{row.accounts} / {row.engines} / {row.executors}</Field><Field label="Custo / conta">{money(row.costPerAccountBrl)}</Field><Field label="Custo / motor">{money(row.costPerEngineBrl)}</Field></dl><details className="fo-detail"><summary>Composição e câmbio do mês</summary><dl className="fo-facts">{Object.entries(row.byProvider).map(([provider, value]) => <Field key={provider} label={provider}>{money(value)}</Field>)}</dl><small>{row.completeness}{row.projectedBrl === null ? ` · Subtotal projetado conhecido: ${money(row.knownProjectedBrl)}` : ""}</small>{row.fx.map((fx) => <p className="fo-help" key={`${fx.base}-${fx.observedAt}`}>1 {fx.base} = {money(fx.rate)} · {fx.source} · {instant(fx.observedAt)}</p>)}<small>Snapshot: {instant(row.capturedAt)}</small></details></article>)}</div>{!history.length ? <p className="fo-empty">Ainda não há snapshot disponível neste período. O histórico começa na implantação deste módulo.</p> : null}</section>

      <section id="detalhamento" className="fo-section"><div className="fo-section-heading"><div><h2>Detalhamento</h2><p>Capital e resultado da estratégia, sem misturar com o custo da plataforma.</p></div></div>
        <details className="fo-detail fo-capital-detail" open><summary>Capital por conta e moeda</summary><div className="fo-capital-list">{data.capital.accounts.slice(0, accountLimit).map((row) => <article key={`${row.accountId}-${row.currency}`}><header><strong>{row.accountName}</strong><span>{row.currency}</span></header><dl className="fo-facts"><Field label="Total monitorado">{money(row.monitored, row.currency)}</Field><Field label="Livre">{money(row.free, row.currency)}</Field><Field label="Posições">{money(row.positions, row.currency)}</Field><Field label="Reservado">{money(row.reserved, row.currency)}</Field><Field label="P&L realizado">{money(row.realizedPnl, row.currency)}</Field><Field label="P&L aberto">{money(row.openPnl, row.currency)}</Field></dl><small>{row.complete ? "Leitura disponível" : "Leitura incompleta"} · {instant(row.observedAt)}</small><p className="fo-help">{row.source}</p></article>)}</div>{data.capital.accounts.length > accountLimit ? <button type="button" className="fo-button" onClick={() => setAccountLimit((value) => value + 10)}>Ver mais contas</button> : null}{!data.capital.accounts.length ? <p className="fo-empty">Capital ainda indisponível no snapshot.</p> : null}</details>
        <details className="fo-detail fo-capital-detail"><summary>Posições e resultado por mercado</summary><div className="fo-capital-list">{data.capital.markets.slice(0, marketLimit).map((row) => <article key={`${row.accountId}-${row.market}`}><header><strong>{row.accountName} · {row.market}</strong></header><dl className="fo-facts"><Field label="Posições">{money(row.positions, row.currency)}</Field><Field label="Reservado">{money(row.reserved, row.currency)}</Field><Field label="P&L realizado">{money(row.realizedPnl, row.currency)}</Field><Field label="P&L aberto">{money(row.openPnl, row.currency)}</Field></dl></article>)}</div>{data.capital.markets.length > marketLimit ? <button type="button" className="fo-button" onClick={() => setMarketLimit((value) => value + 10)}>Ver mais mercados</button> : null}<p className="fo-help">Saldo livre pertence à conta e moeda; não é repetido por mercado.</p></details>
        <details className="fo-detail fo-capital-detail"><summary>Cotação, fontes e critérios</summary><div className="fo-fx-list">{data.fx.map((fx) => <article key={`${fx.base}-${fx.observedAt}`}><strong>1 {fx.base} = {money(fx.rate)}</strong><span>{fx.source}</span><small>Cotação: {instant(fx.observedAt)} · Coleta: {instant(fx.fetchedAt)}</small></article>)}</div>{!data.fx.length ? <p className="fo-help">Cotação indisponível. Nenhuma conversão é presumida.</p> : null}<ul className="fo-notes">{[...data.capital.notes, ...data.sources].map((note, index) => <li key={index}>{note}</li>)}</ul></details>
      </section>
      <footer className="fo-footer"><span>CoinOps · Custos internos · Somente ADMIN</span><span>Leitura de snapshots persistidos · {instant(data.capturedAt)}</span></footer>
    </main>
  </div>;
}

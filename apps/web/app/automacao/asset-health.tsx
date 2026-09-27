"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AssetHealthAsset, AssetHealthDashboard, AssetHealthHistoryItem, AssetHealthStatus, AssetMetric } from "@/lib/coinops-asset-health/types";
import { PremiumDrawer, displayTime } from "./premium-primitives";
import "./asset-health.css";

type Days = 30 | 90 | 365;
type Snapshot = NonNullable<AssetHealthDashboard["assets"][AssetHealthAsset]>;
const statusLabels: Record<AssetHealthStatus, string> = {
  HEALTHY: "SAUDÁVEL", ATTENTION: "ATENÇÃO", STRUCTURAL_RISK: "RISCO ESTRUTURAL", INSUFFICIENT_DATA: "DADOS INSUFICIENTES",
};
const categoryLabels = { NETWORK: "Rede", SECURITY: "Segurança", DEVELOPMENT: "Desenvolvimento", LIQUIDITY: "Liquidez", ECOSYSTEM: "Ecossistema" };
const metricLabels = { HEALTHY: "Saudável", WARNING: "Atenção", CRITICAL: "Deteriorado", SOURCE_UNAVAILABLE: "Fonte indisponível", DATA_STALE: "Dado desatualizado" };
const confidenceLabels = { HIGH: "Alta", MEDIUM: "Média", LOW: "Baixa" };
const names = { BTC: "Bitcoin", SOL: "Solana" };
const cache = new Map<Days, { at: number; data: AssetHealthDashboard }>();
const pending = new Map<Days, Promise<AssetHealthDashboard>>();
const CACHE_MS = 5 * 60_000;

async function readDashboard(days: Days): Promise<AssetHealthDashboard> {
  const cached = cache.get(days);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const inFlight = pending.get(days);
  if (inFlight) return inFlight;
  const request = fetch(`/api/coinops-asset-health?days=${days}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok) throw new Error("ASSET_HEALTH_READ_UNAVAILABLE");
      const data = await response.json() as AssetHealthDashboard;
      if (!data?.assets || !data?.collector || !data.generatedAt) throw new Error("ASSET_HEALTH_READ_INVALID");
      cache.set(days, { at: Date.now(), data });
      return data;
    }).finally(() => pending.delete(days));
  pending.set(days, request);
  return request;
}

export function displayedAssetHealthStatus(snapshot: Snapshot | undefined, now: number): AssetHealthStatus {
  if (!snapshot || !Number.isFinite(Date.parse(snapshot.validUntil)) || Date.parse(snapshot.validUntil) <= now) return "INSUFFICIENT_DATA";
  return snapshot.status;
}

export function assetHealthAge(value: string | undefined, now: number): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Aguardando leitura";
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  return minutes < 1 ? "Atualizado agora" : minutes < 60 ? `Atualizado há ${minutes} min`
    : minutes < 1_440 ? `Atualizado há ${Math.floor(minutes / 60)} h` : `Atualizado há ${Math.floor(minutes / 1_440)} d`;
}

export function assetHealthChanges(history: AssetHealthHistoryItem[]): AssetHealthHistoryItem[] {
  const rows = [...history].sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt));
  return rows.filter((row, index) => index === 0 || row.status !== rows[index - 1].status).reverse();
}

type HealthContext = { dashboard: AssetHealthDashboard | null; now: number; loading: boolean; open: (asset: AssetHealthAsset) => void };
const Context = createContext<HealthContext>({ dashboard: null, now: 0, loading: true, open: () => undefined });

export function assetHealthDeepLink(search: string): AssetHealthAsset | null {
  const asset = new URLSearchParams(search).get("assetHealth");
  return asset === "BTC" || asset === "SOL" ? asset : null;
}

export function AssetHealthProvider({ children }: { children: ReactNode }) {
  const [dashboard, setDashboard] = useState<AssetHealthDashboard | null>(null);
  const [selected, setSelected] = useState<AssetHealthAsset | null>(null);
  const [days, setDays] = useState<Days>(30);
  const [now, setNow] = useState(0);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  useEffect(() => { setSelected(assetHealthDeepLink(window.location.search)); }, []);
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      try {
        const result = await readDashboard(days);
        if (mounted) { setDashboard(result); setReadError(false); }
      } catch { if (mounted) setReadError(true); }
      finally { if (mounted) setLoading(false); }
    };
    setLoading(true);
    void load();
    const refresh = window.setInterval(() => { void load(); }, CACHE_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { mounted = false; window.clearInterval(refresh); window.clearInterval(clock); document.removeEventListener("visibilitychange", onVisible); };
  }, [days]);
  const snapshot = selected ? dashboard?.assets[selected] : undefined;
  return <Context.Provider value={{ dashboard, now, loading, open: setSelected }}>{children}
    {selected ? <PremiumDrawer open title={`Saúde do Ativo — ${names[selected]}`} onClose={() => setSelected(null)}>
      <AssetHealthDetails asset={selected} snapshot={snapshot} now={now} loading={loading} readError={readError}
        days={days} setDays={setDays} collector={dashboard?.collector} />
    </PremiumDrawer> : null}
  </Context.Provider>;
}

export function AssetHealthBadge({ asset }: { asset: AssetHealthAsset }) {
  const { dashboard, now, loading, open } = useContext(Context);
  const snapshot = dashboard?.assets[asset];
  const status = displayedAssetHealthStatus(snapshot, now);
  return <button type="button" className={`ah-badge ah-tone-${status.toLowerCase()}`} onClick={() => open(asset)}
    aria-label={`Saúde do ativo ${names[asset]}: ${snapshot ? statusLabels[status] : loading ? "carregando" : "dados insuficientes"}. Ver análise.`}
    aria-haspopup="dialog" title="Abrir análise estrutural do ativo">
    <span><i aria-hidden="true" /><span>Saúde do ativo · <strong>{snapshot ? statusLabels[status] : loading ? "CARREGANDO" : "DADOS INSUFICIENTES"}</strong></span><span className="ah-badge-chevron" aria-hidden="true">›</span></span>
    <small>{assetHealthAge(snapshot?.evaluatedAt, now)}</small>
  </button>;
}

function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  return /^https:\/\//.test(url) ? <a href={url} target="_blank" rel="noopener noreferrer">{children} ↗</a> : <span>{children}</span>;
}

function TechnicalMetric({ metric }: { metric: AssetMetric }) {
  return <details className="ah-metric"><summary><span>{metric.label}</span><small>{metricLabels[metric.status]}</small></summary>
    <p>{metric.reason}</p><dl><div><dt>Valor medido</dt><dd><pre>{typeof metric.value === "number" ? metric.value.toLocaleString("pt-BR", { maximumFractionDigits: 8 }) : typeof metric.value === "string" ? metric.value : JSON.stringify(metric.value, null, 2) ?? "Indisponível"}{metric.unit ? ` ${metric.unit}` : ""}</pre></dd></div>
      <div><dt>Confiança da fonte</dt><dd>{confidenceLabels[metric.confidence]}</dd></div><div><dt>Data da métrica</dt><dd>{displayTime(metric.metricAt)}</dd></div>
      {metric.observedAt ? <div><dt>Última observação válida</dt><dd>{displayTime(metric.observedAt)}</dd></div> : null}
      <div><dt>Coletado em</dt><dd>{displayTime(metric.fetchedAt)}</dd></div><div><dt>Fonte</dt><dd><SourceLink url={metric.source.url}>{metric.source.name}</SourceLink></dd></div>
      {metric.errorCode ? <div><dt>Erro de coleta{metric.errorAt ? ` em ${displayTime(metric.errorAt)}` : ""}</dt><dd><code>{metric.errorCode}</code>{metric.collectionStatus === "SOURCE_UNAVAILABLE" ? " · Fonte indisponível; última evidência preservada até seu prazo de validade." : ""}</dd></div> : null}</dl>
  </details>;
}

export function AssetHealthDetails({ asset, snapshot, now, loading, readError, days, setDays, collector }: {
  asset: AssetHealthAsset; snapshot?: Snapshot; now: number; loading: boolean; readError: boolean; days: Days;
  setDays: (days: Days) => void; collector?: AssetHealthDashboard["collector"];
}) {
  const status = displayedAssetHealthStatus(snapshot, now);
  const stale = Boolean(snapshot && status === "INSUFFICIENT_DATA" && snapshot.status !== "INSUFFICIENT_DATA");
  const changes = assetHealthChanges(snapshot?.history ?? []);
  const risks = asset === "BTC" ? ["Queda persistente de segurança ou atividade de mineração.", "Falhas prolongadas na produção de blocos e vulnerabilidades críticas confirmadas.", "Concentração relevante, abandono de desenvolvimento ou perda estrutural de liquidez."]
    : ["Falhas prolongadas da rede e perda persistente de validadores ou participação de stake.", "Concentração excessiva e regressão na diversidade de clientes.", "Abandono de desenvolvimento, vulnerabilidades críticas ou perda persistente de uso e liquidez."];
  return <div className="ah-details">
    <section className={`ah-status ah-tone-${status.toLowerCase()}`} aria-label="Status atual">
      <small>STATUS ATUAL</small><strong>{!snapshot && loading ? "CARREGANDO" : statusLabels[status]}</strong>
      <span>{assetHealthAge(snapshot?.evaluatedAt, now)}</span>
      {snapshot && !stale ? <small>Indicadores saudáveis: {snapshot.healthyIndicators}/{snapshot.totalIndicators}</small> : null}
    </section>
    <section className="ah-summary"><h3>Por que está neste status?</h3>
      <p>{!snapshot ? loading ? "Consultando a análise mais recente." : "Ainda não há evidência suficiente disponível para avaliar o ativo. Isso não indica uma falha da rede."
        : stale ? `A análise anterior (${statusLabels[snapshot.status]}) está fora do prazo de validade. É necessário atualizar os dados antes de confirmar a saúde atual.` : snapshot.summary}</p>
      {readError ? <p className="ah-notice" role="status">Não foi possível atualizar a leitura agora. A última evidência válida permanece visível até seu prazo de validade.</p> : null}
      {snapshot && !stale && snapshot.reasons.length ? <ul>{snapshot.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
      {snapshot?.coverage ? <p className="ah-disclaimer">Cobertura atual: {snapshot.coverage.available}/{snapshot.coverage.expected} indicadores disponíveis.
        {snapshot.coverage.missingCategories.length ? ` Áreas sem evidência suficiente: ${snapshot.coverage.missingCategories.map((category) => categoryLabels[category]).join(", ")}.` : ""}
        {snapshot.coverage.unavailableOptional > 0 ? ` ${snapshot.coverage.unavailableOptional} indicador(es) complementar(es) indisponível(is).` : ""}</p> : null}
      <p className="ah-disclaimer">Avaliação informativa da estrutura do ativo. Queda de preço, sozinha, não representa risco estrutural. Este status não envia ordens nem altera seus motores.</p>
    </section>
    {snapshot ? <section className="ah-categories" aria-label="Indicadores por área">{snapshot.categories.map((category) => <article key={category.category}>
      <header><h3>{categoryLabels[category.category]}</h3><span className={`ah-category-label ah-tone-${stale ? "insufficient_data" : category.status === "RISK" ? "structural_risk" : category.status.toLowerCase()}`}>{stale ? "Dado desatualizado" : category.status === "RISK" ? "Risco" : statusLabels[category.status]}</span></header><p>{category.summary}</p>
    </article>)}</section> : null}
    <details className="ah-disclosure"><summary>Riscos acompanhados</summary><p>Estas são condições monitoradas quando há fontes confiáveis; não são previsões.</p><ul>{risks.map((risk) => <li key={risk}>{risk}</li>)}</ul></details>
    <details className="ah-disclosure"><summary>O que pode mudar este status?</summary><h4>O que poderia piorar?</h4><p>Deterioração persistente em várias métricas estruturais, confirmada por fontes independentes. Uma notícia isolada, volatilidade ou falha de API não bastam para risco estrutural.</p><h4>O que faria voltar para saudável?</h4><p>Dados recentes e suficientes mostrando normalização da rede, segurança, desenvolvimento e liquidez, segundo os critérios monitorados. Ausência de dados não confirma recuperação.</p></details>
    <section className="ah-history"><header><h3>Histórico de saúde</h3><select aria-label="Período do histórico de saúde" value={days} onChange={(event) => setDays(Number(event.target.value) as Days)}><option value={30}>30 dias</option><option value={90}>90 dias</option><option value={365}>1 ano</option></select></header>
      {loading ? <p role="status">Carregando histórico…</p> : readError ? <p role="status">Histórico indisponível nesta consulta. Tente novamente mais tarde.</p> : changes.length ? <ol>{changes.slice(0, 12).map((entry) => <li key={entry.evaluatedAt}><div><strong className={`ah-tone-${entry.status.toLowerCase()}`}>{statusLabels[entry.status]}</strong><time dateTime={entry.evaluatedAt}>{displayTime(entry.evaluatedAt)}</time></div>{entry.reasons[0] ? <p>{entry.reasons[0]}</p> : null}</li>)}</ol> : <p>Sem registros no período. O histórico começa na primeira coleta do módulo.</p>}
      {!loading && !readError && changes.length > 12 ? <details><summary>Ver mais {changes.length - 12} mudanças</summary><ol>{changes.slice(12).map((entry) => <li key={entry.evaluatedAt}><strong>{statusLabels[entry.status]}</strong><time dateTime={entry.evaluatedAt}>{displayTime(entry.evaluatedAt)}</time></li>)}</ol></details> : null}
    </section>
    {snapshot ? <><details className="ah-disclosure"><summary>Fontes e última atualização</summary><ul className="ah-sources">{snapshot.sources.map((source) => <li key={source.id}><SourceLink url={source.url}>{source.name}</SourceLink><small>{displayTime(source.fetchedAt)} · {metricLabels[source.status as keyof typeof metricLabels] ?? source.status}</small></li>)}</ul><p>Avaliação: {displayTime(snapshot.evaluatedAt)}<br />Validade: {displayTime(snapshot.validUntil)}</p><p>Monitor de coleta: {collector?.status === "HEALTHY" ? "Em dia" : collector?.status === "FAILED" ? "Falha na coleta" : collector?.status === "STALE" ? "Coleta atrasada" : "Aguardando coleta"} · última execução {displayTime(collector?.lastRunAt)}</p></details>
      <details className="ah-disclosure"><summary>Ver detalhes técnicos</summary><p>Fatos medidos por fonte. O status geral é uma regra derivada; confiança não é probabilidade de investimento.</p>{snapshot.metrics.map((metric) => <TechnicalMetric key={`${metric.source.id}:${metric.key}`} metric={metric} />)}</details></> : null}
  </div>;
}

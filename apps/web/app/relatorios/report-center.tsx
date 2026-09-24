"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { DesktopWorkspace } from "@/components/app/desktop-workspace";
import { AppHeader, MobileScreen } from "@/components/app/mobile-ui";
import { STRATEGY_4_1_EFFECTIVE_AT } from "@/lib/coinops-reports/missed-level-temporal";
import { REPORT_VERSION } from "@/lib/coinops-reports/filters";
import { CANDLE_EXPORT_MAX_DAYS, partitionCandleExports } from "@/lib/coinops-reports/candle-export-parts";

type Environment = "ALL" | "SHADOW" | "TESTNET" | "REAL";
type Preset = "today" | "7d" | "30d" | "month" | "custom" | "strategy4_1";
type View = "overview" | "shadow" | "testnet" | "real" | "exports";
type Filters = { start: string; end: string; preset: Preset; asset: "ALL" | "BTC" | "SOL"; environment: Environment };
type Check = { code: string; status: "PASS" | "WARNING" | "FAIL"; explanation: string; environment?: string; asset?: string };
type ReportFile = { name: string; rows?: number; description?: string };
type Preview = { reportVersion: number; generatedAt: string; summaries: Record<string, unknown>[]; checks: Check[]; warnings: string[]; incompleteSources: string[]; rowCounts: Record<string, number>; files: ReportFile[]; totals?: { errors: number } };
type Download = { name: string; generatedAt: string; start: string; end: string; environment: Environment; asset: string; size: number; reportVersion: number };
type DownloadFormat = "zip" | "csv" | "json" | "markdown" | "candles";

const views: Array<{ key: View; label: string; environment?: Environment }> = [
  { key: "overview", label: "Visão Geral", environment: "ALL" }, { key: "shadow", label: "Shadow", environment: "SHADOW" },
  { key: "testnet", label: "Testnet", environment: "TESTNET" }, { key: "real", label: "Real", environment: "REAL" }, { key: "exports", label: "Exportações" }
];
const descriptions: Record<string, string> = {
  "00_RESUMO.csv": "Resumo em português para leitura rápida", "01_CICLOS.csv": "Ciclos, encerramentos e motivos de reset",
  "02_SLOTS.csv": "Identidade física, níveis e saldos dos slots", "03_OPERACOES.csv": "Entradas, saídas e resultado por operação",
  "04_ORDENS.csv": "Ordens, fills e identificação de ownership", "05_EVENTOS.csv": "Linha do tempo e transições do robô",
  "06_GAINS.csv": "Ganhos por slot e operação", "07_CAPITAL_COMPOUNDING.csv": "Movimentações e reinvestimento por slot",
  "08_MERCADO_GATILHOS.csv": "Candles e evidências ao redor dos gatilhos", "09_RECONCILIACAO.csv": "Conferência do estado local e da exchange",
  "10_ALERTAS_ERROS.csv": "Erros, divergências e comportamento esperado", "11_REGRAS_CONFIGURACAO.csv": "Regras efetivas e configurações conhecidas",
  "12_CHECKS_AUDITORIA.csv": "Verificações automáticas e suas evidências", "13_TESTNET.csv": "Binance Testnet: fundos fictícios",
  "15_ESTRATEGIA_DECISOES.csv": "Decisões, versão, despacho, ACK e latência", "16_MISSED_TEMPORAL.csv": "Histórico, fato gerador, diagnóstico e problemas atuais",
  "14_REAL.csv": "Production somente leitura e preparação LIVE", "LIVE_PREPARATION.csv": "Filtros BTC/SOL BRL, capital, hard caps e dry-run sem ordens", "AUDITORIA_COMPLETA.json": "Todas as relações para auditoria técnica ou IA",
  "manifest.json": "Versão, arquivos, contagens e fontes incompletas", "RESUMO.md": "Explicação simples do resultado e das limitações"
};
const statusLabels = { PASS: "Conforme", WARNING: "Atenção", FAIL: "Divergência" };
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 });
const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Campo_Grande", dateStyle: "short", timeStyle: "short" });
function shiftDate(day: string, offset: number) { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
function initialFilters(today: string): Filters { return { start: shiftDate(today, -29), end: today, preset: "30d", asset: "ALL", environment: "ALL" }; }
function dateLabel(day: string) { return day.split("-").reverse().join("/"); }
function text(value: unknown, fallback = "Não informado") { return typeof value === "string" && value ? value : fallback; }
function numeric(value: unknown) { if (value === null || value === undefined || value === "") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function valueLabel(value: unknown, count = false) { const parsed = numeric(value); return parsed === null ? "Não disponível" : (count ? integer : number).format(parsed); }
function instant(value: unknown) { if (typeof value !== "string") return "Não informado"; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "Não informado" : dateTime.format(parsed); }
function sizeLabel(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${number.format(bytes / 1024)} KB` : `${number.format(bytes / 1024 / 1024)} MB`; }
function environmentLabel(value: string) { return value === "ALL" ? "Todos os ambientes" : value === "TESTNET" ? "Testnet · fictício" : value === "REAL" ? "Real · somente leitura" : "Shadow"; }
function query(filters: Filters, format: string, file?: string) { const params = new URLSearchParams({ ...filters, format }); if (file) params.set("file", file); return `/api/coinops-reports?${params.toString()}`; }

export function ReportCenter({ today, userLabel }: { today: string; userLabel: string }) {
  const [filters, setFilters] = useState<Filters>(() => initialFilters(today));
  const [draft, setDraft] = useState<Filters>(() => initialFilters(today));
  const [view, setView] = useState<View>("overview");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterError, setFilterError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [summaryPage, setSummaryPage] = useState(0);
  const [checkPage, setCheckPage] = useState(0);
  const [candlePage, setCandlePage] = useState(0);
  const [checkStatus, setCheckStatus] = useState("ALL");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPreview(null); setSummaryPage(0); setCheckPage(0); setCandlePage(0);
    fetch(query(filters, "preview"), { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? "Sua sessão expirou. Entre novamente para consultar os relatórios." : response.status === 403 ? "Seu acesso aos dados deste relatório não está disponível." : "Não foi possível carregar as evidências do período. Tente novamente.");
        const payload = await response.json() as Preview;
        if (!Array.isArray(payload.summaries) || !Array.isArray(payload.checks)) throw new Error("O relatório recebido está incompleto. Tente novamente.");
        return payload;
      })
      .then((payload) => { if (!controller.signal.aborted) setPreview(payload); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Relatório indisponível."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, refresh]);

  function changeView(next: View) {
    setView(next);
    const environment = views.find((item) => item.key === next)?.environment;
    if (environment) { setFilters((current) => ({ ...current, environment })); setDraft((current) => ({ ...current, environment })); }
  }
  function changePreset(preset: Preset) {
    setDraft((current) => ({ ...current, preset, ...(preset === "custom" ? {} : { end: today, start: preset === "strategy4_1" ? STRATEGY_4_1_EFFECTIVE_AT.slice(0, 10) : preset === "today" ? today : preset === "month" ? `${today.slice(0, 7)}-01` : shiftDate(today, preset === "7d" ? -6 : -29) }) }));
  }
  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.start || !draft.end || draft.start > draft.end) { setFilterError("Escolha uma data inicial anterior ou igual à final."); return; }
    setFilterError(""); setFilters({ ...draft });
    if (view !== "exports") setView(draft.environment === "ALL" ? "overview" : draft.environment.toLowerCase() as View);
  }
  async function download(format: DownloadFormat, file?: string, environment?: Environment, range?: { start: string; end: string }) {
    const selected: Filters = { ...filters, ...(environment ? { environment } : {}), ...(range ? { start: range.start, end: range.end, preset: "custom" as const } : {}), ...(format === "candles" ? { environment: "SHADOW" as const } : {}) };
    setDownloading(file || `${format}-${selected.environment}${range ? `:${range.start}_${range.end}` : ""}`); setDownloadError("");
    try {
      const response = await fetch(query(selected, format, file), { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Sua sessão expirou. Entre novamente para exportar." : "A exportação não pôde ser concluída. Reduza o período ou tente novamente.");
      const blob = await response.blob();
      const headerName = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1];
      const extension = format === "markdown" ? "md" : format === "candles" ? "csv" : format;
      const filename = (headerName || file || `coinops-report-${selected.start}_${selected.end}.${extension}`).replace(/[\\/:*?"<>|]/g, "_");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDownloads((current) => [{ name: filename, generatedAt: new Date().toISOString(), start: selected.start, end: selected.end, environment: selected.environment, asset: selected.asset, size: blob.size, reportVersion: preview?.reportVersion || REPORT_VERSION }, ...current].slice(0, 20));
    } catch (cause) { setDownloadError(cause instanceof Error ? cause.message : "Não foi possível baixar o arquivo."); }
    finally { setDownloading(null); }
  }

  const checks = preview?.checks || [];
  const counts = { PASS: checks.filter((check) => check.status === "PASS").length, WARNING: checks.filter((check) => check.status === "WARNING").length, FAIL: checks.filter((check) => check.status === "FAIL").length };
  const shownChecks = checks.filter((check) => checkStatus === "ALL" || check.status === checkStatus);
  const summaries = preview?.summaries || [];
  const busy = downloading !== null;
  const files = preview?.files || [];
  const totalRows = Object.values(preview?.rowCounts || {}).reduce((sum, count) => sum + count, 0);
  const warnings = [...new Set([...(preview?.warnings || []), ...(preview?.incompleteSources || []).map((source) => `Fonte incompleta: ${source}`)])];
  const candleParts = partitionCandleExports(filters.start, filters.end);
  const totals = (key: string) => summaries.reduce((sum, row) => sum + (numeric(row[key]) || 0), 0);
  const totalErrors = preview?.totals?.errors ?? totals("errors");
  const downloadButton = <button type="button" className="reports-primary" disabled={busy || loading || !preview} onClick={() => void download("zip")}><span aria-hidden="true">⇩</span>{downloading?.startsWith("zip-") ? "Preparando pacote…" : "Exportar relatório completo"}</button>;
  const content = (
    <div className="reports-center">
      <nav className="reports-tabs" aria-label="Ambientes dos relatórios">{views.map((item) => <button key={item.key} type="button" aria-current={view === item.key ? "page" : undefined} onClick={() => changeView(item.key)}>{item.label}</button>)}</nav>
      <section className="reports-intro"><div><span className="reports-eyebrow">AUDITORIA DO ROBÔ · VERSÃO {preview?.reportVersion || REPORT_VERSION}</span><h2>{view === "exports" ? "Um pacote. Toda a evidência." : "O que o robô fez neste período?"}</h2><p>Mercado, regras e resultados relacionados por ciclo e slot. Fundos e resultados de cada ambiente permanecem separados.</p></div>{downloadButton}</section>
      <details className="reports-filter-panel" open>
        <summary>Filtros <span>{dateLabel(filters.start)} – {dateLabel(filters.end)} · {filters.asset === "ALL" ? "BTC + SOL" : filters.asset}</span></summary>
        <form className="reports-filters" onSubmit={applyFilters}>
          <label>Período<select value={draft.preset} onChange={(event) => changePreset(event.target.value as Preset)}><option value="strategy4_1">Desde Strategy 4.1.0</option><option value="today">Hoje</option><option value="7d">7 dias</option><option value="30d">30 dias</option><option value="month">Mês atual</option><option value="custom">Personalizado</option></select></label>
          <label>De<input type="date" disabled={draft.preset === "strategy4_1"} required value={draft.start} max={draft.end || today} onChange={(event) => setDraft({ ...draft, start: event.target.value, preset: "custom" })} /></label>
          <label>Até<input type="date" disabled={draft.preset === "strategy4_1"} required value={draft.end} min={draft.start} max={today} onChange={(event) => setDraft({ ...draft, end: event.target.value, preset: "custom" })} /></label>
          <label>Ativo<select value={draft.asset} onChange={(event) => setDraft({ ...draft, asset: event.target.value as Filters["asset"] })}><option value="ALL">BTC + SOL</option><option value="BTC">BTC</option><option value="SOL">SOL</option></select></label>
          <label>Ambiente<select value={draft.environment} onChange={(event) => setDraft({ ...draft, environment: event.target.value as Environment })}><option value="ALL">Todos</option><option value="SHADOW">Shadow</option><option value="TESTNET">Testnet · fictício</option><option value="REAL">Real · leitura</option></select></label>
          <button type="submit" className="reports-secondary" disabled={loading}>Aplicar filtros</button>
        </form>{filterError ? <p className="reports-error" role="alert">{filterError}</p> : null}
      </details>
      <div className="reports-context"><span>{filters.preset === "strategy4_1" ? `Desde Strategy 4.1.0 · ${STRATEGY_4_1_EFFECTIVE_AT} (UTC, instante exato)` : `${dateLabel(filters.start)} a ${dateLabel(filters.end)} · America/Campo_Grande`}</span><span>{loading ? "Consultando fontes persistidas…" : preview ? `Gerado em ${instant(preview.generatedAt)}` : "Sem relatório carregado"}</span></div>
      {downloadError ? <p className="reports-error" role="alert">{downloadError}</p> : null}
      {error ? <div className="reports-message" role="alert"><strong>Não foi possível abrir o relatório</strong><p>{error}</p><button type="button" className="reports-secondary" onClick={() => setRefresh((current) => current + 1)}>Tentar novamente</button></div> : null}
      {loading ? <div className="reports-loading" role="status"><span className="reports-loader" />Relacionando ciclos, ordens, regras e eventos…</div> : null}
      {preview ? <>
        {filters.environment === "TESTNET" ? <p className="reports-environment-note testnet"><strong>BINANCE TESTNET / FUNDOS FICTÍCIOS</strong> Ordens executadas apenas no ambiente de testes.</p> : filters.environment === "REAL" ? <p className="reports-environment-note real"><strong>PRODUCTION READ-ONLY · LIVE BLOQUEADO</strong> Consulta e preparação. Este relatório não executa ordens.</p> : filters.environment === "SHADOW" ? <p className="reports-environment-note shadow"><strong>SHADOW</strong> Simulação com mercado real; compras e TPs virtuais.</p> : null}
        {warnings.length ? <details className="reports-warnings"><summary>{warnings.length} {warnings.length === 1 ? "limitação de evidência" : "limitações de evidência"} · consulte antes de concluir a auditoria</summary><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : null}
        <div className="reports-kpis">
          <Kpi label="Checks conformes" value={counts.PASS} helper={`${counts.WARNING} avisos · ${counts.FAIL} divergências`} tone={counts.FAIL ? "negative" : counts.WARNING ? "warning" : "positive"} />
          <Kpi label="Ciclos / operações" value={`${integer.format(totals("cycles"))} / ${integer.format(totals("operations"))}`} helper="Nos ambientes selecionados" />
          <Kpi label={filters.preset === "strategy4_1" ? "Gains pelo fato gerador" : "Gains registrados"} value={integer.format(totals(filters.preset === "strategy4_1" ? "since_strategy_gains_by_fill" : "gains"))} helper={filters.preset === "strategy4_1" ? `${integer.format(totals("ledger_credits_observed_since_strategy"))} créditos observados; ${integer.format(totals("since_strategy_gain_fill_unknown"))} gains sem horário exato do TP` : "Resultado detalhado por ambiente"} />
          {filters.environment === "ALL" || filters.environment === "TESTNET" ? <>
            <Kpi label="Missed históricos Testnet" value={integer.format(totals("historical_missed"))} helper="Preservados, separados do estado atual" />
            <Kpi label="Missed Testnet após 4.1.0" value={integer.format(totals("missed_since_strategy"))} helper={`${integer.format(totals("unresolved_missed"))} pendente(s) de evidência temporal`} tone={totals("missed_since_strategy") || totals("unresolved_missed") ? "warning" : undefined} />
            <Kpi label="Problemas atuais Testnet" value={integer.format(totals("active_errors"))} helper={`${integer.format(totalErrors)} erros registrados no período; não equivalem a erros ativos`} tone={totals("active_errors") ? "warning" : undefined} />
          </> : <Kpi label="Missed / erros registrados" value={`${integer.format(totals("missed_levels"))} / ${integer.format(totalErrors)}`} helper="Registros do período; consulte os checks atuais" tone={totals("missed_levels") || totalErrors ? "warning" : undefined} />}
          <Kpi label="Evidências exportáveis" value={integer.format(totalRows)} helper={`${files.length} arquivos no pacote`} />
        </div>
        {view !== "exports" ? <div className="reports-overview-grid">
          <section className="reports-panel">
            <div className="reports-panel-heading"><div><span className="reports-eyebrow">RESULTADOS SEPARADOS</span><h2>Capital e operação</h2></div><button className="reports-text-button" type="button" disabled={busy} onClick={() => void download("csv", "00_RESUMO.csv")}>Baixar resumo ⇩</button></div>
            <div className="reports-summaries">{summaries.length ? summaries.slice(summaryPage * 2, summaryPage * 2 + 2).map((row, index) => <SummaryCard key={`${text(row.environment)}-${text(row.asset)}-${index}`} row={row} />) : <Empty>Não há registros para os filtros escolhidos.</Empty>}</div>
            <Pager page={summaryPage} total={summaries.length} size={2} onChange={setSummaryPage} label="resultados" />
          </section>
          <section className="reports-panel reports-checks">
            <div className="reports-panel-heading"><div><span className="reports-eyebrow">EVIDÊNCIA, NÃO SUPOSIÇÃO</span><h2>Checks de auditoria</h2></div><select aria-label="Filtrar checks" value={checkStatus} onChange={(event) => { setCheckStatus(event.target.value); setCheckPage(0); }}><option value="ALL">Todos</option><option value="FAIL">Divergências</option><option value="WARNING">Atenção</option><option value="PASS">Conformes</option></select></div>
            <div className="reports-check-list">{shownChecks.length ? shownChecks.slice(checkPage * 5, checkPage * 5 + 5).map((check, index) => <article key={`${check.code}-${check.environment}-${check.asset}-${index}`}><div><span className="reports-check-status" data-status={check.status}>{statusLabels[check.status]}</span><small>{[check.environment, check.asset].filter(Boolean).join(" · ")}</small></div><p>{check.explanation}</p><code>{check.code}</code></article>) : <Empty>Nenhum check nesta seleção.</Empty>}</div>
            <Pager page={checkPage} total={shownChecks.length} size={5} onChange={setCheckPage} label="checks" /><button className="reports-text-button" type="button" disabled={busy} onClick={() => void download("csv", "12_CHECKS_AUDITORIA.csv")}>Exportar todos os checks ⇩</button>
          </section>
        </div> : null}
        <section className="reports-panel reports-export-panel">
          <div className="reports-panel-heading"><div><span className="reports-eyebrow">PACOTE PARA VOCÊ E PARA IA</span><h2>{view === "exports" ? "Arquivos e exportações" : "Exportação auditável"}</h2></div>{view !== "exports" ? <button className="reports-text-button" type="button" onClick={() => setView("exports")}>Ver arquivos individuais →</button> : null}</div>
          <div className="reports-export-options"><p><strong>ZIP completo</strong> · CSVs, resumo em português, JSON relacionado e manifesto. O pacote padrão inclui evidências de mercado ao redor dos gatilhos.</p><div className="reports-export-buttons">{downloadButton}<button type="button" className="reports-secondary" disabled={busy} onClick={() => void download("markdown", "RESUMO.md")}>Resumo legível</button><button type="button" className="reports-secondary" disabled={busy} onClick={() => void download("json", "AUDITORIA_COMPLETA.json")}>JSON para IA</button></div></div>
          {view === "exports" ? <>
            <div className="reports-environment-downloads"><span>Pacote separado:</span>{(["SHADOW", "TESTNET", "REAL"] as Environment[]).map((environment) => <button key={environment} type="button" className="reports-secondary" disabled={busy} onClick={() => void download("zip", undefined, environment)}>{environmentLabel(environment)} ⇩</button>)}</div>
            <div className="reports-file-grid">{files.map((file) => <article key={file.name}><div><strong>{file.name}</strong><p>{file.description || descriptions[file.name] || "Evidência do relatório"}</p><small>{file.rows !== undefined ? `${integer.format(file.rows)} linhas` : preview.rowCounts[file.name] !== undefined ? `${integer.format(preview.rowCounts[file.name])} linhas` : "Metadados e documentação"}</small></div><button type="button" aria-label={`Baixar ${file.name}`} title={`Baixar ${file.name}`} className="reports-file-download" disabled={busy} onClick={() => void download(file.name.endsWith(".csv") ? "csv" : file.name.endsWith(".md") ? "markdown" : "json", file.name)}>⇩</button></article>)}</div>
            <div className="reports-candles"><div><strong>Candles 1m completos</strong><p>Mercado Production usado pelo Shadow; estes candles não comprovam preços ou fills do Testnet. {candleParts.length > 1 ? `Todo o período está dividido em ${candleParts.length} partes de até ${CANDLE_EXPORT_MAX_DAYS} dias. Baixe cada parte desejada; nenhuma data foi removida.` : "Download separado de todos os candles persistidos no período selecionado."} Lacunas de coleta continuam explícitas.</p></div>{candleParts.length === 1 ? <button type="button" className="reports-secondary" disabled={busy} onClick={() => void download("candles")}>{downloading?.startsWith("candles-") ? "Preparando candles…" : "Exportar candles completos ⇩"}</button> : null}</div>
            {candleParts.length > 1 ? <><div className="reports-file-grid" aria-label="Partes do download de candles">{candleParts.slice(candlePage * 6, candlePage * 6 + 6).map((part) => <article key={part.start}><div><strong>Parte {part.number} de {candleParts.length}</strong><p>{dateLabel(part.start)} a {dateLabel(part.end)}</p><small>{part.days} {part.days === 1 ? "dia completo" : "dias completos"} · {filters.asset === "ALL" ? "BTC + SOL" : filters.asset} · CSV 1m</small></div><button type="button" className="reports-file-download" aria-label={`Baixar candles: parte ${part.number}, ${dateLabel(part.start)} a ${dateLabel(part.end)}`} title={`Baixar parte ${part.number}`} disabled={busy} onClick={() => void download("candles", undefined, undefined, part)}>{downloading === `candles-SHADOW:${part.start}_${part.end}` ? "…" : "⇩"}</button></article>)}</div><Pager page={candlePage} total={candleParts.length} size={6} onChange={setCandlePage} label="partes de candles" /></> : null}
          </> : null}
          <p className="reports-format-note">CSV para Excel brasileiro: UTF-8 com BOM e separador ponto e vírgula. Datas ISO; horário local America/Campo_Grande e UTC quando relevante. Secrets nunca integram os arquivos.</p>
        </section>
        <section className="reports-panel reports-history">
          <div className="reports-panel-heading"><div><h2>Downloads desta sessão</h2><p>Somente metadados. Nenhum conteúdo financeiro fica salvo no navegador.</p></div><Link className="reports-text-button" href="/plano-crescimento/relatorios">Relatórios históricos de ciclos →</Link></div>
          {downloads.length ? <div className="reports-history-list">{downloads.slice(0, 5).map((item, index) => <article key={`${item.generatedAt}-${index}`}><div><strong>{item.name}</strong><small>{environmentLabel(item.environment)} · {item.asset === "ALL" ? "BTC + SOL" : item.asset} · {dateLabel(item.start)} a {dateLabel(item.end)}</small></div><span>{sizeLabel(item.size)}<small>{instant(item.generatedAt)} · v{item.reportVersion}</small></span></article>)}</div> : <Empty>Os arquivos baixados nesta sessão aparecerão aqui, com período, ambiente e tamanho.</Empty>}
        </section>
      </> : null}
    </div>
  );
  return <MobileScreen desktop={<DesktopWorkspace title="Relatórios" subtitle="Evidências completas, resultados claros" userLabel={userLabel} actions={<Link href="/automacao">Automação →</Link>}>{content}</DesktopWorkspace>}><AppHeader title="Relatórios" action={<Link href="/automacao">Robô</Link>} />{content}</MobileScreen>;
}

function Kpi({ label, value, helper, tone }: { label: string; value: ReactNode; helper: string; tone?: string }) { return <article className="reports-kpi" data-tone={tone}><span>{label}</span><strong>{value}</strong><small>{helper}</small></article>; }
function SummaryCard({ row }: { row: Record<string, unknown> }) {
  const environment = text(row.environment, "—"); const symbol = text(row.symbol, text(row.asset, "—"));
  const currency = typeof row.quote_asset === "string" ? row.quote_asset : symbol.includes("BRL") ? "BRL" : symbol.includes("USDT") ? "USDT" : "USDC";
  const financial = (key: string) => numeric(row[key]) === null ? "Não disponível" : `${valueLabel(row[key])} ${currency}`;
  const metrics: Array<[string, ReactNode]> = [
    ["Capital livre", financial("free_capital")], ["Comprometido", financial("committed_capital")], ["Lucro realizado", financial("realized_pnl")], ["P&L aberto", financial("open_pnl")],
    ["Gains / operações", `${valueLabel(row.gains, true)} / ${valueLabel(row.operations, true)}`], ["Ciclos / slots", `${valueLabel(row.cycles, true)} / ${valueLabel(row.slots ?? row.slot_count, true)}`],
    ["Ordens abertas", valueLabel(row.orders_open, true)], ["Concluídas / canceladas", `${valueLabel(row.orders_filled, true)} / ${valueLabel(row.orders_cancelled, true)}`],
    ["Fills", valueLabel(row.fills, true)], ["Erros registrados", valueLabel(row.errors, true)],
    ...(environment === "TESTNET" ? [
      ["Missed históricos", valueLabel(row.historical_missed, true)], ["Missed após 4.1.0", valueLabel(row.missed_since_strategy, true)],
      ["Missed ativos / não resolvidos", `${valueLabel(row.active_missed, true)} / ${valueLabel(row.unresolved_missed, true)}`], ["Problemas atuais", valueLabel(row.active_errors, true)],
      ["OPEN / NEXT BUY", `${valueLabel(row.operational_open, true)} / ${valueLabel(row.operational_next_buy, true)}`],
      ["REENTRY WAITING / PLANNED", `${valueLabel(row.operational_reentry_waiting, true)} / ${valueLabel(row.operational_planned, true)}`],
      ["ACTIVE ERROR", valueLabel(row.operational_active_error, true)]
    ] as Array<[string, ReactNode]> : [])
  ];
  if (row.audit_window === "SINCE_STRATEGY_4_1") metrics.push(["Gains pelo TP / créditos observados", `${valueLabel(row.since_strategy_gains_by_fill, true)} / ${valueLabel(row.ledger_credits_observed_since_strategy, true)}`], ["Gains sem horário exato", valueLabel(row.since_strategy_gain_fill_unknown, true)]);
  return <article className="reports-summary-card" data-environment={environment}><header><div><strong>{symbol}</strong><span>{environmentLabel(environment)}</span></div><span className="reports-health">{text(row.health, "Saúde não determinada")}</span></header><div className="reports-capital"><div><span>Capital inicial</span><strong>{financial("capital_start")}</strong></div><span aria-hidden="true">→</span><div><span>Capital final</span><strong>{financial("capital_end")}</strong></div></div><dl className="reports-metrics">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><footer><span>Última execução <strong>{instant(row.last_execution)}</strong></span><span>Reconciliação <strong>{instant(row.last_reconciliation)}</strong></span></footer></article>;
}
function Pager({ page, total, size, onChange, label }: { page: number; total: number; size: number; onChange: (page: number) => void; label: string }) {
  if (total <= size) return null;
  return <nav className="reports-pager" aria-label={`Paginação de ${label}`}><span>{page * size + 1}–{Math.min((page + 1) * size, total)} de {total}</span><div><button type="button" disabled={page === 0} onClick={() => onChange(page - 1)} aria-label={`${label}: página anterior`}>Anterior</button><button type="button" disabled={(page + 1) * size >= total} onClick={() => onChange(page + 1)} aria-label={`${label}: próxima página`}>Próxima</button></div></nav>;
}
function Empty({ children }: { children: ReactNode }) { return <p className="reports-empty">{children}</p>; }

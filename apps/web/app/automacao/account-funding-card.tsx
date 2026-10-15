"use client";

import { useState } from "react";

import { fundingClientMessage, fundingResumeToleranceObservation, type FundingSummary } from "@/lib/execution/account-funding";
import { PremiumDrawer, displayMoney as money, displayNumber as number, displayTime as time } from "./premium-primitives";
import "./account-funding-card.css";

const statusText = (summary: FundingSummary) => summary.status === "INCOMPLETE" ? "VERIFICAÇÃO INCOMPLETA"
  : summary.status === "SHORTFALL" ? "FALTA SALDO SPOT" : "PRINCIPAL COBERTO";
const stale = (summary: FundingSummary, now: number) => summary.observedAt === null
  || !Number.isFinite(Date.parse(summary.observedAt)) || Date.parse(summary.observedAt) - now > 2_000
  || now - Date.parse(summary.observedAt) > 30_000;

export function AccountFundingCard({ accountName, summaries, loading, error, onRefresh, refreshAvailableAt, now }: {
  accountName: string; summaries: FundingSummary[] | null; loading: boolean; error: boolean;
  onRefresh: () => void; refreshAvailableAt: number; now: number;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed" | "expired" | null>(null);
  const cooldown = Math.max(0, Math.ceil((refreshAvailableAt - now) / 1_000));
  const known = summaries?.length ? summaries : null;
  const oldSnapshot = known?.some((summary) => stale(summary, now));
  const needsAttention = known?.some((summary) => summary.status !== "COVERED" || summary.bnbStatus !== "AVAILABLE");
  const copy = async () => {
    if (!known || oldSnapshot) return;
    if (known.some((summary) => stale(summary, Date.now()))) { setCopied("expired"); return; }
    try {
      await navigator.clipboard.writeText(known.map((summary) => fundingClientMessage(summary)).join("\n\n"));
      setCopied("copied");
    } catch { setCopied("failed"); }
  };
  return <section className={`px-panel px-funding${needsAttention ? " px-funding--attention" : ""}`}
    aria-label="Saldo da operação completa" data-testid="account-funding-card">
    <div className="px-funding-heading"><div><h2>Saldo da operação completa</h2>
      <small>{accountName} · todos os motores e mercados da conta</small></div>
      <button type="button" className="px-button" onClick={onRefresh} disabled={loading || cooldown > 0}
        title={cooldown > 0 ? `Nova consulta em ${cooldown}s` : "Consulta somente leitura; não altera ordens"}>
        {loading ? "Verificando saldo…" : "Verificar saldo da operação completa"}</button></div>
    {known ? <div className="px-funding-summary">{known.map((summary) => <div key={summary.currency}>
      <span className={`px-badge${!stale(summary, now) && summary.status === "COVERED" && summary.bnbStatus === "AVAILABLE" ? "" : " px-badge--warning"}`}>
        {summary.currency} · {stale(summary, now) ? "LEITURA ANTIGA / NÃO CONFIRMADA" : statusText(summary)}</span>
      <span>Spot livre <strong>{money(summary.spotFree, summary.currency)}</strong></span>
      <span>Necessário · slots + pendências <strong>{money(summary.cashRequired, summary.currency)}</strong></span>
      <span>Falta para a grade completa <strong>{money(summary.deficit, summary.currency)}</strong></span>
      <small>{summary.engineCount} motor(es) · {summary.slotCount} slots · leitura {time(summary.observedAt)}</small>
      {fundingResumeToleranceObservation(summary, now) ? <small>{fundingResumeToleranceObservation(summary, now)}</small> : null}
    </div>)}</div> : <p role="status">{loading ? "Consultando o saldo físico e o ledger da conta inteira…"
      : error ? "Não foi possível confirmar o saldo completo nesta consulta. Nenhum valor ausente foi tratado como zero."
        : "A consulta completa ainda não tem evidência disponível."}</p>}
    {known?.some((summary) => summary.bnbStatus === "LOW") ? <p className="px-warning" role="status">
      Reserva BNB Spot abaixo do guard atual. A reposição é feita pelo proprietário na Binance; não há compra automática.</p> : null}
    {oldSnapshot ? <p className="px-warning" role="status">Última leitura apresentada apenas como histórico. Atualize antes de informar um valor de reposição.</p> : null}
    <div className="px-funding-actions"><button type="button" className="px-button" onClick={() => { setCopied(null); setOpen(true); }}
      disabled={!known}>Ver detalhes e mensagem para o cliente</button>
      <small>{cooldown > 0 ? `Nova consulta disponível em ${cooldown}s. ` : ""}Somente principal · fees futuras não estimadas · não autoriza ordens.</small></div>
    <PremiumDrawer open={open} title={`${accountName} · saldo da operação completa`} onClose={() => setOpen(false)}>
      <div className="px-funding-details"><p>Leitura pontual e não atômica de Binance × ledger. Considera todos os motores da conta,
        inclusive em executores diferentes. Moedas permanecem separadas; saldo Earn não é caixa Spot.</p>
        {known?.map((summary) => <section key={summary.currency}>
          <h3>{summary.currency} · {stale(summary, now) ? "LEITURA ANTIGA / NÃO CONFIRMADA" : statusText(summary)}</h3>
          <small>{summary.engineCount} motor(es) · {summary.slotCount} slots · leitura {time(summary.observedAt)}</small>
          <dl>{[
            ["Alocação atual dos slots", money(summary.ledgerTarget, summary.currency)],
            ["Limite configurado", money(summary.configuredCap, summary.currency)],
            ["Posições já financiadas · custo de entrada", money(summary.positionCost, summary.currency)],
            ["BUY residentes já reservadas", money(summary.buyReserved, summary.currency)],
            ["Spot livre · contado uma vez", money(summary.spotFree, summary.currency)],
            ["Spot bloqueado · não é saldo livre", money(summary.spotLocked, summary.currency)],
            ["Caixa ainda necessário · slots + pendências", money(summary.cashRequired, summary.currency)],
            ["Falta para financiar a grade completa", money(summary.deficit, summary.currency)],
            ["Aportes pendentes · ainda não aplicados", money(summary.pending, summary.currency)],
            ["BNB livre Spot · guard, não estimativa de fees", summary.bnbFree === null ? "Sem confirmação" : `${number(summary.bnbFree, 8)} BNB`],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          {summary.status === "INCOMPLETE" ? <p className="px-warning">Evidência incompleta: não é possível afirmar cobertura nem déficit total.</p> : null}
          {summary.bnbStatus === "UNKNOWN" ? <p className="px-warning">Reserva BNB não confirmada nesta leitura.</p> : null}
          {summary.issues.length ? <details><summary>Evidências a verificar</summary><ul>{summary.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></details> : null}
          {fundingResumeToleranceObservation(summary, now) ? <p role="note">{fundingResumeToleranceObservation(summary, now)}</p> : null}
          <textarea readOnly aria-label={`Mensagem para o cliente ${summary.currency}`}
            value={`${stale(summary, now) ? "LEITURA ANTIGA / NÃO CONFIRMADA. Atualize antes de informar um valor de reposição.\n\n" : ""}${fundingClientMessage(summary, now)}`} />
        </section>)}
        <button type="button" className="px-button" onClick={() => void copy()} disabled={!known || oldSnapshot}>Copiar mensagem para o cliente</button>
        {copied ? <p role="status">{copied === "copied" ? "Mensagem copiada. Nenhuma mensagem foi enviada."
          : copied === "expired" ? "A leitura expirou. Atualize antes de copiar um valor de reposição."
            : "Não foi possível copiar automaticamente. Selecione o texto acima para copiar."}</p> : null}
        <p>Falta de saldo não cancela TP nem redimensiona a estratégia. A conta deve manter caixa Spot suficiente para as novas compras,
          sem contar venda futura, lucro não realizado ou o saldo externo bloqueado como disponível.</p>
      </div>
    </PremiumDrawer>
  </section>;
}

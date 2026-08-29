import Link from "next/link";

import type {
  BaselinePreview,
  BaselinePreviewAsset,
  BaselinePreviewSlot,
  OfficialMonitoringOverview
} from "@/lib/coinops-monitoring/server";
import { formatOptionalDecimal } from "@/lib/coinops-monitoring/baseline-preview-format";
import { formatUsdt } from "@/lib/slotgain/format";

import { activateOfficialMonitoring } from "./monitoring-actions";

const modeLabel = (mode?: string) => mode === "DEFENSIVE_POST_ATH" ? "Defensivo pós-ATH" : "Normal";

const formatOfficialDate = (value?: string) => {
  if (!value) return "no momento da ativação";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
};

const formatMoney = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? formatUsdt(number) : "—";
};

const previewErrorMessages: Record<string, string> = {
  NO_SLOTS: "Nenhum slot foi encontrado para o snapshot.",
  BTC_STRATEGY_COUNT_INVALID: "A configura\u00e7\u00e3o BTC est\u00e1 ausente ou duplicada.",
  SOL_STRATEGY_COUNT_INVALID: "A configura\u00e7\u00e3o SOL est\u00e1 ausente ou duplicada.",
  UNSUPPORTED_SLOT_ASSET: "Existe slot vinculado a um ativo n\u00e3o suportado.",
  INVALID_OPERATIONAL_VALUE: "Existe slot com saldo operacional inv\u00e1lido.",
  OPEN_SLOT_WITHOUT_VALID_ENTRY: "Existe slot aberto sem pre\u00e7o de entrada v\u00e1lido.",
  OPEN_SLOT_WITHOUT_CAPITAL: "Existe slot aberto sem capital operacional v\u00e1lido.",
  FUNDED_SLOT_WITHOUT_ECONOMIC_TRACE: "Existem slots financiados sem trilha econ\u00f4mica audit\u00e1vel no ledger ou na reconcilia\u00e7\u00e3o.",
  INVALID_SLOT_NUMBER: "Existe slot fora da faixa operacional de 1 a 50.",
  DUPLICATE_ASSET_SLOT_NUMBER: "Existe numera\u00e7\u00e3o de slot duplicada no mesmo ativo.",
  PREVIEW_UNAVAILABLE: "A pr\u00e9via detalhada ainda n\u00e3o est\u00e1 dispon\u00edvel.",
  PREVIEW_NOT_READY: "A pr\u00e9via ainda n\u00e3o passou por todas as valida\u00e7\u00f5es de integridade."
};

const previewErrorMessage = (code: string) =>
  previewErrorMessages[code] || `Pend\u00eancia t\u00e9cnica: ${code}`;

const previewSlots = (preview: BaselinePreview | null) => {
  if (!preview) return [];
  if (Array.isArray(preview.slots)) return preview.slots;
  return preview.slot_details || [];
};

const previewSlotCount = (preview: BaselinePreview | null) => {
  if (!preview) return null;
  if (preview.account) return preview.account.slots;
  return Array.isArray(preview.slots) ? preview.slots.length : preview.slots;
};

const previewAssets = (preview: BaselinePreview | null) => {
  if (!preview) return [];
  if (Array.isArray(preview.assets)) return preview.assets;
  return Object.entries(preview.assets).map(([asset, values]) => ({ asset, ...values })) as BaselinePreviewAsset[];
};

function DetailedBaselinePreview({ preview }: { preview: BaselinePreview }) {
  const account = preview.account;
  const assets = previewAssets(preview);
  const slots = previewSlots(preview);

  return (
    <details className="official-preview-details">
      <summary>Conferir regras e snapshot completo</summary>
      <div className="official-preview-content">
        <section aria-label="Regras oficiais">
          <h3>Estratégia inicial</h3>
          <ul>
            <li>Normal: BTC 2% · SOL 3%</li>
            <li>Meta por ciclo: BTC 7 · SOL 2</li>
            <li>Defensivo após novo ATH: BTC 5% · SOL 8%</li>
            <li>Retorno ao normal em 40% abaixo do pico defensivo</li>
            <li>Slots 1–25 principais; 26–50 reserva desabilitada</li>
          </ul>
        </section>

        {account ? (
          <section aria-label="Resumo da conta">
            <h3>Conta no corte</h3>
            <div className="official-preview-metrics">
              <span><small>Patrimônio</small><strong>{formatUsdt(account.patrimony)}</strong></span>
              <span><small>Saldo operacional</small><strong>{formatUsdt(account.operational_total)}</strong></span>
              <span><small>Lucro realizado</small><strong>{formatUsdt(account.realized_profit)}</strong></span>
              <span><small>PnL aberto</small><strong>{formatUsdt(account.open_pnl)}</strong></span>
              <span><small>Aportes</small><strong>{formatUsdt(account.external_contributions)}</strong></span>
              <span><small>Slots</small><strong>{account.open_slots} abertos · {account.free_slots} livres</strong></span>
              <span><small>Gains reais</small><strong>{formatOptionalDecimal(account.real_gains)}</strong></span>
              <span><small>Gains operacionais</small><strong>{formatOptionalDecimal(account.operational_gains)}</strong></span>
              <span><small>BTC</small><strong>{formatUsdt(account.prices?.BTC)}</strong></span>
              <span><small>SOL</small><strong>{formatUsdt(account.prices?.SOL)}</strong></span>
              <span><small>ATH BTC</small><strong>{formatUsdt(account.official_btc_ath)}</strong></span>
              <span><small>Modo</small><strong>{modeLabel(account.mode)}</strong></span>
            </div>
          </section>
        ) : null}

        {assets.length ? (
          <section aria-label="Resumo por ativo">
            <h3>Ativos preservados</h3>
            <div className="official-preview-assets">
              {assets.map((asset) => (
                <article key={asset.asset}>
                  <div><strong>{asset.asset}</strong><span>{formatUsdt(asset.operational_total)}</span></div>
                  <small>
                    {asset.open_slots ?? asset.open ?? 0} abertos · {asset.free_slots ?? asset.free ?? 0} livres · {formatOptionalDecimal(asset.operational_gains)} gains op.
                  </small>
                  <small>Lucro {formatMoney(asset.realized_profit)} · PnL {formatMoney(asset.open_pnl)} · aportes {formatMoney(asset.external_contributions)}</small>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {slots.length ? (
          <section aria-label="Snapshot dos slots">
            <h3>Slots preservados ({slots.length})</h3>
            <div className="official-preview-slots">
              {slots.map((slot: BaselinePreviewSlot) => (
                <article key={slot.id || slot.slot_id || `${slot.asset}-${slot.slot_number}`}>
                  <div>
                    <strong>{slot.asset} #{slot.slot_number}</strong>
                    <span>{slot.status}</span>
                    <b>{formatUsdt(slot.operational_value)}</b>
                  </div>
                  <small>
                    Op. {formatOptionalDecimal(slot.operational_gains)} · reais {formatOptionalDecimal(slot.real_gains)} · adicionados {formatOptionalDecimal(slot.added_gains)} · PnL {formatUsdt(slot.open_pnl)}
                  </small>
                  <small>
                    Entrada {formatOptionalDecimal(slot.entry)} · alvo {formatOptionalDecimal(slot.target)} · qtd. {formatOptionalDecimal(slot.quantity, 8)} · rank {slot.rank ?? "—"} · {slot.enabled ? "habilitado" : "desabilitado"} · {slot.pool}
                  </small>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {preview.ready === true ? (
          <p className="official-preview-integrity">
            Prévia íntegra vinculada ao estado atual. Se slots ou posições mudarem, a ativação será recusada e uma nova prévia será exigida.
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function OfficialMonitoringPanel({
  overview,
  preview,
  error
}: {
  overview: OfficialMonitoringOverview;
  preview: BaselinePreview | null;
  error: string | null;
}) {
  if (error) {
    return (
      <section className="official-monitoring-card official-monitoring-error">
        <strong>Monitoramento oficial</strong>
        <p>A prévia segura ainda não está disponível neste ambiente. Nenhuma ativação será permitida.</p>
      </section>
    );
  }

  if (!overview.active) {
    const account = preview?.account;
    const previewErrors = preview?.errors?.length
      ? preview.errors
      : preview?.ready === true
        ? []
        : [preview ? "PREVIEW_NOT_READY" : "PREVIEW_UNAVAILABLE"];
    const previewReady = preview?.ready === true && previewErrors.length === 0;
    const canActivate = Boolean(previewReady && preview?.ok && account && preview?.state_hash && !preview?.already_active);

    return (
      <section className="official-monitoring-card" aria-labelledby="official-monitoring-title">
        <div className="official-monitoring-heading">
          <div><small>Nova fase</small><h2 id="official-monitoring-title">Monitoramento oficial</h2></div>
          <span className={`official-mode ${previewReady ? "normal" : "defensive"}`}>
            {previewReady ? "Pronto para ativar" : "Revisão necessária"}
          </span>
        </div>
        <p>
          O passado será preservado como legado. O snapshot iniciará somente os deltas futuros em {formatOfficialDate(preview?.official_date)}.
        </p>
        <div className="official-baseline-grid">
          <span><small>Slots preservados</small><strong>{previewSlotCount(preview) ?? "—"}</strong></span>
          <span><small>Abertos agora</small><strong>{account?.open_slots ?? preview?.open_slots ?? "—"}</strong></span>
          <span><small>Patrimônio no corte</small><strong>{account ? formatUsdt(account.patrimony) : "—"}</strong></span>
          <span><small>Timezone</small><strong>{preview?.timezone || "America/Campo_Grande"}</strong></span>
        </div>
        {!previewReady ? (
          <div className="official-preview-details" role="alert" aria-labelledby="official-preview-gate-title">
            <div className="official-preview-content">
              <section>
                <h3 id="official-preview-gate-title">Ativação bloqueada</h3>
                <p>A prévia não está pronta. Corrija as pendências abaixo e gere uma nova conferência antes de ativar.</p>
                <ul>
                  {previewErrors.map((code) => <li key={code}>{previewErrorMessage(code)}</li>)}
                </ul>
              </section>
            </div>
          </div>
        ) : (
          <p className="official-preview-integrity" role="status">Prévia reconciliada e pronta para ativação.</p>
        )}
        {preview ? <DetailedBaselinePreview preview={preview} /> : null}
        <form action={activateOfficialMonitoring}>
          <button
            className="official-primary-action"
            type="submit"
            disabled={!canActivate}
            aria-describedby={!previewReady ? "official-preview-gate-title" : undefined}
          >
            Ativar baseline oficial
          </button>
        </form>
      </section>
    );
  }

  const btc = overview.assets?.BTC;
  const sol = overview.assets?.SOL;

  return (
    <section className="official-monitoring-card" aria-labelledby="official-monitoring-title">
      <div className="official-monitoring-heading">
        <div><small>Desde {formatOfficialDate(overview.baseline?.official_date)}</small><h2 id="official-monitoring-title">Monitoramento oficial</h2></div>
        <span className={`official-mode ${overview.strategy?.mode === "DEFENSIVE_POST_ATH" ? "defensive" : "normal"}`}>
          {modeLabel(overview.strategy?.mode)}
        </span>
      </div>
      <div className="official-baseline-grid">
        <span><small>Estratégia</small><strong>v{overview.strategy?.version}</strong></span>
        <span><small>Ciclo atual</small><strong>#{overview.cycle?.number}</strong></span>
        <span><small>Dias restantes</small><strong>{overview.cycle?.days_remaining ?? "—"}</strong></span>
        <span><small>Período</small><strong>30 dias</strong></span>
      </div>
      <div className="official-next-slots">
        <article><div><strong>BTC</strong><small>{overview.strategy?.btc_spacing}% · meta {btc?.target ?? "pausada"}</small></div><span>{btc?.below_target ?? 0} abaixo</span><b>Próximo #{btc?.next_slot?.slot_number ?? "—"}</b></article>
        <article><div><strong>SOL</strong><small>{overview.strategy?.sol_spacing}% · meta {sol?.target ?? "pausada"}</small></div><span>{sol?.below_target ?? 0} abaixo</span><b>Próximo #{sol?.next_slot?.slot_number ?? "—"}</b></article>
      </div>
      <div className="official-monitoring-links">
        <Link href="/plano-crescimento/baseline">Ver baseline</Link>
        <Link href="/plano-crescimento/relatorios">Ver relatórios</Link>
        <Link href="/plano-crescimento/regras">Ver regras atuais</Link>
      </div>
    </section>
  );
}

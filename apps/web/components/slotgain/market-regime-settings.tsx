"use client";

import { useMemo, useState, useTransition } from "react";

import { saveMarketRegimeConfiguration } from "@/app/dashboard/actions";
import { DEFAULT_ASSET_MARKET_SETTINGS, DEFAULT_MARKET_REGIME_SETTINGS, MARKET_REGIME_LABELS, activeBuyDropPercent, asMarketRegime, effectiveMarketRegime, operatingPlan, type AssetMarketStrategySettings, type BtcMarketState, type MarketRegimeSettings } from "@/lib/slotgain/market-regime";
import { formatPercent, formatPrice } from "@/lib/slotgain/format";

type Props = {
  marketState: Partial<BtcMarketState> | null;
  regimeSettings: Partial<MarketRegimeSettings> | null;
  assetSettings: Partial<AssetMarketStrategySettings>[];
  editable?: boolean;
};

function parseDecimal(value: string, fallback: number) {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assetConfig(asset: "BTC" | "SOL", rows: Partial<AssetMarketStrategySettings>[]) {
  return { ...DEFAULT_ASSET_MARKET_SETTINGS[asset], ...(rows.find((row) => row.asset === asset) || {}) };
}

function inputValue(value: number) {
  return String(value).replace(".", ",");
}

export function MarketRegimeSettings({ marketState, regimeSettings, assetSettings, editable = false }: Props) {
  const initialRegime = { ...DEFAULT_MARKET_REGIME_SETTINGS, ...regimeSettings, manual_mode: asMarketRegime(regimeSettings?.manual_mode) };
  const [topThreshold, setTopThreshold] = useState(inputValue(Number(initialRegime.top_threshold_percent)));
  const [deepThreshold, setDeepThreshold] = useState(inputValue(Number(initialRegime.deep_threshold_percent)));
  const [hysteresis, setHysteresis] = useState(inputValue(Number(initialRegime.hysteresis_percent)));
  const [modeSource, setModeSource] = useState(initialRegime.mode_source);
  const [manualMode, setManualMode] = useState(asMarketRegime(initialRegime.manual_mode) || "NORMAL");
  const [manualReason, setManualReason] = useState(initialRegime.manual_reason || "");
  const [btc, setBtc] = useState(assetConfig("BTC", assetSettings));
  const [sol, setSol] = useState(assetConfig("SOL", assetSettings));
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();
  const calculated = asMarketRegime(marketState?.calculated_mode) || "NORMAL";
  const automatic = asMarketRegime(regimeSettings?.last_effective_mode) || asMarketRegime(marketState?.effective_mode) || calculated;
  const effective = modeSource === "MANUAL" ? manualMode : automatic;
  const distance = Number(marketState?.distance_from_ath_percent || 0);

  const previewState = useMemo(() => ({
    regime: { top: parseDecimal(topThreshold, 5), deep: parseDecimal(deepThreshold, 30), hysteresis: parseDecimal(hysteresis, 0.5) },
    BTC: { before: assetConfig("BTC", assetSettings), after: btc },
    SOL: { before: assetConfig("SOL", assetSettings), after: sol }
  }), [assetSettings, btc, deepThreshold, hysteresis, sol, topThreshold]);

  function updateDrop(asset: "BTC" | "SOL", mode: "TOP" | "NORMAL" | "DEEP", value: string) {
    const key = mode === "TOP" ? "buy_drop_top_percent" : mode === "DEEP" ? "buy_drop_deep_percent" : "buy_drop_normal_percent";
    const update = (current: AssetMarketStrategySettings) => ({ ...current, [key]: parseDecimal(value, Number(current[key])) });
    asset === "BTC" ? setBtc(update) : setSol(update);
  }

  function save() {
    startTransition(async () => {
      try {
        const result = await saveMarketRegimeConfiguration({
          regime: {
            top_threshold_percent: parseDecimal(topThreshold, 5),
            deep_threshold_percent: parseDecimal(deepThreshold, 30),
            hysteresis_percent: parseDecimal(hysteresis, 0.5),
            mode_source: modeSource,
            manual_mode: modeSource === "MANUAL" ? manualMode : null,
            manual_reason: manualReason
          },
          assets: [btc, sol]
        });
        setNotice(`Configuracao salva. Modo em uso: ${MARKET_REGIME_LABELS[result.effectiveMode]}. Os slots abertos permanecem inalterados.`);
        setPreview(false);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Nao foi possivel salvar a configuracao.");
      }
    });
  }

  const planBtc = operatingPlan("BTC", effective, btc);
  const planSol = operatingPlan("SOL", effective, sol);

  return (
    <section className="section-card market-regime-card">
      <div className="redistribution-heading">
        <div>
          <p>REGIME DO BTC</p>
          <h2>{MARKET_REGIME_LABELS[effective]}</h2>
          <small>Classificacao pelo fechamento diario do BTCUSDT; BTC e SOL usam o mesmo modo.</small>
        </div>
        <strong>{modeSource === "MANUAL" ? "Manual" : "Automatico"}</strong>
      </div>
      <div className="redistribution-metrics">
        <span>ATH historico<strong>{formatPrice(Number(marketState?.ath_price || 0))}</strong></span>
        <span>Preco atual<strong>{formatPrice(Number(marketState?.current_price || 0))}</strong></span>
        <span>Distancia do ATH<strong>{formatPercent(distance / 100)}%</strong></span>
        <span>Modo calculado<strong>{MARKET_REGIME_LABELS[calculated]}</strong></span>
        <span>Modo em uso<strong>{MARKET_REGIME_LABELS[effective]}</strong></span>
        <div className="market-source-detail">
          <span>Fonte</span>
          <details>
            <summary title={marketState?.source || "Aguardando cron"}>{marketState?.source || "Aguardando cron"}</summary>
            <p>{marketState?.source || "Aguardando cron"}</p>
          </details>
        </div>
      </div>
      <div className="settings-list modern-settings">
        <div><span>BTC</span><strong>Reserva: {planBtc.zeroReserveCount} zerados · Nova compra: {activeBuyDropPercent("BTC", effective, btc)}%</strong></div>
        <div><span>SOL</span><strong>Reserva: {planSol.zeroReserveCount} zerados · Nova compra: {activeBuyDropPercent("SOL", effective, sol)}%</strong></div>
      </div>

      {editable ? (
        <div className="tool-form stacked-form market-regime-editor">
          <label>Limite de TOPO (%)<input value={topThreshold} inputMode="decimal" onChange={(event) => setTopThreshold(event.target.value)} /></label>
          <label>Limite de FUNDO FORTE (%)<input value={deepThreshold} inputMode="decimal" onChange={(event) => setDeepThreshold(event.target.value)} /></label>
          <label>Histerese (%)<input value={hysteresis} inputMode="decimal" onChange={(event) => setHysteresis(event.target.value)} /></label>
          <label>Modo do mercado<select value={modeSource} onChange={(event) => setModeSource(event.target.value === "MANUAL" ? "MANUAL" : "AUTO")}><option value="AUTO">Automatico pelo ATH do BTC</option><option value="MANUAL">Manual</option></select></label>
          {modeSource === "MANUAL" ? <><label>Modo manual<select value={manualMode} onChange={(event) => setManualMode(event.target.value as "TOP" | "NORMAL" | "DEEP")}><option value="TOP">TOPO</option><option value="NORMAL">MEIO / NORMAL</option><option value="DEEP">FUNDO FORTE</option></select></label><label>Motivo opcional<input value={manualReason} onChange={(event) => setManualReason(event.target.value)} /></label></> : null}
          <AssetInputs asset="BTC" value={btc} onChange={updateDrop} />
          <AssetInputs asset="SOL" value={sol} onChange={updateDrop} />
          {notice ? <p className="inline-alert">{notice}</p> : null}
          {preview ? <div className="redistribution-preservation"><strong>Previa:</strong> BTC — TOPO {previewState.BTC.before.buy_drop_top_percent}% → {previewState.BTC.after.buy_drop_top_percent}%; NORMAL {previewState.BTC.before.buy_drop_normal_percent}% → {previewState.BTC.after.buy_drop_normal_percent}%. SOL — TOPO {previewState.SOL.before.buy_drop_top_percent}% → {previewState.SOL.after.buy_drop_top_percent}%. Proximas compras ainda nao executadas usarao os valores novos; slots abertos e alvos existentes nao mudam.</div> : null}
          <div className="slot-card-actions"><button type="button" className="ghost-button" onClick={() => setPreview(true)} disabled={saving}>Gerar previa</button>{preview ? <button type="button" className="solid-button" onClick={save} disabled={saving}>{saving ? "Salvando..." : "Confirmar configuracao"}</button> : null}</div>
        </div>
      ) : null}
    </section>
  );
}

function AssetInputs({ asset, value, onChange }: { asset: "BTC" | "SOL"; value: AssetMarketStrategySettings; onChange: (asset: "BTC" | "SOL", mode: "TOP" | "NORMAL" | "DEEP", value: string) => void }) {
  return <fieldset className="mini-drawer"><legend>{asset} — nova compra</legend><label>TOPO<input value={inputValue(value.buy_drop_top_percent)} inputMode="decimal" onChange={(event) => onChange(asset, "TOP", event.target.value)} /></label><label>NORMAL<input value={inputValue(value.buy_drop_normal_percent)} inputMode="decimal" onChange={(event) => onChange(asset, "NORMAL", event.target.value)} /></label><label>FUNDO FORTE<input value={inputValue(value.buy_drop_deep_percent)} inputMode="decimal" onChange={(event) => onChange(asset, "DEEP", event.target.value)} /></label></fieldset>;
}

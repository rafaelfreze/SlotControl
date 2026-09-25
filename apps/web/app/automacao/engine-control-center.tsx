"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Account = { id: string; display_name: string; status: string; kill_switch: boolean;
  is_legacy_default: boolean; credentialValidated: boolean; environment: "REAL" | "TESTNET" | null };
type Engine = { id: string; exchange_account_id: string; symbol: string; quote_asset: string;
  environment: "REAL" | "TESTNET"; status: string; kill_switch: boolean; hard_cap_quote: number | string;
  operational: boolean; ready: boolean; evidence: { physicalSlots: number; open: number;
    residentTp: number; nextBuy: number; recent: boolean; clean: boolean };
  run: { id: string; status: string; last_error: string | null; last_reconciled_at: string | null } | null;
  profile: { gain_rate: number | string; normal_spacing_rate: number | string;
    post_ath_spacing_rate: number | string; config_version: number } | null };
type EnginePreview = { symbol: string; asset: "BTC" | "SOL"; capital: number;
  allocation: number[]; gain: number; spacing: number; postAth: number;
  monthlyTarget: number; currentPrice: number; minNotional: number; minQuantity: number;
  quantityStep: number; priceTick: number; recommendedPerSlot: number;
  minimumCapital: number; validSlots: number; firstEntry: number | null;
  firstTp: number | null; nextBuy: number | null; planned: number; strategyVersion: string };
type Preview = { account: string; quote: string; capital: number; free: number;
  outsideCoinOps: number; observedAt: string; executorIp: string;
  engines: EnginePreview[]; status: "PREVIEW_NO_WRITE" | "NOT_EXECUTABLE" };
type MarketAsset = "BTC" | "SOL";
type Rules = Record<MarketAsset, { gainPercent: string; spacingPercent: string;
  postAthPercent: string; capital: string }>;

const defaultRules: Rules = {
  BTC: { gainPercent: "1.2", spacingPercent: "2", postAthPercent: "5", capital: "" },
  SOL: { gainPercent: "5.5", spacingPercent: "3", postAthPercent: "8", capital: "" },
};
const api = "/api/coinops-engine-control";
const decimal = (value: string) => value.trim().replace(",", ".");
const money = (value: number | string, quote: string) =>
  `${Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${quote}`;
const price = (value: number | null | undefined, quote: string) => value == null ? "—"
  : `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: quote === "BRL" ? 2 : 5 })} ${quote}`;

function split(total: string, assets: MarketAsset[]) {
  const amount = Number(decimal(total));
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7)
    return null;
  const cents = Math.round(amount * 100), base = Math.floor(cents / assets.length), rest = cents % assets.length;
  return Object.fromEntries(assets.map((asset, index) =>
    [asset, ((base + (index < rest ? 1 : 0)) / 100).toFixed(2)])) as Record<MarketAsset, string>;
}

export function EngineControlCenter({ initialAccountId, environment, onEditEngine, onOpenCredentials }: {
  initialAccountId: string; environment: "REAL" | "TESTNET"; onEditEngine: (accountId: string, symbol: string) => void;
  onOpenCredentials: () => void }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [accountId, setAccountId] = useState(initialAccountId === "ALL" ? "" : initialAccountId);
  const [quote, setQuote] = useState<"BRL" | "USDT" | "USDC">("USDT");
  const [assets, setAssets] = useState<MarketAsset[]>(["BTC", "SOL"]);
  const [capital, setCapital] = useState("");
  const [equal, setEqual] = useState(true);
  const [rules, setRules] = useState<Rules>(defaultRules);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const account = accounts.find((item) => item.id === accountId);
  const testnet = account?.environment === "TESTNET";
  const accountEngines = engines.filter((item) => item.exchange_account_id === accountId);
  const plannedSplit = useMemo(() => equal && capital ? split(capital, assets) : null,
    [equal, capital, assets]);
  const refresh = useCallback(async () => {
    const response = await fetch(api, { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "COINOPS_ENGINE_STATUS_UNAVAILABLE");
    setAccounts((payload.accounts ?? []).filter((item: Account) => item.environment === environment));
    setEngines((payload.engines ?? []).filter((item: Engine) => item.environment === environment));
  }, [environment]);
  useEffect(() => { void refresh().catch(() => setMessage("Estado dos motores indisponível.")); }, [refresh]);
  function invalidate() { setPreview(null); setRequestId(crypto.randomUUID()); }
  function updateRule(asset: MarketAsset, field: keyof Rules[MarketAsset], value: string) {
    setRules((current) => ({ ...current, [asset]: { ...current[asset], [field]: value } }));
    invalidate();
  }
  function planInput(action: string) {
    return { action, accountId, requestId, quote, capital: decimal(capital),
      engines: assets.map((asset) => ({ asset,
        capital: decimal(equal ? plannedSplit?.[asset] ?? "" : rules[asset].capital),
        gainPercent: decimal(rules[asset].gainPercent),
        spacingPercent: decimal(rules[asset].spacingPercent),
        postAthPercent: decimal(rules[asset].postAthPercent) })) };
  }
  async function send(body: Record<string, unknown>) {
    const response = await fetch(api, { method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-coinops-admin-intent": "engine-control" },
      body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "COINOPS_ENGINE_CONTROL_FAILED");
    return payload;
  }
  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await work(); } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ação não concluída. Verifique o estado antes de repetir.");
      await refresh().catch(() => {});
    } finally { setBusy(false); }
  }
  async function doPreview() {
    await action(async () => {
      const result = await send(planInput("PREVIEW")) as Preview;
      setPreview(result);
      setMessage(result.status === "PREVIEW_NO_WRITE"
        ? "Preview validado com GET Binance. Nenhuma ordem foi enviada."
        : "Um ou mais slots não são executáveis com o capital informado.");
    });
  }
  async function provision() {
    if (!preview || preview.status !== "PREVIEW_NO_WRITE") return;
    await action(async () => {
      const result = await send(planInput("PROVISION"));
      setMessage(`${result.engines.length} motor(es) preparado(s) em modo INACTIVE. Nenhuma ordem foi enviada.`);
      setPreview(null); await refresh(); router.refresh();
    });
  }
  async function control(engine: Engine, operation: "PREPARE" | "ACTIVATE" | "RECOVER" | "PAUSE" | "RESUME") {
    const accountName = account?.display_name ?? "Conta";
    if (operation === "ACTIVATE" && !window.confirm(
      `Iniciar operações ${engine.environment === "TESTNET" ? "FICTÍCIAS Testnet" : "REAIS"} em ${accountName} / ${engine.symbol} com limite máximo de ${money(engine.hard_cap_quote, engine.quote_asset)}?\n\nA primeira MARKET, TP e próxima BUY serão executadas somente após os gates de Binance e ledger.`)) return;
    if (operation === "PAUSE" && !window.confirm(engine.environment === "TESTNET"
      ? `Pausar ${accountName} / ${engine.symbol} no Testnet? As ordens fictícias próprias, inclusive TPs, serão canceladas com auditoria. As posições permanecem no ledger e os TPs serão restaurados antes de novas entradas ao retomar.`
      : `Pausar ${accountName} / ${engine.symbol}? A próxima BUY própria será cancelada; TPs e posições ficam protegidos.`)) return;
    await action(async () => {
      const result = await send({ action: operation, accountId, engineId: engine.id });
      setMessage(`${engine.symbol}: ${result.status}. ${operation === "ACTIVATE" ? "O worker server-side conclui e reconcilia as ordens; confira o estado atualizado." : ""}`);
      await refresh(); router.refresh();
    });
  }
  const newAccount = account && !account.is_legacy_default && account.status === "INACTIVE"
    && account.credentialValidated && accountEngines.length === 0;
  return <section className="px-engine-center" aria-label="Central de estratégia e motores">
    <header className="px-engine-center-head"><div><span className="px-eyebrow">CONFIGURAÇÃO OPERACIONAL · {testnet ? "TESTNET" : "REAL"}</span>
      <h2>Estratégia e motores</h2><p>Conta e moeda explícitas. O preview consulta a Binance, não envia ordens.
      Cada motor tem seu cap, 25 slots e ciclo próprio.</p></div>
      <button type="button" className="px-button" onClick={onOpenCredentials}>Contas Binance →</button></header>
    <div className="px-engine-account-picker"><label>Conta Binance<select aria-label="Conta Binance para motores"
      value={accountId} onChange={(event) => { setAccountId(event.target.value);
        setQuote(accounts.find((item) => item.id === event.target.value)?.environment === "TESTNET" ? "USDT" : "BRL"); invalidate(); }}>
      <option value="">Selecione uma conta</option>{accounts.map((item) =>
        <option key={item.id} value={item.id}>{item.display_name} · {item.status}</option>)}</select></label>
      {account ? <span className={`px-badge ${account.status === "ACTIVE" ? "" : "px-badge--warning"}`}>
        {account.status} · {account.environment ?? "ambiente a validar"} · {account.credentialValidated ? "API validada" : "API a validar"}</span> : null}</div>
    {account && accountEngines.length > 0 ? <div className="px-engine-list"><h3>Motores da conta</h3>
      {accountEngines.map((engine) => <article className="px-engine-row" key={engine.id}>
        <div><strong>{engine.symbol}</strong><small>{money(engine.hard_cap_quote, engine.quote_asset)} cap · 25 slots
          {engine.profile ? ` · gain ${(Number(engine.profile.gain_rate) * 100).toLocaleString("pt-BR")}% · spacing ${(Number(engine.profile.normal_spacing_rate) * 100).toLocaleString("pt-BR")}%` : ""}</small>
          <small>Ciclo: {engine.run?.status ?? "não iniciado"} · Última reconciliação: {engine.run?.last_reconciled_at ?? "—"}</small>
          {engine.run ? <small>Slots {engine.evidence.physicalSlots}/25 · OPEN {engine.evidence.open} ·
            TP {engine.evidence.residentTp} · próxima BUY {engine.evidence.nextBuy}</small> : null}
          {engine.run?.last_error ? <small className="px-warning">Erro: {engine.run.last_error}</small> : null}</div>
        <span className={`px-badge ${engine.status === "ACTIVE" && (!engine.operational || !engine.run) ? "px-badge--warning" : ""}`}>
          {engine.run?.status === "PAUSED" ? "PAUSADO" : engine.run?.status === "ACTIVE"
            ? engine.operational ? "OPERANDO" : "ATIVO · VERIFICAR"
            : engine.environment === "TESTNET" && engine.status === "ACTIVE" && engine.kill_switch && !engine.run
              ? "BLOQUEADO · SEM CICLO"
            : engine.ready ? "READY" : engine.run?.status === "PREPARING" ? "PREPARANDO · VERIFICAR" : "INACTIVE"}</span>
        <div className="px-engine-actions">
          <button type="button" className="px-button" onClick={() => onEditEngine(accountId, engine.symbol)}>Editar regras</button>
          {engine.status === "INACTIVE" && !engine.run && !engine.ready ? <button type="button" className="px-button"
            disabled={busy || !account.credentialValidated} onClick={() => void control(engine, "PREPARE")}>{engine.environment === "TESTNET" ? "Validar para READY" : "Preparar 25 slots"}</button> : null}
          {engine.ready ? <button type="button" className="px-button px-button-primary"
            disabled={busy || !engine.ready} onClick={() => void control(engine, "ACTIVATE")}>Ativar {engine.symbol}</button> : null}
          {engine.environment === "TESTNET" && engine.status === "ACTIVE" && engine.kill_switch && !engine.run
            ? <button type="button" className="px-button" disabled={busy}
              onClick={() => void control(engine, "RECOVER")}>Recuperar READY</button> : null}
          {engine.run?.status === "ACTIVE" ? <button type="button" className="px-button"
            disabled={busy} onClick={() => void control(engine, "PAUSE")}>Pausar</button> : null}
          {engine.run?.status === "PAUSED" || engine.environment === "REAL" && engine.run?.status === "ACTIVE" && engine.kill_switch ? <button type="button" className="px-button px-button-primary"
            disabled={busy} onClick={() => void control(engine, "RESUME")}>Retomar</button> : null}
        </div></article>)}
      {account.environment === "REAL" && account.status === "INACTIVE" && accountEngines.some((engine) => engine.status === "INACTIVE")
        ? <button type="button" className="px-text-button" disabled={busy}
          onClick={() => void action(async () => { await send({ action: "SYNC", accountId });
            setMessage("Registro INACTIVE sincronizado no executor; nenhuma ordem enviada."); await refresh(); })}>
          Sincronizar configuração INACTIVE com executor</button> : null}
    </div> : null}
    {newAccount ? <div className="px-engine-builder"><h3>Adicionar motores · {account.display_name}</h3>
      <p>O capital é autorização, não saldo consumido. Escolha uma moeda suportada pela Binance {testnet ? "Testnet" : "Production"}; moedas não são convertidas nem somadas.
        O saldo excedente permanece fora do CoinOps.</p>
      <div className="px-engine-form-grid"><label>Moeda de cotação<select value={quote} onChange={(event) => { setQuote(event.target.value as "BRL" | "USDT" | "USDC"); invalidate(); }}>
        {testnet ? <option value="USDC">USDC</option> : <option value="BRL">BRL</option>}<option value="USDT">USDT</option></select></label>
        <label>Capital total autorizado<input type="text" inputMode="decimal" value={capital}
          onChange={(event) => { setCapital(event.target.value); invalidate(); }} placeholder="Ex.: 838,00" /></label></div>
      <div className="px-engine-market-select" aria-label="Mercados"><span>Mercados</span>
        {(["BTC", "SOL"] as const).map((asset) => <label key={asset}><input type="checkbox"
          checked={assets.includes(asset)} onChange={() => {
            setAssets((current) => current.includes(asset) ? current.length > 1
              ? current.filter((item) => item !== asset) : current : [...current, asset].sort()); invalidate();
          }} />{asset}/{quote}</label>)}</div>
      <label className="px-engine-equal"><input type="checkbox" checked={equal}
        onChange={(event) => { setEqual(event.target.checked); invalidate(); }} />
        Distribuir igualmente entre os motores e os 25 slots de cada um</label>
      <div className="px-engine-rules">{assets.map((asset) => <fieldset key={asset}>
        <legend>{asset}/{quote} · PERFIL GERAL</legend>
        <label>Capital do motor<input type="text" inputMode="decimal" disabled={equal}
          value={equal ? plannedSplit?.[asset] ?? "" : rules[asset].capital}
          onChange={(event) => updateRule(asset, "capital", event.target.value)} /></label>
        <label>Gain %<input type="text" inputMode="decimal" value={rules[asset].gainPercent}
          onChange={(event) => updateRule(asset, "gainPercent", event.target.value)} /></label>
        <label>Queda normal %<input type="text" inputMode="decimal" value={rules[asset].spacingPercent}
          onChange={(event) => updateRule(asset, "spacingPercent", event.target.value)} /></label>
        <label>Queda pós-ATH %<input type="text" inputMode="decimal" value={rules[asset].postAthPercent}
          onChange={(event) => updateRule(asset, "postAthPercent", event.target.value)} /></label>
        <small>Meta: {asset === "BTC" ? 7 : 2}/slot/mês · Compounding ON · Single Active Entry ON · Top 15/Reserve</small>
      </fieldset>)}</div>
      <div className="px-engine-actions"><button type="button" className="px-button" disabled={busy || !capital}
        onClick={() => void doPreview()}>Pré-visualizar · sem ordens</button>
        {preview?.status === "PREVIEW_NO_WRITE" ? <button type="button" className="px-button px-button-primary"
          disabled={busy} onClick={() => void provision()}>Salvar motores INACTIVE</button> : null}</div>
    </div> : account && !account.credentialValidated && !account.is_legacy_default
      ? <p role="status">Valide a credencial em Configurações → Contas Binance antes de preparar motores.</p> : null}
    {preview ? <section className="px-engine-preview" aria-label="Preview dos motores"><h3>Preview · {preview.account}</h3>
      <p>Binance GET {preview.observedAt} · IPv4 {preview.executorIp} · livre {money(preview.free, preview.quote)} ·
        capital {money(preview.capital, preview.quote)} · fora do CoinOps {money(preview.outsideCoinOps, preview.quote)}.</p>
      {preview.engines.map((engine) => <article key={engine.symbol}><h4>{engine.symbol}</h4>
        <p>Capital {money(engine.capital, preview.quote)} · 25 slots ·
          {money(engine.allocation[0], preview.quote)}/slot{new Set(engine.allocation).size > 1 ? " (sobra de centavos distribuída)" : ""} ·
          {engine.validSlots === 25 ? "OK" : `Valor insuficiente: mínimo estimado ${money(engine.minimumCapital, preview.quote)} para 25 slots.`}</p>
        <p>Cotação {price(engine.currentPrice, preview.quote)} · minNotional {engine.minNotional} · minQty {engine.minQuantity} · step {engine.quantityStep} · tick {engine.priceTick}</p>
        <p>Slot #1 MARKET estimada {price(engine.firstEntry, preview.quote)} → TP {price(engine.firstTp, preview.quote)} ·
          Slot #2 próxima BUY {price(engine.nextBuy, preview.quote)} · Slots #3–25 PLANNED.</p>
        <p>Gain {(engine.gain * 100).toLocaleString("pt-BR")}% · spacing {(engine.spacing * 100).toLocaleString("pt-BR")}% ·
          pós-ATH {(engine.postAth * 100).toLocaleString("pt-BR")}% · meta {engine.monthlyTarget}/slot/mês · compounding ON.</p>
      </article>)}<small>Estimativas não são ordens. Os filtros, saldos e caps são verificados novamente antes da ativação.</small>
    </section> : null}
    {message ? <p role="status" className="px-engine-message">{message}</p> : null}
    <p className="px-caption">Pausar bloqueia novas entradas; no Testnet, ordens próprias são canceladas de forma auditável e TPs são restaurados ao retomar. Retomar exige reconciliação recente;
      configurar perfil existente vale para o próximo ciclo e não reprifica posições OPEN.</p>
  </section>;
}

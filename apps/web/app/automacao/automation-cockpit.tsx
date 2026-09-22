"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { reconcileV1PhysicalSlotAccounts } from "@/lib/execution/robot-v1-audit";
import { COINOPS_TIME_ZONE } from "@/lib/slotgain/format";

import { AutomationDetails, EnvironmentTabs, type AutomationDetail, type AutomationView } from "./automation-center";
import { CandleChart, type Props } from "./automation-mobile";

type Asset = "BTC" | "SOL";
type OpenDetail = (section: AutomationDetail, title: string) => void;
const activeCycles = new Set(["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]);
const openSlots = new Set(["TP_ACTIVE", "OPEN", "PARTIALLY_FILLED"]);
const openOrders = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
const number = (value: number | string | null | undefined, digits = 2) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("pt-BR", { maximumFractionDigits: digits });
const money = (value: number) => `${number(value, 4)} USDC`;
const at = (value?: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: COINOPS_TIME_ZONE }).format(new Date(value)) : "Aguardando";

export type AutomationStatus = { shadowActive: boolean; testnetOperating: boolean; testnetError: boolean };

export function AutomationStatusStrip({ status }: { status: AutomationStatus }) {
  return <div className="cp-status-strip" aria-label="Estado dos ambientes">
    <span className={status.shadowActive ? "cp-green" : "cp-muted"}><i />SHADOW {status.shadowActive ? "ATIVO" : "PAUSADO"}</span>
    <span className={status.testnetError ? "cp-red" : "cp-purple"}><i />TESTNET {status.testnetError ? "ERRO" : status.testnetOperating ? "OPERANDO" : "EM ESPERA"}</span>
    <span className="cp-muted"><i />LIVE BLOQUEADO</span>
  </div>;
}

function Metric({ label, value, note, tone, onClick }: { label: string; value: string; note?: string; tone?: string; onClick: () => void }) {
  return <button type="button" className={`cp-metric ${tone ? `cp-${tone}` : ""}`} onClick={onClick}>
    <span>{label}<b aria-hidden="true">↗</b></span><strong>{value}</strong>{note ? <small>{note}</small> : null}
  </button>;
}

function Panel({ title, action, onClick, children, className = "" }: { title: string; action: string; onClick: () => void; children: ReactNode; className?: string }) {
  return <section className={`cp-panel ${className}`}><header><h2>{title}</h2><button type="button" onClick={onClick}>{action} <span aria-hidden="true">↗</span></button></header>{children}</section>;
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="cp-row"><span>{label}</span><strong className={tone ? `cp-${tone}` : undefined}>{value}</strong></div>;
}

function Shortcut({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="cp-shortcut" onClick={onClick}>{children}<span aria-hidden="true">↗</span></button>;
}

function MiniChart({ data, asset, open }: { data: Props; asset: Asset; open: OpenDetail }) {
  return <Panel title={`${asset}/USDC · diário`} action="Ampliar" onClick={() => open("market", `Gráfico ${asset}/USDC`)} className="cp-chart-panel">
    <CandleChart candles={data.dailyCandles.filter((candle) => candle.symbol === `${asset}USDC`)} asset={asset} windowSize={30} />
  </Panel>;
}

function Overview({ data, open }: { data: Props; open: OpenDetail }) {
  const capital = data.slotAccounts.reduce((sum, item) => sum + Number(item.balance_usdc), 0);
  const profit = data.slotAccounts.reduce((sum, item) => sum + Number(item.net_profit_usdc), 0);
  const gains = data.slotAccounts.reduce((sum, item) => sum + item.gain_count, 0);
  const orders = data.testnetOrders.filter((item) => openOrders.has(item.status)).length;
  const healthy = data.configs.length > 0 && data.configs.every((config) => config.grid_status === "VALID" && !config.last_engine_error);
  return <div className="cp-view">
    <div className="cp-metrics">
      <Metric label="Capital Shadow" value={money(capital)} note="BTC + SOL · virtual" onClick={() => open("all", "Resumo dos ambientes")} />
      <Metric label="Lucro Shadow" value={money(profit)} note={`${gains} gains acumulados`} tone="green" onClick={() => open("all", "Resultado Shadow")} />
      <Metric label="Ordens Testnet" value={String(orders)} note="Fundos fictícios" tone="purple" onClick={() => open("all", "Resumo dos ambientes")} />
      <Metric label="Production" value="READ-ONLY" note="LIVE bloqueado" onClick={() => open("all", "Estado dos ambientes")} />
    </div>
    <div className="cp-environments">
      <a className="cp-environment cp-env-shadow" href="/automacao?view=shadow"><header><h2>Shadow</h2><span>↗</span></header><strong>{healthy ? "Motor OK" : "Revisar motor"}</strong><p>BTC/USDC + SOL/USDC</p><small>{gains} gains · {money(profit)}</small></a>
      <a className="cp-environment cp-env-testnet" href="/automacao?view=testnet&testnet=check"><header><h2>Testnet</h2><span>↗</span></header><strong>{data.testnetRun?.last_error ? "Atenção" : data.testnetRun?.status === "ACTIVE" ? "Operando" : "Em espera"}</strong><p>{orders} ordem(ns) aberta(s)</p><small>Reconciliação {at(data.testnetRun?.last_reconciled_at)}</small></a>
      <a className="cp-environment" href="/automacao?view=live"><header><h2>Real</h2><span>↗</span></header><strong>LIVE bloqueado</strong><p>Binance somente leitura</p><small>0 ordens reais CoinOps</small></a>
    </div>
    <div className="cp-overview-bottom"><MiniChart data={data} asset="SOL" open={open} /><Panel title="Acompanhamento" action="Atividade" onClick={() => open("events", "Atividade dos ambientes")}>
      <Row label="Shadow · última leitura" value={at(data.configs.find((item) => item.asset === "SOL")?.last_engine_at)} />
      <Row label="Testnet · reconciliação" value={data.testnetRun?.last_error ? "Revisar" : data.testnetRun?.last_reconciled_at ? "Sem erro" : "Aguardando"} />
      <Row label="Production · sincronização" value={at(data.reconciliationAt || data.lastSyncedAt)} />
    </Panel></div>
    <footer className="cp-shortcuts"><Shortcut onClick={() => open("market", "Gráfico diário SOL/USDC")}>Gráfico diário</Shortcut><Shortcut onClick={() => open("events", "Atividade dos ambientes")}>Histórico</Shortcut><Shortcut onClick={() => open("all", "Resumo completo")}>Todos os detalhes</Shortcut></footer>
  </div>;
}

function Shadow({ data, asset, setAsset, open }: { data: Props; asset: Asset; setAsset: (asset: Asset) => void; open: OpenDetail }) {
  const config = data.configs.find((item) => item.asset === asset);
  const cycles = data.cycles.filter((item) => item.asset === asset);
  const cycle = cycles.find((item) => activeCycles.has(item.status));
  const slots = data.slots.filter((item) => item.cycle_id === cycle?.id);
  const accounts = data.slotAccounts.filter((item) => item.config_id === config?.id);
  const testCycles = new Set(cycles.filter((item) => !config?.shadow_test_started_at || Date.parse(item.started_at) >= Date.parse(config.shadow_test_started_at)).map((item) => item.id));
  const operations = data.operations.filter((item) => testCycles.has(item.cycle_id));
  const capital = accounts.reduce((sum, item) => sum + Number(item.balance_usdc), 0);
  const profit = accounts.reduce((sum, item) => sum + Number(item.net_profit_usdc), 0);
  const gains = accounts.reduce((sum, item) => sum + item.gain_count, 0);
  const opened = slots.filter((item) => openSlots.has(item.status));
  const armed = slots.filter((item) => item.status === "PENDING" && item.entry_state === "ARMED");
  const planned = slots.filter((item) => item.status === "PENDING" && item.entry_state !== "ARMED" && !item.missed_at);
  const missed = slots.filter((item) => item.missed_at).length;
  const initial = accounts.reduce((sum, item) => sum + Number(item.initial_balance_usdc), 0);
  const healthy = config?.grid_status === "VALID" && !config.last_engine_error && reconcileV1PhysicalSlotAccounts(accounts, operations) && Math.abs(initial - Number(config.capital_usdc)) < 1e-8 && armed.length <= 1;
  const relevant = [...opened, ...armed].slice(0, 3);
  return <div className="cp-view">
    <div className="cp-view-heading"><div className="cp-asset-tabs" role="group" aria-label="Ativo Shadow">{(["BTC", "SOL"] as const).map((item) => <button key={item} type="button" aria-pressed={asset === item} onClick={() => setAsset(item)}>{item}/USDC</button>)}</div><small>Gain {number(Number(cycle?.gain_rate || config?.gain_rate || 0) * 100)}% · spacing {number(Number(cycle?.entry_spacing || config?.entry_spacing || 0) * 100)}%</small></div>
    <div className="cp-metrics">
      <Metric label="Capital virtual" value={money(capital)} note={`${accounts.length} slots físicos`} onClick={() => open("gains", "Capital e ganhos por slot")} />
      <Metric label="Lucro líquido" value={money(profit)} note="Resultado acumulado" tone="green" onClick={() => open("gains", "Histórico de ganhos")} />
      <Metric label="Gains" value={String(gains)} note={`${opened.length} posição(ões) aberta(s)`} onClick={() => open("gains", "Histórico de ganhos")} />
      <Metric label="Motor Shadow" value={healthy ? "OK" : "Revisar"} note={at(config?.last_engine_at)} tone={healthy ? "green" : "red"} onClick={() => open("all", "Estado completo do Shadow")} />
    </div>
    <div className="cp-main-grid"><Panel title={`Slots ${asset}/USDC`} action={`Ver ${slots.length}`} onClick={() => open("slots", `Slots ${asset}/USDC`)}>
      <div className="cp-counts"><span><b>{opened.length}</b> abertos</span><span><b>{armed.length}</b> próxima BUY</span><span><b>{planned.length}</b> planejados</span></div>
      <div className="cp-slot-preview">{relevant.length ? relevant.map((slot) => <button type="button" key={slot.id} onClick={() => open("slots", `Slots ${asset}/USDC`)}><strong>#{slot.slot_number}</strong><span>{openSlots.has(slot.status) ? "Aberto · TP" : "Próxima BUY"}</span><b>{number(openSlots.has(slot.status) ? slot.take_profit_price : slot.buy_price)} <small>USDC</small></b><span aria-hidden="true">↗</span></button>) : <p>Nenhuma entrada ativa.</p>}</div>
      <small>{missed ? `${missed} nível(is) perdido(s) · ver eventos` : "Nenhum nível perdido"} · {opened.length + armed.length > 3 ? "Prévia de 3 slots" : "Uma próxima compra por ativo"}</small>
    </Panel><MiniChart data={data} asset={asset} open={open} /></div>
    <footer className="cp-shortcuts"><Shortcut onClick={() => open("slots", `Slots ${asset}/USDC`)}>Todos os slots</Shortcut><Shortcut onClick={() => open("market", `Gráfico ${asset}/USDC`)}>Gráfico diário</Shortcut><Shortcut onClick={() => open("gains", "Histórico de ganhos")}>Ganhos</Shortcut><Shortcut onClick={() => open("events", "Eventos Shadow")}>Eventos</Shortcut><Shortcut onClick={() => open("controls", "Configuração Shadow")}>Configuração</Shortcut></footer>
  </div>;
}

function Testnet({ data, open }: { data: Props; open: OpenDetail }) {
  const currentOrders = data.testnetOrders.filter((item) => openOrders.has(item.status));
  const filled = data.testnetOrders.filter((item) => item.side === "BUY" && item.status === "FILLED").at(-1);
  const tp = currentOrders.find((item) => item.purpose === "TP") || data.testnetOrders.filter((item) => item.purpose === "TP" && item.status === "FILLED").at(-1);
  const next = currentOrders.find((item) => item.side === "BUY" && item.purpose === "ENTRY");
  const gains = data.testnetSlots.reduce((sum, item) => sum + item.gain_count, 0);
  const profit = data.testnetSlots.reduce((sum, item) => sum + Number(item.net_profit_usdc), 0);
  const planned = data.testnetSlots.filter((item) => item.entry_state === "PLANNED").length;
  const missed = data.testnetSlots.filter((item) => item.missed_at).length;
  const balances = data.testnet?.ok ? data.testnet.balances : [];
  const error = data.testnetActionError || data.testnetRun?.last_error || (data.testnet && !data.testnet.ok ? data.testnet.error : null);
  return <div className="cp-view">
    <div className="cp-view-heading"><strong>Binance Spot Testnet <small>· fundos fictícios</small></strong><span className={error ? "cp-red" : "cp-green"}>{error ? "Atenção · ver diagnóstico" : data.testnet?.ok ? "Conectado" : "A verificar"}</span></div>
    <div className="cp-metrics">
      <Metric label="USDC disponível" value={number(balances.find((item) => item.asset === "USDC")?.free)} note="Saldo fictício" onClick={() => open("balances", "Saldos Testnet")} />
      <Metric label="SOL disponível" value={number(balances.find((item) => item.asset === "SOL")?.free, 6)} note="Saldo fictício" onClick={() => open("balances", "Saldos Testnet")} />
      <Metric label="Lucro Testnet" value={money(profit)} note={`${gains} gain(s)`} tone="green" onClick={() => open("orders", "Ordens Testnet")} />
      <Metric label="Ordens abertas" value={String(currentOrders.length)} note={`${missed} missed levels`} tone="purple" onClick={() => open("orders", "Ordens Testnet")} />
    </div>
    <div className="cp-main-grid"><Panel title={data.testnetRun?.symbol || "SOL/USDC"} action="Ordens" onClick={() => open("orders", "Ordens Testnet")}>
      <Row label={filled ? `BUY · Slot #${filled.slot_number}` : "BUY inicial"} value={filled ? "Preenchida" : "Aguardando"} tone="green" />
      <Row label={tp ? `TP · Slot #${tp.slot_number}` : "Take profit"} value={tp ? tp.status === "FILLED" ? "Concluído" : "Residente" : "Aguardando"} tone="purple" />
      <Row label={next ? `Próxima BUY · #${next.slot_number}` : "Próxima BUY"} value={next ? `${number(next.price)} USDC` : "Aguardando"} />
      <Row label="Níveis planejados" value={String(planned)} />
    </Panel><Panel title="Saúde Testnet" action="Ver" onClick={() => open("all", "Diagnóstico e controles Testnet")}>
      <Row label="USER_DATA" value={data.testnet?.ok ? "OK" : "A verificar"} />
      <Row label="TRADE / USER_STREAM" value={data.testnet?.ok && data.testnet.tradePermission.ok && data.testnet.userStreamPermission.ok ? "OK / OK" : "A verificar"} />
      <Row label="Última reconciliação" value={at(data.testnetRun?.last_reconciled_at)} />
      <Row label="Estado" value={error ? "Erro · abrir diagnóstico" : data.testnetRun?.last_reconciled_at ? "Sem erro registrado" : "Aguardando"} tone={error ? "red" : undefined} />
    </Panel></div>
    <footer className="cp-shortcuts"><Shortcut onClick={() => open("orders", "Ordens Testnet")}>Ordens</Shortcut><Shortcut onClick={() => open("events", "Eventos Testnet")}>Eventos</Shortcut><Shortcut onClick={() => open("market", "Gráfico diário SOL/USDC")}>Gráfico diário</Shortcut><Shortcut onClick={() => open("balances", "Saldos Testnet")}>Saldos</Shortcut><Shortcut onClick={() => open("all", "Diagnóstico e controles Testnet")}>Controles</Shortcut></footer>
  </div>;
}

function Live({ data, open }: { data: Props; open: OpenDetail }) {
  const connected = data.connectionStatus === "CONNECTED" || data.connectionStatus === "READ_ONLY";
  return <div className="cp-view">
    <div className="cp-view-heading"><strong>Binance Production</strong><span className="cp-muted">Somente leitura · LIVE bloqueado</span></div>
    <div className="cp-metrics">
      <Metric label="Conexão" value={connected ? "Conectada" : "A verificar"} note="READ-ONLY" tone={connected ? "green" : "red"} onClick={() => open("all", "Conexão Production")} />
      <Metric label="Reconciliação" value={data.reconciliationStatus === "COMPLETED" ? "Concluída" : "Pendente"} note={`${data.mismatches} item(ns) para revisão`} onClick={() => open("all", "Reconciliação Production")} />
      <Metric label="Ordens reais CoinOps" value="0" note="Envio bloqueado" onClick={() => open("all", "Proteções LIVE")} />
      <Metric label="Par futuro" value="SOL/BRL" note="Preparação pendente" onClick={() => open("all", "Preparação SOL/BRL")} />
    </div>
    <div className="cp-main-grid"><Panel title="Saldos consultados" action="Detalhes" onClick={() => open("balances", "Saldos Production · somente leitura")}>
      {(["USDT", "BTC", "SOL"] as const).map((asset) => <Row key={asset} label={asset} value={number(data.balances.find((item) => item.asset === asset)?.total, asset === "USDT" ? 2 : 8)} />)}
      <small>Última sincronização {at(data.reconciliationAt || data.lastSyncedAt)}</small>
    </Panel><Panel title="Preparação LIVE" action="Checklist" onClick={() => open("all", "Checklist e filtros SOL/BRL")}>
      <Row label="Mercado SOL/BRL" value={data.solBrlPilot.status} />
      <Row label="Filtros públicos" value="Snapshot disponível" />
      <Row label="Auditoria e autorização" value="Pendentes" />
      <small>Compras, vendas e cancelamentos reais bloqueados.</small>
    </Panel></div>
    <footer className="cp-shortcuts"><Shortcut onClick={() => open("balances", "Saldos Production · somente leitura")}>Saldos</Shortcut><Shortcut onClick={() => open("all", "Checklist e filtros SOL/BRL")}>Checklist</Shortcut><Shortcut onClick={() => open("all", "Detalhes Production")}>Conexão</Shortcut></footer>
  </div>;
}

function DetailDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      trigger?.focus();
    };
  }, []);
  return <dialog ref={ref} className="cp-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" autoFocus onClick={onClose} aria-label="Fechar detalhes">Fechar ×</button></header>
    <div className="cp-dialog-body">{children}</div>
  </dialog>;
}

export function AutomationCenter({ view, data }: { view: AutomationView; data: Props }) {
  const [asset, setAsset] = useState<Asset>("SOL");
  const [detail, setDetail] = useState<{ section: AutomationDetail; title: string } | null>(null);
  const open: OpenDetail = (section, title) => setDetail({ section, title });
  return <div className="coinops-automation ac-cockpit">
    <EnvironmentTabs view={view} />
    {view === "overview" ? <Overview data={data} open={open} /> : view === "shadow" ? <Shadow data={data} asset={asset} setAsset={setAsset} open={open} /> : view === "testnet" ? <Testnet data={data} open={open} /> : <Live data={data} open={open} />}
    {detail ? <DetailDialog title={detail.title} onClose={() => setDetail(null)}>{view === "live" && detail.section === "balances" ? <div className="cp-full-balances">{data.balances.length ? data.balances.map((balance) => <section key={balance.asset}><h3>{balance.asset}</h3><Row label="Disponível" value={number(balance.free, 8)} /><Row label="Bloqueado" value={number(balance.locked, 8)} /><Row label="Total" value={number(balance.total, 8)} /></section>) : <p>Nenhum saldo disponível na última reconciliação.</p>}</div> : <AutomationDetails view={view} data={data} section={detail.section} asset={asset} />}</DetailDialog> : null}
  </div>;
}

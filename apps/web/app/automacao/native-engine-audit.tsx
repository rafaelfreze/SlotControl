import type { PremiumEngine } from "./premium-operator";
import { displayMoney as money, displayNumber as number, displayTime as time } from "./premium-primitives";

/** Native read-only audit for a new market; never reuses the old BRL/USDC labels. */
export function NativeEngineAudit({ model }: { model: PremiumEngine }) {
  return <section className="px-slot-detail" aria-label="Auditoria do motor nativo">
    <h3>{model.accountDisplayName} · {model.environment} · {model.symbol}</h3>
    <p>{model.health.label}: {model.health.reason}</p>
    <dl>{[["Conta", model.accountId], ["Motor", model.engineId], ["Ciclo", model.cycleId],
      ["Moeda nativa", model.currency], ["Capital lógico", money(model.capital, model.currency)],
      ["Posições", money(model.committed, model.currency)], ["Reservas", money(model.reserved, model.currency)],
      ["Exposição", money(model.exposure, model.currency)], ["Hard cap", money(model.cap, model.currency)],
      ["P&L realizado", money(model.realizedPnl, model.currency)], ["P&L aberto", money(model.openPnl, model.currency)],
      ["Fees", money(model.fees, model.currency)], ["Gains", model.gains], ["Slots físicos", model.slots.length],
      ["Última reconciliação", time(model.lastCheck)]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value ?? "Sem evidência"}</dd></div>)}</dl>
    <h3>Ordens próprias · ciclo carregado</h3>
    {model.orders.map((order) => <details key={order.id}><summary>Slot #{order.slotNumber} · {order.side} · {order.purpose} · {order.status}</summary><p>{money(order.price, model.currency)} · {number(order.quantity, 8)} {model.asset}</p><code>{order.id}</code><p>Binance: {order.exchangeId ?? "Sem ID residente"}</p></details>)}
    {!model.orders.length ? <p>Sem ordens registradas neste motor.</p> : null}
    <h3>Eventos deste motor</h3>{model.events.map((event) => <details key={event.id}><summary>{time(event.at)} · {event.type}</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>)}
    <a className="px-button" href={`/relatorios?account=${model.accountId}&engine=${model.engineId}&environment=${model.environment}`}>Relatórios da conta e motor →</a>
  </section>;
}

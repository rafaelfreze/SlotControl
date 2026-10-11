import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentBillingIdentity, localProjection } from "@/lib/saas-billing/server";
import { BillingError, statusLabel } from "@/lib/saas-billing/contract";
import { BillingControls } from "./billing-controls";
import "./billing.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Minha assinatura | CoinOps", robots: { index: false, follow: false } };
const money = (v: number | null) => v === null ? "Indisponível" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v / 100);
const date = (v: string | null) => v ? new Date(`${v.slice(0, 10)}T12:00:00Z`).toLocaleDateString("pt-BR") : "—";
export default async function BillingPage() {
  let identity: Awaited<ReturnType<typeof currentBillingIdentity>> | null = null;
  try { identity = await currentBillingIdentity(); } catch (e) {
    if (e instanceof BillingError && e.status === 401) redirect("/login?redirectTo=/assinatura");
  }
  let projection = null, failed = false;
  if (identity) try { projection = await localProjection(identity.user.id, identity.service); } catch { failed = true; }
  const back = identity?.user.app_metadata?.coinops_role === "VIEWER" ? "/meu-coinops" : "/automacao";
  return <main className="page-shell saas-billing-page"><header className="saas-billing-heading"><Link className="brand-link" href={back}><Image src="/icon-96x96.png" alt="" width={38} height={38}/><strong>CoinOps</strong></Link><Link className="button secondary" href={back}>Voltar ao CoinOps</Link></header><section className="card"><span className="eyebrow">CONTA</span><h1>Minha assinatura</h1><p>Mensalidade, vencimento e pagamento em um só lugar.</p>
  {!identity || failed ? <p role="alert">A assinatura está indisponível nesta consulta. Fale com a OnPlay para conferir seu acesso.</p> : !projection ? <><h2>Nenhuma assinatura vinculada</h2><p>O responsável da OnPlay pode vincular seu acesso ao contrato já contratado.</p><BillingControls payable={false}/></> : <><div className="saas-billing-identity"><h2>{projection.tenant_name}</h2><span className="badge">{projection.registration_pending ? "Vínculo pendente" : statusLabel(projection.status)}</span></div><dl className="saas-billing-facts">{[["Assinatura", projection.plan_name], ["Mensalidade", money(projection.amount_cents)], ["Próximo vencimento", date(projection.next_due_date)], ["Pagamento confirmado", date(projection.last_paid_at)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{projection.trial_ends_at && <p>Período de teste até {date(projection.trial_ends_at)}.</p>}{projection.manual_pause && <p>Assinatura pausada pelo responsável. A liberação precisa ser confirmada pela OnPlay.</p>}<BillingControls payable={!projection.registration_pending && !!projection.contract_id && !!projection.installment_id && (projection.balance_cents ?? 0) > 0}/></>}
  </section></main>;
}

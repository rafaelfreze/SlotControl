import Link from "next/link";
import type { RenewalNotice } from "@/lib/saas-billing/renewal";
import "./renewal-notice.css";

export function BillingRenewalNotice({ notice }: { notice: RenewalNotice | null }) {
  if (!notice) return null;
  return <section className="coinops-renewal-notice" role="alert">
    <div><h2>{notice.title}</h2><p>{notice.description}</p></div>
    <Link href="/assinatura">Acessar pagamento</Link>
  </section>;
}

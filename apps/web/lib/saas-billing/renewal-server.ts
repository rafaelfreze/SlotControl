import "server-only";
import { localProjection } from "./server";
import { billingViewerAccessAllowed, buildRenewalNotice, type RenewalNotice } from "./renewal";

export async function readBillingRenewal(userId: string): Promise<{ notice: RenewalNotice | null; blocked: boolean }> {
  try {
    const projection = await localProjection(userId);
    return { notice: buildRenewalNotice(projection), blocked: !billingViewerAccessAllowed(projection) };
  } catch {
    // An unavailable commercial read cannot affect engine supervision or execution.
    return { notice: { title: "Assinatura indisponível nesta consulta", description: "Confira sua assinatura para consultar o vencimento e o pagamento.", blocked: false }, blocked: false };
  }
}

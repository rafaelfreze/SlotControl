import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReportCenter } from "./report-center";
import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Central de relatórios" };
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";

export default async function ReportsPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const tenant = getCoinOpsServiceTenantId();
  if (!tenant) throw new Error("COINOPS_REPORT_SCOPE_INVALID");
  const owned = await supabase.from("operators").select("product_id,tenant_id,user_id")
    .eq("tenant_id", tenant).eq("user_id", user.id).single();
  if (owned.error || !owned.data) throw new Error("COINOPS_REPORT_SCOPE_UNAVAILABLE");
  const registry = await loadOperatorRegistry(supabase, owned.data);
  const parts = new Intl.DateTimeFormat("en", { timeZone: "America/Campo_Grande", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((value) => value.type === type)?.value || "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return <ReportCenter today={today} userLabel={user.email || "Conta CoinOps"} registry={registry} />;
}

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReportCenter } from "./report-center";

export const metadata: Metadata = { title: "Central de relatórios" };
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";

export default async function ReportsPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const parts = new Intl.DateTimeFormat("en", { timeZone: "America/Campo_Grande", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((value) => value.type === type)?.value || "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return <ReportCenter today={today} userLabel={user.email || "Conta CoinOps"} />;
}

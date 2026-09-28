import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireFinopsAdmin, loadFinopsDashboard } from "@/lib/coinops-finops/server";
import { buildFinopsNavigation } from "@/lib/coinops-finops/navigation";
import { FinopsPanel } from "./finops-panel";
import "./finops.css";

export const metadata: Metadata = { title: "Custos & Operação" };
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";

export default async function FinopsPage({ searchParams }: { searchParams?: { view?: string; account?: string; market?: string } }) {
  const scope = await requireFinopsAdmin().catch((error: unknown) => {
    if (error instanceof Error && error.message === "AUTH_REQUIRED") redirect("/login");
    if (error instanceof Error && error.message === "ADMIN_REQUIRED") redirect("/meu-coinops");
    throw error;
  });
  const data = await loadFinopsDashboard(scope);
  return <FinopsPanel data={data} homeHref={buildFinopsNavigation(searchParams).automationHref} />;
}

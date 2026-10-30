import { resolveHubPeriod } from "@/vendor/marketing-1.3.2/kit.mjs";
import { parseChannel } from "@/vendor/marketing-1.3.2/hub-server.mjs";
import { MarketingDashboard } from "@/vendor/marketing-1.3.2/dashboard.mjs";
import { readWebsiteDashboard } from "@/vendor/marketing-1.3.2/website-server.mjs";
import "@/vendor/marketing-1.3.2/styles.css";
import { websiteDb, websiteProduct } from "@/lib/marketing-hub/website-source";
import { requireAssetHealthAccess } from "@/lib/coinops-asset-health/access";
export const dynamic = "force-dynamic";
export default async function WebsiteMarketing({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireAssetHealthAccess(true);
  const params = await searchParams,
    search = Object.fromEntries(
      Object.entries(params).map(([k, v]) => [
        k,
        typeof v === "string" ? v : undefined,
      ]),
    );
  const period = resolveHubPeriod(search, "America/Campo_Grande"),
    data = await readWebsiteDashboard(
      websiteDb(),
      websiteProduct,
      period,
      parseChannel(search.channel),
    );
  return (
    <MarketingDashboard
      product={websiteProduct}
      companyKey={websiteProduct + ":platform"}
      data={data}
      basePath="/automacao/marketing"
      title="Atividade do site institucional"
      paid={{ available: false, reports: [] }}
      backHref="/automacao"
    />
  );
}

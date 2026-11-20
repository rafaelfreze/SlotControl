import { resolveEpochPeriod } from "@/vendor/marketing-1.4.18/epoch-server.js";
import { MarketingDashboard } from "@/vendor/marketing-1.3.2/dashboard.mjs";
import { readPlatformEpochDashboard } from "@/lib/marketing-hub/epoch";
import "@/vendor/marketing-1.3.2/styles.css";
import { websiteProduct } from "@/lib/marketing-hub/website-source";
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
  const period = resolveEpochPeriod(search),
    data = await readPlatformEpochDashboard(period);
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

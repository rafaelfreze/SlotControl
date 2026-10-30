import { serveWebsiteSource } from "@/vendor/marketing-1.3.2/website-server.mjs";
import { websiteDb, websiteProduct } from "@/lib/marketing-hub/website-source";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    return await serveWebsiteSource(
      request,
      websiteDb(),
      websiteProduct,
      process.env.MARKETING_CENTRAL_READ_SECRET ?? "",
    );
  } catch {
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}

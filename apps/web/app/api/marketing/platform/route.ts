import { serveWebsiteCounter } from "@/vendor/marketing-1.3.2/website-server.mjs";
import { websiteDb, websiteProduct } from "@/lib/marketing-hub/website-source";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    return await serveWebsiteCounter(request, websiteDb(), websiteProduct);
  } catch {
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}

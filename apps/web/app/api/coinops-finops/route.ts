import { NextRequest, NextResponse } from "next/server";
import { loadFinopsDashboard, requireFinopsAdmin, saveFinopsManualService, syncFinops } from "@/lib/coinops-finops/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
export const maxDuration = 300;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "COINOPS_FINOPS_UNAVAILABLE";
  const status = message === "AUTH_REQUIRED" ? 401 : message === "ADMIN_REQUIRED" ? 403
    : /(?:INVALID|REQUIRED)$/.test(message) ? 400 : 503;
  return NextResponse.json({ error: /^(?:COINOPS_FINOPS_[A-Z0-9_]+|AUTH_REQUIRED|ADMIN_REQUIRED)$/.test(message)
    ? message : "COINOPS_FINOPS_UNAVAILABLE" }, { status, headers });
}
export async function GET() {
  try { return NextResponse.json(await loadFinopsDashboard(await requireFinopsAdmin()), { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin
    || request.headers.get("sec-fetch-site") === "cross-site"
    || request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return NextResponse.json({ error: "COINOPS_FINOPS_ORIGIN_DENIED" }, { status: 403, headers });
  try {
    const scope = await requireFinopsAdmin();
    if (Number(request.headers.get("content-length") ?? 0) > 12_000) throw new Error("COINOPS_FINOPS_INPUT_INVALID");
    const raw = await request.text();
    if (raw.length > 12_000) throw new Error("COINOPS_FINOPS_INPUT_INVALID");
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new Error("COINOPS_FINOPS_INPUT_INVALID"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("COINOPS_FINOPS_INPUT_INVALID");
    const payload = input as Record<string, unknown>;
    if (payload.action === "SYNC") {
      // The authenticated operator is resolved above. Never forward force,
      // external-refresh settings or browser-supplied scope into the worker.
      return NextResponse.json(await syncFinops(scope), { headers });
    }
    if (payload.action !== undefined) throw new Error("COINOPS_FINOPS_INPUT_INVALID");
    return NextResponse.json(await saveFinopsManualService(scope, payload), { headers });
  } catch (error) { return failure(error); }
}

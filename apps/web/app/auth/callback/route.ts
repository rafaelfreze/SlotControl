import { type NextRequest, NextResponse } from "next/server";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") || "/dashboard";

  if (!isSupabaseConfigured()) {
    requestUrl.pathname = "/login";
    requestUrl.search = "?setup=missing-env";
    return NextResponse.redirect(requestUrl);
  }

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      requestUrl.pathname = "/login";
      requestUrl.search = "?auth=callback-error";
      return NextResponse.redirect(requestUrl);
    }
  }

  requestUrl.pathname = next.startsWith("/") ? next : "/dashboard";
  requestUrl.search = "";
  return NextResponse.redirect(requestUrl);
}

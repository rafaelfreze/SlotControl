import { type NextRequest, NextResponse } from "next/server";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { getAuthDestination } from "@/lib/auth/navigation";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = getAuthDestination({ next: requestUrl.searchParams.get("next") });

  if (!isSupabaseConfigured()) {
    requestUrl.pathname = "/login";
    requestUrl.search = "?setup=missing-env";
    return NextResponse.redirect(requestUrl);
  }

  const callbackError = () => {
    requestUrl.pathname = "/login";
    requestUrl.search = "?auth=callback-error";
    const response = NextResponse.redirect(requestUrl);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
  if (!code || requestUrl.searchParams.has("error") || requestUrl.searchParams.has("error_description")) return callbackError();
  try {
    const supabase = createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session) return callbackError();
    const response = NextResponse.redirect(new URL(next, requestUrl.origin));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch { return callbackError(); }
}

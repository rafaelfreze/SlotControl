import { type NextRequest, NextResponse } from "next/server";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { getAuthDestination } from "@/lib/auth/navigation";
import { markOwnershipVerified } from "@/lib/auth/optional-email-server";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const ownershipIntent=requestUrl.searchParams.get("intent")==="ownership";
  const tokenHash=requestUrl.searchParams.get("token_hash");
  const otpType=requestUrl.searchParams.get("type");
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
  if ((!code && !(ownershipIntent && tokenHash && ["magiclink","email"].includes(otpType??""))) || requestUrl.searchParams.has("error") || requestUrl.searchParams.has("error_description")) return callbackError();
  try {
    const supabase = createClient();
    const { data, error } = ownershipIntent&&tokenHash
      ?await supabase.auth.verifyOtp({token_hash:tokenHash,type:otpType as "magiclink"|"email"})
      :await supabase.auth.exchangeCodeForSession(code!);
    if (error || !data.session) return callbackError();
    if(ownershipIntent){
      const identity=await supabase.auth.getUser();
      if(identity.error||!identity.data.user||!await markOwnershipVerified(identity.data.user))return callbackError();
      await supabase.auth.refreshSession();
    }
    const response = NextResponse.redirect(new URL(next, requestUrl.origin));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch { return callbackError(); }
}

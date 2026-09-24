import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getAuthDestination } from "@/lib/auth/navigation";
import { getSupabaseDataSchema } from "@/lib/supabase/env";

const protectedRoutes = ["/dashboard", "/slots", "/historico", "/config", "/meu-coinops"];
const authRoutes = ["/login", "/cadastro"];

type CookieToSet = {
  name: string;
  value: string;
  options?: Parameters<NextResponse["cookies"]["set"]>[2];
};

function hasSupabaseEnv() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

function isRoute(pathname: string, routes: string[]) {
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Cron routes authenticate their own server secret; do not add an Auth
  // round-trip to the frequent executor schedule.
  if (pathname.startsWith("/api/cron/")) return NextResponse.next();

  if (!hasSupabaseEnv()) {
    if (isRoute(pathname, protectedRoutes)) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("setup", "missing-env");
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  }

  let response = NextResponse.next({
    request
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: getSupabaseDataSchema() },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({
            request
          });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        }
      }
    }
  );

  const {
    data: { user }
  } = await supabase.auth.getUser();

  // Viewer authorization is checked on every request, including API routes.
  // The account binding comes from RLS, never from a URL or browser claim.
  if (user?.app_metadata?.coinops_role === "VIEWER") {
    const { data: viewer, error } = await supabase.from("viewer_access")
      .select("status").eq("user_id", user.id).maybeSingle();
    const allowed = pathname === "/meu-coinops" || pathname === "/redefinir-senha"
      || pathname === "/recuperar-senha" || pathname === "/auth/callback";
    const viewerRead = pathname === "/api/coinops-viewer-state" && request.method === "GET";
    if (error || !viewer || viewer.status !== "ACTIVE") {
      if (pathname.startsWith("/api/")) return NextResponse.json({ error: "VIEWER_ACCESS_DISABLED" }, { status: 403 });
      if (pathname !== "/acesso-suspenso" && pathname !== "/redefinir-senha")
        return NextResponse.redirect(new URL("/acesso-suspenso", request.url));
    } else if (!allowed && !viewerRead) {
      if (pathname.startsWith("/api/")) return NextResponse.json({ error: "VIEWER_READ_ONLY" }, { status: 403 });
      return NextResponse.redirect(new URL("/meu-coinops", request.url));
    }
  }

  if (!user && isRoute(pathname, protectedRoutes)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(url);
  }

  if (user && isRoute(pathname, authRoutes)) {
    const target = getAuthDestination({
      redirectTo: request.nextUrl.searchParams.get("redirectTo"),
      returnTo: request.nextUrl.searchParams.get("returnTo"),
      next: request.nextUrl.searchParams.get("next")
    });
    const url = new URL(target, request.url);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"
  ]
};

import { NextResponse } from "next/server";

import { loadCoinOpsWorkspaceData } from "@/lib/coinops-workspace/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store, max-age=0"
};

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }

  try {
    const workspace = await loadCoinOpsWorkspaceData(supabase);
    return NextResponse.json(workspace, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch {
    return NextResponse.json(
      { error: "CoinOps workspace unavailable" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}

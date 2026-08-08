import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "./env";

export function createServiceRoleClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service role env vars are missing.");
  }

  const dataSchema = getSupabaseDataSchema();
  const coinOpsServiceTenantId = getCoinOpsServiceTenantId();

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    db: {
      schema: dataSchema
    },
    global: dataSchema === "coinops" && coinOpsServiceTenantId
      ? { headers: { "x-coinops-tenant-id": coinOpsServiceTenantId } }
      : undefined,
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

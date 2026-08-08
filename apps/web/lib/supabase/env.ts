export function getSupabaseEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase env vars are missing.");
  }

  return {
    supabaseUrl,
    supabaseAnonKey
  };
}

export function getSupabaseDataSchema() {
  // Keep the legacy project on public until its Vercel cutover.  The shared
  // platform uses the isolated CoinOps schema and opts in explicitly through a
  // server-only environment variable.
  return process.env.SUPABASE_DATA_SCHEMA === "coinops" ? "coinops" : "public";
}

/**
 * Background workers use service_role and therefore bypass RLS.  On the
 * shared platform they must still carry an explicit CoinOps tenant scope for
 * every read as well as every write.  The legacy single-project runtime has
 * no tenant column and intentionally returns null.
 */
export function getCoinOpsServiceTenantId() {
  if (getSupabaseDataSchema() !== "coinops") return null;

  const tenantId = process.env.COINOPS_SERVICE_TENANT_ID?.trim();
  if (!tenantId) {
    throw new Error("COINOPS_SERVICE_TENANT_ID is required for the shared CoinOps runtime.");
  }

  return tenantId;
}

export function isSupabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

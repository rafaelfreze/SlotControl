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

export function isSupabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

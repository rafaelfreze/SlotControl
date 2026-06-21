"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseEnv, isSupabaseConfigured } from "./env";

let browserClient: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (!browserClient) {
    const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();
    browserClient = createBrowserClient(supabaseUrl, supabaseAnonKey);
  }

  return browserClient;
}

export { isSupabaseConfigured };

import "server-only";
import {
  assertWebsiteBackend,
  type WebsiteDb,
} from "@/vendor/marketing-1.3.2/website-server.mjs";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getSupabaseDataSchema } from "@/lib/supabase/env";
export const websiteProduct = "coinops" as const;
export function websiteDb(): WebsiteDb {
  assertWebsiteBackend(
    websiteProduct,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseDataSchema(),
  );
  const db = createServiceRoleClient();
  if (!db) throw Error("website_unconfigured");
  return { rpc: (name, args) => db.rpc(name, args) };
}

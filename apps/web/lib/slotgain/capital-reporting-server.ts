import type { SupabaseClient } from "@supabase/supabase-js";

import type { CapitalContributionView } from "./capital-contributions";

export type CapitalReportingEntry = CapitalContributionView & {
  id: string;
  asset: "BTC" | "SOL";
  slot_number: number;
  operational_before: number | string;
  operational_after: number | string;
  reason: string;
  applied_by: string | null;
  created_at: string;
  bulk_batch_id: string | null;
  bulk_sequence: number | null;
  bulk_slot_count: number | null;
  incorporated_in_opening: boolean;
  source: "CONTRIBUTION" | "SLOT_INITIAL_CAPITAL";
};

const REPORTING_FIELDS = "id,asset,slot_id,slot_number,amount_usdt,accounting_amount_usdt,gain_equivalent,input_mode,operational_before,operational_after,reason,applied_by,created_at,bulk_batch_id,bulk_sequence,bulk_slot_count,incorporated_in_opening,source";
const PAGE_SIZE = 500;

/** Read the RLS-protected reporting view, never the raw lifetime capital balance.
 * Paginate explicitly: a PostgREST row limit must not silently truncate totals.
 */
export async function loadCapitalReportingEntries(
  supabase: SupabaseClient,
  options: { slotId?: string; includeIncorporated?: boolean } = {}
): Promise<{ data: CapitalReportingEntry[]; error: { message: string } | null }> {
  const rows: CapitalReportingEntry[] = [];
  const readAt = new Date().toISOString();
  let expectedCount: number | null = null;

  do {
    let query = supabase.from("capital_reporting_entries")
      .select(REPORTING_FIELDS, { count: "exact" })
      .lte("created_at", readAt)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (!options.includeIncorporated) query = query.eq("incorporated_in_opening", false);
    if (options.slotId) query = query.eq("slot_id", options.slotId);

    const response = await query.range(rows.length, rows.length + PAGE_SIZE - 1);
    // Fail closed: returning [] would render a convincing but false zero,
    // especially in desktop consumers without a separate error banner.
    if (response.error) throw new Error("Não foi possível carregar os lançamentos de capital. Atualize a página.");
    if (response.count === null || (expectedCount !== null && expectedCount !== response.count)) {
      throw new Error("Os lançamentos de capital mudaram durante a leitura. Atualize a página.");
    }
    expectedCount = response.count;
    const page = (response.data || []) as CapitalReportingEntry[];
    if (!page.length && rows.length < expectedCount) {
      throw new Error("Não foi possível carregar todos os lançamentos de capital.");
    }
    rows.push(...page);
  } while (rows.length < expectedCount);

  return { data: rows, error: null };
}

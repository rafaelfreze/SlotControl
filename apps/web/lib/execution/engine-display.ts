/** IDs are the identity; numbering is presentation only and stable by creation order. */
type DisplayEngine = { id: string; symbol: string; exchange_account_id?: string; created_at?: string };
export function engineDisplayName(engine: DisplayEngine, siblings: readonly DisplayEngine[]) {
  const unique = new Map(siblings.filter((item) => item.symbol === engine.symbol
    && item.exchange_account_id === engine.exchange_account_id).map((item) => [item.id, item]));
  unique.set(engine.id, engine);
  const same = [...unique.values()].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")
    || a.id.localeCompare(b.id));
  return same.length > 1 ? `${engine.symbol} · Motor ${same.findIndex((item) => item.id === engine.id) + 1}` : engine.symbol;
}

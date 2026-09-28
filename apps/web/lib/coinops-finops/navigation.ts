import { isIdentity } from "../execution/operator-context.ts";

export type FinopsNavigationParams = { view?: unknown; account?: unknown; market?: unknown };

const views = new Set(["live", "testnet", "shadow", "overview"]);
const markets = new Set(["ALL", "BTCBRL", "SOLBRL", "BTCUSDT", "SOLUSDT"]);

/** Read-only navigation context, not authorization. Both destinations are fixed:
 * no returnTo, external URL, account name or arbitrary query enters the href. */
export function buildFinopsNavigation(params: FinopsNavigationParams = {}): {
  costsHref: string; automationHref: string;
} {
  const view = typeof params.view === "string" && views.has(params.view) ? params.view : "live";
  const account = isIdentity(params.account) ? params.account.toLowerCase() : "ALL";
  const market = typeof params.market === "string" && markets.has(params.market) ? params.market : "ALL";
  const query = new URLSearchParams({ view, account, market }).toString();
  return { costsHref: `/custos-operacao?${query}`, automationHref: `/automacao?${query}` };
}

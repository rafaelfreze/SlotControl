import { assertDomainRegistry, isIdentity, resolveEngineContext, type DomainRegistry } from "../execution/operator-context.ts";

export type ReportInitialSelection = {
  account: string; engine: string; environment: "ALL" | "SHADOW" | "TESTNET" | "REAL";
  asset: "ALL" | "BTC" | "SOL";
};
export type ReportSelectionParams = Partial<Record<keyof ReportInitialSelection, string | string[]>>;

/** UI defaults only: the authenticated report API still resolves authorization.
 * Invalid explicit selectors must never silently widen a report to ALL. */
export function resolveReportInitialSelection(registry: DomainRegistry, params: ReportSelectionParams = {}): ReportInitialSelection {
  assertDomainRegistry(registry, registry.operator);
  const input = (key: keyof ReportInitialSelection) => {
    const value = params[key];
    if (value === undefined) return "ALL";
    if (typeof value !== "string" || !value) throw new Error("COINOPS_REPORT_LINK_INVALID");
    return value;
  };
  const account = input("account"), engine = input("engine"), environment = input("environment"), asset = input("asset");
  if (!["ALL", "SHADOW", "TESTNET", "REAL"].includes(environment) || !["ALL", "BTC", "SOL"].includes(asset))
    throw new Error("COINOPS_REPORT_LINK_INVALID");
  const accountRow = registry.accounts.find((row) => row.id === account);
  if (account !== "ALL" && (!isIdentity(account) || !accountRow || ["DISABLED", "REVOKED"].includes(accountRow.status)))
    throw new Error("COINOPS_REPORT_ACCOUNT_DENIED");
  if (engine !== "ALL") {
    if (!isIdentity(engine) || account === "ALL") throw new Error("COINOPS_REPORT_ENGINE_DENIED");
    const row = registry.engines.find((candidate) => candidate.id === engine);
    if (!row || row.exchange_account_id !== account || environment !== "ALL" && row.environment !== environment
      || asset !== "ALL" && row.base_asset !== asset || !["BTC", "SOL"].includes(row.base_asset))
      throw new Error("COINOPS_REPORT_ENGINE_DENIED");
    const context = resolveEngineContext(registry, { environment: row.environment,
      exchange_account_id: account, trading_engine_id: engine });
    return { account, engine, environment: context.environment, asset: context.base_asset as "BTC" | "SOL" };
  }
  return { account, engine, environment: environment as ReportInitialSelection["environment"], asset: asset as ReportInitialSelection["asset"] };
}

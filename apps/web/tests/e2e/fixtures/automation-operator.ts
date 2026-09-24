import { AUTOMATION_FIXTURE_NOW, automationPremiumFixture } from "./automation-premium";
import { buildPremiumEngine } from "../../../app/automacao/premium-operator";
import type { Presentation } from "../../../app/automacao/premium-automation";
import type { EngineContext } from "../../../lib/execution/operator-context";

export const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
export const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";

/** Synthetic only: two accounts, same physical numbers and four native markets. */
export function automationOperatorFixture(): Presentation {
  const fixture: Presentation = automationPremiumFixture();
  fixture.operator = { accounts: [{ id: ACCOUNT_A, displayName: "Rafael Demo", status: "ACTIVE", killSwitch: false },
    { id: ACCOUNT_B, displayName: "Conta B Demo", status: "ACTIVE", killSwitch: false }], engines: [], engineData: {},
    accountCaps: [ACCOUNT_A, ACCOUNT_B].flatMap((accountId) => ["BRL", "USDT"].map((currency) => ({ accountId, currency, cap: 725 }))) };
  let sequence = 0;
  for (const [accountId, label] of [[ACCOUNT_A, "Rafael Demo"], [ACCOUNT_B, "Conta B Demo"]]) {
    for (const symbol of ["BTCBRL", "SOLBRL", "BTCUSDT", "SOLUSDT"]) {
      sequence++;
      const asset = symbol.startsWith("BTC") ? "BTC" : "SOL", quote = symbol.endsWith("BRL") ? "BRL" : "USDT";
      const engineId = `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      const context: EngineContext = { operator_id: "30000000-0000-4000-8000-000000000001",
        exchange_account_id: accountId, trading_engine_id: engineId, account_display_name: label,
        environment: "REAL", symbol, base_asset: asset, quote_asset: quote, is_legacy_default: accountId === ACCOUNT_A,
        global_kill_switch: false, account_kill_switch: false, engine_kill_switch: false,
        status: "ACTIVE", hard_cap_quote: asset === "BTC" ? 450 : 275, legacy_compatible: accountId === ACCOUNT_A && quote === "BRL",
        ath_reference_symbol: accountId === ACCOUNT_A && quote === "BRL" ? `${asset}USDC` : symbol };
      const scoped = automationPremiumFixture();
      scoped.engineContext = context;
      scoped.liveAssetData = { [asset]: scoped.liveAssetData![asset]! };
      scoped.liveAssetData[asset]!.run.symbol = symbol;
      scoped.liveAssetData[asset]!.run.id = `${engineId}:run`;
      scoped.liveAssetData[asset]!.orders = scoped.liveAssetData[asset]!.orders.map((order) => ({ ...order,
        client_order_id: `${engineId}:${order.client_order_id}`, exchange_order_id: `${engineId}:${order.exchange_order_id}` }));
      if (accountId === ACCOUNT_B) {
        scoped.liveAssetData[asset]!.accounts.forEach((account) => { account.balance_brl = 8; });
      }
      const model = buildPremiumEngine(scoped, context, Date.parse(AUTOMATION_FIXTURE_NOW));
      fixture.operator.engines.push(model);
      fixture.operator.engineData[engineId] = scoped;
    }
  }
  fixture.dailyCandles = [...fixture.dailyCandles, ...fixture.dailyCandles.filter((row) => row.symbol.endsWith("BRL"))
    .map((row) => ({ ...row, symbol: row.symbol.replace("BRL", "USDT") }))];
  return fixture;
}

import type { EngineContext } from "@/lib/execution/operator-context";

/** IDs are routing hints, not authorization. Every action resolves them again. */
export function EngineScopeFields({ context }: { context?: EngineContext }) {
  return <><input type="hidden" name="exchange_account_id" value={context?.exchange_account_id ?? ""} />
    <input type="hidden" name="trading_engine_id" value={context?.trading_engine_id ?? ""} /></>;
}

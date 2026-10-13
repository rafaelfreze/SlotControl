/** Personal presentation preference only. Never resolves a ledger alert, changes
 * engine health, disables push, or grants permission for a financial action. */
export const FUNDING_WARNING_AWARENESS_KEY = "coinops-funding-warning-awareness-v1";
const LIMIT = 200;
const CODES = new Set(["COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", "COINOPS_LIVE_BNB_FEE_RESERVE_MISSING"]);
type Warning = { code: string; severity: string; at: string | null };
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function fundingWarningFingerprint(engineId: string, warning: Warning): string | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(engineId) || warning.severity !== "WARNING"
    || !CODES.has(warning.code) || !warning.at || !Number.isFinite(Date.parse(warning.at))) return null;
  return `${engineId}|${warning.code}|${warning.at}`;
}

function valid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const pieces = value.split("|");
  return pieces.length === 3 && fundingWarningFingerprint(pieces[0], {
    code: pieces[1], severity: "WARNING", at: pieces[2],
  }) === value;
}

export function readFundingWarningAwareness(storage: StorageLike): string[] {
  const raw = storage.getItem(FUNDING_WARNING_AWARENESS_KEY);
  if (!raw) return [];
  try {
    const values: unknown = JSON.parse(raw);
    return Array.isArray(values) ? [...new Set(values.filter(valid))].slice(-LIMIT) : [];
  } catch { return []; }
}

export function updateFundingWarningAwareness(storage: StorageLike, fingerprints: string[], acknowledge: boolean): string[] {
  const current = readFundingWarningAwareness(storage), requested = fingerprints.filter(valid);
  const result = acknowledge ? [...new Set([...current, ...requested])].slice(-LIMIT)
    : current.filter((value) => !requested.includes(value));
  // Only opaque identity/code/timestamp fingerprints are stored, never amounts,
  // account names, credentials, order IDs, or diagnostic payloads.
  storage.setItem(FUNDING_WARNING_AWARENESS_KEY, JSON.stringify(result));
  return result;
}

/** Hide the funding-only banner only when the read model proves no other fault.
 * Mixed critical/read/TP/cap/schema/ownership problems always stay visible. */
export function fundingOnlyBannerAcknowledged(engine: { engineId: string; engineStatus: string; killSwitch: boolean;
  health: { label: string }; activeIssueCount: number; alerts: Warning[] }, acknowledged: ReadonlySet<string>): boolean {
  return engine.engineStatus === "ACTIVE" && !engine.killSwitch && engine.health.label === "AGUARDANDO SALDO"
    && engine.alerts.length > 0 && engine.activeIssueCount === engine.alerts.length
    && engine.alerts.every((warning) => {
      const fingerprint = fundingWarningFingerprint(engine.engineId, warning);
      return fingerprint !== null && acknowledged.has(fingerprint);
    });
}

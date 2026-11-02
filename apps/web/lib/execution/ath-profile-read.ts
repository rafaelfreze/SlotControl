type Profile = Record<string, unknown>;
type Owner = { product_id: string; tenant_id: string; user_id: string; operator_id: string;
  exchange_account_id: string; trading_engine_id: string; asset: string; quote_asset: string };
type RecoveryRun = Owner & { config_version: number; gain_rate: number | string; entry_regime: string;
  entry_spacing: number | string; ath_transition_key: string | null; config_snapshot: Record<string, unknown> };
const OWNER_KEYS = ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id",
  "trading_engine_id", "asset", "quote_asset"] as const;
const RATE_KEYS = ["gain_rate", "normal_spacing_rate", "post_ath_spacing_rate"] as const;
const positive = (value: unknown) => value !== null && value !== undefined && value !== ""
  && Number.isFinite(Number(value)) && Number(value) > 0;

/** Successful absence, malformed configuration and foreign ownership are hard
 * failures, never transient GET errors or a permission to use defaults. */
export function assertAthProfileIdentity(profile: Profile, owner: Owner) {
  if (OWNER_KEYS.some(key => !owner[key] || profile[key] !== owner[key]) || profile.environment !== "REAL"
    || typeof profile.id !== "string" || !profile.id
    || !Number.isInteger(profile.config_version) || Number(profile.config_version) < 1
    || !["NORMAL", "POST_ATH"].includes(String(profile.regime))
    || RATE_KEYS.some(key => !positive(profile[key]) || Number(profile[key]) >= 1)
    || typeof profile.updated_at !== "string" || !Number.isFinite(Date.parse(profile.updated_at)))
    throw new Error("COINOPS_ATH_PROFILE_INVALID");
}

/** Recovery observes only. A pending/version/regime/rate change must follow
 * the normal leased transition instead of inheriting a read-outage approval.
 * The ordered proof must be identical before and after external observations. */
export function athProfileRecoveryProof(profile: Profile, run: RecoveryRun) {
  assertAthProfileIdentity(profile, run);
  const snapshot = run.config_snapshot;
  const close = (a: unknown, b: unknown) => positive(a) && positive(b) && Math.abs(Number(a) - Number(b)) < 1e-12;
  if (profile.config_version !== run.config_version || profile.regime !== run.entry_regime
    || profile.transition_key !== run.ath_transition_key
    || ["next_config_version", "next_gain_rate", "next_normal_spacing_rate", "next_post_ath_spacing_rate"]
      .some(key => profile[key] !== null)
    || RATE_KEYS.some(key => !close(profile[key], snapshot[key]))
    || !close(profile.gain_rate, run.gain_rate)
    || !close(profile.regime === "POST_ATH" ? profile.post_ath_spacing_rate : profile.normal_spacing_rate, run.entry_spacing)
    || snapshot.regime !== profile.regime || snapshot.source_config_version !== profile.config_version
    || snapshot.ath_price !== profile.ath_price || snapshot.ath_source !== profile.ath_source)
    throw new Error("COINOPS_LIVE_ATH_PROFILE_RECOVERY_UNPROVEN");
  return JSON.stringify([profile.id, ...OWNER_KEYS.map(key => profile[key]), profile.environment,
    profile.config_version, profile.regime, ...RATE_KEYS.map(key => Number(profile[key])),
    profile.transition_key, profile.updated_at, profile.ath_price, profile.ath_source,
    profile.ath_verified_at, profile.previous_ath, profile.ath_floor_reference,
    profile.transition_observed_at, profile.transition_events]);
}

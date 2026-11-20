/** Encoding uses letters only so the activity contract never mistakes the digest for a phone number. */
export function campaignDigestEncode(bytes) {
    return Array.from(bytes, b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join("");
}
/** Hash only after marketing consent. This is pseudonymous, not anonymous. */
export async function campaignDigest(alias) {
    const bytes = new TextEncoder().encode(alias.normalize("NFC"));
    return "sha256_" + campaignDigestEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
export const isCampaignDigest = (value) => /^sha256_[a-p]{64}$/u.test(value);

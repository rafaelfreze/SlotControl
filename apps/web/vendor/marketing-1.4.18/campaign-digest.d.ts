/** Encoding uses letters only so the activity contract never mistakes the digest for a phone number. */
export declare function campaignDigestEncode(bytes: Uint8Array): string;
/** Hash only after marketing consent. This is pseudonymous, not anonymous. */
export declare function campaignDigest(alias: string): Promise<string>;
export declare const isCampaignDigest: (value: string) => boolean;

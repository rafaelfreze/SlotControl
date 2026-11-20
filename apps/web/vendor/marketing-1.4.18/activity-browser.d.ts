import { type ActivityConsent } from "./activity-contract.js";
type OrganicSocialNetwork = "instagram" | "facebook" | "google";
/** Explicit organic UTMs only. Referrers or isolated click IDs cannot prove organic traffic. */
export declare function organicSocialNetworkFromUtm(search: string): OrganicSocialNetwork | undefined;
export declare function revokeActivitySessions(): void;
/** One observer for the existing aggregate endpoint. A session token is transient
 * deduplication evidence, HMACed at ingestion; never a persistent visitor ID. */
export declare function observeActivityV2(options: {
    endpoint: string;
    pagePath?: string;
    slug?: string;
    root?: string;
    sendView?: boolean;
    onView?: () => void;
    consentKey?: string;
    sessionKey?: string;
    getConsent?: () => ActivityConsent;
    consentEvent?: string;
    attributionEnabled?: boolean;
    captureCampaign?: boolean;
    captureCampaignDigest?: boolean;
    captureOrganicSocialV2?: boolean;
    describeClick?: (anchor: HTMLAnchorElement | null, action: HTMLElement | null) => {
        linkDetail?: string;
        buttonDetail?: string;
    };
    observeConfirmedActions?: (record: (event: Event, detail: string) => void) => () => void;
    observeConfirmedContacts?: (record: (event: Event, detail: "whatsapp" | "phone" | "form") => void) => () => void;
}): () => void;
export {};

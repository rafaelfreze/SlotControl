export { createActiveEngagement, observeActiveEngagement, type EngagementProof } from "./active-engagement.js";
import type { ActivityConsent } from "./activity-contract.js";
export { observeActivityV2, revokeActivitySessions } from "./activity-browser.js";
export type OperationalAction = "page_view" | "whatsapp_click" | "phone_click";
export { claimOperationalEvent, operationalChannel, sendOperational } from "./operational-transport.js";
/** Attach only on public templates. No storage, tags, identifiers, URL query or message body. */
export declare function observeOperationalClicks({ endpoint, slug, root, sendView, onView, version, consentKey, sessionKey, getConsent, consentEvent, attributionEnabled, captureCampaign, captureCampaignDigest, captureOrganicSocialV2, }: {
    endpoint: string;
    slug?: string;
    root?: string;
    sendView?: boolean;
    onView?: () => void;
    version?: 1 | 2;
    consentKey?: string;
    sessionKey?: string;
    getConsent?: () => ActivityConsent;
    consentEvent?: string;
    attributionEnabled?: boolean;
    captureCampaign?: boolean;
    captureCampaignDigest?: boolean;
    captureOrganicSocialV2?: boolean;
}): () => void;

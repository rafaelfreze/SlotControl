/** Version 2 qualification: visible/focused active time AND real interaction,
 * or a real contact CTA. This is engagement evidence, never a person identity. */
export type EngagementInteraction = "scroll" | "relevant_click" | "contact";
export type EngagementProof = {
    activeMs: number;
    interaction: EngagementInteraction;
    scrollPercent?: number;
};
export declare function createActiveEngagement(now?: number): {
    sample(at: number, active: boolean): EngagementProof | null;
    interact(kind: EngagementInteraction, trusted: boolean, active: boolean, percent?: number): EngagementProof | null;
    readonly activeMs: number;
};
/** Scroll events can be trusted even after scrollTo(). Require a recent real
 * wheel/touch/scroll-key gesture as well; click handlers call interact directly. */
export declare function observeActiveEngagement(onQualified: (proof: EngagementProof) => void, allowed: () => boolean, onActivity?: () => boolean | void): {
    interact(kind: EngagementInteraction, event: Event): void;
    readonly activeMs: number;
    stop(): void;
};

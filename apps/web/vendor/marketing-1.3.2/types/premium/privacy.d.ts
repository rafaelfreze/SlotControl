/** In-flow, non-blocking choice. No tags, storage or inferred consent here. */
export declare function PrivacyChoice({ choice, onChoose, policyHref, operational, advancedGoogle, }: {
    choice: "unknown" | "accepted" | "declined";
    onChoose: (choice: "accepted" | "declined") => void;
    policyHref?: string;
    operational?: boolean;
    advancedGoogle?: boolean;
}): import("react").JSX.Element;

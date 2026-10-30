import type { ReactNode } from "react";
import { type HubDashboard } from "./types.js";
export type MarketingDashboardProps = {
    data: HubDashboard;
    title?: string;
    eyebrow?: string;
    basePath: string;
    query?: Record<string, string>;
    details?: ReactNode;
};
export declare function MarketingDashboard({ data, title, eyebrow, basePath, query, details }: MarketingDashboardProps): import("react").JSX.Element;

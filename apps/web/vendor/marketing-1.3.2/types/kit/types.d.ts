export declare const PRODUCTS: readonly ["onplay_fiscal", "servnexx", "zelyvara", "onfood", "nexxfitpro", "onplay_ads"];
export type Product = typeof PRODUCTS[number];
export declare const CHANNELS: readonly ["google_ads", "meta", "direct", "organic", "unknown"];
export type Channel = typeof CHANNELS[number];
export declare const CHANNEL_LABELS: Record<Channel, string>;
export declare const COUNT_METRICS: readonly ["visits", "intents", "leads", "conversations", "appointments", "closures", "purchases"];
export type CountMetric = typeof COUNT_METRICS[number];
export type Quality = "updated" | "syncing" | "partial" | "disconnected" | "empty";
export type Population = "page_views" | "sessions" | "events" | "entities";
export type MetricFact = {
    date: string;
    channel: Channel | "all";
    metric: CountMetric;
    value: number;
    population: Population;
    attribution: "first_party" | "utm" | "unattributed";
    quality: "complete" | "partial";
};
export type SourceSnapshot = {
    version: 1;
    externalTenant: string;
    from: string;
    to: string;
    timezone: string;
    currency: string;
    collectedAt: string;
    availableMetrics: CountMetric[];
    coverageStart: Partial<Record<CountMetric, string>>;
    definitions: Partial<Record<CountMetric, string>>;
    facts: MetricFact[];
};
export type HubPeriod = {
    key: "today" | "7d" | "30d" | "custom";
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    timezone: string;
    label: string;
    warning?: string;
};
export type HubMetric = {
    key: string;
    label: string;
    value: number | null;
    unit: "count" | "currency" | "percent";
    note: string;
    mobile?: boolean;
    change?: number | null;
    lowerIsBetter?: boolean;
};
export type HubChannel = {
    key: Channel;
    visits: number | null;
    leads: number | null;
    conversations: number | null;
    spend: number | null;
    share: number | null;
};
export type HubCampaign = {
    id: string;
    provider: "google_ads" | "meta";
    name: string;
    status: string;
    spend: number | null;
    officialConversions: number | null;
    cpa: number | null;
    currency: string;
    externalId: string;
};
export type HubFunnelStep = {
    key: CountMetric;
    label: string;
    value: number | null;
    rate: number | null;
    note: string;
};
export type HubTrendPoint = {
    date: string;
    visits: number | null;
    spend: number | null;
};
export type HubDashboard = {
    version: 1;
    clientName: string;
    currency: string;
    timezone: string;
    period: HubPeriod;
    channel: Channel | "all";
    quality: Quality;
    updatedAt: string | null;
    notice: string | null;
    metrics: HubMetric[];
    channels: HubChannel[];
    funnel: HubFunnelStep[];
    campaigns: HubCampaign[];
    trend: HubTrendPoint[];
    integrations: Array<{
        name: string;
        state: Quality;
        message: string;
    }>;
    insight: {
        title: string;
        detail: string;
    };
};
export type HubSummaryRequest = {
    externalTenant: string;
    from: string;
    to: string;
    channel: Channel | "all";
};
export type SourceRequest = {
    externalTenant: string;
    from: string;
    to: string;
};

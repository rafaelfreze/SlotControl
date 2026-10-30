import type { HubPeriod } from "./types.js";
export declare function validDay(value: unknown): value is string;
export declare function validTimezone(value: string): boolean;
export declare function dayInTimezone(value: Date | string, timezone: string): string;
export declare function addDays(day: string, days: number): string;
export declare function dayRange(from: string, to: string, max?: number): string[];
export declare function resolveHubPeriod(search: Record<string, string | undefined>, timezone?: string, now?: Date): HubPeriod;
/** Midnight in an IANA zone, including DST; no assumption of a fixed UTC offset. */
export declare function startOfLocalDay(day: string, timezone: string): string;

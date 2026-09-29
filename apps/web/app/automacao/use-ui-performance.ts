"use client";
import { useEffect } from "react";

/** Local measurements only. No analytics service, PII, event payload or network traffic. */
export function useUiPerformance() {
  useEffect(() => {
    performance.mark("coinops:hydrated");
    const measures: Record<string, number> = { hydratedAtMs: performance.now() };
    const target = window as typeof window & { __coinopsPerformance?: Record<string, number> };
    target.__coinopsPerformance = measures;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav) measures.ttfbMs = nav.responseStart - nav.startTime;
    const observers: PerformanceObserver[] = [];
    for (const type of ["paint", "largest-contentful-paint", "event", "longtask"]) {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === "first-contentful-paint") measures.fcpMs = entry.startTime;
          if (entry.entryType === "largest-contentful-paint") measures.lcpMs = entry.startTime;
          // Diagnostic maximum event latency, NOT a substitute for field INP/p98.
          if (entry.entryType === "event") measures.maxEventDurationMs = Math.max(measures.maxEventDurationMs ?? 0, entry.duration);
          if (entry.entryType === "longtask") measures.longTaskCount = (measures.longTaskCount ?? 0) + 1;
        }
      });
      observer.observe({ type, buffered: true, ...(type === "event" ? { durationThreshold: 16 } : {}) });
      observers.push(observer);
    }
    return () => { observers.forEach((observer) => observer.disconnect()); delete target.__coinopsPerformance; };
  }, []);
}

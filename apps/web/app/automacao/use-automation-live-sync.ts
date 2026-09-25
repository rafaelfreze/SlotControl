"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import type { AutomationView } from "./automation-center";
import type { PremiumEngine, PremiumSelection } from "./premium-operator";
import { automationSignalMatches, automationSignalScopes } from "./automation-live-scope";

type SyncStatus = "AO VIVO" | "RECONECTANDO" | "DESATUALIZADO";
const STALE_MS = 150_000;
const ONLINE_REFRESH_MS = 120_000;
const FALLBACK_REFRESH_MS = 30_000;

export function useAutomationLiveSync(view: AutomationView, engines: PremiumEngine[],
  selection: PremiumSelection, snapshotAt: string) {
  const router = useRouter();
  const scopeKey = useMemo(() => JSON.stringify(automationSignalScopes(engines, view, selection)),
    [engines, view, selection]);
  const [connected, setConnected] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(() => Date.parse(snapshotAt) || Date.now());
  const [clock, setClock] = useState(Date.now());
  const [generation, setGeneration] = useState(0);
  const lastFocus = useRef(0);
  const lastRefreshRequested = useRef(0);
  const connectedRef = useRef(false);
  const lastSyncedRef = useRef(Date.parse(snapshotAt) || Date.now());
  const pendingRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const observed = Date.parse(snapshotAt) || Date.now();
    lastSyncedRef.current = observed;
    setLastSyncedAt(observed);
  }, [snapshotAt]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    const scopes = JSON.parse(scopeKey) as ReturnType<typeof automationSignalScopes>;
    const client = createClient();
    connectedRef.current = false;
    setConnected(false);
    const refresh = (delay = 1_000) => {
      if (pendingRefresh.current) return;
      pendingRefresh.current = setTimeout(() => {
        pendingRefresh.current = null;
        if (active && document.visibilityState === "visible"
          && Date.now() - lastRefreshRequested.current > 2_000) {
          lastRefreshRequested.current = Date.now();
          router.refresh();
        }
      }, delay);
    };
    const hash = scopes.reduce((value, scope) =>
      [...scope.trading_engine_id].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, value), 0);
    const channel = scopes.length ? client.channel(`automation-refresh-${hash.toString(16)}`) : null;
    for (const scope of scopes) channel?.on("postgres_changes", {
      event: "*", schema: "coinops", table: "automation_refresh_signals",
      filter: `trading_engine_id=eq.${scope.trading_engine_id}`,
    }, (payload) => { if (active && automationSignalMatches(scope, payload.new)) refresh(); });
    channel?.subscribe((state) => {
      if (!active) return;
      connectedRef.current = state === "SUBSCRIBED";
      setConnected(connectedRef.current);
    });
    const poll = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastSyncedRef.current > (channel && connectedRef.current
        ? ONLINE_REFRESH_MS : FALLBACK_REFRESH_MS)) refresh(0);
    }, FALLBACK_REFRESH_MS);
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastFocus.current < 1_000) return;
      lastFocus.current = Date.now();
      setConnected(false);
      lastRefreshRequested.current = Date.now();
      router.refresh();
      setGeneration((current) => current + 1);
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      clearInterval(poll);
      if (pendingRefresh.current) clearTimeout(pendingRefresh.current);
      pendingRefresh.current = null;
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
      if (channel) void client.removeChannel(channel);
    };
  }, [scopeKey, generation, router]);
  const stale = clock - lastSyncedAt > STALE_MS;
  const status: SyncStatus = stale ? "DESATUALIZADO" : connected ? "AO VIVO" : "RECONECTANDO";
  return { status, lastSyncedAt, stale, recent: clock - lastSyncedAt < 30_000 };
}

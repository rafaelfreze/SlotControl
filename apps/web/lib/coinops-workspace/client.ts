"use client";

import { useCallback, useEffect, useState } from "react";

import type { CoinOpsWorkspaceData } from "./server";

export type CoinOpsWorkspaceRequestStatus = "idle" | "loading" | "success" | "error";

type CoinOpsWorkspaceClientState = {
  data: CoinOpsWorkspaceData | null;
  error: string | null;
  isDesktop: boolean;
  status: CoinOpsWorkspaceRequestStatus;
};

const DESKTOP_QUERY = "(min-width: 1024px)";

export function useCoinOpsWorkspaceData() {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<CoinOpsWorkspaceClientState>({
    data: null,
    error: null,
    isDesktop: false,
    status: "idle"
  });

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    let activeRequest: AbortController | null = null;
    let disposed = false;

    const loadForViewport = async () => {
      activeRequest?.abort();
      activeRequest = null;

      if (!media.matches) {
        if (!disposed) {
          setState({ data: null, error: null, isDesktop: false, status: "idle" });
        }
        return;
      }

      const controller = new AbortController();
      activeRequest = controller;
      setState((current) => ({
        ...current,
        error: null,
        isDesktop: true,
        status: "loading"
      }));

      try {
        const response = await fetch("/api/coinops-workspace", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`COINOPS_WORKSPACE_HTTP_${response.status}`);
        const data = await response.json() as CoinOpsWorkspaceData;
        if (!disposed && !controller.signal.aborted) {
          setState({ data, error: null, isDesktop: true, status: "success" });
        }
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setState({
          data: null,
          error: error instanceof Error ? error.message : "COINOPS_WORKSPACE_UNAVAILABLE",
          isDesktop: true,
          status: "error"
        });
      }
    };

    const handleViewportChange = () => {
      void loadForViewport();
    };

    void loadForViewport();
    media.addEventListener("change", handleViewportChange);

    return () => {
      disposed = true;
      activeRequest?.abort();
      media.removeEventListener("change", handleViewportChange);
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  return { ...state, reload };
}

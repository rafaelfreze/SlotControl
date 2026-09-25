"use client";

import { useEffect, useMemo, useState } from "react";

export type AutomationMarketState = {
  prices: Record<string, number>;
  status: "online" | "reconnecting" | "stale";
  lastUpdated: Date | null;
};

const REFERENCE = ["BTCUSDT", "SOLUSDT"];
const SYMBOL = /^[A-Z0-9]{5,24}$/;

export function validMarketSymbols(symbols: string[]): string[] {
  return [...new Set([...symbols, ...REFERENCE].filter((symbol) => SYMBOL.test(symbol)))].sort();
}

export function parseMarketTicker(value: unknown, allowed: ReadonlySet<string>): { symbol: string; price: number } | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as { data?: { s?: unknown; c?: unknown } };
  const symbol = envelope.data?.s;
  const price = Number(envelope.data?.c);
  return typeof symbol === "string" && allowed.has(symbol) && Number.isFinite(price) && price > 0
    ? { symbol, price } : null;
}

/** One market-data-only Binance stream, never an account/user-data stream. */
export function useAutomationMarketPrices(symbols: string[]): AutomationMarketState {
  const symbolsKey = useMemo(() => validMarketSymbols(symbols).join(","), [symbols]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [streamConnected, setStreamConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const names = symbolsKey.split(",").filter(Boolean);
    const allowed = new Set(names);
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let retry = 0;
    const buffered: Record<string, number> = {};
    const publish = () => {
      flushTimer = null;
      if (!active || !Object.keys(buffered).length) return;
      const batch = { ...buffered };
      for (const key of Object.keys(buffered)) delete buffered[key];
      setPrices((current) => ({ ...current, ...batch }));
      setLastUpdated(new Date());
    };
    const queue = (symbol: string, price: number) => {
      buffered[symbol] = price;
      if (!flushTimer) flushTimer = setTimeout(publish, 1_000);
    };
    const fallback = async () => {
      if (!active || document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(names))}`,
          { cache: "no-store" });
        if (!response.ok) return;
        const rows: unknown = await response.json();
        if (!active || !Array.isArray(rows)) return;
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const item = row as { symbol?: string; price?: string };
          const price = Number(item.price);
          if (item.symbol && allowed.has(item.symbol) && Number.isFinite(price) && price > 0)
            queue(item.symbol, price);
        }
      } catch { /* The stale indicator remains visible while offline. */ }
    };
    const connect = () => {
      if (!active || document.visibilityState !== "visible") return;
      try {
        socket = new WebSocket(`wss://data-stream.binance.vision/stream?streams=${names.map((name) => `${name.toLowerCase()}@miniTicker`).join("/")}`);
        socket.onopen = () => { if (active) { retry = 0; setStreamConnected(true); } };
        socket.onmessage = (event) => {
          if (!active) return;
          try { const ticker = parseMarketTicker(JSON.parse(event.data as string), allowed);
            if (ticker) queue(ticker.symbol, ticker.price); } catch { /* Invalid public tick. */ }
        };
        socket.onerror = () => { socket?.close(); };
        socket.onclose = () => {
          if (!active) return;
          setStreamConnected(false);
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(retry++, 5)));
        };
      } catch { setStreamConnected(false); reconnectTimer = setTimeout(connect, 30_000); }
    };
    void fallback();
    connect();
    const fallbackTimer = setInterval(() => { if (!socket || socket.readyState !== WebSocket.OPEN) void fallback(); }, 30_000);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void fallback();
      setGeneration((current) => current + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(fallbackTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushTimer) clearTimeout(flushTimer);
      socket?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [symbolsKey, generation]);
  const status = !lastUpdated || clock - lastUpdated.getTime() > 45_000 ? "stale"
    : streamConnected ? "online" : "reconnecting";
  return { prices, status, lastUpdated };
}

"use client";

import { useEffect, useMemo, useState } from "react";

type Asset = "BTC" | "SOL";
type PriceMap = Partial<Record<Asset, number>>;

type LivePriceState = {
  prices: PriceMap;
  lastUpdated: Date | null;
  status: "online" | "offline" | "loading";
};

const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: "BTCUSDT",
  SOL: "SOLUSDT"
};

async function fetchBinancePrice(asset: Asset) {
  const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${BINANCE_SYMBOLS[asset]}`, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Falha ao buscar ${asset}`);
  }

  const payload = (await response.json()) as { price?: string };
  const price = Number(payload.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Preco invalido para ${asset}`);
  }

  return price;
}

export function useLivePrices() {
  const [state, setState] = useState<LivePriceState>({
    prices: {},
    lastUpdated: null,
    status: "loading"
  });

  useEffect(() => {
    let active = true;

    async function loadPrices() {
      try {
        const [btc, sol] = await Promise.all([fetchBinancePrice("BTC"), fetchBinancePrice("SOL")]);

        if (!active) return;

        setState({
          prices: { BTC: btc, SOL: sol },
          lastUpdated: new Date(),
          status: "online"
        });
      } catch {
        if (!active) return;

        setState((current) => ({
          ...current,
          status: current.lastUpdated ? "offline" : "offline"
        }));
      }
    }

    void loadPrices();
    const interval = window.setInterval(loadPrices, 10000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return useMemo(
    () => ({
      ...state,
      isStale: state.status !== "online" && Boolean(state.lastUpdated)
    }),
    [state]
  );
}

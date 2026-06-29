"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { registerAutoGain } from "@/app/dashboard/actions";
import type { SlotView } from "@/lib/slotgain/types";

const AUTO_GAIN_STORAGE_KEY = "slotgain:auto-gain-enabled";
const AUTO_GAIN_EVENT = "slotgain:auto-gain-changed";

type Asset = "BTC" | "SOL";

type AutoGainNotice = {
  asset: Asset;
  message: string;
  slotNumber: number;
};

function readStoredAutoGain() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(AUTO_GAIN_STORAGE_KEY) === "true";
}

function getAssetFromSlot(slot: SlotView): Asset {
  return slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
}

export function useAutoGainSetting() {
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    setEnabledState(readStoredAutoGain());

    function syncFromStorage() {
      setEnabledState(readStoredAutoGain());
    }

    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(AUTO_GAIN_EVENT, syncFromStorage);

    return () => {
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(AUTO_GAIN_EVENT, syncFromStorage);
    };
  }, []);

  function setEnabled(nextEnabled: boolean) {
    setEnabledState(nextEnabled);
    window.localStorage.setItem(AUTO_GAIN_STORAGE_KEY, String(nextEnabled));
    window.dispatchEvent(new Event(AUTO_GAIN_EVENT));
  }

  return { enabled, setEnabled };
}

export function useAutoGainWatcher({
  enabled,
  slots,
  prices,
  readKey,
  onRegistered
}: {
  enabled: boolean;
  slots: SlotView[];
  prices: Record<Asset, number | undefined>;
  readKey: number | null;
  onRegistered: (notice: AutoGainNotice) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const confirmationsRef = useRef<Record<string, { count: number; lastReadKey: number | null }>>({});
  const lockedRef = useRef<Set<string>>(new Set());
  const onRegisteredRef = useRef(onRegistered);
  const btcPrice = prices.BTC;
  const solPrice = prices.SOL;

  useEffect(() => {
    onRegisteredRef.current = onRegistered;
  }, [onRegistered]);

  useEffect(() => {
    const openIds = new Set(slots.filter((slot) => slot.status === "aberto").map((slot) => slot.id));

    Object.keys(confirmationsRef.current).forEach((slotId) => {
      if (!openIds.has(slotId)) {
        delete confirmationsRef.current[slotId];
      }
    });

    Array.from(lockedRef.current).forEach((slotId) => {
      if (!openIds.has(slotId)) {
        lockedRef.current.delete(slotId);
      }
    });
  }, [slots]);

  useEffect(() => {
    if (!enabled || !readKey) {
      return;
    }

    slots.forEach((slot) => {
      if (slot.status !== "aberto") {
        return;
      }

      const entryPrice = Number(slot.preco_entrada || 0);
      const strategyGainRate = Number(slot.strategy?.gain_rate ?? slot.gain_rate ?? 0);
      const targetPrice = entryPrice > 0 ? entryPrice * (1 + strategyGainRate) : Number(slot.preco_alvo || 0);
      if (targetPrice <= 0) {
        return;
      }

      const asset = getAssetFromSlot(slot);
      const currentPrice = Number((asset === "SOL" ? solPrice : btcPrice) || 0);
      if (currentPrice <= 0) {
        return;
      }

      const confirmation = confirmationsRef.current[slot.id] || { count: 0, lastReadKey: null };
      if (confirmation.lastReadKey === readKey) {
        return;
      }

      confirmation.lastReadKey = readKey;
      confirmation.count = currentPrice >= targetPrice ? confirmation.count + 1 : 0;
      confirmationsRef.current[slot.id] = confirmation;

      if (confirmation.count < 2 || lockedRef.current.has(slot.id)) {
        return;
      }

      lockedRef.current.add(slot.id);

      startTransition(async () => {
        const result = await registerAutoGain({
          slotId: slot.id,
          currentPrice,
          targetPrice
        });

        if (result.registered) {
          onRegisteredRef.current({
            asset,
            message: result.message || `Gain automatico registrado no ${asset} - Slot ${slot.slot_number}`,
            slotNumber: result.slotNumber || slot.slot_number
          });
          router.refresh();
          return;
        }

        lockedRef.current.delete(slot.id);
      });
    });
  }, [btcPrice, enabled, readKey, router, slots, solPrice]);
}

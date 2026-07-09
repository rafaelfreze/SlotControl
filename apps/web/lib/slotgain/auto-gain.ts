"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { registerAutoGain, registerAutomaticEntry } from "@/app/dashboard/actions";
import type { SlotView } from "@/lib/slotgain/types";

const AUTOMATION_STORAGE_KEY = "slotgain:automation-mode";
const LEGACY_AUTO_GAIN_STORAGE_KEY = "slotgain:auto-gain-enabled";
const AUTOMATION_EVENT = "slotgain:automation-changed";
const LEGACY_AUTO_GAIN_EVENT = "slotgain:auto-gain-changed";

type Asset = "BTC" | "SOL";

export type AutomationMode = "off" | "exit_only" | "entry_exit";

type AutomationNotice = {
  asset: Asset;
  message: string;
  slotNumber: number;
};

function readStoredAutomationMode(): AutomationMode {
  if (typeof window === "undefined") {
    return "off";
  }

  const stored = window.localStorage.getItem(AUTOMATION_STORAGE_KEY);
  if (stored === "exit_only" || stored === "entry_exit" || stored === "off") {
    return stored;
  }

  return window.localStorage.getItem(LEGACY_AUTO_GAIN_STORAGE_KEY) === "true" ? "exit_only" : "off";
}

function getAssetFromSlot(slot: SlotView): Asset {
  return slot.strategy?.asset?.toUpperCase() === "SOL" ? "SOL" : "BTC";
}

export function getAutomationModeLabel(mode: AutomationMode) {
  const labels: Record<AutomationMode, string> = {
    off: "Desligado",
    exit_only: "Somente saida",
    entry_exit: "Entrada e saida"
  };

  return labels[mode];
}

export function isAutomationActive(mode: AutomationMode) {
  return mode !== "off";
}

export function useAutomationSetting(initialMode: AutomationMode = "off") {
  const [mode, setModeState] = useState<AutomationMode>(initialMode);

  useEffect(() => {
    const storedMode = readStoredAutomationMode();
    const nextMode = storedMode === "off" && initialMode !== "off" ? initialMode : storedMode;
    setModeState(nextMode);
    window.localStorage.setItem(AUTOMATION_STORAGE_KEY, nextMode);
    window.localStorage.setItem(LEGACY_AUTO_GAIN_STORAGE_KEY, String(nextMode !== "off"));

    function syncFromStorage() {
      setModeState(readStoredAutomationMode());
    }

    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(AUTOMATION_EVENT, syncFromStorage);
    window.addEventListener(LEGACY_AUTO_GAIN_EVENT, syncFromStorage);

    return () => {
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(AUTOMATION_EVENT, syncFromStorage);
      window.removeEventListener(LEGACY_AUTO_GAIN_EVENT, syncFromStorage);
    };
  }, [initialMode]);

  function setMode(nextMode: AutomationMode) {
    setModeState(nextMode);
    window.localStorage.setItem(AUTOMATION_STORAGE_KEY, nextMode);
    window.localStorage.setItem(LEGACY_AUTO_GAIN_STORAGE_KEY, String(nextMode !== "off"));
    window.dispatchEvent(new Event(AUTOMATION_EVENT));
    window.dispatchEvent(new Event(LEGACY_AUTO_GAIN_EVENT));
  }

  return { mode, setMode, enabled: mode !== "off" };
}

export function useAutoGainSetting(initialMode: AutomationMode = "off") {
  const { mode, setMode, enabled } = useAutomationSetting(initialMode);

  return {
    enabled,
    setEnabled: (nextEnabled: boolean) => setMode(nextEnabled ? "exit_only" : "off"),
    mode,
    setMode
  };
}

export function useAutomationWatcher({
  mode,
  slots,
  prices,
  readKey,
  onRegistered
}: {
  mode: AutomationMode;
  slots: SlotView[];
  prices: Record<Asset, number | undefined>;
  readKey: number | null;
  onRegistered: (notice: AutomationNotice) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const exitConfirmationsRef = useRef<Record<string, { count: number; lastReadKey: number | null }>>({});
  const lockedRef = useRef<Set<string>>(new Set());
  const onRegisteredRef = useRef(onRegistered);
  const btcPrice = prices.BTC;
  const solPrice = prices.SOL;

  useEffect(() => {
    onRegisteredRef.current = onRegistered;
  }, [onRegistered]);

  useEffect(() => {
    const activeIds = new Set(slots.filter((slot) => slot.status === "aberto" || slot.status === "hold").map((slot) => slot.id));

    Object.keys(exitConfirmationsRef.current).forEach((slotId) => {
      if (!activeIds.has(slotId)) {
        delete exitConfirmationsRef.current[slotId];
      }
    });

    Array.from(lockedRef.current).forEach((lockKey) => {
      const [, slotId] = lockKey.split(":");
      if (!activeIds.has(slotId)) {
        lockedRef.current.delete(lockKey);
      }
    });
  }, [slots]);

  useEffect(() => {
    if (mode === "off" || !readKey) {
      return;
    }

    slots.forEach((slot) => {
      const asset = getAssetFromSlot(slot);
      const currentPrice = Number((asset === "SOL" ? solPrice : btcPrice) || 0);
      if (currentPrice <= 0) {
        return;
      }

      if (mode === "entry_exit" && slot.status === "hold") {
        const entryPrice = Number(slot.preco_entrada || 0);
        const entryLockKey = `entry:${slot.id}`;

        if (entryPrice > 0 && currentPrice <= entryPrice && !lockedRef.current.has(entryLockKey)) {
          lockedRef.current.add(entryLockKey);

          startTransition(async () => {
            const result = await registerAutomaticEntry({
              slotId: slot.id,
              currentPrice
            });

            if (result.registered) {
              onRegisteredRef.current({
                asset,
                message: result.message || `Entrada automatica registrada no ${asset} - Slot ${slot.slot_number}`,
                slotNumber: result.slotNumber || slot.slot_number
              });
              router.refresh();
              return;
            }

            lockedRef.current.delete(entryLockKey);
          });
        }

        return;
      }

      if (slot.status !== "aberto") {
        return;
      }

      const entryPrice = Number(slot.preco_entrada || 0);
      const strategyGainRate = Number(slot.strategy?.gain_rate ?? slot.gain_rate ?? 0);
      const targetPrice = entryPrice > 0 ? entryPrice * (1 + strategyGainRate) : Number(slot.preco_alvo || 0);
      if (targetPrice <= 0) {
        return;
      }

      const confirmation = exitConfirmationsRef.current[slot.id] || { count: 0, lastReadKey: null };
      if (confirmation.lastReadKey === readKey) {
        return;
      }

      confirmation.lastReadKey = readKey;
      confirmation.count = currentPrice >= targetPrice ? confirmation.count + 1 : 0;
      exitConfirmationsRef.current[slot.id] = confirmation;

      const exitLockKey = `exit:${slot.id}`;
      if (confirmation.count < 2 || lockedRef.current.has(exitLockKey)) {
        return;
      }

      lockedRef.current.add(exitLockKey);

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

        lockedRef.current.delete(exitLockKey);
      });
    });
  }, [btcPrice, mode, readKey, router, slots, solPrice]);
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
  onRegistered: (notice: AutomationNotice) => void;
}) {
  useAutomationWatcher({
    mode: enabled ? "exit_only" : "off",
    slots,
    prices,
    readKey,
    onRegistered
  });
}

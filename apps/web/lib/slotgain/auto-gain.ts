"use client";

import { useEffect, useRef, useState } from "react";

import { updateAutomationMode } from "@/app/dashboard/actions";

const AUTOMATION_STORAGE_KEY = "slotgain:automation-mode";
const LEGACY_AUTO_GAIN_STORAGE_KEY = "slotgain:auto-gain-enabled";
const AUTOMATION_EVENT = "slotgain:automation-changed";
const LEGACY_AUTO_GAIN_EVENT = "slotgain:auto-gain-changed";

export type AutomationMode = "off" | "exit_only" | "entry_exit";

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
  const hasSyncedStoredModeRef = useRef(false);

  useEffect(() => {
    const storedMode = readStoredAutomationMode();
    const nextMode = storedMode === "off" && initialMode !== "off" ? initialMode : storedMode;
    setModeState(nextMode);
    window.localStorage.setItem(AUTOMATION_STORAGE_KEY, nextMode);
    window.localStorage.setItem(LEGACY_AUTO_GAIN_STORAGE_KEY, String(nextMode !== "off"));

    if (!hasSyncedStoredModeRef.current && storedMode !== "off" && storedMode !== initialMode) {
      hasSyncedStoredModeRef.current = true;
      void updateAutomationMode(storedMode).catch(() => {
        hasSyncedStoredModeRef.current = false;
      });
    }

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

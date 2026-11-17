"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { EngineState, PlaybackEngine } from "@/lib/playback/engine";

/** Subscribe to a slice of the playback engine's state. The selector must return a primitive. */
export function useEngineState<T>(engine: PlaybackEngine, selector: (s: EngineState) => T): T {
  return useSyncExternalStore(
    engine.subscribe,
    () => selector(engine.getSnapshot()),
    () => selector(engine.getSnapshot()),
  );
}

export interface Prefs {
  captions: boolean;
  rate: number;
  muted: boolean;
}

const DEFAULTS: Prefs = { captions: true, rate: 1, muted: false };
const KEY = "wbt:prefs";
const EVENT = "wbt:prefs-changed";

function subscribePrefs(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** Fallback used when localStorage is unavailable (private mode, blocked cookies). */
let memoryRaw = "";

function readRaw(): string {
  try {
    return localStorage.getItem(KEY) ?? memoryRaw;
  } catch {
    return memoryRaw;
  }
}

/** Viewer preferences kept in localStorage, exposed through useSyncExternalStore. */
export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const raw = useSyncExternalStore(subscribePrefs, readRaw, () => "");
  const prefs = useMemo<Prefs>(() => {
    try {
      return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
    } catch {
      return DEFAULTS;
    }
  }, [raw]);

  const update = useCallback((patch: Partial<Prefs>) => {
    let current = DEFAULTS;
    try {
      const stored = readRaw();
      if (stored) current = { ...DEFAULTS, ...(JSON.parse(stored) as Partial<Prefs>) };
    } catch {
      /* corrupt value: start from defaults */
    }
    memoryRaw = JSON.stringify({ ...current, ...patch });
    try {
      localStorage.setItem(KEY, memoryRaw);
    } catch {
      /* kept in memory for this session */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [prefs, update];
}

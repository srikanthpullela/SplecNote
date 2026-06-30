// Theme management for Splec Note.
// Light is the default. Modes: 'light' | 'dark' | 'system'.
// The chosen mode is persisted via tauri-plugin-store (with a localStorage fallback
// so the frontend also works when served by plain Vite outside of Tauri).

import { load, type Store } from "@tauri-apps/plugin-store";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORE_FILE = "splec-settings.json";
const THEME_KEY = "themeMode";
const DEFAULT_MODE: ThemeMode = "light";

let storePromise: Promise<Store> | null = null;

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

async function getStore(): Promise<Store | null> {
  if (!isTauri()) return null;
  if (!storePromise) storePromise = load(STORE_FILE, { defaults: {}, autoSave: true });
  try {
    return await storePromise;
  } catch {
    return null;
  }
}

export async function loadThemeMode(): Promise<ThemeMode> {
  try {
    const store = await getStore();
    if (store) {
      const value = await store.get<ThemeMode>(THEME_KEY);
      if (value === "light" || value === "dark" || value === "system") {
        return value;
      }
    } else if (typeof localStorage !== "undefined") {
      const value = localStorage.getItem(THEME_KEY) as ThemeMode | null;
      if (value === "light" || value === "dark" || value === "system") {
        return value;
      }
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_MODE;
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  try {
    const store = await getStore();
    if (store) {
      await store.set(THEME_KEY, mode);
      await store.save();
      return;
    }
  } catch {
    /* fall back to localStorage */
  }
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* ignore persistence failures */
  }
}

const darkQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") {
    return darkQuery()?.matches ? "dark" : "light";
  }
  return mode;
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  return resolved;
}

/** Cycle order surfaced by the toggle: Light → Dark → System → Light. */
export function nextMode(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
}

/**
 * Watch OS theme changes. The callback fires only while the active mode is
 * 'system'. Returns a disposer.
 */
export function watchSystemTheme(
  getMode: () => ThemeMode,
  onChange: (resolved: ResolvedTheme) => void,
): () => void {
  const mq = darkQuery();
  if (!mq) return () => {};
  const handler = () => {
    if (getMode() === "system") {
      onChange(mq.matches ? "dark" : "light");
    }
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

// User preferences, persisted via tauri-plugin-store (localStorage fallback for
// plain Vite). Theme lives in theme.ts; everything else lives here.

import { load, type Store } from "@tauri-apps/plugin-store";

export interface Prefs {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  defaultLanguage: string;
  /** Show whitespace markers (spaces/tabs) in the editor. */
  showWhitespace: boolean;
  /** Show indent guides in the editor. */
  indentGuides: boolean;
  /** Continuously mirror buffers to backups (the "never lose work" engine). */
  autosave: boolean;
  /** Reopen the previous session (incl. unsaved untitled tabs) on launch. */
  restoreSession: boolean;
  /** Launch Splec Note automatically when you log in. */
  openAtLogin: boolean;
  /** Editor color theme id ("auto" follows the app light/dark chrome). */
  editorTheme: string;
}

export const DEFAULT_PREFS: Prefs = {
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  defaultLanguage: "plaintext",
  showWhitespace: false,
  indentGuides: true,
  autosave: true,
  restoreSession: true,
  openAtLogin: false,
  editorTheme: "auto",
};

const STORE_FILE = "splec-settings.json";
const PREFS_KEY = "prefs";

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

function sanitize(p: Partial<Prefs> | null | undefined): Prefs {
  const merged = { ...DEFAULT_PREFS, ...(p ?? {}) };
  merged.fontSize = Math.min(28, Math.max(10, Math.round(merged.fontSize)));
  merged.tabSize = Math.min(8, Math.max(1, Math.round(merged.tabSize)));
  merged.wordWrap = Boolean(merged.wordWrap);
  merged.showWhitespace = Boolean(merged.showWhitespace);
  merged.indentGuides = merged.indentGuides === undefined ? true : Boolean(merged.indentGuides);
  merged.autosave = merged.autosave === undefined ? true : Boolean(merged.autosave);
  merged.restoreSession =
    merged.restoreSession === undefined ? true : Boolean(merged.restoreSession);
  merged.openAtLogin = Boolean(merged.openAtLogin);
  if (typeof merged.defaultLanguage !== "string") merged.defaultLanguage = "plaintext";
  if (typeof merged.editorTheme !== "string" || !merged.editorTheme) merged.editorTheme = "auto";
  return merged;
}

export async function loadPrefs(): Promise<Prefs> {
  try {
    const store = await getStore();
    if (store) {
      return sanitize(await store.get<Partial<Prefs>>(PREFS_KEY));
    }
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) return sanitize(JSON.parse(raw));
    }
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_PREFS };
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  const clean = sanitize(prefs);
  try {
    const store = await getStore();
    if (store) {
      await store.set(PREFS_KEY, clean);
      await store.save();
      return;
    }
  } catch {
    /* fall back */
  }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(clean));
  } catch {
    /* ignore */
  }
}

// Editor theme registry for Splec Note.
//
// The *editor* theme (colors of the code surface) is independent of the app
// *chrome* light/dark mode. Built-in themes ship here; users can also import a
// simple JSON token-color theme. The chosen theme id + any imported themes are
// persisted via tauri-plugin-store (localStorage fallback for plain Vite).

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { ResolvedTheme } from "./theme";

const fontStack =
  "'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace";

/** A flat palette that can drive both the surface theme and the token highlight. */
export interface ThemePalette {
  background: string;
  foreground: string;
  caret: string;
  selection: string;
  lineHighlight: string;
  gutterBackground: string;
  gutterForeground: string;
  gutterActive: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  variable: string;
  operator: string;
  heading: string;
  invalid: string;
  matchingBracket: string;
}

export interface EditorThemeDef {
  id: string;
  label: string;
  dark: boolean;
  /** True for user-imported themes (persisted, removable). */
  custom?: boolean;
  palette: ThemePalette;
}

function buildExtension(def: EditorThemeDef): Extension {
  const p = def.palette;
  const surface = EditorView.theme(
    {
      "&": { color: p.foreground, backgroundColor: p.background, height: "100%" },
      ".cm-scroller": { fontFamily: fontStack, lineHeight: "1.7" },
      ".cm-content": { caretColor: p.caret, padding: "14px 0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.caret },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: p.selection,
      },
      ".cm-activeLine": { backgroundColor: p.lineHighlight },
      ".cm-gutters": {
        backgroundColor: p.gutterBackground,
        color: p.gutterForeground,
        border: "none",
        paddingRight: "6px",
      },
      ".cm-activeLineGutter": { backgroundColor: p.lineHighlight, color: p.gutterActive },
      ".cm-foldPlaceholder": {
        backgroundColor: p.lineHighlight,
        border: "none",
        color: p.keyword,
      },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: p.matchingBracket,
        outline: "none",
      },
    },
    { dark: def.dark },
  );

  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: p.keyword, fontWeight: "600" },
    { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: p.variable },
    { tag: [t.function(t.variableName), t.labelName], color: p.function },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: p.number },
    {
      tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.namespace],
      color: p.type,
    },
    { tag: [t.operator, t.operatorKeyword], color: p.operator },
    { tag: [t.number, t.bool, t.atom], color: p.number },
    { tag: [t.string, t.special(t.string), t.regexp], color: p.string },
    { tag: [t.meta, t.comment], color: p.comment, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.link, color: p.function, textDecoration: "underline" },
    { tag: t.heading, color: p.heading, fontWeight: "700" },
    { tag: t.invalid, color: p.invalid },
  ]);

  return [
    surface,
    syntaxHighlighting(highlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  ];
}

// ---- Built-in palettes -----------------------------------------------------

const splecLight: ThemePalette = {
  background: "#ffffff",
  foreground: "#1c1830",
  caret: "#7c5cff",
  selection: "#e3dcff",
  lineHighlight: "rgba(124, 92, 255, 0.06)",
  gutterBackground: "#ffffff",
  gutterForeground: "#b6aecb",
  gutterActive: "#7c5cff",
  comment: "#8a86a0",
  keyword: "#7c3aed",
  string: "#0a7d52",
  number: "#b5530a",
  function: "#2f6df0",
  type: "#b2229a",
  variable: "#1c1830",
  operator: "#5b3ff0",
  heading: "#5b3ff0",
  invalid: "#e11d48",
  matchingBracket: "rgba(124, 92, 255, 0.16)",
};

const splecDark: ThemePalette = {
  background: "#0b0d16",
  foreground: "#e7e6f0",
  caret: "#9db4ff",
  selection: "#2a2550",
  lineHighlight: "rgba(157, 180, 255, 0.07)",
  gutterBackground: "#0b0d16",
  gutterForeground: "#4a4763",
  gutterActive: "#9db4ff",
  comment: "#6f6b8a",
  keyword: "#c4b5ff",
  string: "#7ee0b8",
  number: "#ffd6a3",
  function: "#9db4ff",
  type: "#ff9ed8",
  variable: "#e7e6f0",
  operator: "#c4b5ff",
  heading: "#b9a8ff",
  invalid: "#ff6b81",
  matchingBracket: "rgba(157, 180, 255, 0.18)",
};

const highContrast: ThemePalette = {
  background: "#000000",
  foreground: "#ffffff",
  caret: "#ffffff",
  selection: "#3a3a8a",
  lineHighlight: "rgba(255, 255, 255, 0.10)",
  gutterBackground: "#000000",
  gutterForeground: "#8a8a8a",
  gutterActive: "#ffffff",
  comment: "#9aa0b4",
  keyword: "#7ad0ff",
  string: "#7dffb0",
  number: "#ffd24a",
  function: "#ffd24a",
  type: "#ff8df0",
  variable: "#ffffff",
  operator: "#7ad0ff",
  heading: "#7ad0ff",
  invalid: "#ff5a6a",
  matchingBracket: "rgba(255, 255, 255, 0.28)",
};

const sepia: ThemePalette = {
  background: "#f4ecd8",
  foreground: "#43361f",
  caret: "#a8642a",
  selection: "#e4d3a8",
  lineHighlight: "rgba(168, 100, 42, 0.10)",
  gutterBackground: "#f4ecd8",
  gutterForeground: "#a89b7a",
  gutterActive: "#a8642a",
  comment: "#9a8b6a",
  keyword: "#9a5b1e",
  string: "#5c7a2e",
  number: "#a8642a",
  function: "#7a5a1e",
  type: "#9a3b6a",
  variable: "#43361f",
  operator: "#9a5b1e",
  heading: "#7a4a1e",
  invalid: "#c0392b",
  matchingBracket: "rgba(168, 100, 42, 0.22)",
};

export const BUILTIN_THEMES: EditorThemeDef[] = [
  { id: "splec-light", label: "Splec Light", dark: false, palette: splecLight },
  { id: "splec-dark", label: "Splec Dark", dark: true, palette: splecDark },
  { id: "high-contrast", label: "High Contrast", dark: true, palette: highContrast },
  { id: "sepia", label: "Sepia Note", dark: false, palette: sepia },
];

// ---- Custom (imported) themes + persistence --------------------------------

const STORE_FILE = "splec-settings.json";
const CUSTOM_KEY = "customThemes";

let customThemes: EditorThemeDef[] = [];
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

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v : fallback;
}

/**
 * Build a theme def from a loosely-typed JSON object. Accepts either a flat
 * `{ colors: {...} }` shape or top-level color keys. Missing colors fall back
 * to a sensible base (Splec Light or Dark depending on `dark`).
 */
export function paletteFromJson(json: any, idHint: string): EditorThemeDef {
  const dark = Boolean(json?.dark);
  const base = dark ? splecDark : splecLight;
  const c = (json?.colors ?? json ?? {}) as Record<string, unknown>;
  const pick = (k: keyof ThemePalette) => str(c[k], base[k]);
  const palette: ThemePalette = {
    background: pick("background"),
    foreground: pick("foreground"),
    caret: pick("caret"),
    selection: pick("selection"),
    lineHighlight: pick("lineHighlight"),
    gutterBackground: str(c.gutterBackground, str(c.background, base.gutterBackground)),
    gutterForeground: pick("gutterForeground"),
    gutterActive: pick("gutterActive"),
    comment: pick("comment"),
    keyword: pick("keyword"),
    string: pick("string"),
    number: pick("number"),
    function: pick("function"),
    type: pick("type"),
    variable: str(c.variable, str(c.foreground, base.variable)),
    operator: pick("operator"),
    heading: str(c.heading, str(c.keyword, base.heading)),
    invalid: pick("invalid"),
    matchingBracket: pick("matchingBracket"),
  };
  const label = str(json?.name ?? json?.label, idHint);
  const id = "custom:" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return { id, label, dark, custom: true, palette };
}

export async function loadCustomThemes(): Promise<void> {
  try {
    const store = await getStore();
    let raw: unknown = null;
    if (store) raw = await store.get(CUSTOM_KEY);
    else if (typeof localStorage !== "undefined") {
      const s = localStorage.getItem(CUSTOM_KEY);
      raw = s ? JSON.parse(s) : null;
    }
    if (Array.isArray(raw)) {
      customThemes = raw
        .filter((d) => d && typeof d === "object" && d.palette && d.id)
        .map((d) => ({ ...d, custom: true }) as EditorThemeDef);
    }
  } catch {
    customThemes = [];
  }
}

async function persistCustomThemes(): Promise<void> {
  try {
    const store = await getStore();
    if (store) {
      await store.set(CUSTOM_KEY, customThemes);
      await store.save();
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customThemes));
  } catch {
    /* ignore */
  }
}

export async function addCustomTheme(def: EditorThemeDef): Promise<void> {
  customThemes = [...customThemes.filter((d) => d.id !== def.id), def];
  await persistCustomThemes();
}

export function allThemes(): EditorThemeDef[] {
  return [...BUILTIN_THEMES, ...customThemes];
}

export function findTheme(id: string): EditorThemeDef | undefined {
  return allThemes().find((d) => d.id === id);
}

const extCache = new Map<string, Extension>();

/**
 * Resolve a theme id to a CodeMirror extension. The special id "auto" follows
 * the app chrome: Splec Light in light chrome, Splec Dark in dark chrome.
 */
export function resolveThemeExtension(themeId: string, chrome: ResolvedTheme): Extension {
  let def: EditorThemeDef | undefined;
  if (themeId === "auto" || !themeId) {
    def = chrome === "dark" ? BUILTIN_THEMES[1] : BUILTIN_THEMES[0];
  } else {
    def = findTheme(themeId);
  }
  if (!def) def = chrome === "dark" ? BUILTIN_THEMES[1] : BUILTIN_THEMES[0];
  const cached = extCache.get(def.id);
  if (cached) return cached;
  const ext = buildExtension(def);
  extCache.set(def.id, ext);
  return ext;
}

/** Whether the resolved editor theme is dark (used for chrome-independent UI bits). */
export function themeIsDark(themeId: string, chrome: ResolvedTheme): boolean {
  if (themeId === "auto" || !themeId) return chrome === "dark";
  return findTheme(themeId)?.dark ?? chrome === "dark";
}

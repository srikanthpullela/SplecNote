// User-Defined Languages (Notepad++ "UDL"). Users define keyword sets and
// comment/string delimiters; we build a CodeMirror StreamLanguage from that
// definition so their custom syntax highlights. Definitions persist via
// tauri-plugin-store (localStorage fallback for plain Vite dev).

import type { Extension } from "@codemirror/state";
import { load, type Store } from "@tauri-apps/plugin-store";
import { registerUdlResolver, type PickerEntry } from "./languages";

const STORE_FILE = "splec-settings.json";
const UDL_KEY = "udlLanguages";

export interface UdlDef {
  id: string; // slug, stored without the "udl:" prefix
  name: string;
  keywords: string[];
  types: string[];
  lineComment: string;
  blockStart: string;
  blockEnd: string;
  strings: string[];
  caseInsensitive: boolean;
}

export function emptyUdl(): UdlDef {
  return {
    id: "",
    name: "",
    keywords: [],
    types: [],
    lineComment: "//",
    blockStart: "/*",
    blockEnd: "*/",
    strings: ['"', "'"],
    caseInsensitive: false,
  };
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `udl-${Date.now()}`
  );
}

let udls: UdlDef[] = [];
let storePromise: Promise<Store> | null = null;
const extCache = new Map<string, Extension>();

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

function sanitize(raw: any): UdlDef | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length > 0) : [];
  const str = (v: unknown, fb: string): string => (typeof v === "string" ? v : fb);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : slugify(name),
    name,
    keywords: list(raw.keywords),
    types: list(raw.types),
    lineComment: str(raw.lineComment, ""),
    blockStart: str(raw.blockStart, ""),
    blockEnd: str(raw.blockEnd, ""),
    strings: list(raw.strings).length ? list(raw.strings) : ['"', "'"],
    caseInsensitive: Boolean(raw.caseInsensitive),
  };
}

export async function loadUdls(): Promise<void> {
  try {
    const store = await getStore();
    let raw: unknown = null;
    if (store) raw = await store.get(UDL_KEY);
    else if (typeof localStorage !== "undefined") {
      const s = localStorage.getItem(UDL_KEY);
      raw = s ? JSON.parse(s) : null;
    }
    udls = Array.isArray(raw) ? raw.map(sanitize).filter((d): d is UdlDef => !!d) : [];
  } catch {
    udls = [];
  }
}

async function persist(): Promise<void> {
  try {
    const store = await getStore();
    if (store) {
      await store.set(UDL_KEY, udls);
      await store.save();
      return;
    }
  } catch {
    /* fall through to localStorage */
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(UDL_KEY, JSON.stringify(udls));
  }
}

export function allUdls(): UdlDef[] {
  return [...udls];
}

export function findUdl(idOrLang: string): UdlDef | undefined {
  const id = idOrLang.startsWith("udl:") ? idOrLang.slice(4) : idOrLang;
  return udls.find((d) => d.id === id);
}

export async function saveUdl(def: UdlDef): Promise<UdlDef> {
  const clean = sanitize(def);
  if (!clean) throw new Error("A name is required for a user-defined language.");
  if (!clean.id) clean.id = slugify(clean.name);
  udls = [...udls.filter((d) => d.id !== clean.id), clean];
  extCache.delete(`udl:${clean.id}`);
  await persist();
  return clean;
}

export async function removeUdl(id: string): Promise<void> {
  const slug = id.startsWith("udl:") ? id.slice(4) : id;
  udls = udls.filter((d) => d.id !== slug);
  extCache.delete(`udl:${slug}`);
  await persist();
}

async function buildExtension(def: UdlDef): Promise<Extension> {
  const { StreamLanguage } = await import("@codemirror/language");
  const fold = def.caseInsensitive ? (s: string) => s.toLowerCase() : (s: string) => s;
  const keywords = new Set(def.keywords.map(fold));
  const types = new Set(def.types.map(fold));
  const { lineComment, blockStart, blockEnd, strings } = def;

  return StreamLanguage.define<{ inBlock: boolean }>({
    name: `udl-${def.id}`,
    startState: () => ({ inBlock: false }),
    token(stream, state) {
      if (state.inBlock) {
        if (blockEnd) {
          while (!stream.eol()) {
            if (stream.match(blockEnd)) {
              state.inBlock = false;
              break;
            }
            stream.next();
          }
        } else {
          stream.skipToEnd();
        }
        return "comment";
      }
      if (stream.eatSpace()) return null;

      if (blockStart && stream.match(blockStart)) {
        state.inBlock = true;
        return "comment";
      }
      if (lineComment && stream.match(lineComment)) {
        stream.skipToEnd();
        return "comment";
      }

      const ch = stream.peek();
      if (ch && strings.includes(ch)) {
        stream.next();
        let esc = false;
        let c: string | void;
        while ((c = stream.next()) != null) {
          if (c === ch && !esc) break;
          esc = !esc && c === "\\";
        }
        return "string";
      }

      if (stream.match(/^0x[\da-f]+/i) || stream.match(/^-?\d[\d_]*\.?\d*(e[-+]?\d+)?/i)) {
        return "number";
      }

      const word = stream.match(/^[A-Za-z_$][\w$]*/);
      if (word) {
        const w = fold(String(word));
        if (keywords.has(w)) return "keyword";
        if (types.has(w)) return "type";
        return null;
      }
      stream.next();
      return null;
    },
  });
}

function entries(): PickerEntry[] {
  return udls.map((d) => ({ id: `udl:${d.id}`, label: d.name }));
}

// Wire UDLs into the language registry so the picker, labels, and editor
// extension loader all understand "udl:<id>" language ids.
registerUdlResolver({
  label: (id) => findUdl(id)?.name ?? null,
  load: (id) => {
    const def = findUdl(id);
    if (!def) return null;
    const key = `udl:${def.id}`;
    const cached = extCache.get(key);
    if (cached) return Promise.resolve(cached);
    return buildExtension(def).then((ext) => {
      extCache.set(key, ext);
      return ext;
    });
  },
  entries,
});

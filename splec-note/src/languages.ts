// Language registry for Splec Note.
// - Lazy-loads CodeMirror language packs on demand (keeps the initial bundle small).
// - Maps file extensions to a language id (reused from the old CongaCode fileAssociations).

import type { Extension } from "@codemirror/state";

// Legacy (stream-parser) modes, imported explicitly so Vite can bundle each one.
// Each entry resolves to the parser object exported by the legacy-modes package.
const LEGACY_LOADERS: Record<string, () => Promise<any>> = {
  shell: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  ruby: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
  lua: () => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua),
  swift: () => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift),
  clike: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.clike),
  r: () => import("@codemirror/legacy-modes/mode/r").then((m) => m.r),
  kotlin: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  scala: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala),
  csharp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp),
  dart: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart),
  objectivec: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveC),
  properties: () => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  perl: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),
  powershell: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
  dockerfile: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile),
  groovy: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy),
  clojure: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),
  haskell: () => import("@codemirror/legacy-modes/mode/haskell").then((m) => m.haskell),
  julia: () => import("@codemirror/legacy-modes/mode/julia").then((m) => m.julia),
  diff: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
  nginx: () => import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx),
};

export interface LanguageDef {
  id: string;
  label: string;
  load: () => Promise<Extension>;
}

async function stream(modeName: string): Promise<Extension> {
  const [{ StreamLanguage }, parser] = await Promise.all([
    import("@codemirror/language"),
    LEGACY_LOADERS[modeName](),
  ]);
  return StreamLanguage.define(parser);
}

// A lightweight, language-agnostic highlighter so files without a dedicated
// pack still get keyword/comment/string/number coloring instead of flat text.
const GENERIC_KEYWORDS = new Set([
  "if", "else", "elif", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "function", "func", "fn", "def", "class", "struct", "enum",
  "interface", "trait", "impl", "import", "export", "from", "use", "package", "module",
  "namespace", "public", "private", "protected", "static", "const", "let", "var", "val",
  "new", "delete", "try", "catch", "finally", "throw", "throws", "async", "await", "yield",
  "true", "false", "null", "nil", "none", "void", "int", "float", "double", "bool", "string",
  "char", "long", "short", "unsigned", "signed", "type", "typedef", "extends", "implements",
  "super", "this", "self", "end", "then", "begin", "when", "unless", "until", "with", "in", "is",
]);

async function genericFallback(): Promise<Extension> {
  const { StreamLanguage } = await import("@codemirror/language");
  return StreamLanguage.define({
    name: "generic",
    startState: () => ({ inBlock: false }),
    token(stream: any, state: any) {
      if (state.inBlock) {
        if (stream.match(/.*?\*\//)) state.inBlock = false;
        else stream.skipToEnd();
        return "comment";
      }
      if (stream.eatSpace()) return null;
      // Block + line comments (covers // # -- ; ' styles).
      if (stream.match("/*")) {
        state.inBlock = true;
        return "comment";
      }
      if (stream.match("//") || stream.match("--") || stream.match("#") || stream.match(";")) {
        stream.skipToEnd();
        return "comment";
      }
      // Strings.
      const ch = stream.peek();
      if (ch === '"' || ch === "'" || ch === "`") {
        stream.next();
        let esc = false;
        let c: string | void;
        while ((c = stream.next()) != null) {
          if (c === ch && !esc) break;
          esc = !esc && c === "\\";
        }
        return "string";
      }
      // Numbers.
      if (stream.match(/^0x[\da-f]+/i) || stream.match(/^-?\d[\d_]*\.?\d*(e[-+]?\d+)?/i)) {
        return "number";
      }
      // Identifiers / keywords.
      if (stream.match(/^[A-Za-z_$][\w$]*/)) {
        return GENERIC_KEYWORDS.has(stream.current()) ? "keyword" : null;
      }
      stream.next();
      return null;
    },
  });
}

// id -> definition. `plaintext` is the no-highlight fallback.
export const LANGUAGES: Record<string, LanguageDef> = {
  plaintext: { id: "plaintext", label: "Plain Text", load: async () => [] },
  markdown: {
    id: "markdown",
    label: "Markdown",
    load: async () => (await import("@codemirror/lang-markdown")).markdown({ codeLanguages: [] }),
  },
  javascript: {
    id: "javascript",
    label: "JavaScript",
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  },
  typescript: {
    id: "typescript",
    label: "TypeScript",
    load: async () =>
      (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  },
  json: {
    id: "json",
    label: "JSON",
    load: async () => (await import("@codemirror/lang-json")).json(),
  },
  html: {
    id: "html",
    label: "HTML",
    load: async () => (await import("@codemirror/lang-html")).html(),
  },
  css: {
    id: "css",
    label: "CSS",
    load: async () => (await import("@codemirror/lang-css")).css(),
  },
  python: {
    id: "python",
    label: "Python",
    load: async () => (await import("@codemirror/lang-python")).python(),
  },
  rust: {
    id: "rust",
    label: "Rust",
    load: async () => (await import("@codemirror/lang-rust")).rust(),
  },
  cpp: {
    id: "cpp",
    label: "C / C++",
    load: async () => (await import("@codemirror/lang-cpp")).cpp(),
  },
  java: {
    id: "java",
    label: "Java",
    load: async () => (await import("@codemirror/lang-java")).java(),
  },
  go: {
    id: "go",
    label: "Go",
    load: async () => (await import("@codemirror/lang-go")).go(),
  },
  php: {
    id: "php",
    label: "PHP",
    load: async () => (await import("@codemirror/lang-php")).php(),
  },
  sql: {
    id: "sql",
    label: "SQL",
    load: async () => (await import("@codemirror/lang-sql")).sql(),
  },
  yaml: {
    id: "yaml",
    label: "YAML",
    load: async () => (await import("@codemirror/lang-yaml")).yaml(),
  },
  xml: {
    id: "xml",
    label: "XML",
    load: async () => (await import("@codemirror/lang-xml")).xml(),
  },
  shell: { id: "shell", label: "Shell", load: () => stream("shell") },
  ruby: { id: "ruby", label: "Ruby", load: () => stream("ruby") },
  toml: { id: "toml", label: "TOML", load: () => stream("toml") },
  lua: { id: "lua", label: "Lua", load: () => stream("lua") },
  swift: { id: "swift", label: "Swift", load: () => stream("swift") },
  kotlin: { id: "kotlin", label: "Kotlin", load: () => stream("kotlin") },
  scala: { id: "scala", label: "Scala", load: () => stream("scala") },
  csharp: { id: "csharp", label: "C#", load: () => stream("csharp") },
  dart: { id: "dart", label: "Dart", load: () => stream("dart") },
  objectivec: { id: "objectivec", label: "Objective-C", load: () => stream("objectivec") },
  groovy: { id: "groovy", label: "Groovy", load: () => stream("groovy") },
  perl: { id: "perl", label: "Perl", load: () => stream("perl") },
  powershell: { id: "powershell", label: "PowerShell", load: () => stream("powershell") },
  dockerfile: { id: "dockerfile", label: "Dockerfile", load: () => stream("dockerfile") },
  clojure: { id: "clojure", label: "Clojure", load: () => stream("clojure") },
  haskell: { id: "haskell", label: "Haskell", load: () => stream("haskell") },
  julia: { id: "julia", label: "Julia", load: () => stream("julia") },
  nginx: { id: "nginx", label: "Nginx", load: () => stream("nginx") },
  diff: { id: "diff", label: "Diff / Patch", load: () => stream("diff") },
  properties: { id: "properties", label: "INI / Properties", load: () => stream("properties") },
  clike: { id: "clike", label: "C-like", load: () => stream("clike") },
  r: { id: "r", label: "R", load: () => stream("r") },
  generic: { id: "generic", label: "Code (generic)", load: () => genericFallback() },
};

// Order shown in the status-bar language picker.
export const PICKER_ORDER = [
  "plaintext",
  "markdown",
  "javascript",
  "typescript",
  "json",
  "html",
  "css",
  "python",
  "rust",
  "cpp",
  "java",
  "go",
  "php",
  "sql",
  "yaml",
  "xml",
  "shell",
  "ruby",
  "toml",
  "lua",
  "swift",
  "kotlin",
  "scala",
  "csharp",
  "dart",
  "objectivec",
  "groovy",
  "perl",
  "powershell",
  "dockerfile",
  "clojure",
  "haskell",
  "julia",
  "nginx",
  "diff",
  "properties",
  "r",
  "generic",
];

// File extension (lowercase, no dot) -> language id.
const EXT_TO_ID: Record<string, string> = {
  txt: "plaintext",
  text: "plaintext",
  log: "plaintext",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  scss: "css",
  less: "css",
  py: "python",
  pyw: "python",
  rs: "rust",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  java: "java",
  go: "go",
  php: "php",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  svg: "xml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  rb: "ruby",
  toml: "toml",
  lua: "lua",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  cs: "csharp",
  csx: "csharp",
  dart: "dart",
  m: "objectivec",
  mm: "objectivec",
  groovy: "groovy",
  gradle: "groovy",
  pl: "perl",
  pm: "perl",
  ps1: "powershell",
  psm1: "powershell",
  clj: "clojure",
  cljs: "clojure",
  edn: "clojure",
  hs: "haskell",
  jl: "julia",
  diff: "diff",
  patch: "diff",
  ini: "properties",
  cfg: "properties",
  conf: "properties",
  properties: "properties",
  env: "properties",
  r: "r",
  // Code-ish formats without a dedicated pack fall back to the generic highlighter.
  pp: "generic",
  groovysh: "generic",
  vim: "generic",
  tf: "generic",
  hcl: "generic",
  proto: "generic",
  gql: "generic",
  graphql: "generic",
  cmake: "generic",
  awk: "generic",
  sed: "generic",
  bat: "generic",
  cmd: "generic",
};

export function languageIdForFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower === "makefile" || lower === "gnumakefile") return "generic";
  if (lower === "cmakelists.txt") return "generic";
  if (lower === ".gitconfig" || lower === ".editorconfig" || lower === ".npmrc") return "properties";
  if (lower === ".env" || lower.startsWith(".env.")) return "properties";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = lower.slice(dot + 1);
  return EXT_TO_ID[ext] ?? "plaintext";
}

export function languageLabel(id: string): string {
  if (id.startsWith("udl:")) return udlResolver?.label(id) ?? "User Language";
  return LANGUAGES[id]?.label ?? "Plain Text";
}

const loadCache = new Map<string, Extension>();

export async function loadLanguageExtension(id: string): Promise<Extension> {
  if (id.startsWith("udl:")) {
    const ext = await udlResolver?.load(id);
    return ext ?? [];
  }
  const def = LANGUAGES[id] ?? LANGUAGES.plaintext;
  const cached = loadCache.get(def.id);
  if (cached) return cached;
  const ext = await def.load();
  loadCache.set(def.id, ext);
  return ext;
}

// User-Defined Language resolver hook (registered by the UDL module at startup),
// keeps languages.ts decoupled from UDL storage/UI.
export interface PickerEntry {
  id: string;
  label: string;
}
export interface UdlResolver {
  label: (id: string) => string | null;
  load: (id: string) => Promise<Extension> | null;
  entries: () => PickerEntry[];
}
let udlResolver: UdlResolver | null = null;
export function registerUdlResolver(r: UdlResolver): void {
  udlResolver = r;
}

/** Full ordered picker list: built-in languages followed by any User-Defined Languages. */
export function pickerEntries(): PickerEntry[] {
  const base = PICKER_ORDER.map((id) => ({ id, label: languageLabel(id) }));
  const udls = udlResolver?.entries() ?? [];
  return udls.length ? [...base, ...udls] : base;
}

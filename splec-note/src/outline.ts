// Document outline: Markdown headings and code functions/classes. Computed with
// a lightweight line scan so it works uniformly across Lezer packs, legacy
// StreamLanguage modes, and User-Defined Languages. Click an item to jump.

import type { EditorState } from "@codemirror/state";

export interface OutlineItem {
  label: string;
  line: number; // 1-based
  pos: number; // document offset of the line start
  level: number; // nesting depth for indentation (0 = top)
}

interface CodeRule {
  re: RegExp; // capture group 1 = symbol name
  kind: string;
}

// Order matters: more specific rules first. Each matches a single line.
const CODE_RULES: CodeRule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:public|private|protected|internal|abstract|final|sealed|data)?\s*class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?(?:public|private|protected)?\s*(?:interface|trait|protocol)\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?(?:public|private|protected)?\s*(?:struct|enum|union)\s+([A-Za-z_$][\w$]*)/, kind: "struct" },
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, kind: "function" }, // Rust
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, kind: "function" }, // Go / Swift
  { re: /^\s*def\s+([A-Za-z_][\w?!]*)/, kind: "function" }, // Python / Ruby
  { re: /^\s*sub\s+([A-Za-z_][\w]*)/, kind: "function" }, // Perl
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, kind: "function" }, // JS arrow/func vars
  { re: /^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?function\b/, kind: "function" }, // obj methods
];

const MD_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT = /^(=+|-+)\s*$/;

function isMarkdown(languageId: string): boolean {
  return languageId === "markdown" || languageId === "md";
}

export function computeOutline(state: EditorState, languageId: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const doc = state.doc;
  const total = doc.lines;
  const md = isMarkdown(languageId);
  let inFence = false;

  for (let n = 1; n <= total; n++) {
    const line = doc.line(n);
    const text = line.text;

    if (md) {
      const fence = text.match(/^\s*(```|~~~)/);
      if (fence) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const h = text.match(MD_HEADING);
      if (h) {
        items.push({ label: h[2] || "(untitled)", line: n, pos: line.from, level: h[1].length - 1 });
        continue;
      }
      // Setext: previous non-empty line is the heading text.
      if (SETEXT.test(text) && n > 1) {
        const prev = doc.line(n - 1).text.trim();
        if (prev && !MD_HEADING.test(prev)) {
          items.push({
            label: prev,
            line: n - 1,
            pos: doc.line(n - 1).from,
            level: text.startsWith("=") ? 0 : 1,
          });
        }
      }
      continue;
    }

    for (const rule of CODE_RULES) {
      const m = text.match(rule.re);
      if (m && m[1]) {
        const indent = text.length - text.trimStart().length;
        items.push({ label: m[1], line: n, pos: line.from, level: Math.min(3, Math.floor(indent / 2)) });
        break;
      }
    }
  }

  return items;
}

// CodeMirror 6 editor wiring for Splec Note.
// Provides a single editor view with line numbers, active-line highlight,
// history/undo, and syntax highlighting for Markdown / JavaScript / TypeScript / JSON.
// Editor chrome + syntax colors are brand-tuned and swap with the app theme via a Compartment.

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import type { ResolvedTheme } from "./theme";

export type LanguageName = "markdown" | "javascript" | "typescript" | "json";

export function getLanguageExtension(name: LanguageName): Extension {
  switch (name) {
    case "javascript":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return json();
    case "markdown":
    default:
      return markdown({ codeLanguages: [] });
  }
}

// ---- Editor chrome themes (backgrounds, gutter, cursor, selection) ----
// Colors mirror the CSS custom properties in styles.css.

const lightTheme = EditorView.theme(
  {
    "&": {
      color: "#1c1830",
      backgroundColor: "#ffffff",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily:
        "'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: "14px",
      lineHeight: "1.7",
    },
    ".cm-content": { caretColor: "#7c5cff", padding: "14px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#7c5cff" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#e3dcff" },
    ".cm-activeLine": { backgroundColor: "rgba(124, 92, 255, 0.06)" },
    ".cm-gutters": {
      backgroundColor: "#ffffff",
      color: "#b6aecb",
      border: "none",
      paddingRight: "6px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(124, 92, 255, 0.08)",
      color: "#7c5cff",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#efeafd",
      border: "none",
      color: "#7c5cff",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(124, 92, 255, 0.16)",
      outline: "none",
    },
  },
  { dark: false },
);

const darkTheme = EditorView.theme(
  {
    "&": {
      color: "#e7e6f0",
      backgroundColor: "#0b0d16",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily:
        "'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: "14px",
      lineHeight: "1.7",
    },
    ".cm-content": { caretColor: "#9db4ff", padding: "14px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#9db4ff" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#2a2550" },
    ".cm-activeLine": { backgroundColor: "rgba(157, 180, 255, 0.07)" },
    ".cm-gutters": {
      backgroundColor: "#0b0d16",
      color: "#4a4763",
      border: "none",
      paddingRight: "6px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(157, 180, 255, 0.10)",
      color: "#9db4ff",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#1b1e2e",
      border: "none",
      color: "#9db4ff",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(157, 180, 255, 0.18)",
      outline: "none",
    },
  },
  { dark: true },
);

// ---- Syntax highlight styles ----

const lightHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#7c3aed", fontWeight: "600" },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#1c1830" },
  { tag: [t.function(t.variableName), t.labelName], color: "#2f6df0" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#b5530a" },
  { tag: [t.definition(t.name), t.separator], color: "#1c1830" },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.namespace], color: "#b2229a" },
  { tag: [t.operator, t.operatorKeyword], color: "#5b3ff0" },
  { tag: [t.number, t.bool, t.atom], color: "#b5530a" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#0a7d52" },
  { tag: [t.meta, t.comment], color: "#8a86a0", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#7c5cff", textDecoration: "underline" },
  { tag: t.heading, color: "#5b3ff0", fontWeight: "700" },
  { tag: t.invalid, color: "#e11d48" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#c4b5ff", fontWeight: "600" },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#e7e6f0" },
  { tag: [t.function(t.variableName), t.labelName], color: "#9db4ff" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#ffd6a3" },
  { tag: [t.definition(t.name), t.separator], color: "#e7e6f0" },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.namespace], color: "#ff9ed8" },
  { tag: [t.operator, t.operatorKeyword], color: "#c4b5ff" },
  { tag: [t.number, t.bool, t.atom], color: "#ffd6a3" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#7ee0b8" },
  { tag: [t.meta, t.comment], color: "#6f6b8a", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#9db4ff", textDecoration: "underline" },
  { tag: t.heading, color: "#b9a8ff", fontWeight: "700" },
  { tag: t.invalid, color: "#ff6b81" },
]);

function themeExtension(theme: ResolvedTheme): Extension {
  return theme === "dark"
    ? [darkTheme, syntaxHighlighting(darkHighlight), syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
    : [lightTheme, syntaxHighlighting(lightHighlight), syntaxHighlighting(defaultHighlightStyle, { fallback: true })];
}

export interface CursorInfo {
  line: number;
  col: number;
}

export interface CreateEditorOptions {
  parent: HTMLElement;
  doc: string;
  theme: ResolvedTheme;
  language: LanguageName;
  onCursor?: (info: CursorInfo) => void;
}

export interface SplecEditor {
  view: EditorView;
  setTheme: (theme: ResolvedTheme) => void;
  setLanguage: (language: LanguageName) => void;
}

export function createEditor(options: CreateEditorOptions): SplecEditor {
  const themeCompartment = new Compartment();
  const languageCompartment = new Compartment();

  const cursorListener = EditorView.updateListener.of((update) => {
    if (!options.onCursor) return;
    if (update.selectionSet || update.docChanged) {
      const head = update.state.selection.main.head;
      const line = update.state.doc.lineAt(head);
      options.onCursor({ line: line.number, col: head - line.from + 1 });
    }
  });

  const baseExtensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    highlightActiveLine(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    EditorView.lineWrapping,
    cursorListener,
  ];

  const state = EditorState.create({
    doc: options.doc,
    extensions: [
      themeCompartment.of(themeExtension(options.theme)),
      languageCompartment.of(getLanguageExtension(options.language)),
      ...baseExtensions,
    ],
  });

  const view = new EditorView({ state, parent: options.parent });

  // Report initial cursor position.
  if (options.onCursor) options.onCursor({ line: 1, col: 1 });

  return {
    view,
    setTheme(theme: ResolvedTheme) {
      view.dispatch({ effects: themeCompartment.reconfigure(themeExtension(theme)) });
    },
    setLanguage(language: LanguageName) {
      view.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension(language)),
      });
    },
  };
}

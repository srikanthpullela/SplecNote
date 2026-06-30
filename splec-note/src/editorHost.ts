// Editor host: owns a single CodeMirror EditorView and swaps a per-buffer EditorState
// in/out as the user changes tabs. Theme, language, word-wrap and tab-size are shared
// compartments reconfigured to the global/per-buffer values whenever a buffer is shown.

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightWhitespace,
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
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  search,
  highlightSelectionMatches,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { tags as t } from "@lezer/highlight";
import { bookmarks, initialBookmarks, toggleBookmark, jumpBookmark } from "./bookmarks";
import { toggleComment, jumpToMatchingBracket } from "./transforms";
import type { ResolvedTheme } from "./theme";

const fontStack =
  "'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace";

const lightTheme = EditorView.theme(
  {
    "&": { color: "#1c1830", backgroundColor: "#ffffff", height: "100%" },
    ".cm-scroller": { fontFamily: fontStack, lineHeight: "1.7" },
    ".cm-content": { caretColor: "#7c5cff", padding: "14px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#7c5cff" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#e3dcff",
    },
    ".cm-activeLine": { backgroundColor: "rgba(124, 92, 255, 0.06)" },
    ".cm-gutters": { backgroundColor: "#ffffff", color: "#b6aecb", border: "none", paddingRight: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(124, 92, 255, 0.08)", color: "#7c5cff" },
    ".cm-foldPlaceholder": { backgroundColor: "#efeafd", border: "none", color: "#7c5cff" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(124, 92, 255, 0.16)",
      outline: "none",
    },
  },
  { dark: false },
);

const darkTheme = EditorView.theme(
  {
    "&": { color: "#e7e6f0", backgroundColor: "#0b0d16", height: "100%" },
    ".cm-scroller": { fontFamily: fontStack, lineHeight: "1.7" },
    ".cm-content": { caretColor: "#9db4ff", padding: "14px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#9db4ff" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#2a2550",
    },
    ".cm-activeLine": { backgroundColor: "rgba(157, 180, 255, 0.07)" },
    ".cm-gutters": { backgroundColor: "#0b0d16", color: "#4a4763", border: "none", paddingRight: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(157, 180, 255, 0.10)", color: "#9db4ff" },
    ".cm-foldPlaceholder": { backgroundColor: "#1b1e2e", border: "none", color: "#9db4ff" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(157, 180, 255, 0.18)",
      outline: "none",
    },
  },
  { dark: true },
);

const lightHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "#7c3aed", fontWeight: "600" },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#1c1830" },
  { tag: [t.function(t.variableName), t.labelName], color: "#2f6df0" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#b5530a" },
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

function tabSizeExtension(n: number): Extension {
  return [EditorState.tabSize.of(n), indentUnit.of(" ".repeat(n))];
}

export interface CursorInfo {
  line: number;
  col: number;
  selLen: number;
}

export interface HostCallbacks {
  onDocChanged: () => void;
  onSelectionChanged: () => void;
  onScroll: (scrollTop: number) => void;
}

export class EditorHost {
  readonly view: EditorView;
  private themeC = new Compartment();
  private langC = new Compartment();
  private wrapC = new Compartment();
  private tabC = new Compartment();
  private wsC = new Compartment();
  private guideC = new Compartment();
  private theme: ResolvedTheme;
  private wrap: boolean;
  private tabSize: number;
  private showWhitespace: boolean;
  private indentGuides: boolean;
  private cb: HostCallbacks;

  constructor(parent: HTMLElement, opts: {
    theme: ResolvedTheme;
    wrap: boolean;
    tabSize: number;
    fontSize: number;
    showWhitespace?: boolean;
    indentGuides?: boolean;
    callbacks: HostCallbacks;
  }) {
    this.theme = opts.theme;
    this.wrap = opts.wrap;
    this.tabSize = opts.tabSize;
    this.showWhitespace = opts.showWhitespace ?? false;
    this.indentGuides = opts.indentGuides ?? true;
    this.cb = opts.callbacks;
    this.view = new EditorView({
      parent,
      state: this.createState("", []),
    });
    this.setFontSize(opts.fontSize);
    this.view.scrollDOM.addEventListener("scroll", () => {
      this.cb.onScroll(this.view.scrollDOM.scrollTop);
    });
  }

  /** Build a fresh per-buffer state wired to the shared compartments. */
  createState(
    doc: string,
    langExt: Extension,
    selection?: { anchor: number; head: number },
    bookmarkLines?: number[],
  ): EditorState {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) this.cb.onDocChanged();
      if (u.selectionSet) this.cb.onSelectionChanged();
    });
    const clamp = (n: number) => Math.max(0, Math.min(doc.length, n));
    return EditorState.create({
      doc,
      selection: selection
        ? { anchor: clamp(selection.anchor), head: clamp(selection.head) }
        : undefined,
      extensions: [
        this.themeC.of(themeExtension(this.theme)),
        this.langC.of(langExt),
        this.wrapC.of(this.wrap ? EditorView.lineWrapping : []),
        this.tabC.of(tabSizeExtension(this.tabSize)),
        this.wsC.of(this.showWhitespace ? highlightWhitespace() : []),
        this.guideC.of(this.indentGuides ? indentationMarkers() : []),
        initialBookmarks.of(bookmarkLines ?? []),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        bookmarks(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search(),
        keymap.of([
          { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
          { key: "Mod-Shift-l", run: selectSelectionMatches, preventDefault: true },
          { key: "Mod-/", run: toggleComment, preventDefault: true },
          { key: "Mod-Shift-\\", run: jumpToMatchingBracket, preventDefault: true },
          { key: "Mod-b", run: (v) => toggleBookmark(v), preventDefault: true },
          { key: "F2", run: (v) => jumpBookmark(v, 1), preventDefault: true },
          { key: "Shift-F2", run: (v) => jumpBookmark(v, -1), preventDefault: true },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        updateListener,
      ],
    });
  }

  /** Show a buffer's state, then sync shared compartments + restore scroll. */
  show(state: EditorState, langExt: Extension, scrollTop: number): void {
    this.view.setState(state);
    this.view.dispatch({
      effects: [
        this.themeC.reconfigure(themeExtension(this.theme)),
        this.langC.reconfigure(langExt),
        this.wrapC.reconfigure(this.wrap ? EditorView.lineWrapping : []),
        this.tabC.reconfigure(tabSizeExtension(this.tabSize)),
        this.wsC.reconfigure(this.showWhitespace ? highlightWhitespace() : []),
        this.guideC.reconfigure(this.indentGuides ? indentationMarkers() : []),
      ],
    });
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = scrollTop;
    });
  }

  setLanguageExtension(langExt: Extension): void {
    this.view.dispatch({ effects: this.langC.reconfigure(langExt) });
  }

  setTheme(theme: ResolvedTheme): void {
    this.theme = theme;
    this.view.dispatch({ effects: this.themeC.reconfigure(themeExtension(theme)) });
  }

  setWrap(wrap: boolean): void {
    this.wrap = wrap;
    this.view.dispatch({ effects: this.wrapC.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }

  setTabSize(n: number): void {
    this.tabSize = n;
    this.view.dispatch({ effects: this.tabC.reconfigure(tabSizeExtension(n)) });
  }

  setShowWhitespace(on: boolean): void {
    this.showWhitespace = on;
    this.view.dispatch({ effects: this.wsC.reconfigure(on ? highlightWhitespace() : []) });
  }

  setIndentGuides(on: boolean): void {
    this.indentGuides = on;
    this.view.dispatch({ effects: this.guideC.reconfigure(on ? indentationMarkers() : []) });
  }

  isShowWhitespace(): boolean {
    return this.showWhitespace;
  }

  setFontSize(px: number): void {
    this.view.scrollDOM.style.fontSize = `${px}px`;
  }

  focus(): void {
    this.view.focus();
  }

  cursorInfo(): CursorInfo {
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.head);
    return { line: line.number, col: sel.head - line.from + 1, selLen: Math.abs(sel.to - sel.from) };
  }
}

// Word/char counting for the status bar.
export function countText(doc: string): { words: number; chars: number } {
  const chars = doc.length;
  const words = (doc.match(/\S+/g) ?? []).length;
  return { words, chars };
}

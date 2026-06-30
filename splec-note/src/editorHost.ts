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
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import {
  search,
  highlightSelectionMatches,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { bookmarks, initialBookmarks, toggleBookmark, jumpBookmark } from "./bookmarks";
import { toggleComment, jumpToMatchingBracket } from "./transforms";

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
  private extraC = new Compartment();
  private themeExt: Extension;
  private wrap: boolean;
  private tabSize: number;
  private showWhitespace: boolean;
  private indentGuides: boolean;
  private extra: Extension = [];
  private cb: HostCallbacks;

  constructor(parent: HTMLElement, opts: {
    themeExt: Extension;
    wrap: boolean;
    tabSize: number;
    fontSize: number;
    showWhitespace?: boolean;
    indentGuides?: boolean;
    callbacks: HostCallbacks;
  }) {
    this.themeExt = opts.themeExt;
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
        this.themeC.of(this.themeExt),
        this.langC.of(langExt),
        this.wrapC.of(this.wrap ? EditorView.lineWrapping : []),
        this.tabC.of(tabSizeExtension(this.tabSize)),
        this.wsC.of(this.showWhitespace ? highlightWhitespace() : []),
        this.guideC.of(this.indentGuides ? indentationMarkers() : []),
        this.extraC.of(this.extra),
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
        this.themeC.reconfigure(this.themeExt),
        this.langC.reconfigure(langExt),
        this.wrapC.reconfigure(this.wrap ? EditorView.lineWrapping : []),
        this.tabC.reconfigure(tabSizeExtension(this.tabSize)),
        this.wsC.reconfigure(this.showWhitespace ? highlightWhitespace() : []),
        this.guideC.reconfigure(this.indentGuides ? indentationMarkers() : []),
        this.extraC.reconfigure(this.extra),
      ],
    });
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = scrollTop;
    });
  }

  setLanguageExtension(langExt: Extension): void {
    this.view.dispatch({ effects: this.langC.reconfigure(langExt) });
  }

  setTheme(themeExt: Extension): void {
    this.themeExt = themeExt;
    this.view.dispatch({ effects: this.themeC.reconfigure(themeExt) });
  }

  /** Set an extra editor extension (e.g. the minimap) via a dedicated compartment. */
  setExtra(ext: Extension): void {
    this.extra = ext;
    this.view.dispatch({ effects: this.extraC.reconfigure(ext) });
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

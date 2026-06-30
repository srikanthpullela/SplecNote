// Text transforms + navigation commands (Notepad++-style editing power).
// Each export is a CodeMirror command: (view) => boolean.

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  copyLineDown,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  splitLine,
  deleteLine,
  toggleComment,
  toggleLineComment,
  toggleBlockComment,
} from "@codemirror/commands";

export type EditorCommand = (view: EditorView) => boolean;

// ---- Case + per-selection transforms --------------------------------------

/** Apply `fn` to each selection range's text; empty ranges expand to their line. */
function transformRanges(view: EditorView, fn: (s: string) => string): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  for (const range of state.selection.ranges) {
    let from = range.from;
    let to = range.to;
    if (from === to) {
      const line = state.doc.lineAt(from);
      from = line.from;
      to = line.to;
    }
    const slice = state.doc.sliceString(from, to);
    const next = fn(slice);
    if (next !== slice) changes.push({ from, to, insert: next });
  }
  if (!changes.length) return false;
  view.dispatch(state.update({ changes, scrollIntoView: true }));
  return true;
}

export const toUpperCase: EditorCommand = (v) => transformRanges(v, (s) => s.toUpperCase());
export const toLowerCase: EditorCommand = (v) => transformRanges(v, (s) => s.toLowerCase());
export const toTitleCase: EditorCommand = (v) =>
  transformRanges(v, (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()));

// ---- Line-span helpers -----------------------------------------------------

/** The block of whole lines touched by the main selection (or the whole doc if empty). */
function lineBlock(view: EditorView): { from: number; to: number } {
  const { state } = view;
  const main = state.selection.main;
  if (main.empty) {
    return { from: 0, to: state.doc.length };
  }
  const a = state.doc.lineAt(main.from);
  const b = state.doc.lineAt(main.to);
  return { from: a.from, to: b.to };
}

function replaceBlockLines(view: EditorView, map: (lines: string[]) => string[]): boolean {
  const { from, to } = lineBlock(view);
  const text = view.state.doc.sliceString(from, to);
  const lines = text.split("\n");
  const out = map(lines).join("\n");
  if (out === text) return false;
  view.dispatch(view.state.update({ changes: { from, to, insert: out }, scrollIntoView: true }));
  return true;
}

function sortLines(view: EditorView, dir: 1 | -1, unique: boolean): boolean {
  return replaceBlockLines(view, (lines) => {
    let out = [...lines].sort((a, b) => a.localeCompare(b));
    if (dir === -1) out.reverse();
    if (unique) {
      const seen = new Set<string>();
      out = out.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
    }
    return out;
  });
}

export const sortLinesAsc: EditorCommand = (v) => sortLines(v, 1, false);
export const sortLinesDesc: EditorCommand = (v) => sortLines(v, -1, false);
export const sortLinesUnique: EditorCommand = (v) => sortLines(v, 1, true);

export const trimTrailingWhitespace: EditorCommand = (v) =>
  replaceBlockLines(v, (lines) => lines.map((l) => l.replace(/[ \t]+$/, "")));

export const joinLines: EditorCommand = (view) => {
  const { state } = view;
  const main = state.selection.main;
  if (main.empty) {
    // Join current line with the next one.
    const line = state.doc.lineAt(main.head);
    if (line.number >= state.doc.lines) return false;
    const next = state.doc.line(line.number + 1);
    view.dispatch(
      state.update({
        changes: { from: line.to, to: next.from + next.text.match(/^\s*/)![0].length, insert: " " },
        scrollIntoView: true,
      }),
    );
    return true;
  }
  return replaceBlockLines(view, (lines) => [
    lines.map((l, i) => (i === 0 ? l : l.replace(/^\s+/, ""))).join(" "),
  ]);
};

// ---- Re-exported built-ins -------------------------------------------------

export const duplicateLine = copyLineDown;
export const removeLine = deleteLine;
export { moveLineUp, moveLineDown, indentMore, indentLess, splitLine };
export { toggleComment, toggleLineComment, toggleBlockComment };

// ---- Navigation ------------------------------------------------------------

/** Jump to the bracket matching the one at/just-before the cursor. */
export const jumpToMatchingBracket: EditorCommand = (view) => {
  const { state } = view;
  const pos = state.selection.main.head;
  const open = "([{", close = ")]}";
  const text = state.doc;
  const here = pos < text.length ? text.sliceString(pos, pos + 1) : "";
  const prev = pos > 0 ? text.sliceString(pos - 1, pos) : "";
  let start = -1;
  let forward = true;
  if (open.includes(here)) {
    start = pos;
    forward = true;
  } else if (close.includes(prev)) {
    start = pos - 1;
    forward = false;
  } else if (close.includes(here)) {
    start = pos;
    forward = false;
  } else if (open.includes(prev)) {
    start = pos - 1;
    forward = true;
  }
  if (start < 0) return false;
  const ch = text.sliceString(start, start + 1);
  const isOpen = open.includes(ch);
  const pair = isOpen ? close[open.indexOf(ch)] : open[close.indexOf(ch)];
  let depth = 0;
  const len = text.length;
  for (let i = start; forward ? i < len : i >= 0; i += forward ? 1 : -1) {
    const c = text.sliceString(i, i + 1);
    if (c === ch) depth++;
    else if (c === pair) {
      depth--;
      if (depth === 0) {
        const target = forward ? i + 1 : i;
        view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true });
        return true;
      }
    }
  }
  return false;
};

/** Move the cursor to a 1-based line number. */
export function goToLine(view: EditorView, lineNo: number): boolean {
  const n = Math.max(1, Math.min(view.state.doc.lines, Math.floor(lineNo)));
  const line = view.state.doc.line(n);
  view.dispatch({
    selection: EditorSelection.cursor(line.from),
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

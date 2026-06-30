// Line bookmarks: a gutter marker you can toggle on any line and jump between.
// Bookmarks are anchored to document positions (a RangeSet) so they survive edits,
// and their line numbers are persisted in the session manifest.

import {
  Facet,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";

/** Toggle/set a bookmark at a line-start position. */
export const setBookmark = StateEffect.define<{ pos: number; on: boolean }>();
const clearBookmarks = StateEffect.define<null>();

class BookmarkMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-bookmark-mark";
    el.textContent = "◆";
    return el;
  }
}
const bookmarkMarker = new BookmarkMarker();

/** Initial bookmark line numbers (1-based), supplied per-buffer on restore. */
export const initialBookmarks = Facet.define<number[], number[]>({
  combine: (values) => values[0] ?? [],
});

const bookmarkField = StateField.define<RangeSet<GutterMarker>>({
  create(state) {
    const lines = state.facet(initialBookmarks);
    if (!lines.length) return RangeSet.empty;
    const ranges = lines
      .filter((n) => n >= 1 && n <= state.doc.lines)
      .map((n) => bookmarkMarker.range(state.doc.line(n).from));
    ranges.sort((a, b) => a.from - b.from);
    return RangeSet.of(ranges, true);
  },
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setBookmark)) {
        const at = tr.state.doc.lineAt(e.value.pos).from;
        if (e.value.on) {
          set = set.update({ add: [bookmarkMarker.range(at)], sort: true });
        } else {
          set = set.update({ filter: (from) => from !== at });
        }
      } else if (e.is(clearBookmarks)) {
        set = RangeSet.empty;
      }
    }
    return set;
  },
});

function bookmarkOnLine(state: EditorState, pos: number): boolean {
  const at = state.doc.lineAt(pos).from;
  let found = false;
  state.field(bookmarkField).between(at, at, () => {
    found = true;
  });
  return found;
}

/** Toggle a bookmark on the current line. */
export function toggleBookmark(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  const on = !bookmarkOnLine(view.state, pos);
  view.dispatch({ effects: setBookmark.of({ pos, on }) });
  return true;
}

export function clearAllBookmarks(view: EditorView): boolean {
  view.dispatch({ effects: clearBookmarks.of(null) });
  return true;
}

function bookmarkPositions(state: EditorState): number[] {
  const out: number[] = [];
  state.field(bookmarkField).between(0, state.doc.length, (from) => {
    out.push(from);
  });
  return out;
}

/** Jump to the next (dir=1) or previous (dir=-1) bookmark, wrapping around. */
export function jumpBookmark(view: EditorView, dir: 1 | -1): boolean {
  const positions = bookmarkPositions(view.state);
  if (!positions.length) return false;
  const head = view.state.selection.main.head;
  const curLine = view.state.doc.lineAt(head).from;
  let target: number | null = null;
  if (dir === 1) {
    target = positions.find((p) => p > curLine) ?? positions[0];
  } else {
    for (let i = positions.length - 1; i >= 0; i--) {
      if (positions[i] < curLine) {
        target = positions[i];
        break;
      }
    }
    if (target === null) target = positions[positions.length - 1];
  }
  view.dispatch({
    selection: { anchor: target },
    effects: EditorView.scrollIntoView(target, { y: "center" }),
    scrollIntoView: true,
  });
  return true;
}

/** Bookmark line numbers (1-based) for persistence. */
export function bookmarkLines(state: EditorState): number[] {
  return bookmarkPositions(state).map((p) => state.doc.lineAt(p).number);
}

const bookmarkGutter = gutter({
  class: "cm-bookmark-gutter",
  markers: (view) => view.state.field(bookmarkField),
  initialSpacer: () => bookmarkMarker,
});

export function bookmarks(): Extension {
  return [bookmarkField, bookmarkGutter];
}

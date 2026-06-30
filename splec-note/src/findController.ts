// Find / Replace controller. Drives a custom Splec-styled panel (not CM's default
// search panel). Computes matches manually for accurate counts, current-match index,
// wrap-around, whole-word and in-selection scoping; uses @codemirror/search only to
// paint match highlights in the editor.

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  RegExpCursor,
  SearchCursor,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";

interface FindOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  inSelection: boolean;
  wrap: boolean;
}

interface Match {
  from: number;
  to: number;
  groups: string[] | null;
}

const MAX_MATCHES = 20000;
const WORD = /[\w$]/;

function isWordBoundary(doc: string, from: number, to: number): boolean {
  const before = from > 0 ? doc[from - 1] : "";
  const after = to < doc.length ? doc[to] : "";
  const startOk = !before || !WORD.test(before);
  const endOk = !after || !WORD.test(after);
  return startOk && endOk;
}

export class FindController {
  private panel = document.querySelector<HTMLElement>("#find-panel")!;
  private findInput = document.querySelector<HTMLInputElement>("#find-input")!;
  private replaceInput = document.querySelector<HTMLInputElement>("#replace-input")!;
  private replaceRow = document.querySelector<HTMLElement>("#find-replace-row")!;
  private countEl = document.querySelector<HTMLElement>("#find-count")!;
  private btnRegex = document.querySelector<HTMLButtonElement>("#find-regex")!;
  private btnCase = document.querySelector<HTMLButtonElement>("#find-case")!;
  private btnWord = document.querySelector<HTMLButtonElement>("#find-word")!;
  private btnInSel = document.querySelector<HTMLButtonElement>("#find-insel")!;

  private scope: { from: number; to: number } | null = null;
  private matches: Match[] = [];
  private current = -1;

  constructor(
    private getView: () => EditorView,
    private onMessage: (msg: string) => void,
  ) {
    this.findInput.addEventListener("input", () => this.runQuery(true));
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.shiftKey ? this.prev() : this.next();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.replaceOne();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    for (const btn of [this.btnRegex, this.btnCase, this.btnWord, this.btnInSel]) {
      btn.addEventListener("click", () => {
        btn.classList.toggle("is-on");
        if (btn === this.btnInSel) this.captureScope();
        this.runQuery(true);
        this.findInput.focus();
      });
    }

    document.querySelector("#find-next")?.addEventListener("click", () => this.next());
    document.querySelector("#find-prev")?.addEventListener("click", () => this.prev());
    document.querySelector("#find-close")?.addEventListener("click", () => this.close());
    document.querySelector("#replace-one")?.addEventListener("click", () => this.replaceOne());
    document.querySelector("#replace-all")?.addEventListener("click", () => this.replaceAll());
  }

  isOpen(): boolean {
    return !this.panel.hidden;
  }

  open(mode: "find" | "replace"): void {
    const view = this.getView();
    const sel = view.state.selection.main;
    if (!sel.empty && sel.to - sel.from < 200) {
      const text = view.state.doc.sliceString(sel.from, sel.to);
      if (!text.includes("\n")) this.findInput.value = text;
    }
    this.replaceRow.hidden = mode !== "replace";
    this.panel.hidden = false;
    this.captureScope();
    this.runQuery(false);
    this.findInput.focus();
    this.findInput.select();
  }

  close(): void {
    this.panel.hidden = true;
    const view = this.getView();
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    view.focus();
  }

  /** Re-run the active query after a tab switch so highlights/counts track the buffer. */
  refresh(): void {
    if (this.isOpen()) {
      this.scope = null;
      this.btnInSel.classList.remove("is-on");
      this.runQuery(false);
    }
  }

  private options(): FindOptions {
    return {
      query: this.findInput.value,
      regex: this.btnRegex.classList.contains("is-on"),
      caseSensitive: this.btnCase.classList.contains("is-on"),
      wholeWord: this.btnWord.classList.contains("is-on"),
      inSelection: this.btnInSel.classList.contains("is-on"),
      wrap: true,
    };
  }

  private captureScope(): void {
    const opts = this.options();
    if (!opts.inSelection) {
      this.scope = null;
      return;
    }
    const sel = this.getView().state.selection.main;
    this.scope = sel.empty ? null : { from: sel.from, to: sel.to };
    if (!this.scope) this.btnInSel.classList.remove("is-on");
  }

  private computeMatches(): void {
    const view = this.getView();
    const opts = this.options();
    this.matches = [];
    this.current = -1;
    if (!opts.query) {
      this.paint(opts);
      this.renderCount();
      return;
    }
    const doc = view.state.doc;
    const docStr = doc.toString();
    const from = this.scope ? this.scope.from : 0;
    const to = this.scope ? this.scope.to : doc.length;

    try {
      if (opts.regex) {
        const cursor = new RegExpCursor(
          doc,
          opts.query,
          { ignoreCase: !opts.caseSensitive },
          from,
          to,
        );
        for (const m of cursor) {
          if (opts.wholeWord && !isWordBoundary(docStr, m.from, m.to)) continue;
          this.matches.push({ from: m.from, to: m.to, groups: [...m.match] });
          if (this.matches.length >= MAX_MATCHES) break;
        }
      } else {
        const normalize = opts.caseSensitive ? undefined : (s: string) => s.toLowerCase();
        const cursor = new SearchCursor(doc, opts.query, from, to, normalize);
        for (const m of cursor) {
          if (opts.wholeWord && !isWordBoundary(docStr, m.from, m.to)) continue;
          this.matches.push({ from: m.from, to: m.to, groups: null });
          if (this.matches.length >= MAX_MATCHES) break;
        }
      }
      this.countEl.classList.remove("is-error");
    } catch (err) {
      this.matches = [];
      this.countEl.textContent = "Bad regex";
      this.countEl.classList.add("is-error");
      return;
    }

    const head = view.state.selection.main.head;
    this.current = this.matches.findIndex((m) => m.from >= head);
    this.paint(opts);
    this.renderCount();
  }

  private paint(opts: FindOptions): void {
    const view = this.getView();
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: opts.query,
          caseSensitive: opts.caseSensitive,
          regexp: opts.regex,
          wholeWord: opts.wholeWord,
          replace: this.replaceInput.value,
        }),
      ),
    });
  }

  private renderCount(): void {
    if (this.countEl.classList.contains("is-error")) return;
    if (!this.findInput.value) {
      this.countEl.textContent = "";
      return;
    }
    const n = this.matches.length;
    if (n === 0) {
      this.countEl.textContent = "No results";
      return;
    }
    const idx = this.current >= 0 ? this.current + 1 : "—";
    const capped = n >= MAX_MATCHES ? "+" : "";
    this.countEl.textContent = `${idx} of ${n}${capped}`;
  }

  private runQuery(resetCurrent: boolean): void {
    if (resetCurrent) this.current = -1;
    this.computeMatches();
  }

  private moveTo(index: number): void {
    if (!this.matches.length) return;
    const n = this.matches.length;
    this.current = ((index % n) + n) % n;
    const m = this.matches[this.current];
    const view = this.getView();
    view.dispatch({
      selection: EditorSelection.range(m.from, m.to),
      effects: EditorView.scrollIntoView(m.from, { y: "center" }),
      scrollIntoView: true,
    });
    this.renderCount();
  }

  next(): void {
    if (!this.matches.length) {
      this.computeMatches();
      if (!this.matches.length) return;
    }
    const head = this.getView().state.selection.main.head;
    let i = this.matches.findIndex((m) => m.from > head - 1 && m.from >= head);
    if (this.current >= 0) i = this.current + 1;
    else if (i < 0) i = 0;
    this.moveTo(i);
  }

  prev(): void {
    if (!this.matches.length) return;
    const i = this.current >= 0 ? this.current - 1 : this.matches.length - 1;
    this.moveTo(i);
  }

  private expand(template: string, groups: string[] | null): string {
    if (groups === null) return template;
    return template.replace(/\$(\$|&|\d{1,2})/g, (_, t) => {
      if (t === "$") return "$";
      if (t === "&") return groups[0] ?? "";
      const n = Number(t);
      return groups[n] ?? "";
    });
  }

  private replaceOne(): void {
    if (!this.matches.length || this.current < 0) {
      this.next();
      return;
    }
    const view = this.getView();
    const opts = this.options();
    const m = this.matches[this.current];
    const sel = view.state.selection.main;
    // Only replace if the current match is actually selected (Notepad++ behaviour).
    if (sel.from !== m.from || sel.to !== m.to) {
      this.moveTo(this.current);
      return;
    }
    const insert = opts.regex ? this.expand(this.replaceInput.value, m.groups) : this.replaceInput.value;
    view.dispatch(view.state.update({ changes: { from: m.from, to: m.to, insert }, scrollIntoView: true }));
    this.computeMatches();
    // Advance to the next match after the replacement point.
    const at = m.from + insert.length;
    const i = this.matches.findIndex((x) => x.from >= at);
    if (this.matches.length) this.moveTo(i < 0 ? 0 : i);
  }

  private replaceAll(): void {
    if (!this.matches.length) {
      this.onMessage("No matches to replace");
      return;
    }
    const view = this.getView();
    const opts = this.options();
    const changes: ChangeSpec[] = this.matches.map((m) => ({
      from: m.from,
      to: m.to,
      insert: opts.regex ? this.expand(this.replaceInput.value, m.groups) : this.replaceInput.value,
    }));
    const count = changes.length;
    view.dispatch(view.state.update({ changes, scrollIntoView: true }));
    this.scope = null;
    this.btnInSel.classList.remove("is-on");
    this.computeMatches();
    this.onMessage(`Replaced ${count} ${count === 1 ? "match" : "matches"}`);
  }
}

// Split editor: a second pane that mirrors the active document as a live clone
// (independent cursor/scroll per pane). Edits in either pane sync to the other;
// the primary editor remains the single source of truth for the buffer, so the
// session-persistence engine is unaffected. Only the split layout (on/off +
// orientation) is persisted.

import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";

export type SplitOrientation = "vertical" | "horizontal";

export interface SplitContext {
  panesEl: HTMLElement; // #editor-panes
  pane2El: HTMLElement; // #editor-pane-2
  mountEl: HTMLElement; // #editor-2
  getDoc: () => string; // current primary document text
  applyEdit: (text: string) => void; // push pane-2 edits into the primary editor
  themeExt: () => Extension; // current editor theme extension
  langExt: () => Extension; // current language extension
  onChange?: () => void; // notify (e.g. persist layout)
}

export class SplitView {
  enabled = false;
  orientation: SplitOrientation = "vertical";

  private view: EditorView | null = null;
  private themeC = new Compartment();
  private langC = new Compartment();
  private applying = false;

  constructor(private ctx: SplitContext) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): void {
    this.enabled ? this.disable() : this.enable();
  }

  enable(orientation?: SplitOrientation): void {
    if (orientation) this.orientation = orientation;
    this.enabled = true;
    this.ctx.pane2El.hidden = false;
    this.applyOrientation();
    if (!this.view) this.createView();
    this.mirror(this.ctx.getDoc());
    this.ctx.onChange?.();
  }

  disable(): void {
    this.enabled = false;
    this.ctx.pane2El.hidden = true;
    this.ctx.onChange?.();
  }

  toggleOrientation(): void {
    this.orientation = this.orientation === "vertical" ? "horizontal" : "vertical";
    this.applyOrientation();
    if (this.enabled) this.ctx.onChange?.();
  }

  /** "Clone document to other view" — ensure the split is showing the active doc. */
  cloneToOther(): void {
    if (!this.enabled) this.enable();
    else this.mirror(this.ctx.getDoc());
    this.view?.focus();
  }

  private applyOrientation(): void {
    this.ctx.panesEl.classList.toggle("is-split", this.enabled);
    this.ctx.panesEl.classList.toggle("split-horizontal", this.orientation === "horizontal");
  }

  private createView(): void {
    this.view = new EditorView({
      parent: this.ctx.mountEl,
      state: EditorState.create({
        doc: this.ctx.getDoc(),
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          EditorView.lineWrapping,
          this.themeC.of(this.ctx.themeExt()),
          this.langC.of(this.ctx.langExt()),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !this.applying) {
              this.ctx.applyEdit(u.state.doc.toString());
            }
          }),
        ],
      }),
    });
  }

  /** Update pane-2 content to match the primary document (no-op if identical). */
  mirror(text: string): void {
    if (!this.enabled || !this.view) return;
    const current = this.view.state.doc.toString();
    if (current === text) return;
    this.applying = true;
    const sel = this.view.state.selection.main;
    const anchor = Math.min(sel.anchor, text.length);
    const head = Math.min(sel.head, text.length);
    this.view.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      selection: { anchor, head },
    });
    this.applying = false;
  }

  setThemeExt(ext: Extension): void {
    this.view?.dispatch({ effects: this.themeC.reconfigure(ext) });
  }

  setLangExt(ext: Extension): void {
    this.view?.dispatch({ effects: this.langC.reconfigure(ext) });
  }

  focus(): void {
    this.view?.focus();
  }
}

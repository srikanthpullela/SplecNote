// Splec Note — frontend entry point (Phase 1 + 2).
// Owns the editor host, the buffer store, preferences and the session engine,
// and wires the tab strip, status bar, menu, keyboard shortcuts and empty state.

import "./styles.css";
import {
  AppWindow,
  FilePlus,
  FileX,
  FolderOpen,
  Menu,
  Monitor,
  Moon,
  Redo2,
  Save,
  SaveAll,
  Settings,
  Sun,
  Undo2,
  createElement,
  type IconNode,
} from "lucide";
import { redo, undo } from "@codemirror/commands";
import { selectNextOccurrence } from "@codemirror/search";
import { EditorHost, countText } from "./editorHost";
import * as T from "./transforms";
import { goToLine } from "./transforms";
import {
  toggleBookmark,
  jumpBookmark,
  clearAllBookmarks,
  bookmarkLines,
} from "./bookmarks";
import { FindController } from "./findController";
import { FindInFilesController } from "./findInFiles";
import {
  BufferStore,
  baseName,
  newId,
  nextUntitledTitle,
  type Buffer,
} from "./buffers";
import {
  pickerEntries,
  languageLabel,
  loadLanguageExtension,
} from "./languages";
import {
  loadUdls,
  allUdls,
  saveUdl,
  removeUdl,
  findUdl,
  emptyUdl,
  type UdlDef,
} from "./udl";
import { StatusBar } from "./statusbar";
import { renderTabs } from "./tabs";
import { renderEmptyState } from "./emptystate";
import { loadPrefs, savePrefs, type Prefs } from "./prefs";
import { loadRecent } from "./recent";
import { isAutostartEnabled, setAutostart } from "./backend";
import { FileOps } from "./fileops";
import { SessionManager } from "./session";
import {
  applyTheme,
  loadThemeMode,
  nextMode,
  saveThemeMode,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme";
import {
  allThemes,
  loadCustomThemes,
  resolveThemeExtension,
  paletteFromJson,
  addCustomTheme,
} from "./themes";
import { computeOutline, type OutlineItem } from "./outline";
import { CommandPalette, type PaletteCommand } from "./commandPalette";
import { SplitView } from "./split";

const THEME_META: Record<ThemeMode, { label: string; icon: typeof Sun }> = {
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
  system: { label: "System", icon: Monitor },
};

export interface NewBufferOptions {
  id?: string;
  path?: string | null;
  title?: string;
  language?: string;
  content?: string;
  encoding?: string;
  eol?: "LF" | "CRLF" | "CR";
  dirty?: boolean;
  cursor?: { anchor: number; head: number };
  scrollTop?: number;
  bookmarks?: number[];
  diskMtimeMs?: number | null;
  diskSize?: number | null;
  backup?: string | null;
}

export class SplecApp {
  readonly store = new BufferStore();
  host!: EditorHost;
  prefs!: Prefs;
  statusBar!: StatusBar;
  fileOps!: FileOps;
  session!: SessionManager;
  find!: FindController;
  findFiles!: FindInFilesController;
  recent: string[] = [];

  private mode: ThemeMode = "light";
  private resolvedChrome: ResolvedTheme = "light";
  private editorEl = document.querySelector<HTMLElement>("#editor")!;
  private emptyEl = document.querySelector<HTMLElement>("#empty-state")!;
  private tabstripEl = document.querySelector<HTMLElement>("#tabstrip")!;

  palette!: CommandPalette;
  split!: SplitView;
  private outlineVisible = false;
  private minimapOn = false;
  private zenOn = false;
  private currentLangExt: import("@codemirror/state").Extension = [];

  async init(): Promise<void> {
    this.mode = await loadThemeMode();
    const resolved = applyTheme(this.mode);
    this.resolvedChrome = resolved;
    this.prefs = await loadPrefs();
    this.recent = await loadRecent();
    await loadCustomThemes();
    await loadUdls();

    this.host = new EditorHost(this.editorEl, {
      themeExt: resolveThemeExtension(this.prefs.editorTheme, resolved),
      wrap: this.prefs.wordWrap,
      tabSize: this.prefs.tabSize,
      fontSize: this.prefs.fontSize,
      showWhitespace: this.prefs.showWhitespace,
      indentGuides: this.prefs.indentGuides,
      callbacks: {
        onDocChanged: () => this.handleDocChanged(),
        onSelectionChanged: () => this.refreshStatus(),
        onScroll: (top) => this.handleScroll(top),
      },
    });

    this.statusBar = new StatusBar({
      onLanguageChange: (id) => void this.setActiveLanguage(id),
      onEolChange: (eol) => this.setEol(eol),
      onEncodingChange: (enc) => this.setEncoding(enc),
      onWrapToggle: () => this.toggleWrap(),
      onWhitespaceToggle: () => this.toggleWhitespace(),
    });

    this.fileOps = new FileOps(this);
    this.session = new SessionManager(this);
    this.find = new FindController(() => this.host.view, (m) => this.setMessage(m));
    this.findFiles = new FindInFilesController(
      (file, line, col) => void this.openAtLocation(file, line, col),
      (m) => this.setMessage(m),
    );

    this.split = new SplitView({
      panesEl: document.querySelector<HTMLElement>("#editor-panes")!,
      pane2El: document.querySelector<HTMLElement>("#editor-pane-2")!,
      mountEl: document.querySelector<HTMLElement>("#editor-2")!,
      getDoc: () => this.host.view.state.doc.toString(),
      applyEdit: (text) => this.applySplitEdit(text),
      themeExt: () => resolveThemeExtension(this.prefs.editorTheme, this.resolvedChrome),
      langExt: () => this.currentLangExt,
      onChange: () => this.scheduleAutosave(),
    });
    this.palette = new CommandPalette(() => this.paletteCommands());
    this.wireOutline();

    this.renderThemeButton(this.mode);
    this.renderToolbarIcons();
    this.wireChrome();
    this.wireKeyboard();
    this.wirePrefsModal();
    this.statusBar.setWhitespaceOn(this.prefs.showWhitespace);

    // Restore previous session unless launched as a clean window or disabled.
    const cleanWindow = new URLSearchParams(location.search).get("new") === "1";
    let restored = false;
    if (!cleanWindow && this.prefs.restoreSession) {
      restored = await this.session.restore();
    }
    if (!restored && this.store.count() === 0) {
      this.newBuffer();
    }

    this.session.startAutosaveLifecycle();
    void this.session.cleanup();

    watchSystemTheme(
      () => this.mode,
      (sys) => this.setMode("system", sys),
    );
  }

  // ---- Buffer lifecycle ----------------------------------------------------

  makeBuffer(opts: NewBufferOptions): Buffer {
    const content = opts.content ?? "";
    const buf: Buffer = {
      id: opts.id ?? newId(),
      path: opts.path ?? null,
      title: opts.title ?? nextUntitledTitle(),
      language: opts.language ?? "plaintext",
      encoding: opts.encoding ?? "UTF-8",
      eol: opts.eol ?? "LF",
      dirty: opts.dirty ?? false,
      state: this.host.createState(content, [], opts.cursor, opts.bookmarks),
      scrollTop: opts.scrollTop ?? 0,
      diskMtimeMs: opts.diskMtimeMs ?? null,
      diskSize: opts.diskSize ?? null,
      backup: opts.backup ?? null,
    };
    return buf;
  }

  newBuffer(language?: string): Buffer {
    const buf = this.makeBuffer({ language: language ?? this.prefs.defaultLanguage });
    this.store.add(buf);
    void this.activate(buf.id);
    this.scheduleAutosave();
    return buf;
  }

  /** Persist the live editor state back into the active buffer. */
  syncActiveState(): void {
    const a = this.store.active();
    if (!a) return;
    a.state = this.host.view.state;
    a.scrollTop = this.host.view.scrollDOM.scrollTop;
  }

  async activate(id: string): Promise<void> {
    if (this.store.activeIdValue() === id && this.store.active()?.state) {
      this.host.focus();
      return;
    }
    this.syncActiveState();
    const buf = this.store.get(id);
    if (!buf) return;
    this.store.setActive(id);
    if (!buf.state) buf.state = this.host.createState("", []);
    const langExt = await loadLanguageExtension(buf.language);
    this.currentLangExt = langExt;
    this.host.show(buf.state, langExt, buf.scrollTop);
    this.afterShow();
  }

  /**
   * Show whichever buffer is currently active in the store, with no
   * short-circuit. Used after closing the active tab: the store has already
   * moved `activeId` to a neighbour, so we must force the editor + tab strip
   * to re-render onto that buffer (plain `activate` would early-return).
   */
  async showActive(): Promise<void> {
    const buf = this.store.active();
    if (!buf) {
      this.refreshAll();
      return;
    }
    if (!buf.state) buf.state = this.host.createState("", []);
    const langExt = await loadLanguageExtension(buf.language);
    this.currentLangExt = langExt;
    this.host.show(buf.state, langExt, buf.scrollTop);
    this.afterShow();
  }

  /** Shared post-show wiring: focus, refresh chrome, sync split + outline. */
  private afterShow(): void {
    this.split.setLangExt(this.currentLangExt);
    this.split.mirror(this.host.view.state.doc.toString());
    this.host.focus();
    this.refreshAll();
    this.refreshOutline();
    this.find?.refresh();
  }

  /** Live EditorState for a buffer (the active one lives in the view). */
  private liveState(buf: Buffer) {
    return this.store.activeIdValue() === buf.id ? this.host.view.state : buf.state!;
  }

  docText(buf: Buffer): string {
    return this.liveState(buf).doc.toString();
  }

  selectionOf(buf: Buffer): { anchor: number; head: number } {
    const sel = this.liveState(buf).selection.main;
    return { anchor: sel.anchor, head: sel.head };
  }

  scrollOf(buf: Buffer): number {
    return this.store.activeIdValue() === buf.id
      ? this.host.view.scrollDOM.scrollTop
      : buf.scrollTop;
  }

  bookmarksOf(buf: Buffer): number[] {
    return bookmarkLines(this.liveState(buf));
  }

  /** Open a file (if needed) and move the cursor to a 1-based line/column. */
  async openAtLocation(path: string, line: number, col: number): Promise<void> {
    await this.fileOps.openPath(path);
    const buf = this.store.list().find((b) => b.path === path);
    if (!buf || this.store.activeIdValue() !== buf.id) return;
    const view = this.host.view;
    const lineInfo = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line)));
    const pos = Math.min(lineInfo.to, lineInfo.from + Math.max(0, col - 1));
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  }

  async setActiveLanguage(id: string): Promise<void> {
    const buf = this.store.active();
    if (!buf) return;
    buf.language = id;
    const ext = await loadLanguageExtension(id);
    this.currentLangExt = ext;
    this.host.setLanguageExtension(ext);
    this.split.setLangExt(ext);
    this.statusBar.setMessage(`Language: ${languageLabel(id)}`);
    this.refreshOutline();
    this.scheduleAutosave();
  }

  /** Replace a buffer's content from disk (reload / external-change resolution). */
  async replaceBufferContent(
    buf: Buffer,
    content: string,
    eol: "LF" | "CRLF",
    mtime: number | null,
    size: number | null,
  ): Promise<void> {
    buf.state = this.host.createState(content, []);
    buf.eol = eol;
    buf.dirty = false;
    buf.diskMtimeMs = mtime;
    buf.diskSize = size;
    buf.scrollTop = 0;
    if (this.store.activeIdValue() === buf.id) {
      const ext = await loadLanguageExtension(buf.language);
      this.host.show(buf.state, ext, 0);
    }
    this.refreshTabs();
    this.refreshStatus();
  }

  // ---- Editor event handlers ----------------------------------------------

  private handleDocChanged(): void {
    const a = this.store.active();
    if (a && !a.dirty) {
      a.dirty = true;
      this.refreshTabs();
    }
    this.refreshStatus();
    this.split.mirror(this.host.view.state.doc.toString());
    this.scheduleOutline();
    this.scheduleAutosave();
  }

  private handleScroll(top: number): void {
    const a = this.store.active();
    if (a) a.scrollTop = top;
    this.scheduleAutosave();
  }

  // ---- Rendering -----------------------------------------------------------

  refreshAll(): void {
    this.refreshTabs();
    this.refreshStatus();
    this.refreshEmptyState();
  }

  refreshTabs(): void {
    renderTabs(this.tabstripEl, this.store, {
      onSelect: (id) => void this.activate(id),
      onClose: (id) => void this.fileOps.close(id),
      onReorder: (from, to) => {
        this.store.move(from, to);
        this.refreshTabs();
        this.scheduleAutosave();
      },
    });
  }

  refreshStatus(): void {
    const buf = this.store.active();
    if (!buf) {
      this.statusBar.setEnabled(false);
      return;
    }
    this.statusBar.setEnabled(true);
    const info = this.host.cursorInfo();
    const { words, chars } = countText(this.docText(buf));
    this.statusBar.update({
      line: info.line,
      col: info.col,
      selLen: info.selLen,
      language: buf.language,
      encoding: buf.encoding,
      eol: buf.eol,
      words,
      chars,
      wordWrap: this.prefs.wordWrap,
    });
  }

  refreshEmptyState(): void {
    const empty = this.store.count() === 0;
    this.emptyEl.hidden = !empty;
    this.editorEl.style.visibility = empty ? "hidden" : "visible";
    if (empty) {
      renderEmptyState(this.emptyEl, this.recent, {
        onNew: () => this.newBuffer(),
        onOpen: () => void this.fileOps.openDialog(),
        onOpenRecent: (p) => void this.fileOps.openPath(p),
      });
    }
  }

  async refreshRecent(): Promise<void> {
    this.recent = await loadRecent();
    this.renderMenuRecent();
    if (this.store.count() === 0) this.refreshEmptyState();
  }

  setMessage(text: string): void {
    this.statusBar.setMessage(text);
  }

  scheduleAutosave(): void {
    this.session?.scheduleAutosave();
  }

  // ---- Preferences ---------------------------------------------------------

  toggleWrap(): void {
    this.prefs.wordWrap = !this.prefs.wordWrap;
    this.host.setWrap(this.prefs.wordWrap);
    this.syncViewMenuChecks();
    this.refreshStatus();
    void savePrefs(this.prefs);
  }

  toggleEol(): void {
    const order: Array<"LF" | "CRLF" | "CR"> = ["LF", "CRLF", "CR"];
    const buf = this.store.active();
    if (!buf) return;
    const next = order[(order.indexOf(buf.eol) + 1) % order.length];
    this.setEol(next);
  }

  setEol(eol: "LF" | "CRLF" | "CR"): void {
    const buf = this.store.active();
    if (!buf || buf.eol === eol) return;
    buf.eol = eol;
    buf.dirty = true;
    this.refreshTabs();
    this.refreshStatus();
    this.setMessage(`Line endings: ${eol}`);
    this.scheduleAutosave();
  }

  setEncoding(encoding: string): void {
    const buf = this.store.active();
    if (!buf || buf.encoding === encoding) return;
    buf.encoding = encoding;
    buf.dirty = true;
    this.refreshTabs();
    this.refreshStatus();
    this.setMessage(`Encoding: ${encoding} (applied on next save)`);
    this.scheduleAutosave();
  }

  toggleWhitespace(): void {
    const on = !this.host.isShowWhitespace();
    this.host.setShowWhitespace(on);
    this.prefs.showWhitespace = on;
    this.statusBar.setWhitespaceOn(on);
    this.syncViewMenuChecks();
    void savePrefs(this.prefs);
  }

  toggleIndentGuides(): void {
    const on = !this.prefs.indentGuides;
    this.prefs.indentGuides = on;
    this.host.setIndentGuides(on);
    this.syncViewMenuChecks();
    void savePrefs(this.prefs);
  }

  applyPrefs(next: Prefs): void {
    this.prefs = next;
    this.host.setFontSize(next.fontSize);
    this.host.setTabSize(next.tabSize);
    this.host.setWrap(next.wordWrap);
    this.host.setShowWhitespace(next.showWhitespace);
    this.host.setIndentGuides(next.indentGuides);
    this.statusBar.setWhitespaceOn(next.showWhitespace);
    this.syncViewMenuChecks();
    this.refreshStatus();
    void savePrefs(next);
  }

  /** Reflect View-menu checkbox state for the toggle items. */
  syncViewMenuChecks(): void {
    const set = (act: string, on: boolean) => {
      document
        .querySelector<HTMLElement>(`.menu-item-check[data-act="${act}"]`)
        ?.classList.toggle("is-checked", on);
    };
    set("wrap", this.prefs.wordWrap);
    set("whitespace", this.prefs.showWhitespace);
    set("indentGuides", this.prefs.indentGuides);
    set("toggleOutline", this.outlineVisible);
    set("toggleMinimap", this.minimapOn);
    set("toggleSplit", this.split?.isEnabled() ?? false);
    set("toggleZen", this.zenOn);
  }

  // ---- View panels: outline, minimap, split, distraction-free --------------

  private outlineTimer: number | null = null;

  private wireOutline(): void {
    document.querySelector("#outline-close")?.addEventListener("click", () => this.toggleOutline(false));
  }

  toggleOutline(force?: boolean): void {
    this.outlineVisible = force ?? !this.outlineVisible;
    const panel = document.querySelector<HTMLElement>("#outline-panel");
    if (panel) panel.hidden = !this.outlineVisible;
    if (this.outlineVisible) this.refreshOutline();
    this.syncViewMenuChecks();
  }

  private scheduleOutline(): void {
    if (!this.outlineVisible) return;
    if (this.outlineTimer != null) clearTimeout(this.outlineTimer);
    this.outlineTimer = window.setTimeout(() => this.refreshOutline(), 250);
  }

  refreshOutline(): void {
    if (!this.outlineVisible) return;
    const buf = this.store.active();
    const list = document.querySelector<HTMLElement>("#outline-list");
    if (!list) return;
    list.replaceChildren();
    if (!buf) return;
    const items = computeOutline(this.host.view.state, buf.language);
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No symbols found.";
      list.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "outline-item";
      row.style.paddingLeft = `${10 + item.level * 12}px`;
      row.textContent = item.label;
      row.title = `Line ${item.line}`;
      row.addEventListener("click", () => this.jumpToOutline(item));
      list.append(row);
    }
  }

  private jumpToOutline(item: OutlineItem): void {
    const view = this.host.view;
    const pos = Math.min(item.pos, view.state.doc.length);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  }

  toggleMinimap(force?: boolean): void {
    this.minimapOn = force ?? !this.minimapOn;
    if (this.minimapOn) {
      void import("@replit/codemirror-minimap").then(({ showMinimap }) => {
        if (!this.minimapOn) return;
        const create = () => {
          const dom = document.createElement("div");
          return { dom };
        };
        this.host.setExtra(showMinimap.compute([], () => ({ create, showOverlay: "always" as const })));
      });
    } else {
      this.host.setExtra([]);
    }
    this.syncViewMenuChecks();
  }

  toggleZen(force?: boolean): void {
    this.zenOn = force ?? !this.zenOn;
    document.body.classList.toggle("zen-mode", this.zenOn);
    this.syncViewMenuChecks();
    this.host.focus();
  }

  /** Apply an edit made in the secondary split pane to the primary editor. */
  private applySplitEdit(text: string): void {
    const view = this.host.view;
    const current = view.state.doc.toString();
    if (current === text) return;
    const sel = view.state.selection.main;
    const anchor = Math.min(sel.anchor, text.length);
    view.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      selection: { anchor, head: anchor },
    });
  }

  // ---- Command palette ------------------------------------------------------

  private paletteCommands(): PaletteCommand[] {
    const items: Array<[string, string, string?]> = [
      ["new", "New Note", "⌘T"],
      ["open", "Open File…", "⌘O"],
      ["save", "Save", "⌘S"],
      ["saveAs", "Save As…", "⇧⌘S"],
      ["close", "Close Tab", "⌘W"],
      ["newWindow", "New Window", "⇧⌘N"],
      ["prefs", "Preferences…", "⌘,"],
      ["find", "Find…", "⌘F"],
      ["replace", "Replace…", "⌘H"],
      ["findInFiles", "Find in Files…", "⇧⌘F"],
      ["gotoLine", "Go to Line…", "⌘G"],
      ["toggleComment", "Toggle Comment", "⌘/"],
      ["selectNext", "Select Next Occurrence", "⌘D"],
      ["duplicateLine", "Duplicate Line"],
      ["moveLineUp", "Move Line Up", "⌥↑"],
      ["moveLineDown", "Move Line Down", "⌥↓"],
      ["toggleBookmark", "Toggle Bookmark", "⌘B"],
      ["nextBookmark", "Next Bookmark", "F2"],
      ["clearBookmarks", "Clear All Bookmarks"],
      ["upper", "Transform: UPPERCASE"],
      ["lower", "Transform: lowercase"],
      ["title", "Transform: Title Case"],
      ["sortAsc", "Sort Lines (A→Z)"],
      ["sortDesc", "Sort Lines (Z→A)"],
      ["sortUnique", "Sort & Remove Duplicates"],
      ["trim", "Trim Trailing Whitespace"],
      ["join", "Join Lines"],
      ["wrap", "Toggle Word Wrap"],
      ["whitespace", "Toggle Show Whitespace"],
      ["indentGuides", "Toggle Indent Guides"],
      ["toggleOutline", "Toggle Outline Panel"],
      ["toggleMinimap", "Toggle Minimap"],
      ["toggleSplit", "Toggle Split Editor"],
      ["splitOrientation", "Toggle Split Orientation"],
      ["cloneToOther", "Clone to Other Pane"],
      ["toggleZen", "Toggle Distraction-Free", "⌃⌘F"],
    ];
    return items.map(([act, title, hint]) => ({
      id: act,
      title,
      hint,
      run: () => this.runMenuAction(act),
    }));
  }

  // ---- Theme ---------------------------------------------------------------

  private setMode(mode: ThemeMode, resolvedHint?: ResolvedTheme): void {
    this.mode = mode;
    const resolved = resolvedHint ?? applyTheme(mode);
    if (resolvedHint) applyTheme(mode);
    this.resolvedChrome = resolved;
    this.applyEditorTheme();
    this.renderThemeButton(mode);
  }

  /** Re-resolve and apply the editor color theme from prefs + current chrome. */
  applyEditorTheme(): void {
    const ext = resolveThemeExtension(this.prefs.editorTheme, this.resolvedChrome);
    this.host.setTheme(ext);
    this.split?.setThemeExt(resolveThemeExtension(this.prefs.editorTheme, this.resolvedChrome));
  }

  /** Choose an editor color theme by id ("auto" follows chrome). */
  setEditorTheme(id: string): void {
    this.prefs.editorTheme = id;
    this.applyEditorTheme();
    void savePrefs(this.prefs);
    this.syncEditorThemeUI();
  }

  /** Import a simple JSON token-color theme from text; returns its label or null. */
  async importEditorThemeJson(text: string): Promise<string | null> {
    try {
      const json = JSON.parse(text);
      const def = paletteFromJson(json, "Imported Theme");
      await addCustomTheme(def);
      this.setEditorTheme(def.id);
      this.populateEditorThemeSelect();
      this.setMessage(`Imported theme “${def.label}”`);
      return def.label;
    } catch (err) {
      this.setMessage(`Could not import theme: ${String(err)}`);
      return null;
    }
  }

  private populateEditorThemeSelect(): void {
    const sel = document.querySelector<HTMLSelectElement>("#pref-editor-theme");
    if (!sel) return;
    sel.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "Auto (follow app theme)";
    sel.append(auto);
    for (const def of allThemes()) {
      const opt = document.createElement("option");
      opt.value = def.id;
      opt.textContent = def.label + (def.custom ? " (imported)" : "");
      sel.append(opt);
    }
    sel.value = this.prefs.editorTheme;
  }

  private syncEditorThemeUI(): void {
    const sel = document.querySelector<HTMLSelectElement>("#pref-editor-theme");
    if (sel) sel.value = this.prefs.editorTheme;
  }

  private renderThemeButton(mode: ThemeMode): void {
    const slot = document.querySelector<HTMLElement>("#theme-toggle .icon-slot");
    const button = document.querySelector<HTMLButtonElement>("#theme-toggle");
    const meta = THEME_META[mode];
    if (slot) slot.replaceChildren(createElement(meta.icon));
    if (button) {
      const tip = `Theme: ${meta.label} — click for ${THEME_META[nextMode(mode)].label}`;
      button.setAttribute("aria-label", tip);
      button.setAttribute("title", tip);
    }
    // Keep the Preferences segmented control in sync if it's mounted.
    document.querySelectorAll<HTMLButtonElement>("#pref-theme .seg").forEach((seg) => {
      const on = seg.dataset.mode === mode;
      seg.classList.toggle("is-active", on);
      seg.setAttribute("aria-checked", String(on));
    });
  }

  private renderToolbarIcons(): void {
    const ico = (sel: string, icon: IconNode) => {
      const el = document.querySelector<HTMLButtonElement>(sel);
      if (el) el.replaceChildren(createElement(icon));
    };
    ico("#act-new", FilePlus);
    ico("#act-open", FolderOpen);
    ico("#act-save", Save);
    ico("#act-saveas", SaveAll);
    ico("#act-close", FileX);
    ico("#act-undo", Undo2);
    ico("#act-redo", Redo2);
    ico("#act-newwin", AppWindow);

    const menuSlot = document.querySelector<HTMLElement>("#menu-toggle .icon-slot");
    if (menuSlot) menuSlot.replaceChildren(createElement(Menu));
    const settingsSlot = document.querySelector<HTMLElement>("#settings-toggle .icon-slot");
    if (settingsSlot) settingsSlot.replaceChildren(createElement(Settings));
  }

  // ---- Chrome wiring -------------------------------------------------------

  private wireChrome(): void {
    document.querySelector("#theme-toggle")?.addEventListener("click", () => {
      this.chooseMode(nextMode(this.mode));
    });

    document.querySelector("#act-new")?.addEventListener("click", () => this.newBuffer());
    document.querySelector("#act-open")?.addEventListener("click", () => void this.fileOps.openDialog());
    document.querySelector("#act-save")?.addEventListener("click", () => void this.fileOps.save());
    document.querySelector("#act-saveas")?.addEventListener("click", () => void this.fileOps.saveAs());
    document.querySelector("#act-close")?.addEventListener("click", () => {
      const a = this.store.active();
      if (a) void this.fileOps.close(a.id);
    });
    document.querySelector("#act-undo")?.addEventListener("click", () => {
      undo(this.host.view);
      this.host.focus();
    });
    document.querySelector("#act-redo")?.addEventListener("click", () => {
      redo(this.host.view);
      this.host.focus();
    });
    document.querySelector("#act-newwin")?.addEventListener("click", () => void this.session.openCleanWindow());
    document.querySelector("#tab-new")?.addEventListener("click", () => this.newBuffer());
    document.querySelector("#settings-toggle")?.addEventListener("click", () => this.openPrefs());

    this.wireMenu();
    this.wireGotoLine();
    this.syncViewMenuChecks();
  }

  // ---- Go to line ----------------------------------------------------------

  private openGotoLine(): void {
    const overlay = document.querySelector<HTMLElement>("#goto-overlay");
    const input = document.querySelector<HTMLInputElement>("#goto-input");
    if (!overlay || !input) return;
    const info = this.host.cursorInfo();
    input.value = "";
    input.placeholder = `Line (1–${this.host.view.state.doc.lines}) — current ${info.line}`;
    overlay.hidden = false;
    input.focus();
  }

  private closeGotoLine(): void {
    const overlay = document.querySelector<HTMLElement>("#goto-overlay");
    if (overlay) overlay.hidden = true;
    this.host.focus();
  }

  private wireGotoLine(): void {
    const input = document.querySelector<HTMLInputElement>("#goto-input");
    const overlay = document.querySelector<HTMLElement>("#goto-overlay");
    if (!input || !overlay) return;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const n = Number(input.value);
        if (Number.isFinite(n) && n >= 1) goToLine(this.host.view, n);
        this.closeGotoLine();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeGotoLine();
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeGotoLine();
    });
  }

  private chooseMode(mode: ThemeMode): void {
    this.setMode(mode);
    void saveThemeMode(mode);
  }

  private wireMenu(): void {
    const toggle = document.querySelector<HTMLButtonElement>("#menu-toggle");
    const menu = document.querySelector<HTMLElement>("#app-menu");
    if (!toggle || !menu) return;

    const closeMenu = () => {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    };
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) this.renderMenuRecent();
    });
    document.addEventListener("click", () => closeMenu());
    menu.addEventListener("click", (e) => e.stopPropagation());

    menu.querySelectorAll<HTMLButtonElement>(".menu-item[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        closeMenu();
        this.runMenuAction(btn.dataset.act!);
      });
    });
  }

  private runMenuAction(act: string): void {
    const run = (fn: (v: import("@codemirror/view").EditorView) => boolean) => {
      fn(this.host.view);
      this.host.focus();
    };
    switch (act) {
      case "new": this.newBuffer(); break;
      case "open": void this.fileOps.openDialog(); break;
      case "save": void this.fileOps.save(); break;
      case "saveAs": void this.fileOps.saveAs(); break;
      case "close": {
        const a = this.store.active();
        if (a) void this.fileOps.close(a.id);
        break;
      }
      case "newWindow": void this.session.openCleanWindow(); break;
      case "prefs": this.openPrefs(); break;
      // Search
      case "find": this.find.open("find"); break;
      case "replace": this.find.open("replace"); break;
      case "findInFiles": this.findFiles.open(); break;
      case "gotoLine": this.openGotoLine(); break;
      // Edit
      case "toggleComment": run(T.toggleComment); break;
      case "selectNext": run(selectNextOccurrence); break;
      case "duplicateLine": run(T.duplicateLine); break;
      case "moveLineUp": run(T.moveLineUp); break;
      case "moveLineDown": run(T.moveLineDown); break;
      case "toggleBookmark": run(toggleBookmark); break;
      case "nextBookmark": run((v) => jumpBookmark(v, 1)); break;
      case "clearBookmarks": run(clearAllBookmarks); break;
      case "upper": run(T.toUpperCase); break;
      case "lower": run(T.toLowerCase); break;
      case "title": run(T.toTitleCase); break;
      case "sortAsc": run(T.sortLinesAsc); break;
      case "sortDesc": run(T.sortLinesDesc); break;
      case "sortUnique": run(T.sortLinesUnique); break;
      case "trim": run(T.trimTrailingWhitespace); break;
      case "join": run(T.joinLines); break;
      // View
      case "wrap": this.toggleWrap(); break;
      case "whitespace": this.toggleWhitespace(); break;
      case "indentGuides": this.toggleIndentGuides(); break;
      case "toggleOutline": this.toggleOutline(); break;
      case "toggleMinimap": this.toggleMinimap(); break;
      case "toggleSplit": this.split.toggle(); break;
      case "splitOrientation": this.split.toggleOrientation(); break;
      case "cloneToOther": this.split.cloneToOther(); break;
      case "toggleZen": this.toggleZen(); break;
      case "commandPalette": this.palette.open(); break;
    }
  }

  private renderMenuRecent(): void {
    const wrap = document.querySelector<HTMLElement>("#menu-recent");
    if (!wrap) return;
    wrap.replaceChildren();
    if (this.recent.length === 0) {
      const empty = document.createElement("div");
      empty.className = "menu-empty";
      empty.textContent = "No recent files";
      wrap.append(empty);
      return;
    }
    for (const path of this.recent) {
      const item = document.createElement("button");
      item.className = "menu-item menu-recent-item";
      item.type = "button";
      item.title = path;
      item.textContent = baseName(path);
      item.addEventListener("click", () => {
        document.querySelector<HTMLElement>("#app-menu")!.hidden = true;
        void this.fileOps.openPath(path);
      });
      wrap.append(item);
    }
  }

  // ---- Preferences modal ---------------------------------------------------

  private wirePrefsModal(): void {
    const langSel = document.querySelector<HTMLSelectElement>("#pref-lang");
    if (langSel && langSel.options.length === 0) {
      for (const { id, label } of pickerEntries()) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = label;
        langSel.append(opt);
      }
    }
    document.querySelector("#prefs-close")?.addEventListener("click", () => this.closePrefs());
    document.querySelector("#prefs-overlay")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.closePrefs();
    });

    // Appearance — theme segmented control.
    document.querySelectorAll<HTMLButtonElement>("#pref-theme .seg").forEach((seg) => {
      seg.addEventListener("click", () => {
        const mode = seg.dataset.mode as ThemeMode;
        if (mode) this.chooseMode(mode);
      });
    });

    const font = document.querySelector<HTMLInputElement>("#pref-font");
    const tab = document.querySelector<HTMLSelectElement>("#pref-tab");
    const wrap = document.querySelector<HTMLInputElement>("#pref-wrap");
    const whitespace = document.querySelector<HTMLInputElement>("#pref-whitespace");
    const guides = document.querySelector<HTMLInputElement>("#pref-guides");
    const restore = document.querySelector<HTMLInputElement>("#pref-restore");
    const autosave = document.querySelector<HTMLInputElement>("#pref-autosave");
    const apply = () => {
      this.applyPrefs({
        ...this.prefs,
        fontSize: Number(font?.value ?? this.prefs.fontSize),
        tabSize: Number(tab?.value ?? this.prefs.tabSize),
        wordWrap: Boolean(wrap?.checked),
        showWhitespace: whitespace ? whitespace.checked : this.prefs.showWhitespace,
        indentGuides: guides ? guides.checked : this.prefs.indentGuides,
        defaultLanguage: langSel?.value ?? this.prefs.defaultLanguage,
        restoreSession: restore ? restore.checked : this.prefs.restoreSession,
        autosave: autosave ? autosave.checked : this.prefs.autosave,
      });
    };
    font?.addEventListener("change", apply);
    tab?.addEventListener("change", apply);
    wrap?.addEventListener("change", apply);
    whitespace?.addEventListener("change", apply);
    guides?.addEventListener("change", apply);
    langSel?.addEventListener("change", apply);
    restore?.addEventListener("change", apply);
    autosave?.addEventListener("change", apply);

    // Open at login is handled by the OS via the autostart plugin; reflect the
    // real resulting state back into the checkbox.
    const login = document.querySelector<HTMLInputElement>("#pref-login");
    login?.addEventListener("change", () => {
      void (async () => {
        const result = await setAutostart(login.checked);
        login.checked = result;
        this.applyPrefs({ ...this.prefs, openAtLogin: result });
      })();
    });

    // Editor color theme select + JSON import.
    const themeSel = document.querySelector<HTMLSelectElement>("#pref-editor-theme");
    themeSel?.addEventListener("change", () => this.setEditorTheme(themeSel.value));
    const importBtn = document.querySelector<HTMLButtonElement>("#pref-import-theme");
    const fileInput = document.querySelector<HTMLInputElement>("#pref-theme-file");
    importBtn?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      void file.text().then((text) => this.importEditorThemeJson(text));
      fileInput.value = "";
    });

    this.wireUdlEditor();
  }

  // ---- User-Defined Languages ----------------------------------------------

  private udlEditingId: string | null = null;

  private wireUdlEditor(): void {
    document.querySelector("#udl-add")?.addEventListener("click", () => this.openUdlEditor());
    document.querySelector("#udl-close")?.addEventListener("click", () => this.closeUdlEditor());
    document.querySelector("#udl-cancel")?.addEventListener("click", () => this.closeUdlEditor());
    document.querySelector("#udl-overlay")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.closeUdlEditor();
    });
    document.querySelector("#udl-save")?.addEventListener("click", () => void this.saveUdlFromForm());
    document.querySelector("#udl-delete")?.addEventListener("click", () => void this.deleteCurrentUdl());
  }

  private renderUdlList(): void {
    const wrap = document.querySelector<HTMLElement>("#udl-list");
    if (!wrap) return;
    wrap.replaceChildren();
    const defs = allUdls();
    if (defs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "udl-empty";
      empty.textContent = "No user-defined languages yet.";
      wrap.append(empty);
      return;
    }
    for (const def of defs) {
      const row = document.createElement("div");
      row.className = "udl-item";
      const name = document.createElement("span");
      name.className = "udl-item-name";
      name.textContent = def.name;
      const edit = document.createElement("button");
      edit.className = "prefs-btn";
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => this.openUdlEditor(def.id));
      row.append(name, edit);
      wrap.append(row);
    }
  }

  private openUdlEditor(id?: string): void {
    const def: UdlDef = id ? findUdl(id) ?? emptyUdl() : emptyUdl();
    this.udlEditingId = id ?? null;
    const set = (sel: string, v: string) => {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
      if (el) el.value = v;
    };
    set("#udl-name", def.name);
    set("#udl-line", def.lineComment);
    set("#udl-blockstart", def.blockStart);
    set("#udl-blockend", def.blockEnd);
    set("#udl-strings", def.strings.join(" "));
    set("#udl-keywords", def.keywords.join(" "));
    set("#udl-types", def.types.join(" "));
    const ci = document.querySelector<HTMLInputElement>("#udl-ci");
    if (ci) ci.checked = def.caseInsensitive;
    const del = document.querySelector<HTMLButtonElement>("#udl-delete");
    if (del) del.hidden = !id;
    const overlay = document.querySelector<HTMLElement>("#udl-overlay");
    if (overlay) overlay.hidden = false;
    document.querySelector<HTMLInputElement>("#udl-name")?.focus();
  }

  private closeUdlEditor(): void {
    const overlay = document.querySelector<HTMLElement>("#udl-overlay");
    if (overlay) overlay.hidden = true;
    this.udlEditingId = null;
  }

  private async saveUdlFromForm(): Promise<void> {
    const get = (sel: string): string =>
      document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.value ?? "";
    const tokens = (s: string): string[] => s.split(/\s+/).filter(Boolean);
    const name = get("#udl-name").trim();
    if (!name) {
      this.setMessage("A name is required for a user-defined language.");
      return;
    }
    const def: UdlDef = {
      id: this.udlEditingId ?? "",
      name,
      keywords: tokens(get("#udl-keywords")),
      types: tokens(get("#udl-types")),
      lineComment: get("#udl-line").trim(),
      blockStart: get("#udl-blockstart").trim(),
      blockEnd: get("#udl-blockend").trim(),
      strings: tokens(get("#udl-strings")),
      caseInsensitive: document.querySelector<HTMLInputElement>("#udl-ci")?.checked ?? false,
    };
    try {
      const saved = await saveUdl(def);
      this.refreshLanguagePickers();
      this.renderUdlList();
      this.closeUdlEditor();
      // Apply immediately if the active buffer is using this UDL.
      const buf = this.store.active();
      if (buf && buf.language === `udl:${saved.id}`) await this.setActiveLanguage(buf.language);
      this.setMessage(`Saved language: ${saved.name}`);
    } catch (e) {
      this.setMessage(String(e instanceof Error ? e.message : e));
    }
  }

  private async deleteCurrentUdl(): Promise<void> {
    if (!this.udlEditingId) return;
    await removeUdl(this.udlEditingId);
    this.refreshLanguagePickers();
    this.renderUdlList();
    this.closeUdlEditor();
    this.setMessage("Deleted user-defined language.");
  }

  /** Rebuild the status-bar and Preferences language selects (e.g. after UDL edits). */
  private refreshLanguagePickers(): void {
    this.statusBar.rebuildLanguages();
    const langSel = document.querySelector<HTMLSelectElement>("#pref-lang");
    if (langSel) {
      const cur = langSel.value;
      langSel.replaceChildren();
      for (const { id, label } of pickerEntries()) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = label;
        langSel.append(opt);
      }
      langSel.value = cur || this.prefs.defaultLanguage;
    }
  }

  private openPrefs(): void {
    const overlay = document.querySelector<HTMLElement>("#prefs-overlay");
    if (!overlay) return;
    document.querySelector<HTMLInputElement>("#pref-font")!.value = String(this.prefs.fontSize);
    document.querySelector<HTMLSelectElement>("#pref-tab")!.value = String(this.prefs.tabSize);
    document.querySelector<HTMLInputElement>("#pref-wrap")!.checked = this.prefs.wordWrap;
    document.querySelector<HTMLInputElement>("#pref-whitespace")!.checked = this.prefs.showWhitespace;
    document.querySelector<HTMLInputElement>("#pref-guides")!.checked = this.prefs.indentGuides;
    document.querySelector<HTMLSelectElement>("#pref-lang")!.value = this.prefs.defaultLanguage;
    document.querySelector<HTMLInputElement>("#pref-restore")!.checked = this.prefs.restoreSession;
    document.querySelector<HTMLInputElement>("#pref-autosave")!.checked = this.prefs.autosave;
    this.populateEditorThemeSelect();
    this.renderUdlList();
    this.renderThemeButton(this.mode); // syncs the segmented control
    overlay.hidden = false;
    // Reflect the OS-level autostart state (may differ from saved pref).
    void (async () => {
      const login = document.querySelector<HTMLInputElement>("#pref-login");
      if (login) login.checked = await isAutostartEnabled();
    })();
  }

  private closePrefs(): void {
    const overlay = document.querySelector<HTMLElement>("#prefs-overlay");
    if (overlay) overlay.hidden = true;
    this.host.focus();
  }

  // ---- Keyboard ------------------------------------------------------------

  private wireKeyboard(): void {
    window.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (e.key === "Tab") {
        e.preventDefault();
        const id = this.store.cycle(e.shiftKey ? -1 : 1);
        if (id) void this.activate(id);
      } else if (key === "p" && e.shiftKey) {
        e.preventDefault();
        this.palette.open();
      } else if (key === "f" && e.ctrlKey && e.metaKey) {
        e.preventDefault();
        this.toggleZen();
      } else if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        this.newBuffer();
      } else if (key === "n" && e.shiftKey) {
        e.preventDefault();
        void this.session.openCleanWindow();
      } else if (key === "n") {
        e.preventDefault();
        this.newBuffer();
      } else if (key === "o") {
        e.preventDefault();
        void this.fileOps.openDialog();
      } else if (key === "s" && e.shiftKey) {
        e.preventDefault();
        void this.fileOps.saveAs();
      } else if (key === "s") {
        e.preventDefault();
        void this.fileOps.save();
      } else if (key === "w") {
        e.preventDefault();
        const a = this.store.active();
        if (a) void this.fileOps.close(a.id);
      } else if (key === "f" && e.shiftKey) {
        e.preventDefault();
        this.findFiles.open();
      } else if (key === "f") {
        e.preventDefault();
        this.find.open("find");
      } else if (key === "h") {
        e.preventDefault();
        this.find.open("replace");
      } else if (key === "g") {
        e.preventDefault();
        this.openGotoLine();
      } else if (key === ",") {
        e.preventDefault();
        this.openPrefs();
      }
    });
  }
}

const app = new SplecApp();
window.addEventListener("DOMContentLoaded", () => {
  void app.init();
});

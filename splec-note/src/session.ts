// Session persistence engine (frontend half).
// Continuously mirrors every open buffer — named or untitled — to a backup file
// in the app data dir, and writes an ordered session manifest. On launch it
// rebuilds every tab (including unsaved untitled ones) with cursor/scroll, and
// reconciles real files against their on-disk state.

import {
  autosaveBackup,
  cleanupBackups,
  isTauri,
  loadSession,
  readTextFile,
  statFile,
  writeSession,
  type ManifestTab,
  type SessionManifest,
} from "./backend";
import { confirm } from "./confirm";
import { baseName } from "./buffers";
import type { SplecApp } from "./main";

const AUTOSAVE_DEBOUNCE_MS = 500;
const RETENTION_DAYS = 14;

export class SessionManager {
  private timer: number | null = null;
  private inFlight: Promise<void> | null = null;
  private pendingAgain = false;

  constructor(private app: SplecApp) {}

  // ---- Autosave scheduling -------------------------------------------------

  scheduleAutosave(): void {
    if (!isTauri()) return;
    if (!this.app.prefs.autosave) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.autosaveAll();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Run an autosave now, serializing concurrent calls. */
  private async autosaveAll(): Promise<void> {
    if (this.inFlight) {
      this.pendingAgain = true;
      return this.inFlight;
    }
    this.inFlight = this.doAutosave().finally(() => {
      this.inFlight = null;
      if (this.pendingAgain) {
        this.pendingAgain = false;
        void this.autosaveAll();
      }
    });
    return this.inFlight;
  }

  private async doAutosave(): Promise<void> {
    if (!isTauri()) return;
    if (!this.app.prefs.autosave) return;
    this.app.syncActiveState();
    const buffers = this.app.store.list();
    // Mirror each buffer's content to its backup file (atomic in the backend).
    for (const buf of buffers) {
      try {
        buf.backup = await autosaveBackup(buf.id, this.app.docText(buf));
      } catch {
        /* keep going; a single backup failure must not lose the rest */
      }
    }
    try {
      await writeSession(this.buildManifest());
    } catch {
      /* manifest write failure is non-fatal for this tick */
    }
  }

  /** Force a synchronous-ish flush (used on tab switch / blur / quit). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.autosaveAll();
  }

  // ---- Manifest ------------------------------------------------------------

  private buildManifest(): SessionManifest {
    const tabs: ManifestTab[] = this.app.store.list().map((buf) => {
      const sel = this.app.selectionOf(buf);
      return {
        id: buf.id,
        path: buf.path,
        title: buf.title,
        language: buf.language,
        encoding: buf.encoding,
        eol: buf.eol,
        dirty: buf.dirty,
        backup: buf.backup,
        cursor: sel.head,
        selAnchor: sel.anchor,
        selHead: sel.head,
        scrollTop: Math.round(this.app.scrollOf(buf)),
        bookmarks: this.app.bookmarksOf(buf),
        diskMtimeMs: buf.diskMtimeMs,
        diskSize: buf.diskSize,
      };
    });
    return {
      version: 1,
      activeId: this.app.store.activeIdValue(),
      tabs,
      split: {
        enabled: this.app.split?.isEnabled() ?? false,
        orientation: this.app.split?.orientation ?? "vertical",
      },
    };
  }

  // ---- Restore -------------------------------------------------------------

  async restore(): Promise<boolean> {
    if (!isTauri()) return false;
    let restored: { manifest: SessionManifest; contents: Record<string, string> } | null;
    try {
      restored = await loadSession();
    } catch {
      return false;
    }
    if (!restored || !restored.manifest || restored.manifest.tabs.length === 0) {
      return false;
    }

    const { manifest, contents } = restored;
    for (const tab of manifest.tabs) {
      const content = contents[tab.id] ?? "";
      const buf = this.app.makeBuffer({
        id: tab.id,
        path: tab.path,
        title: tab.title || (tab.path ? baseName(tab.path) : "Untitled"),
        language: tab.language || "plaintext",
        content,
        encoding: tab.encoding || "UTF-8",
        eol: tab.eol === "CRLF" ? "CRLF" : tab.eol === "CR" ? "CR" : "LF",
        dirty: tab.dirty,
        cursor: { anchor: tab.selAnchor, head: tab.selHead },
        scrollTop: tab.scrollTop,
        bookmarks: Array.isArray(tab.bookmarks) ? tab.bookmarks : [],
        diskMtimeMs: tab.diskMtimeMs,
        diskSize: tab.diskSize,
        backup: tab.backup,
      });
      this.app.store.add(buf);
    }

    const activeId =
      manifest.activeId && this.app.store.get(manifest.activeId)
        ? manifest.activeId
        : this.app.store.list()[0]?.id ?? null;
    if (activeId) await this.app.activate(activeId);
    else this.app.refreshAll();

    // Restore split layout after the active tab is shown.
    if (manifest.split?.enabled) {
      this.app.split.enable(manifest.split.orientation === "horizontal" ? "horizontal" : "vertical");
    }

    this.app.setMessage(`Restored ${manifest.tabs.length} tab${manifest.tabs.length === 1 ? "" : "s"}`);

    // Reconcile real files against disk (don't block the UI on it).
    void this.reconcileDisk();
    return true;
  }

  private async reconcileDisk(): Promise<void> {
    for (const buf of [...this.app.store.list()]) {
      if (!buf.path || buf.diskMtimeMs === null) continue;
      let changed = false;
      try {
        const s = await statFile(buf.path);
        changed = s.exists && s.mtime_ms !== null && s.mtime_ms !== buf.diskMtimeMs;
      } catch {
        changed = false;
      }
      if (!changed) continue;
      const name = baseName(buf.path);
      const reload = await confirm(
        `"${name}" changed on disk since you last edited it. Reload it from disk, or keep the copy you have open here?`,
        { title: "File changed on disk", okLabel: "Reload from Disk", cancelLabel: "Keep My Copy" },
      );
      if (reload) {
        try {
          const read = await readTextFile(buf.path);
          await this.app.replaceBufferContent(
            buf,
            read.content,
            read.eol === "CRLF" ? "CRLF" : "LF",
            read.mtime_ms,
            read.size,
          );
        } catch {
          /* leave the editor copy intact on read failure */
        }
      } else {
        // Keep the editor copy; mark dirty so it stays backed up.
        buf.dirty = true;
        this.app.refreshTabs();
      }
    }
    this.scheduleAutosave();
  }

  // ---- Cleanup -------------------------------------------------------------

  async cleanup(): Promise<void> {
    if (!isTauri()) return;
    const keep = this.app.store
      .list()
      .map((b) => b.backup)
      .filter((p): p is string => Boolean(p));
    try {
      await cleanupBackups(keep, RETENTION_DAYS);
    } catch {
      /* non-fatal */
    }
  }

  // ---- Lifecycle hooks -----------------------------------------------------

  startAutosaveLifecycle(): void {
    if (!isTauri()) return;

    window.addEventListener("blur", () => void this.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.flush();
    });

    // Intercept window close so nothing is lost on quit.
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        await win.onCloseRequested(async (event) => {
          event.preventDefault();
          await this.flush();
          await win.destroy();
        });
      } catch {
        /* not in a Tauri window */
      }
    })();
  }

  // ---- New (clean) window --------------------------------------------------

  async openCleanWindow(): Promise<void> {
    if (!isTauri()) {
      window.open(`${location.pathname}?new=1`, "_blank");
      return;
    }
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const label = `splec-${Date.now()}`;
      new WebviewWindow(label, {
        url: "index.html?new=1",
        title: "Splec Note",
        width: 980,
        height: 680,
      });
    } catch (err) {
      this.app.setMessage(`Could not open window: ${String(err)}`);
    }
  }
}

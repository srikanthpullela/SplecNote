// Buffer model + store. A "buffer" is one open document (saved file or untitled
// scratch note). The active buffer's live document lives in the EditorView; every
// buffer keeps its own EditorState so undo history, selection and scroll survive
// tab switches.

import type { EditorState } from "@codemirror/state";

export interface Buffer {
  /** Stable internal id — also the backup filename stem. */
  id: string;
  /** Real file path, or null for an untitled buffer. */
  path: string | null;
  /** Tab label. */
  title: string;
  /** Language id (see languages.ts). */
  language: string;
  encoding: string; // "UTF-8" | "UTF-8-BOM" | "UTF-16LE" | "UTF-16BE"
  eol: "LF" | "CRLF" | "CR";
  dirty: boolean;
  /** Per-buffer CodeMirror state (null only transiently before first show). */
  state: EditorState | null;
  /** Last known scroll offset of the editor for this buffer. */
  scrollTop: number;
  /** Disk mtime/size at last read/write — used for external-change detection. */
  diskMtimeMs: number | null;
  diskSize: number | null;
  /** Backup path (relative to AutoSave root) once mirrored, else null. */
  backup: string | null;
}

let untitledCounter = 0;

export function nextUntitledTitle(): string {
  untitledCounter += 1;
  return untitledCounter === 1 ? "Untitled" : `Untitled-${untitledCounter}`;
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function baseName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

export class BufferStore {
  private buffers: Buffer[] = [];
  private activeId: string | null = null;

  list(): readonly Buffer[] {
    return this.buffers;
  }

  count(): number {
    return this.buffers.length;
  }

  get(id: string): Buffer | undefined {
    return this.buffers.find((b) => b.id === id);
  }

  active(): Buffer | undefined {
    return this.activeId ? this.get(this.activeId) : undefined;
  }

  activeIdValue(): string | null {
    return this.activeId;
  }

  indexOf(id: string): number {
    return this.buffers.findIndex((b) => b.id === id);
  }

  add(buffer: Buffer, atIndex?: number): void {
    if (atIndex === undefined || atIndex >= this.buffers.length) {
      this.buffers.push(buffer);
    } else {
      this.buffers.splice(Math.max(0, atIndex), 0, buffer);
    }
  }

  remove(id: string): Buffer | undefined {
    const idx = this.indexOf(id);
    if (idx < 0) return undefined;
    const [removed] = this.buffers.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.buffers[idx] ?? this.buffers[idx - 1];
      this.activeId = next ? next.id : null;
    }
    return removed;
  }

  move(fromIndex: number, toIndex: number): void {
    if (
      fromIndex < 0 ||
      fromIndex >= this.buffers.length ||
      toIndex < 0 ||
      toIndex >= this.buffers.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const [b] = this.buffers.splice(fromIndex, 1);
    this.buffers.splice(toIndex, 0, b);
  }

  setActive(id: string | null): void {
    this.activeId = id;
  }

  /** Cycle to the next (or previous) tab; returns the new active id. */
  cycle(dir: 1 | -1): string | null {
    if (this.buffers.length === 0) return null;
    const cur = this.activeId ? this.indexOf(this.activeId) : -1;
    const next = (cur + dir + this.buffers.length) % this.buffers.length;
    this.activeId = this.buffers[next].id;
    return this.activeId;
  }

  hasUnsaved(): boolean {
    return this.buffers.some((b) => b.dirty);
  }
}

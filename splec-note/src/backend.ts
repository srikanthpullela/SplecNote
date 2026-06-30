// Typed bridge to the Rust backend commands + native dialogs.
// Everything degrades gracefully when running outside Tauri (plain `vite`).

import { invoke } from "@tauri-apps/api/core";

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export interface FileRead {
  content: string;
  eol: string;
  encoding: string;
  mtime_ms: number | null;
  size: number;
}
export interface FileStat {
  exists: boolean;
  mtime_ms: number | null;
  size: number;
}
export interface WriteResult {
  mtime_ms: number | null;
  size: number;
}
export interface RestoredSession {
  manifest: SessionManifest;
  contents: Record<string, string>;
}

export interface ManifestTab {
  id: string;
  path: string | null;
  title: string;
  language: string;
  encoding: string;
  eol: string;
  dirty: boolean;
  backup: string | null;
  cursor: number;
  selAnchor: number;
  selHead: number;
  scrollTop: number;
  bookmarks: number[];
  diskMtimeMs: number | null;
  diskSize: number | null;
}
export interface SessionSplit {
  enabled: boolean;
  orientation: "vertical" | "horizontal";
}

export interface SessionManifest {
  version: number;
  activeId: string | null;
  tabs: ManifestTab[];
  split?: SessionSplit;
}

export async function readTextFile(path: string): Promise<FileRead> {
  return invoke<FileRead>("read_text_file", { path });
}
export async function writeTextFile(
  path: string,
  content: string,
  eol: string,
  encoding?: string,
): Promise<WriteResult> {
  return invoke<WriteResult>("write_text_file", { path, content, eol, encoding });
}
export async function statFile(path: string): Promise<FileStat> {
  return invoke<FileStat>("stat_file", { path });
}
export async function autosaveBackup(id: string, content: string): Promise<string> {
  return invoke<string>("autosave_backup", { id, content });
}
export async function readBackup(rel: string): Promise<string> {
  return invoke<string>("read_backup", { rel });
}
export async function deleteBackup(rel: string): Promise<void> {
  await invoke("delete_backup", { rel });
}
export async function writeSession(manifest: SessionManifest): Promise<void> {
  await invoke("write_session", { manifest });
}
export async function loadSession(): Promise<RestoredSession | null> {
  return invoke<RestoredSession | null>("load_session");
}
export async function cleanupBackups(keep: string[], retentionDays: number): Promise<number> {
  return invoke<number>("cleanup_backups", { keep, retentionDays });
}

// ---- Find in Files --------------------------------------------------------

export interface FindArgs {
  root: string;
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  includeGlob: string | null;
  maxResults: number;
  maxFileSizeBytes: number;
}
export interface FileMatch {
  file: string;
  line: number;
  col: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}
export interface FindResult {
  matches: FileMatch[];
  filesScanned: number;
  truncated: boolean;
}

export async function findInFiles(args: FindArgs): Promise<FindResult> {
  return invoke<FindResult>("find_in_files", { args });
}

// ---- Native dialogs (via plugin-dialog) ----------------------------------

export async function openFileDialog(): Promise<string[]> {
  if (!isTauri()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ multiple: true, directory: false });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function saveFileDialog(defaultName?: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const result = await save({ defaultPath: defaultName });
  return result ?? null;
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ multiple: false, directory: true });
  if (!result) return null;
  return Array.isArray(result) ? result[0] ?? null : result;
}

export async function confirmDialog(message: string, title = "Splec Note"): Promise<boolean> {
  if (!isTauri()) {
    return typeof window !== "undefined" ? window.confirm(message) : true;
  }
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title, kind: "warning" });
}

// ---- Launch at login (via plugin-autostart) ------------------------------

export async function isAutostartEnabled(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { isEnabled } = await import("@tauri-apps/plugin-autostart");
    return await isEnabled();
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const mod = await import("@tauri-apps/plugin-autostart");
    if (enabled) await mod.enable();
    else await mod.disable();
    return await mod.isEnabled();
  } catch {
    return false;
  }
}

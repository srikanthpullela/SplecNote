// Find in Files: search a chosen folder via the Rust backend and show grouped,
// clickable results (file -> line -> preview). Click-to-open jumps to the match.

import { findInFiles, pickDirectory, type FileMatch } from "./backend";
import { baseName } from "./buffers";

const MAX_RESULTS = 2000;
const MAX_FILE_BYTES = 2_000_000;

export class FindInFilesController {
  private panel = document.querySelector<HTMLElement>("#fif-panel")!;
  private input = document.querySelector<HTMLInputElement>("#fif-input")!;
  private glob = document.querySelector<HTMLInputElement>("#fif-glob")!;
  private folderLabel = document.querySelector<HTMLElement>("#fif-folder-label")!;
  private results = document.querySelector<HTMLElement>("#fif-results")!;
  private summary = document.querySelector<HTMLElement>("#fif-summary")!;
  private btnRegex = document.querySelector<HTMLButtonElement>("#fif-regex")!;
  private btnCase = document.querySelector<HTMLButtonElement>("#fif-case")!;
  private btnWord = document.querySelector<HTMLButtonElement>("#fif-word")!;

  private root: string | null = null;

  constructor(
    private onOpenMatch: (file: string, line: number, col: number) => void,
    private onMessage: (msg: string) => void,
  ) {
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.run();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.glob.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.run();
      }
    });
    for (const btn of [this.btnRegex, this.btnCase, this.btnWord]) {
      btn.addEventListener("click", () => btn.classList.toggle("is-on"));
    }
    document.querySelector("#fif-folder")?.addEventListener("click", () => void this.chooseFolder());
    document.querySelector("#fif-run")?.addEventListener("click", () => void this.run());
    document.querySelector("#fif-close")?.addEventListener("click", () => this.close());
  }

  isOpen(): boolean {
    return !this.panel.hidden;
  }

  open(): void {
    this.panel.hidden = false;
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.panel.hidden = true;
  }

  async chooseFolder(): Promise<void> {
    const dir = await pickDirectory();
    if (dir) {
      this.root = dir;
      this.folderLabel.textContent = baseName(dir) || dir;
      this.folderLabel.title = dir;
      this.input.focus();
    }
  }

  private async run(): Promise<void> {
    if (!this.root) {
      await this.chooseFolder();
      if (!this.root) return;
    }
    const query = this.input.value.trim();
    if (!query) return;
    this.summary.textContent = "Searching…";
    this.results.replaceChildren();
    try {
      const res = await findInFiles({
        root: this.root,
        query: this.input.value,
        isRegex: this.btnRegex.classList.contains("is-on"),
        caseSensitive: this.btnCase.classList.contains("is-on"),
        wholeWord: this.btnWord.classList.contains("is-on"),
        includeGlob: this.glob.value.trim() || null,
        maxResults: MAX_RESULTS,
        maxFileSizeBytes: MAX_FILE_BYTES,
      });
      this.render(res.matches, res.filesScanned, res.truncated);
    } catch (err) {
      this.summary.textContent = `Search failed: ${String(err)}`;
    }
  }

  private render(matches: FileMatch[], filesScanned: number, truncated: boolean): void {
    this.results.replaceChildren();
    if (matches.length === 0) {
      this.summary.textContent = `No matches in ${filesScanned} file${filesScanned === 1 ? "" : "s"}`;
      return;
    }
    const byFile = new Map<string, FileMatch[]>();
    for (const m of matches) {
      const arr = byFile.get(m.file) ?? [];
      arr.push(m);
      byFile.set(m.file, arr);
    }
    this.summary.textContent =
      `${matches.length}${truncated ? "+" : ""} match${matches.length === 1 ? "" : "es"} in ` +
      `${byFile.size} file${byFile.size === 1 ? "" : "s"}` +
      (truncated ? " (limited)" : "");

    const frag = document.createDocumentFragment();
    for (const [file, fileMatches] of byFile) {
      const group = document.createElement("div");
      group.className = "fif-group";

      const head = document.createElement("div");
      head.className = "fif-file";
      const name = document.createElement("span");
      name.className = "fif-file-name";
      name.textContent = baseName(file);
      const path = document.createElement("span");
      path.className = "fif-file-path";
      path.textContent = file;
      const cnt = document.createElement("span");
      cnt.className = "fif-file-count";
      cnt.textContent = String(fileMatches.length);
      head.append(name, path, cnt);
      group.append(head);

      for (const m of fileMatches) {
        const row = document.createElement("button");
        row.className = "fif-match";
        row.type = "button";
        row.title = `${file}:${m.line}:${m.col}`;

        const ln = document.createElement("span");
        ln.className = "fif-line";
        ln.textContent = String(m.line);

        const prev = document.createElement("span");
        prev.className = "fif-preview";
        const before = m.preview.slice(0, m.matchStart);
        const hit = m.preview.slice(m.matchStart, m.matchEnd);
        const after = m.preview.slice(m.matchEnd);
        prev.append(
          document.createTextNode(before),
          (() => {
            const mark = document.createElement("mark");
            mark.textContent = hit;
            return mark;
          })(),
          document.createTextNode(after),
        );

        row.append(ln, prev);
        row.addEventListener("click", () => this.onOpenMatch(m.file, m.line, m.col));
        group.append(row);
      }
      frag.append(group);
    }
    this.results.append(frag);
    this.onMessage(`Found ${matches.length} result${matches.length === 1 ? "" : "s"}`);
  }
}

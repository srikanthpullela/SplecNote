// Command palette (Cmd/Ctrl+Shift+P). A searchable list of every app command,
// driven by a provider so it always reflects the current command set.

export interface PaletteCommand {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx; // contiguous match, earlier = better
  // Subsequence match (fuzzy).
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length ? 10 : 0;
}

export class CommandPalette {
  private overlay = document.querySelector<HTMLElement>("#palette-overlay")!;
  private input = document.querySelector<HTMLInputElement>("#palette-input")!;
  private list = document.querySelector<HTMLElement>("#palette-list")!;
  private filtered: PaletteCommand[] = [];
  private active = 0;

  constructor(private provider: () => PaletteCommand[]) {
    this.input.addEventListener("input", () => this.refresh());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  isOpen(): boolean {
    return !this.overlay.hidden;
  }

  open(): void {
    this.overlay.hidden = false;
    this.input.value = "";
    this.refresh();
    this.input.focus();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private refresh(): void {
    const q = this.input.value.trim();
    this.filtered = this.provider()
      .map((c) => ({ c, s: score(q, c.title) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    this.active = 0;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren();
    this.filtered.forEach((cmd, i) => {
      const row = document.createElement("div");
      row.className = "palette-item" + (i === this.active ? " is-active" : "");
      row.setAttribute("role", "option");
      const title = document.createElement("span");
      title.className = "palette-item-title";
      title.textContent = cmd.title;
      row.append(title);
      if (cmd.hint) {
        const hint = document.createElement("span");
        hint.className = "palette-item-hint";
        hint.textContent = cmd.hint;
        row.append(hint);
      }
      row.addEventListener("mousemove", () => {
        if (this.active !== i) {
          this.active = i;
          this.render();
        }
      });
      row.addEventListener("click", () => this.runActive(i));
      this.list.append(row);
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = Math.min(this.active + 1, this.filtered.length - 1);
      this.render();
      this.scrollActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = Math.max(this.active - 1, 0);
      this.render();
      this.scrollActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.runActive(this.active);
    }
  }

  private scrollActive(): void {
    this.list.children[this.active]?.scrollIntoView({ block: "nearest" });
  }

  private runActive(i: number): void {
    const cmd = this.filtered[i];
    if (!cmd) return;
    this.close();
    cmd.run();
  }
}

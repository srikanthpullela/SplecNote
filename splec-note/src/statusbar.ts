// Status bar: line/col, selection, language picker, encoding, EOL, whitespace,
// word/char counts. Encoding and EOL open small popup menus to convert.

import { pickerEntries } from "./languages";

export interface StatusInfo {
  line: number;
  col: number;
  selLen: number;
  language: string;
  encoding: string;
  eol: "LF" | "CRLF" | "CR";
  words: number;
  chars: number;
  wordWrap: boolean;
}

export interface StatusHandlers {
  onLanguageChange: (id: string) => void;
  onEolChange: (eol: "LF" | "CRLF" | "CR") => void;
  onEncodingChange: (encoding: string) => void;
  onWrapToggle: () => void;
  onWhitespaceToggle: () => void;
}

export class StatusBar {
  private cursor = document.querySelector<HTMLElement>("#cursor-pos")!;
  private counts = document.querySelector<HTMLElement>("#status-counts")!;
  private langSelect = document.querySelector<HTMLSelectElement>("#lang-select")!;
  private encodingBtn = document.querySelector<HTMLButtonElement>("#encoding-btn")!;
  private eolBtn = document.querySelector<HTMLButtonElement>("#eol-btn")!;
  private wrapBtn = document.querySelector<HTMLButtonElement>("#wrap-toggle")!;
  private wsBtn = document.querySelector<HTMLButtonElement>("#ws-toggle")!;
  private encodingMenu = document.querySelector<HTMLElement>("#encoding-menu")!;
  private eolMenu = document.querySelector<HTMLElement>("#eol-menu")!;
  private msg = document.querySelector<HTMLElement>("#status-msg")!;

  constructor(handlers: StatusHandlers) {
    this.rebuildLanguages();
    this.langSelect.addEventListener("change", () =>
      handlers.onLanguageChange(this.langSelect.value),
    );
    this.wrapBtn.addEventListener("click", () => handlers.onWrapToggle());
    this.wsBtn.addEventListener("click", () => handlers.onWhitespaceToggle());

    this.wireMenu(this.encodingBtn, this.encodingMenu, "enc", (v) => handlers.onEncodingChange(v));
    this.wireMenu(this.eolBtn, this.eolMenu, "eol", (v) =>
      handlers.onEolChange(v as "LF" | "CRLF" | "CR"),
    );

    document.addEventListener("click", () => this.closeMenus());
  }

  /** (Re)populate the language picker, e.g. after User-Defined Languages load. */
  rebuildLanguages(): void {
    const current = this.langSelect.value;
    this.langSelect.replaceChildren();
    for (const { id, label } of pickerEntries()) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      this.langSelect.append(opt);
    }
    if (current) this.langSelect.value = current;
  }

  private wireMenu(
    btn: HTMLButtonElement,
    menu: HTMLElement,
    dataKey: string,
    onPick: (value: string) => void,
  ): void {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      this.closeMenus();
      if (open) {
        const rect = btn.getBoundingClientRect();
        menu.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
        menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
        menu.hidden = false;
      }
    });
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.querySelectorAll<HTMLButtonElement>(".status-menu-item").forEach((item) => {
      item.addEventListener("click", () => {
        menu.hidden = true;
        onPick(item.dataset[dataKey]!);
      });
    });
  }

  private closeMenus(): void {
    this.encodingMenu.hidden = true;
    this.eolMenu.hidden = true;
  }

  setMessage(text: string): void {
    this.msg.textContent = text;
  }

  update(info: StatusInfo): void {
    this.cursor.textContent =
      info.selLen > 0
        ? `Ln ${info.line}, Col ${info.col} (${info.selLen} sel)`
        : `Ln ${info.line}, Col ${info.col}`;
    this.counts.textContent = `${info.words} ${info.words === 1 ? "word" : "words"}, ${info.chars} chars`;
    if (this.langSelect.value !== info.language) this.langSelect.value = info.language;
    this.encodingBtn.textContent = info.encoding;
    this.eolBtn.textContent = info.eol;
    this.wrapBtn.textContent = info.wordWrap ? "Wrap: On" : "Wrap: Off";
    this.wrapBtn.classList.toggle("is-on", info.wordWrap);
  }

  setWhitespaceOn(on: boolean): void {
    this.wsBtn.classList.toggle("is-on", on);
  }

  setEnabled(enabled: boolean): void {
    for (const el of [this.langSelect, this.encodingBtn, this.eolBtn, this.wsBtn]) {
      el.toggleAttribute("disabled", !enabled);
    }
  }
}

// Splec Note — frontend entry point (Phase 0).
// Wires the CodeMirror editor, the Light/Dark/System theme toggle (persisted),
// the language picker, and the status bar.

import "./styles.css";
import { createElement, Monitor, Moon, Sun } from "lucide";
import { createEditor, type LanguageName, type SplecEditor } from "./editor";
import {
  applyTheme,
  loadThemeMode,
  nextMode,
  saveThemeMode,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme";

const WELCOME_DOC = `# Welcome to Splec Note ✨

A lightweight, distinctive editor for **notes** and **code** — built with Tauri + CodeMirror.

## Try it out
- Type freely. This pane is a fully editable CodeMirror 6 editor.
- Switch the **Language** in the status bar (Markdown / JavaScript / TypeScript / JSON)
  to see syntax highlighting change.
- Toggle **Light / Dark / System** from the top-right. Your choice is remembered
  across restarts.

\`\`\`js
// A tiny taste of the editor
function splec(note) {
  return \`take a \${note}\`;
}
console.log(splec("note"));
\`\`\`

> Light mode is the default. Dark mode lives on the #06070d Splec canvas.
`;

const THEME_META: Record<ThemeMode, { label: string; icon: typeof Sun }> = {
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
  system: { label: "System", icon: Monitor },
};

let editor: SplecEditor;
let currentMode: ThemeMode = "light";

function renderThemeButton(mode: ThemeMode): void {
  const slot = document.querySelector<HTMLElement>(".icon-slot");
  const label = document.querySelector<HTMLElement>("#theme-label");
  const button = document.querySelector<HTMLButtonElement>("#theme-toggle");
  const meta = THEME_META[mode];
  if (slot) {
    slot.replaceChildren(createElement(meta.icon));
  }
  if (label) label.textContent = meta.label;
  if (button) {
    button.setAttribute(
      "aria-label",
      `Theme: ${meta.label}. Click to switch to ${THEME_META[nextMode(mode)].label}.`,
    );
  }
}

function setMode(mode: ThemeMode, resolvedHint?: ResolvedTheme): void {
  currentMode = mode;
  const resolved = resolvedHint ?? applyTheme(mode);
  if (resolvedHint) applyTheme(mode);
  editor?.setTheme(resolved);
  renderThemeButton(mode);
}

function updateCursor(line: number, col: number): void {
  const el = document.querySelector<HTMLElement>("#cursor-pos");
  if (el) el.textContent = `Ln ${line}, Col ${col}`;
}

async function init(): Promise<void> {
  const parent = document.querySelector<HTMLElement>("#editor");
  if (!parent) return;

  currentMode = await loadThemeMode();
  const resolved = applyTheme(currentMode);

  editor = createEditor({
    parent,
    doc: WELCOME_DOC,
    theme: resolved,
    language: "markdown",
    onCursor: ({ line, col }) => updateCursor(line, col),
  });

  renderThemeButton(currentMode);

  // Theme toggle: cycle Light → Dark → System.
  document
    .querySelector<HTMLButtonElement>("#theme-toggle")
    ?.addEventListener("click", () => {
      const mode = nextMode(currentMode);
      setMode(mode);
      void saveThemeMode(mode);
    });

  // Language picker.
  const langSelect = document.querySelector<HTMLSelectElement>("#lang-select");
  langSelect?.addEventListener("change", () => {
    const lang = langSelect.value as LanguageName;
    editor.setLanguage(lang);
    const msg = document.querySelector<HTMLElement>("#status-msg");
    if (msg) msg.textContent = `Editing ${langSelect.options[langSelect.selectedIndex].text}`;
  });

  // Keep up with OS theme changes while in 'system' mode.
  watchSystemTheme(
    () => currentMode,
    (sys) => setMode("system", sys),
  );

  // Focus the editor so the user can type immediately.
  editor.view.focus();
}

window.addEventListener("DOMContentLoaded", () => {
  void init();
});

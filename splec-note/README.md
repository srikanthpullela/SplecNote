# Splec Note

A lightweight, distinctive cross-platform text & code editor — great for **both
note-taking and coding**. Built with **Tauri 2** (Rust + web), **TypeScript +
Vite**, and the **CodeMirror 6** editor engine.

> **Phase 0 scaffold.** This is the foundation: project setup, design system,
> branding, theming, and a single working editor pane. File operations, tabs,
> session persistence, find/replace, etc. arrive in later phases.

<p>
  <img src="../branding/source-assets/apple-touch-icon.png" width="72" alt="Splec mark" />
</p>

## Highlights

- **Native-feeling, small footprint** via Tauri (no Chromium bundle).
- **CodeMirror 6** editor: line numbers, active-line highlight, bracket
  matching, undo/history, and syntax highlighting for **Markdown / JavaScript /
  TypeScript / JSON** (switchable from the status bar).
- **Deliberate Splec design system** — not a generic VS Code clone:
  - Brand purple `#7c5cff`, periwinkle `#9db4ff`, dark canvas `#06070d`.
  - Bundled fonts (no hot-linking): **Dancing Script** (the *Splec* logotype),
    **Space Grotesk** (display/UI headings), **Inter** (UI body), **JetBrains
    Mono** (editor).
  - Rounded panels/tabs, soft depth, the Splec "S" mark + wordmark.
- **Light / Dark / System theming.** Light is the default; dark uses the
  `#06070d` Splec canvas. Your choice is persisted via `tauri-plugin-store` and
  survives restarts.
- **Plugins wired:** `store`, `window-state`, `fs`, `dialog` (with capability
  permissions in `src-tauri/capabilities/default.json`).

## Prerequisites

- **Node.js 20+** (or 22). A `.nvmrc` is provided at the repo root.
- **Rust** (stable) with Cargo — https://rustup.rs
- **macOS:** an Xcode / Command Line Tools toolchain whose license has been
  accepted. If `npm run tauri dev` fails with *"You have not agreed to the Xcode
  license agreements"*, run one of:
  ```bash
  sudo xcodebuild -license accept          # if full Xcode is installed
  xcode-select --install                    # to (re)install Command Line Tools
  ```
- **Windows (future target):** the MSVC build tools / WebView2 (configuration is
  already present in `tauri.conf.json`, including the `.ico` and NSIS settings).

## Develop

```bash
cd splec-note
npm install
npm run tauri dev      # launches the desktop app with hot-reload
```

The frontend dev server runs on `http://localhost:1420`. You can also run just
the web UI in a browser with `npm run dev` (Tauri-only features degrade
gracefully — e.g. theme persistence falls back to `localStorage`).

## Build

```bash
npm run build          # type-check + bundle the frontend (dist/)
npm run tauri build    # produce platform installers (.app/.dmg on macOS)
```

## Branding & icons

Brand sources live in [`../branding/`](../branding):

- `splec-mark.svg` — the recreated Splec "S" (script S + purple→periwinkle
  gradient on a `#10131f → #06070d` rounded tile).
- `splec-mark-bare.svg` — the gradient "S" without the tile (used in-app).
- `source-assets/` — the original assets downloaded from splecdevelopers.com.

Regenerate the full app icon set (`.icns`, `.ico`, PNGs) after editing the mark:

```bash
# Render the SVG to a 1024px PNG, then let Tauri build every size.
npx tauri icon ../branding/splec-icon-1024.png
```

## Project layout

```
splec-note/
├─ index.html              # app shell (titlebar, tabstrip, editor, statusbar)
├─ src/
│  ├─ main.ts              # wires editor + theme toggle + language picker
│  ├─ editor.ts            # CodeMirror 6 setup + brand light/dark syntax themes
│  ├─ theme.ts             # Light/Dark/System modes, persisted via plugin-store
│  ├─ styles.css           # design tokens + app chrome (both themes)
│  ├─ fonts.css            # @font-face for the bundled fonts
│  └─ assets/fonts/        # locally bundled woff2 files
├─ src-tauri/
│  ├─ src/lib.rs           # Tauri builder + plugin registration
│  ├─ tauri.conf.json      # app config, bundle targets (mac + win), icons
│  ├─ capabilities/        # permission grants for the main window
│  └─ icons/               # generated icon set
└─ NOTICE                  # font + icon attributions
```

## License

MIT for the application code. Bundled fonts are under the SIL Open Font License
1.1 and Lucide icons under ISC — see [`NOTICE`](./NOTICE). The Splec mark and
wordmarks are brand assets of Splec Developers.

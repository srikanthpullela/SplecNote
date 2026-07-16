# Apex Debug Studio — Complete Project Reference

> A modern Notepad++/Sublime Text/VS Code-style desktop text editor for macOS, built with Electron + Monaco Editor.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Project Structure](#project-structure)
4. [Tech Stack](#tech-stack)
5. [npm Registry / Proxy](#npm-registry--proxy)
6. [Running in Development](#running-in-development)
7. [Building for macOS](#building-for-macos)
8. [Architecture Overview](#architecture-overview)
9. [File Descriptions](#file-descriptions)
10. [Features](#features)
11. [Keyboard Shortcuts](#keyboard-shortcuts)
12. [Themes](#themes)
13. [Command Palette](#command-palette)
14. [Data & Persistence](#data--persistence)
15. [External Dependencies](#external-dependencies)
16. [Common Issues & Fixes](#common-issues--fixes)
17. [Code Map (Key Locations)](#code-map-key-locations)

---

## Quick Start

```bash
cd "/Users/spullela/AI Projects/Apex Debug Studio"
source ~/.nvm/nvm.sh && nvm use 22
npx electron .
```

Or use npm:

```bash
npm start
```

---

## Prerequisites

| Requirement       | Version         | Notes                                           |
| ----------------- | --------------- | ----------------------------------------------- |
| **Node.js**       | v22.18.0        | Via nvm: `nvm use 22` (`.nvmrc` has `22`)       |
| **npm**           | v10.9.3         | Comes with Node 22                              |
| **macOS**         | 13+ (Ventura+)  | ARM64 (Apple Silicon) build                     |
| **Ripgrep**       | 15.1.0          | For global search: `brew install ripgrep`       |
| **nvm**           | any             | `source ~/.nvm/nvm.sh && nvm use 22`            |

---

## Project Structure

```
ApexDebugStudio/
├── package.json              # App config, dependencies, electron-builder config
├── package-lock.json
├── .nvmrc                    # Contains "22" — node version
├── .gitignore
├── README.md
├── APEXDEBUGSTUDIO.md              # THIS FILE — full project reference
├── build/
│   ├── icon.icns             # macOS app icon
│   ├── icon.ico              # Windows app icon
│   └── icon.png              # PNG source icon
├── dist/                     # Build output (generated)
│   ├── Apex Debug Studio-1.0.0-arm64.dmg       # macOS installer (~106 MB)
│   ├── Apex Debug Studio-1.0.0-arm64-mac.zip   # macOS zip (~103 MB)
│   └── mac-arm64/                       # Unpacked .app
├── node_modules/             # Dependencies (npm install)
└── src/
    ├── main/
    │   └── main.js           # Electron main process (474 lines)
    ├── preload/
    │   └── preload.js        # Secure IPC bridge (69 lines)
    └── renderer/
        ├── index.html        # UI layout (265 lines)
        ├── styles.css        # All CSS + 14 theme definitions (1109 lines)
        └── app.js            # All renderer logic (2497 lines)
```

**Total source**: ~4,412 lines across 5 files.

---

## Tech Stack

| Component         | Technology            | Version   |
| ----------------- | --------------------- | --------- |
| Desktop framework | Electron              | 28.1.0    |
| Code editor       | Monaco Editor         | 0.45.0    |
| File watcher      | chokidar              | 3.5.3     |
| Build tool        | electron-builder      | 24.9.1    |
| Full-text search  | ripgrep (rg)          | 15.1.0    |

---

## npm Registry / Proxy

The project uses a corporate Artifactory npm registry. If installing dependencies:

```bash
npm install --registry=https://art01.apttuscloud.io/api/npm/npm/ --fetch-timeout=120000
```

Or set in `.npmrc`:

```
registry=https://art01.apttuscloud.io/api/npm/npm/
fetch-timeout=120000
```

---

## Running in Development

```bash
# 1. Switch to Node 22
source ~/.nvm/nvm.sh && nvm use 22

# 2. Install dependencies (only needed first time or after package.json changes)
npm install --fetch-timeout=120000

# 3. Run the app
npx electron .
# OR
npm start
# OR (dev mode with NODE_ENV=development)
npm run dev
```

**To run in background (keeps terminal free):**

```bash
cd "/Users/spullela/AI Projects/Apex Debug Studio" && source ~/.nvm/nvm.sh && nvm use 22 && npx electron . &
```

**To kill and restart:**

```bash
pkill -f "Electron.*Apex Debug Studio" 2>/dev/null; sleep 1
cd "/Users/spullela/AI Projects/Apex Debug Studio" && source ~/.nvm/nvm.sh && nvm use 22 && npx electron .
```

---

## Building for macOS

```bash
cd "/Users/spullela/AI Projects/Apex Debug Studio"
source ~/.nvm/nvm.sh && nvm use 22
npx electron-builder --mac
```

**Output** (in `dist/`):
- `Apex Debug Studio-1.0.0-arm64.dmg` — macOS disk image installer (~106 MB)
- `Apex Debug Studio-1.0.0-arm64-mac.zip` — Compressed app (~103 MB)

> **Note**: Code signing is skipped (no Apple Developer ID certificate). macOS Gatekeeper will show a warning on first launch. Bypass with: **Right-click → Open**.

**Build configuration** is in `package.json` under the `"build"` key:
- App ID: `com.apexdebugstudio.app`
- Category: `public.app-category.developer-tools`
- Dark mode support: enabled
- ASAR packaging: enabled (monaco-editor unpacked)
- File associations: `.txt`, `.md`, `.json`, `.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.css`, `.html`, `.xml`, `.yaml`, `.sql`, `.sh`, `.swift`, `.kt`, `.dart`, and more

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   MAIN PROCESS                       │
│  src/main/main.js                                   │
│  • BrowserWindow management                         │
│  • IPC handlers (file I/O, dialogs, search)         │
│  • Native menus (File, Edit, Selection, View, etc.) │
│  • Session & recent file persistence                │
│  • Ripgrep spawning for global search               │
│  • chokidar file watching (future)                  │
│  • Shell integration (Finder, Terminal)             │
└──────────────┬──────────────────────────────────────┘
               │ IPC (contextBridge)
┌──────────────┴──────────────────────────────────────┐
│                 PRELOAD SCRIPT                       │
│  src/preload/preload.js                             │
│  • Exposes `window.apexStudio` API                   │
│  • Whitelist of valid IPC channels                  │
│  • contextIsolation: true, nodeIntegration: false   │
└──────────────┬──────────────────────────────────────┘
               │ window.apexStudio.*
┌──────────────┴──────────────────────────────────────┐
│                RENDERER PROCESS                      │
│  src/renderer/index.html + styles.css + app.js      │
│  • Monaco Editor instance                           │
│  • Tab management (create, close, switch, reorder)  │
│  • File tree (recursive dir rendering)              │
│  • Quick Open (⌘P), Command Palette (⇧⌘P)          │
│  • Global Search (⇧⌘F) via ripgrep                 │
│  • Theme engine (14 themes)                         │
│  • Keyboard shortcut handler                        │
│  • Welcome screen & no-editor overlay               │
│  • Drag & drop file opening                         │
│  • Context menus (file tree + tabs)                 │
└─────────────────────────────────────────────────────┘
```

**Security model**: Electron's `contextIsolation: true` + `nodeIntegration: false`. All file system access goes through the preload bridge → main process IPC handlers.

---

## File Descriptions

### `src/main/main.js` (474 lines)

The Electron main process. Responsibilities:

- **Window creation**: `createWindow()` with `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: {x:14, y:14}`
- **IPC handlers**: `dialog:open-file`, `dialog:open-folder`, `dialog:save-file`, `fs:read-file`, `fs:write-file`, `fs:read-dir`, `fs:stat`, `fs:delete`, `fs:rename`, `fs:create-dir`, `fs:get-all-files`, `fs:search-in-files`, `autosave:get-path`, `session:save`, `session:load`, `recent:add`, `recent:get`, `app:get-paths`, `app:new-window`, `shell:show-item`, `shell:open-terminal`
- **Global search** (`fs:search-in-files`): Spawns `/opt/homebrew/bin/rg` (ripgrep) with `--json` flag, parses streaming output
- **Native menus**: Full macOS menu bar — File, Edit, Selection, View, Navigate, Help
- **New window**: `createNewWindow()` opens a fresh window with `?new=1` query param
- **Terminal integration**: `open -a Terminal` with PATH augmented for `/opt/homebrew/bin:/usr/local/bin`
- **Data paths**: `~/ApexDebugStudio/.session.json`, `~/ApexDebugStudio/.recent.json`, `~/ApexDebugStudio/AutoSave/`

### `src/preload/preload.js` (69 lines)

Secure IPC bridge. Exposes `window.apexStudio` with:

- **Dialogs**: `openFileDialog()`, `openFolderDialog()`, `saveFileDialog()`
- **File system**: `readFile()`, `writeFile()`, `readDir()`, `stat()`, `deleteFile()`, `rename()`, `createDir()`, `getAllFiles()`, `searchInFiles()`
- **Auto-save**: `getAutoSavePath()`
- **Session**: `saveSession()`, `loadSession()`
- **Recent**: `addRecent()`, `getRecent()`
- **Window**: `newWindow()`
- **Shell**: `revealInFinder()`, `openInTerminal()`
- **Events**: `on(channel, callback)` — whitelisted channels for menu → renderer communication

### `src/renderer/index.html` (265 lines)

The UI layout:

- **Titlebar**: Custom titlebar with sidebar toggle button
- **Sidebar**: Root folder bar (with "Open Folder" button), file tree container, recent files section with resizer
- **Editor area**: Tab bar, search/replace bar, goto-line bar, Monaco editor container, no-editor overlay (VS Code-style shortcuts), status bar
- **Modals/Overlays**: Quick Open, Command Palette, Theme Picker, Global Search
- **Context menus**: File tree context menu, tab bar context menu
- **Welcome screen**: Full-screen overlay with recent files and action buttons
- **Monaco loading**: AMD loader from `../../node_modules/monaco-editor/min/vs/loader.js`

### `src/renderer/styles.css` (1,109 lines)

All styling:

- **14 theme definitions** as CSS custom properties (e.g., `[data-theme="dark"]`, `[data-theme="apex"]`)
- **Layout**: Flexbox-based sidebar + editor layout with resizable sidebar
- **Components**: Tabs, file tree (with chevron arrows), search bars, modals, context menus, status bar, welcome screen
- **No-editor overlay**: VS Code-style watermark with clickable keyboard shortcuts
- **Tree view**: `.tree-chevron`, `.tree-chevron-spacer` for expandable arrows
- **Tab icons**: `.tab-icon` for file type emoji icons
- **Global search**: `.gs-selected` for arrow key navigation highlighting
- **Animations**: Smooth transitions, hover effects

### `src/renderer/app.js` (2,497 lines)

All renderer logic — the biggest file. Major sections:

| Section | Lines | Description |
| ------- | ----- | ----------- |
| State & DOM cache | 1-86 | `state` object, `cacheDom()`, DOM element references |
| Themes | 88-468 | `THEMES` array (14 entries), `defineMonacoThemes()` with full token rules |
| Monaco init | 470-515 | `initMonaco()` — AMD load, editor creation, change listeners |
| Tab management | 517-642 | `createTab()`, `activateTab()`, `closeTab()`, `renderTabs()`, `markTabModified()` |
| File I/O | 645-717 | `openFileDialog()`, `openFile()`, `saveFile()`, `saveAsFile()`, auto-save |
| Session | 719-785 | `saveSession()`, `restoreSession()` |
| Folder / Tree | 787-990 | `openFolder()`, `renderTreeDir()`, context menu, `refreshTree()` |
| Tab context menu | 995-1060 | Right-click tab actions (close, close others, close all, copy path, reveal) |
| Search & Replace | 1063-1200 | In-file find/replace with decorations, match navigation |
| Go to Line | 1204-1235 | `showGotoBar()`, `doGoto()` |
| Quick Open | 1238-1370 | `⌘P` — file finder with recent files, fuzzy filter, arrow nav |
| Command Palette | 1372-1480 | `⇧⌘P` — 36 commands, filter, arrow nav |
| Global Search | 1483-1665 | `⇧⌘F` — ripgrep integration, result rendering, arrow nav |
| Theme Picker | 1669-1788 | Theme selection UI with preview, arrow nav |
| Sidebar | 1790-1885 | Toggle, resize, recent section |
| Status bar | 1958-1971 | Cursor position, language display |
| Welcome & Overlay | 1973-2038 | Welcome screen, no-editor shortcuts overlay |
| Editor actions | 2041-2082 | `toggleWordWrap()`, `toggleMinimap()`, `changeFontSize()`, `reopenClosedTab()`, `closeOtherTabs()`, `closeAllTabs()` |
| Keyboard shortcuts | 2085-2318 | `initKeyboard()` — all 36+ keyboard shortcuts |
| IPC handlers | 2319-2354 | Menu → renderer event handlers |
| Drag & drop | 2356-2377 | File drag & drop to open |
| Utilities | 2379-2422 | `escHtml()`, `debounce()`, `guessLanguage()`, `getFileIcon()` |
| Init | 2424-2497 | `init()` — bootstraps everything on DOM load |

---

## Features

### Core Editing
- **Monaco Editor** — Full VS Code editing engine with syntax highlighting for 50+ languages
- **Multi-tab interface** — Create, close, switch, reorder tabs
- **Auto-save** — Unsaved content auto-saved to `~/ApexDebugStudio/AutoSave/`
- **Session persistence** — Tabs and state restored on restart
- **File icons** — Emoji-based file type icons in tabs, Quick Open, and search results

### File Management
- **Open file/folder** dialogs
- **Save / Save As**
- **File tree** — Recursive directory browser with expandable folders (arrow icons)
- **Recent files** — Sidebar section + welcome screen
- **Drag & drop** — Drop files onto the window to open them
- **File watcher** — chokidar watches for external file changes

### Search
- **In-file Find** (`⌘F`) — With match highlighting, next/prev navigation, match count
- **Find & Replace** (`⌘H`) — Replace one or replace all
- **Global Search** (`⇧⌘F`) — Powered by ripgrep, searches across all files in folder with result grouping, arrow navigation, and click-to-open
- **Go to Line** (`⌘G`)

### Navigation
- **Quick Open** (`⌘P`) — File finder with recent files prioritized, fuzzy matching
- **Command Palette** (`⇧⌘P`) — 36 commands with fuzzy filter
- **Tab switching** — Ctrl+Tab (MRU order), ⌘1-9, ⌘Shift+]/[, ⌘Alt+←/→

### UI
- **Custom titlebar** — macOS hidden inset with traffic lights
- **Resizable sidebar** — Drag to resize, toggle with ⌘B
- **Welcome screen** — Shows recent files and quick actions on startup
- **No-editor overlay** — VS Code-style watermark with keyboard shortcut hints
- **Context menus** — Right-click on files (rename, delete, reveal, terminal) and tabs (close, close others, copy path)
- **Status bar** — Line:column position, language, encoding

### Themes (14)
- Dark (Default), Light, Monokai, Dracula, Nord, Solarized Dark, Sublime Mariana, One Dark Pro, Material Ocean, GitHub Dark, Tomorrow Night, Ayu Dark, Gruvbox Dark, **Apex Dark**

### Window
- **New window** (`⇧⌘N`) — Opens empty
- **Reveal in Finder** — From file tree context menu
- **Open in Terminal** — Opens macOS Terminal at folder path

---

## Keyboard Shortcuts

### File Operations

| Shortcut | Action |
| -------- | ------ |
| `⌘N` | New Tab |
| `⇧⌘N` | New Window |
| `⌘O` | Open File |
| `⇧⌘O` | Open Folder |
| `⌘S` | Save |
| `⇧⌘S` | Save As |
| `⌘W` | Close Tab |
| `⇧⌘T` | Reopen Closed Tab |

### Tab Navigation

| Shortcut | Action |
| -------- | ------ |
| `Ctrl+Tab` | Switch to next recent tab (MRU) |
| `Ctrl+Shift+Tab` | Switch to previous recent tab (MRU) |
| `⌘1` – `⌘8` | Jump to tab 1–8 |
| `⌘9` | Jump to last tab |
| `⌘Shift+]` | Next tab (sequential) |
| `⌘Shift+[` | Previous tab (sequential) |
| `⌘Alt+→` | Next tab (VS Code style) |
| `⌘Alt+←` | Previous tab (VS Code style) |

### Search & Navigation

| Shortcut | Action |
| -------- | ------ |
| `⌘F` | Find in file |
| `⌘H` | Find and Replace |
| `⇧⌘F` | Find in Files (Global Search) |
| `⌘G` | Go to Line |
| `⌘P` | Quick Open (file finder) |
| `⇧⌘P` | Command Palette |
| `⇧⌘\` | Jump to matching bracket |

### Editing

| Shortcut | Action |
| -------- | ------ |
| `⌘D` | Add next occurrence to selection |
| `⌘L` | Select line |
| `⇧⌘L` | Select all occurrences |
| `⌘/` | Toggle line comment |
| `⇧⌘A` | Toggle block comment |
| `⌘]` | Indent line |
| `⌘[` | Outdent line |
| `⌘Enter` | Insert line below |
| `⇧⌘Enter` | Insert line above |
| `⇧⌘K` | Delete line |
| `⌘U` | Undo cursor position |

### Line Operations

| Shortcut | Action |
| -------- | ------ |
| `Alt+↑` | Move line up |
| `Alt+↓` | Move line down |
| `Shift+Alt+↑` | Copy line up |
| `Shift+Alt+↓` | Duplicate line down |
| `Shift+Alt+F` | Format document |

### View

| Shortcut | Action |
| -------- | ------ |
| `⌘B` | Toggle Sidebar |
| `Alt+Z` | Toggle Word Wrap |
| `⌘+` / `⌘=` | Increase Font Size |
| `⌘-` | Decrease Font Size |
| `⌘0` | Reset Font Size (14px) |
| `⇧⌘Space` | Trigger Parameter Hints |

---

## Themes

All 14 themes are defined as CSS custom properties in `styles.css` AND as Monaco editor themes in `app.js` `defineMonacoThemes()`.

| ID | Label | Base |
| -- | ----- | ---- |
| `dark` | Dark (Default) | vs-dark |
| `light` | Light | vs |
| `monokai` | Monokai | vs-dark |
| `dracula` | Dracula | vs-dark |
| `nord` | Nord | vs-dark |
| `solarized-dark` | Solarized Dark | vs-dark |
| `sublime-mariana` | Sublime Mariana | vs-dark |
| `one-dark` | One Dark Pro | vs-dark |
| `material-ocean` | Material Ocean | vs-dark |
| `github-dark` | GitHub Dark | vs-dark |
| `tomorrow-night` | Tomorrow Night | vs-dark |
| `ayu-dark` | Ayu Dark | vs-dark |
| `gruvbox` | Gruvbox Dark | vs-dark |
| `apex` | Apex Dark | vs-dark |

**Apex Dark** uses the Monokai color palette (`#272822` bg, `#f8f8f2` fg) with ~60 token rules including:
- Functions: green (`#a6e22e`)
- Keywords: pink bold (`#f92672`)
- Strings: yellow (`#e6db74`)
- Numbers: purple (`#ae81ff`)
- Comments: gray italic (`#75715e`)
- Parameters: orange italic (`#fd971f`)
- Types: blue italic (`#66d9ef`)
- Rainbow bracket coloring (6 levels)

---

## Command Palette

Opened with `⇧⌘P`. Contains 36 commands:

| Command | Shortcut |
| ------- | -------- |
| New Tab | ⌘N |
| New Window | ⇧⌘N |
| Open File | ⌘O |
| Open Folder | ⇧⌘O |
| Save | ⌘S |
| Save As... | ⇧⌘S |
| Close Tab | ⌘W |
| Close Other Tabs | — |
| Close All Tabs | — |
| Reopen Closed Tab | ⇧⌘T |
| Find | ⌘F |
| Find and Replace | ⌘H |
| Find in Files | ⇧⌘F |
| Go to Line | ⌘G |
| Quick Open | ⌘P |
| Toggle Sidebar | ⌘B |
| Toggle Word Wrap | ⌥Z |
| Change Theme | — |
| Toggle Minimap | — |
| Increase Font Size | ⌘+ |
| Decrease Font Size | ⌘- |
| Reset Font Size | ⌘0 |
| Format Document | ⇧⌥F |
| Delete Line | ⇧⌘K |
| Select Line | ⌘L |
| Add Next Occurrence | ⌘D |
| Select All Occurrences | ⇧⌘L |
| Toggle Comment | ⌘/ |
| Toggle Block Comment | ⇧⌘A |
| Move Line Up | ⌥↑ |
| Move Line Down | ⌥↓ |
| Copy Line Up | ⇧⌥↑ |
| Duplicate Line Down | ⇧⌥↓ |
| Indent Line | ⌘] |
| Outdent Line | ⌘[ |
| Jump to Bracket | ⇧⌘\ |
| Undo Cursor | ⌘U |

---

## Data & Persistence

All app data is stored in `~/ApexDebugStudio/`:

```
~/ApexDebugStudio/
├── .session.json     # Tabs, active tab, window bounds (auto-saved on quit)
├── .recent.json      # Recently opened file paths (max entries)
└── AutoSave/         # Auto-saved unsaved file content
```

- **Session** (`saveSession()`): Saved on `beforeunload` and periodically. Contains tab titles, file paths, content, active tab ID, window position/size.
- **Recent files** (`addRecent()`): Appended on every file open. Used in Quick Open (⌘P) and sidebar.
- **Auto-save** (`scheduleAutoSave()`): Debounced 2-second timer on content change. Saves to `~/ApexDebugStudio/AutoSave/<filename>`.

---

## External Dependencies

### Ripgrep (required for Global Search)

```bash
brew install ripgrep
```

Path hardcoded: `/opt/homebrew/bin/rg`

The main process spawns `rg` with `--json` flag and streams results. If ripgrep is not installed, global search will not work.

### Monaco Editor

Loaded via AMD (RequireJS) from `node_modules/monaco-editor/min/vs/`. In the `asar` build, monaco-editor is **unpacked** (`asarUnpack` in `package.json`) so the AMD loader can access the files.

---

## Common Issues & Fixes

### App shows "Electron" in menu bar instead of "Apex Debug Studio"
- Fixed: `app.setName('Apex Debug Studio')` is called before anything else in `main.js`

### Monaco editor not loading
- Ensure `node_modules/monaco-editor/` exists: `npm install`
- The AMD loader path in `index.html` is `../../node_modules/monaco-editor/min/vs/loader.js` (relative to `src/renderer/`)

### Global search not working
- Ensure ripgrep is installed: `which rg` should return `/opt/homebrew/bin/rg`
- If not: `brew install ripgrep`

### macOS Gatekeeper blocks the built app
- Right-click the `.app` → **Open** → click **Open** in the dialog
- Or: `xattr -cr "/path/to/Apex Debug Studio.app"`

### npm install times out
- Use the Artifactory proxy with longer timeout:
  ```bash
  npm install --registry=https://art01.apttuscloud.io/api/npm/npm/ --fetch-timeout=120000
  ```

### New window opens with old tabs
- New windows are opened with `?new=1` query param, which tells the renderer to skip session restore

### Sidebar not showing when opening a folder
- Fixed: `openFolder()` auto-expands sidebar if `!state.sidebarVisible`

### Tabs broken / Quick Open not working
- Check for `getFileIcon()` vs `getFileIconHTML()` mismatch — only `getFileIcon()` exists
- All calls should use `getFileIcon(filename)` which returns an emoji string

---

## Code Map (Key Locations)

Quick reference for finding things in the source code.

### main.js

| What | Line(s) |
| ---- | ------- |
| App name set | ~21 |
| Data paths (session, recent, autosave) | ~26-30 |
| `createWindow()` | ~55 |
| IPC handlers start | ~100+ |
| `fs:search-in-files` (ripgrep) | ~200+ |
| Native menu definition | ~300+ |
| `createNewWindow()` | ~420+ |
| `shell:open-terminal` | ~450+ |

### app.js

| What | Line(s) |
| ---- | ------- |
| `state` object | 11-29 |
| `cacheDom()` | 32 |
| `THEMES` array | 88 |
| `defineMonacoThemes()` | 105 |
| Apex Dark theme token rules | inside defineMonacoThemes |
| `initMonaco()` | 475 |
| `createTab()` | 517 |
| `activateTab()` | 549 |
| `closeTab()` (pushes to recentlyClosed) | 566 |
| `renderTabs()` | 602 |
| `openFileDialog()` | 645 |
| `saveFile()` | 667 |
| `saveAsFile()` | 686 |
| `scheduleAutoSave()` | 701 |
| `saveSession()` | 719 |
| `restoreSession()` | 741 |
| `openFolder()` | 787 |
| `renderTreeDir()` | 828 |
| File tree context menu | 915 |
| Tab context menu | 995 |
| `showSearchBar()` / in-file search | 1063 |
| `showGotoBar()` | 1204 |
| `showQuickOpen()` / Quick Open | 1238 |
| `COMMANDS` array (36 entries) | 1372 |
| `showCommandPalette()` | 1412 |
| `showGlobalSearch()` / Global Search | 1483 |
| `doGlobalSearch()` (ripgrep integration) | 1506 |
| Theme picker | 1669 |
| `applyTheme()` | 1707 |
| `toggleSidebar()` | 1790 |
| `applySidebarState()` | 1796 |
| Sidebar resizer | 1888 |
| Recent section resizer | 1921 |
| Status bar updates | 1958 |
| Welcome screen | 1973 |
| No-editor overlay shortcuts | 2016 |
| `toggleWordWrap()` | 2041 |
| `toggleMinimap()` | 2047 |
| `changeFontSize()` | 2053 |
| `reopenClosedTab()` | 2059 |
| `closeOtherTabs()` | 2070 |
| `closeAllTabs()` | 2077 |
| `initKeyboard()` — all shortcuts | 2085 |
| Ctrl+Tab MRU logic | 2086-2115 |
| Cmd+1-9 tab jump | ~2155 |
| Line operations (move/copy/delete) | ~2170-2240 |
| `initIpcHandlers()` | 2319 |
| `initDragDrop()` | 2356 |
| `guessLanguage()` | 2389 |
| `getFileIcon()` | 2406 |
| `init()` — entry point | 2424 |

### styles.css

| What | Approx. Location |
| ---- | ---------------- |
| Theme CSS variables | Top of file, `[data-theme="..."]` blocks |
| Titlebar | `.titlebar` |
| Sidebar | `.sidebar` |
| File tree | `.tree-item`, `.tree-chevron` |
| Tabs | `.tab-bar`, `.tab` |
| Search bar | `.search-bar` |
| Quick Open | `.quick-open-*` |
| Command Palette | `.cmd-palette-*` |
| Global Search | `.global-search-*` |
| Theme Picker | `.theme-picker-*` |
| Context menus | `.ctx-menu` |
| Welcome screen | `.welcome-*` |
| No-editor overlay | `.ets-*` |
| Status bar | `.status-bar` |

### index.html

| What | Description |
| ---- | ----------- |
| Titlebar | `#titlebar` with sidebar toggle |
| Sidebar | `#sidebar` with file tree + recent |
| Editor | `#editor-container` (Monaco mounts here) |
| Tab bar | `#tab-bar` |
| Search bar | `#search-bar` |
| Goto bar | `#goto-bar` |
| Quick Open | `#quick-open-overlay` |
| Command Palette | `#cmd-palette-overlay` |
| Theme Picker | `#theme-picker-overlay` |
| Global Search | `#global-search-overlay` |
| File tree context menu | `#ctx-menu` |
| Tab context menu | `#tab-ctx-menu` |
| Welcome screen | `#welcome-screen` |
| No-editor overlay | `#empty-tab-shortcuts` |
| Status bar | `#status-bar` |
| Monaco loader | `<script src="../../node_modules/monaco-editor/min/vs/loader.js">` |

---

## Version History

| Version | Date | Notes |
| ------- | ---- | ----- |
| 1.0.0 | Feb 2026 | Initial release — full editor with tabs, search, themes, shortcuts |

---

*This file is the single source of truth for the Apex Debug Studio project. Keep it updated when making changes.*

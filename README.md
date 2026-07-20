# Apex Debug Studio

**Live Apex debugging, reimagined.** A modern Salesforce Apex editor for macOS with a Chrome DevTools-style **live Apex debugger**, plus **auto-save**, **session persistence**, and powerful editing features.

## Features

- **Live Apex debugging** — set breakpoints, step through `.cls` files, inspect variables and watch expressions, and replay org execution logs
- **Salesforce tooling** — org connection, Apex test runner, SOQL, and system-mode queries via the Salesforce CLI
- **Monaco Editor** — the same editor engine that powers VS Code
- **Auto-save** — every tab is automatically saved to `~/ApexDebugStudio/AutoSave/YYYY-MM-DD/` with date-based folders
- **Session persistence** — all tabs, cursor positions, and settings survive app restarts
- **Tabs** — open multiple files, rename tabs with double-click, close with middle-click
- **Search & Replace** — regex, case-sensitive, whole-word matching (⌘F / ⌘H)
- **Go to Line** — ⌘G
- **File tree sidebar** — browse and open folders
- **Recent files** — quick access from sidebar and welcome screen
- **Drag & drop** — drop files or folders onto the editor
- **Syntax highlighting** — 30+ languages supported
- **Minimap, word wrap, zoom** — toggle from View menu
- **Dark theme** — Catppuccin-inspired color scheme
- **Keyboard shortcuts** — ⌘N, ⌘O, ⌘S, ⌘W, ⌘1-9 for tab switching, Ctrl+Tab

## Getting Started

```bash
npm install
npm start
```

## Build for Distribution

```bash
npm run build       # macOS .dmg + .zip
npm run build:all   # macOS + Windows
```

## Auto-Save Location

All unsaved tabs are persisted to:

```
~/ApexDebugStudio/AutoSave/2026-02-25/Untitled-1.txt
```

Session data is stored in `~/ApexDebugStudio/.session.json`.

## Keyboard Shortcuts

| Action           | Shortcut       |
|------------------|----------------|
| New Tab          | ⌘N             |
| Open File        | ⌘O             |
| Open Folder      | ⇧⌘O            |
| Save             | ⌘S             |
| Save As          | ⇧⌘S            |
| Close Tab        | ⌘W             |
| Find             | ⌘F             |
| Replace          | ⌘H             |
| Go to Line       | ⌘G             |
| Toggle Sidebar   | ⌘B             |
| Toggle Minimap   | ⇧⌘M            |
| Toggle Word Wrap | Alt+Z          |
| Zoom In          | ⌘+             |
| Zoom Out         | ⌘-             |
| Reset Zoom       | ⌘0             |
| Switch Tab       | ⌘1–⌘9          |
| Next Tab         | Ctrl+Tab       |
| Prev Tab         | Ctrl+Shift+Tab |
| Duplicate Line   | ⇧⌘D            |
| Move Line Up     | Alt+↑          |
| Move Line Down   | Alt+↓          |

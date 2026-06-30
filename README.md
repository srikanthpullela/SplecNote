# Splec Note + CongaCode

This repository now hosts two editors:

- **[Splec Note](./splec-note/)** — a fresh, lightweight cross-platform editor
  (Tauri 2 + TypeScript/Vite + CodeMirror 6) for both note-taking and coding,
  with a distinctive Splec design system and Light/Dark/System theming. This is
  the actively developed app. See **[`splec-note/README.md`](./splec-note/README.md)**
  to build and run it.
- **CongaCode** *(legacy, below)* — the original Electron + Monaco app, kept
  in place for reference.

---

# CongaCode

A modern, Sublime Text–inspired notepad application for macOS with **auto-save**, **session persistence**, and powerful editing features.

## Features

- **Monaco Editor** — the same editor engine that powers VS Code
- **Auto-save** — every tab is automatically saved to `~/CongaCode/AutoSave/YYYY-MM-DD/` with date-based folders
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
~/CongaCode/AutoSave/2026-02-25/Untitled-1.txt
```

Session data is stored in `~/CongaCode/.session.json`.

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

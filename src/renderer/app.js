/* ========================================================================
   Apex Debug Studio — Renderer (app.js)
   ======================================================================== */

'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---- Cross-platform path helpers (Windows uses \, macOS/Linux use /) ---- */
const _lastSep = (p) => Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
const baseName = (p) => String(p == null ? '' : p).split(/[/\\]/).pop();
const dirName = (p) => { const i = _lastSep(p); return i < 0 ? '' : String(p).substring(0, i); };
const _pathSep = (p) => (String(p).includes('\\') ? '\\' : '/');
// Approximate the user's home directory + native separator from a sample path
// (e.g. /Users/name on macOS, C:\Users\name on Windows, /home/name on Linux).
const _homeAndSep = (sample) => {
  const sep = _pathSep(sample || '');
  const parts = String(sample || '').split(/[/\\]/);
  const home = parts.length >= 3 ? parts.slice(0, 3).join(sep) : '~';
  return { home, sep };
};

/* ---- State ---- */
const state = {
  editor: null,
  tabs: [],               // { id, title, filePath, model, viewState, modified }
  activeTabId: null,
  folderPath: null,
  sidebarVisible: false,
  sidebarWidth: 260,      // remembered width before collapse
  searchDecorations: [],   // IDs for current in-file search decorations
  globalSearchAbort: null, // AbortController for async global search
  recentSectionOpen: false,
  recentHeight: 150,       // starting height for recent section
  autoSaveTimers: {},
  theme: 'github-dark',
  welcomeVisible: true,
  treeSectionOpen: true,
  recentlyClosed: [],      // stack of { title, filePath, content } for Cmd+Shift+T
  // New feature state
  zenMode: false,
  splitEditor: null,       // secondary Monaco editor instance
  splitActive: false,
  markdownPreviewVisible: false,
  outlineSectionOpen: false,
  gitStatus: null,         // { branch, files, ahead, behind }
  imagePreviewActive: false,
  settings: null,
  terminalVisible: false,
  terminalCwd: null,
  terminalHistory: [],
  terminalHistoryIdx: -1,
  blameVisible: false,
  blameData: null,
  blameDecorations: [],
  // Tool panels state
  apiHistory: [],
  apiCollections: [],
  bookmarks: [],
  dbFilePath: null,
  dbType: null,
  dbTables: [],
  activeToolPanel: null, // 'api'|'regex'|'json'|'bookmarks'|'screenshot'|'db'|null
  historySectionOpen: false,
};
window.state = state;

/* ---- DOM cache ---- */
const dom = {};

function cacheDom() {
  dom.titlebarTitle    = $('#titlebar-title');
  dom.sidebar          = $('#sidebar');
  dom.sidebarResizer   = $('#sidebar-resizer');
  dom.rootFolderBar    = $('#root-folder-bar');
  dom.rootFolderName   = $('#root-folder-name');
  dom.fileTree         = $('#file-tree');
  dom.fileTreeEmpty    = $('#file-tree-empty');
  dom.recentSection    = $('#recent-section');
  dom.recentSectionHeader = $('#recent-section-header');
  dom.recentToggleIcon = $('#recent-toggle-icon');
  dom.recentList       = $('#recent-list');
  dom.recentResizer    = $('#recent-resizer');
  dom.tabsContainer    = $('#tabs-container');
  dom.editorContainer  = $('#editor-container');
  dom.searchBar        = $('#search-bar');
  dom.searchInput      = $('#search-input');
  dom.searchCount      = $('#search-count');
  dom.searchCase       = $('#search-case');
  dom.searchRegex      = $('#search-regex');
  dom.searchWhole      = $('#search-whole');
  dom.replaceRow       = $('#replace-row');
  dom.replaceInput     = $('#replace-input');
  dom.gotoBar          = $('#goto-bar');
  dom.gotoInput        = $('#goto-input');
  dom.quickOpenOverlay = $('#quick-open-overlay');
  dom.quickOpenInput   = $('#quick-open-input');
  dom.quickOpenResults = $('#quick-open-results');
  dom.cmdPaletteOverlay = $('#command-palette-overlay');
  dom.cmdPaletteInput  = $('#command-palette-input');
  dom.cmdPaletteResults = $('#command-palette-results');
  dom.themePickerOverlay = $('#theme-picker-overlay');
  dom.themePickerInput   = $('#theme-picker-input');
  dom.themePickerResults = $('#theme-picker-results');
  dom.globalSearchOverlay = $('#global-search-overlay');
  dom.globalSearchInput   = $('#global-search-input');
  dom.globalSearchResults = $('#global-search-results');
  dom.globalSearchStatus  = $('#global-search-status');
  dom.globalSearchCase    = $('#global-search-case');
  dom.globalSearchRegex   = $('#global-search-regex');
  dom.contextMenu      = $('#context-menu');
  dom.welcomeScreen    = $('#welcome-screen');
  dom.emptyTabShortcuts = $('#empty-tab-shortcuts');
  dom.statusPosition   = $('#status-position');
  dom.statusEncoding   = $('#status-encoding');
  dom.statusLanguage   = $('#status-language');
  dom.statusEol        = $('#status-eol');
  dom.statusIndent     = $('#status-indent');
  dom.statusTheme      = $('#status-theme');
  dom.statusAutosave   = $('#status-autosave');
  // New feature DOM
  dom.breadcrumbsBar   = $('#breadcrumbs-bar');
  dom.breadcrumbs      = $('#breadcrumbs');
  dom.imagePreview     = $('#image-preview');
  dom.imagePreviewImg  = $('#image-preview-img');
  dom.imagePreviewInfo = $('#image-preview-info');
  dom.markdownPreview  = $('#markdown-preview');
  dom.markdownContent  = $('#markdown-preview-content');
  dom.outlineSection   = $('#outline-section');
  dom.outlineSectionHeader = $('#outline-section-header');
  dom.outlineToggleIcon = $('#outline-toggle-icon');
  dom.outlineList      = $('#outline-list');
  dom.historySection     = $('#history-section');
  dom.historySectionHeader = $('#history-section-header');
  dom.historyToggleIcon  = $('#history-toggle-icon');
  dom.historyList         = $('#history-list');
  dom.toastContainer   = $('#toast-container');
  dom.statusGit        = $('#status-git');
  dom.editorRow        = $('#editor-row');
  dom.editorSplitContainer = $('#editor-split-container');
  dom.editorSecondary  = $('#editor-container-secondary');
  dom.splitResizer     = $('#split-resizer');
  // Terminal
  dom.terminalPanel    = $('#terminal-panel');
  dom.terminalOutput   = $('#terminal-output');
  dom.terminalInput    = $('#terminal-input');
  dom.terminalPrompt   = $('#terminal-prompt');
  dom.terminalCwd      = $('#terminal-cwd');
  dom.terminalResizer  = $('#terminal-resizer');
  // Language picker
  dom.languagePickerOverlay = $('#language-picker-overlay');
  dom.languagePickerInput   = $('#language-picker-input');
  dom.languagePickerResults = $('#language-picker-results');
  // Minimap indicator
  dom.statusMinimap    = $('#status-minimap');
  // Git info popup
  dom.gitInfoPopup     = $('#git-info-popup');
  dom.gitInfoBranch    = $('#git-info-branch');
  dom.gitInfoTracking  = $('#git-info-tracking');
  dom.gitInfoSync      = $('#git-info-sync');
  dom.gitInfoRemote    = $('#git-info-remote');
  dom.gitInfoStash     = $('#git-info-stash');
  dom.gitInfoFiles     = $('#git-info-files');
  dom.gitInfoCommits   = $('#git-info-commits');
  // Rich text editor
  dom.richTextContainer = $('#richtext-container');
  dom.richTextToolbar  = $('#richtext-toolbar');
  dom.richTextEditor   = $('#richtext-editor');
  dom.statusRichText   = $('#status-richtext');
}

/* ================================================================
   1. MONACO INIT
   ================================================================ */

const THEMES = [
  { id: 'dark',             label: 'Dark (Default)',    base: 'vs-dark' },
  { id: 'light',            label: 'Light',             base: 'vs' },
  { id: 'monokai',          label: 'Monokai',           base: 'vs-dark' },
  { id: 'dracula',          label: 'Dracula',           base: 'vs-dark' },
  { id: 'nord',             label: 'Nord',              base: 'vs-dark' },
  { id: 'solarized-dark',   label: 'Solarized Dark',    base: 'vs-dark' },
  { id: 'sublime-mariana',  label: 'Sublime Mariana',   base: 'vs-dark' },
  { id: 'one-dark',         label: 'One Dark Pro',      base: 'vs-dark' },
  { id: 'material-ocean',   label: 'Material Ocean',    base: 'vs-dark' },
  { id: 'github-dark',      label: 'GitHub Dark',       base: 'vs-dark' },
  { id: 'tomorrow-night',   label: 'Tomorrow Night',    base: 'vs-dark' },
  { id: 'ayu-dark',         label: 'Ayu Dark',          base: 'vs-dark' },
  { id: 'gruvbox',          label: 'Gruvbox Dark',      base: 'vs-dark' },
  { id: 'apex',             label: 'Apex Dark',         base: 'vs-dark' },
];

function defineMonacoThemes(monaco) {
  const themes = {
    dark: {
      base: 'vs-dark', inherit: true,
      rules: [{ token: 'comment', foreground: '6c7086', fontStyle: 'italic' }],
      colors: { 'editor.background': '#1e1e2e', 'editor.foreground': '#cdd6f4', 'editor.selectionBackground': '#89b4fa40' },
    },
    light: {
      base: 'vs', inherit: true,
      rules: [{ token: 'comment', foreground: '999999', fontStyle: 'italic' }],
      colors: { 'editor.background': '#ffffff', 'editor.foreground': '#333333', 'editor.selectionBackground': '#0066cc33' },
    },
    monokai: {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '75715e', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'f92672' },
        { token: 'keyword.control', foreground: 'f92672' },
        { token: 'string', foreground: 'e6db74' },
        { token: 'string.escape', foreground: 'ae81ff' },
        { token: 'number', foreground: 'ae81ff' },
        { token: 'number.hex', foreground: 'ae81ff' },
        { token: 'constant', foreground: 'ae81ff' },
        { token: 'type', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'type.identifier', foreground: 'a6e22e' },
        { token: 'identifier', foreground: 'f8f8f2' },
        { token: 'function', foreground: 'a6e22e' },
        { token: 'function.declaration', foreground: 'a6e22e' },
        { token: 'variable', foreground: 'f8f8f2' },
        { token: 'variable.predefined', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'operator', foreground: 'f92672' },
        { token: 'delimiter', foreground: 'f8f8f2' },
        { token: 'delimiter.bracket', foreground: 'f8f8f2' },
        { token: 'delimiter.parenthesis', foreground: 'f8f8f2' },
        { token: 'tag', foreground: 'f92672' },
        { token: 'tag.id', foreground: 'f92672' },
        { token: 'tag.class', foreground: 'f92672' },
        { token: 'attribute.name', foreground: 'a6e22e' },
        { token: 'attribute.value', foreground: 'e6db74' },
        { token: 'metatag', foreground: 'f92672' },
        { token: 'metatag.content', foreground: 'f8f8f2' },
        { token: 'regexp', foreground: 'e6db74' },
        { token: 'annotation', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'predefined', foreground: '66d9ef', fontStyle: 'italic' },
      ],
      colors: {
        'editor.background': '#272822',
        'editor.foreground': '#f8f8f2',
        'editor.selectionBackground': '#49483e',
        'editor.lineHighlightBackground': '#3e3d3250',
        'editorCursor.foreground': '#f8f8f0',
        'editorWhitespace.foreground': '#46473680',
        'editorIndentGuide.background': '#46473680',
        'editorLineNumber.foreground': '#90908a',
        'editorLineNumber.activeForeground': '#c2c2bf',
        'editor.findMatchBackground': '#e6db7450',
        'editor.findMatchHighlightBackground': '#e6db7425',
        'editorBracketMatch.background': '#3e3d3280',
        'editorBracketMatch.border': '#888888',
      },
    },
    dracula: {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '6272a4', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff79c6' },
        { token: 'keyword.control', foreground: 'ff79c6' },
        { token: 'string', foreground: 'f1fa8c' },
        { token: 'string.escape', foreground: 'ff79c6' },
        { token: 'number', foreground: 'bd93f9' },
        { token: 'constant', foreground: 'bd93f9' },
        { token: 'type', foreground: '8be9fd', fontStyle: 'italic' },
        { token: 'type.identifier', foreground: '50fa7b' },
        { token: 'function', foreground: '50fa7b' },
        { token: 'function.declaration', foreground: '50fa7b' },
        { token: 'variable', foreground: 'f8f8f2' },
        { token: 'variable.predefined', foreground: '8be9fd', fontStyle: 'italic' },
        { token: 'operator', foreground: 'ff79c6' },
        { token: 'delimiter', foreground: 'f8f8f2' },
        { token: 'tag', foreground: 'ff79c6' },
        { token: 'attribute.name', foreground: '50fa7b' },
        { token: 'attribute.value', foreground: 'f1fa8c' },
        { token: 'regexp', foreground: 'f1fa8c' },
        { token: 'annotation', foreground: '8be9fd', fontStyle: 'italic' },
        { token: 'predefined', foreground: '8be9fd', fontStyle: 'italic' },
      ],
      colors: {
        'editor.background': '#282a36',
        'editor.foreground': '#f8f8f2',
        'editor.selectionBackground': '#44475a',
        'editor.lineHighlightBackground': '#44475a50',
        'editorCursor.foreground': '#f8f8f0',
        'editorLineNumber.foreground': '#6272a4',
        'editorLineNumber.activeForeground': '#f8f8f2',
        'editorBracketMatch.background': '#44475a80',
        'editorBracketMatch.border': '#ff79c6',
      },
    },
    nord: {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '616e88', fontStyle: 'italic' },
        { token: 'keyword', foreground: '81a1c1' },
        { token: 'string', foreground: 'a3be8c' },
        { token: 'number', foreground: 'b48ead' },
      ],
      colors: { 'editor.background': '#2e3440', 'editor.foreground': '#d8dee9', 'editor.selectionBackground': '#434c5e' },
    },
    'solarized-dark': {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '586e75', fontStyle: 'italic' },
        { token: 'keyword', foreground: '859900' },
        { token: 'string', foreground: '2aa198' },
        { token: 'number', foreground: 'd33682' },
      ],
      colors: { 'editor.background': '#002b36', 'editor.foreground': '#839496', 'editor.selectionBackground': '#073642' },
    },
    'sublime-mariana': {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '6c7a8c', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'C695C6' },
        { token: 'string', foreground: '99C794' },
        { token: 'number', foreground: 'F9AE58' },
        { token: 'type', foreground: '5FB4B4' },
      ],
      colors: { 'editor.background': '#303841', 'editor.foreground': '#D8DEE9', 'editor.selectionBackground': '#3c455480' },
    },
    'one-dark': {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '5c6370', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c678dd' },
        { token: 'string', foreground: '98c379' },
        { token: 'number', foreground: 'd19a66' },
        { token: 'type', foreground: 'e5c07b' },
      ],
      colors: { 'editor.background': '#282c34', 'editor.foreground': '#abb2bf', 'editor.selectionBackground': '#3e4451' },
    },
    'material-ocean': {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '464B5D', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'C792EA' },
        { token: 'string', foreground: 'C3E88D' },
        { token: 'number', foreground: 'F78C6C' },
        { token: 'type', foreground: 'FFCB6B' },
      ],
      colors: { 'editor.background': '#0F111A', 'editor.foreground': '#A6ACCD', 'editor.selectionBackground': '#292D3E' },
    },
    'github-dark': {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '484f58', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff7b72' },
        { token: 'string', foreground: 'a5d6ff' },
        { token: 'number', foreground: '79c0ff' },
        { token: 'type', foreground: 'ffa657' },
      ],
      colors: { 'editor.background': '#0d1117', 'editor.foreground': '#c9d1d9', 'editor.selectionBackground': '#264f78' },
    },
    'tomorrow-night': {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '686868', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'b294bb' },
        { token: 'string', foreground: 'b5bd68' },
        { token: 'number', foreground: 'de935f' },
        { token: 'type', foreground: 'f0c674' },
      ],
      colors: { 'editor.background': '#1d1f21', 'editor.foreground': '#c5c8c6', 'editor.selectionBackground': '#373b41' },
    },
    'ayu-dark': {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '565B66', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'FF8F40' },
        { token: 'string', foreground: 'AAD94C' },
        { token: 'number', foreground: 'D2A6FF' },
        { token: 'type', foreground: '59C2FF' },
      ],
      colors: { 'editor.background': '#0A0E14', 'editor.foreground': '#B3B1AD', 'editor.selectionBackground': '#1B273380' },
    },
    gruvbox: {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '928374', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'fb4934' },
        { token: 'string', foreground: 'b8bb26' },
        { token: 'number', foreground: 'd3869b' },
        { token: 'type', foreground: 'fabd2f' },
      ],
      colors: { 'editor.background': '#282828', 'editor.foreground': '#ebdbb2', 'editor.selectionBackground': '#3c383680' },
    },
    apex: {
      base: 'vs-dark', inherit: true,
      rules: [
        // Comments
        { token: 'comment', foreground: '75715e', fontStyle: 'italic' },
        { token: 'comment.doc', foreground: '75715e', fontStyle: 'italic' },
        { token: 'comment.block', foreground: '75715e', fontStyle: 'italic' },

        // Keywords — bold pink
        { token: 'keyword', foreground: 'f92672', fontStyle: 'bold' },
        { token: 'keyword.control', foreground: 'f92672', fontStyle: 'bold' },
        { token: 'keyword.flow', foreground: 'f92672', fontStyle: 'bold' },
        { token: 'keyword.operator', foreground: 'f92672' },
        { token: 'keyword.other', foreground: 'f92672', fontStyle: 'bold' },

        // Storage / type keywords — italic blue
        { token: 'storage', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'storage.type', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'storage.modifier', foreground: 'f92672', fontStyle: 'bold' },

        // Strings — yellow
        { token: 'string', foreground: 'e6db74' },
        { token: 'string.escape', foreground: 'ae81ff' },
        { token: 'string.key', foreground: '66d9ef' },
        { token: 'string.value', foreground: 'e6db74' },

        // Numbers / constants — purple
        { token: 'number', foreground: 'ae81ff' },
        { token: 'number.hex', foreground: 'ae81ff' },
        { token: 'number.float', foreground: 'ae81ff' },
        { token: 'constant', foreground: 'ae81ff' },
        { token: 'constant.language', foreground: 'ae81ff' },

        // Types — italic blue
        { token: 'type', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'type.identifier', foreground: 'a6e22e' },

        // Functions — bright green
        { token: 'function', foreground: 'a6e22e' },
        { token: 'function.declaration', foreground: 'a6e22e' },
        { token: 'function.call', foreground: 'a6e22e' },
        { token: 'method', foreground: 'a6e22e' },
        { token: 'method.declaration', foreground: 'a6e22e' },
        { token: 'support.function', foreground: 'a6e22e' },
        { token: 'entity.name.function', foreground: 'a6e22e' },

        // Variables — depends on context
        { token: 'variable', foreground: 'f8f8f2' },
        { token: 'variable.predefined', foreground: 'fd971f' },
        { token: 'variable.parameter', foreground: 'fd971f', fontStyle: 'italic' },
        { token: 'variable.other', foreground: 'f8f8f2' },
        { token: 'variable.language', foreground: '66d9ef', fontStyle: 'italic' },

        // Parameters — orange italic (key differentiator)
        { token: 'parameter', foreground: 'fd971f', fontStyle: 'italic' },
        { token: 'parameter.name', foreground: 'fd971f', fontStyle: 'italic' },

        // Identifiers
        { token: 'identifier', foreground: 'f8f8f2' },

        // Operators — pink
        { token: 'operator', foreground: 'f92672' },
        { token: 'operator.arrow', foreground: 'f92672' },
        { token: 'operator.assignment', foreground: 'f92672' },

        // Delimiters / brackets — colored for depth
        { token: 'delimiter', foreground: 'f8f8f2' },
        { token: 'delimiter.bracket', foreground: 'f8f8f2' },
        { token: 'delimiter.parenthesis', foreground: 'f8f8f2' },
        { token: 'delimiter.curly', foreground: 'f8f8f2' },
        { token: 'delimiter.square', foreground: 'f8f8f2' },
        { token: 'delimiter.angle', foreground: 'f8f8f2' },

        // HTML/XML tags
        { token: 'tag', foreground: 'f92672' },
        { token: 'tag.id', foreground: 'f92672' },
        { token: 'tag.class', foreground: 'a6e22e' },

        // HTML/XML attributes
        { token: 'attribute.name', foreground: 'a6e22e' },
        { token: 'attribute.value', foreground: 'e6db74' },
        { token: 'attribute.value.number', foreground: 'ae81ff' },

        // Meta tags
        { token: 'metatag', foreground: 'f92672' },
        { token: 'metatag.content', foreground: 'f8f8f2' },
        { token: 'metatag.content.string', foreground: 'e6db74' },

        // Regex
        { token: 'regexp', foreground: 'e6db74' },
        { token: 'regexp.escape', foreground: 'ae81ff' },

        // Annotations / decorators — blue italic
        { token: 'annotation', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'predefined', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'decorator', foreground: '66d9ef', fontStyle: 'italic' },

        // CSS-specific
        { token: 'attribute.name.css', foreground: 'a6e22e' },
        { token: 'attribute.value.css', foreground: 'e6db74' },
        { token: 'attribute.value.number.css', foreground: 'ae81ff' },
        { token: 'attribute.value.unit.css', foreground: 'f92672' },
        { token: 'tag.css', foreground: 'f92672' },
        { token: 'tag.id.css', foreground: 'fd971f' },
        { token: 'tag.class.css', foreground: 'a6e22e' },

        // JSON keys — blue
        { token: 'string.key.json', foreground: '66d9ef' },
        { token: 'string.value.json', foreground: 'e6db74' },

        // Markdown
        { token: 'markup.heading', foreground: 'a6e22e', fontStyle: 'bold' },
        { token: 'markup.bold', foreground: 'fd971f', fontStyle: 'bold' },
        { token: 'markup.italic', foreground: 'e6db74', fontStyle: 'italic' },
        { token: 'markup.inline', foreground: 'ae81ff' },

        // Python-specific
        { token: 'keyword.python', foreground: 'f92672', fontStyle: 'bold' },
        { token: 'identifier.python', foreground: 'f8f8f2' },
        { token: 'delimiter.python', foreground: 'f8f8f2' },
        { token: 'type.python', foreground: '66d9ef', fontStyle: 'italic' },

        // Java / C# / TypeScript — class names
        { token: 'class', foreground: 'a6e22e', fontStyle: 'underline' },
        { token: 'class.name', foreground: 'a6e22e', fontStyle: 'underline' },
        { token: 'interface', foreground: '66d9ef', fontStyle: 'italic' },

        // Shell
        { token: 'variable.shell', foreground: 'fd971f' },

        // This/self — italic blue
        { token: 'variable.self', foreground: '66d9ef', fontStyle: 'italic' },
        { token: 'variable.this', foreground: '66d9ef', fontStyle: 'italic' },

        // Namespace / module  
        { token: 'namespace', foreground: 'a6e22e' },

        // Catch-all for property access
        { token: 'property', foreground: '66d9ef' },
        { token: 'member', foreground: '66d9ef' },
      ],
      colors: {
        'editor.background': '#272822',
        'editor.foreground': '#f8f8f2',
        'editor.selectionBackground': '#49483e',
        'editor.lineHighlightBackground': '#3e3d3260',
        'editorCursor.foreground': '#f8f8f0',
        'editorWhitespace.foreground': '#46453830',
        'editorIndentGuide.background': '#46453850',
        'editorLineNumber.foreground': '#90908a',
        'editorLineNumber.activeForeground': '#c2c2bf',
        'editor.findMatchBackground': '#ffe79240',
        'editor.findMatchHighlightBackground': '#ffe79220',
        'editorBracketMatch.background': '#3e3d3260',
        'editorBracketMatch.border': '#75715e',
        'editorBracketHighlight.foreground1': '#f92672',
        'editorBracketHighlight.foreground2': '#a6e22e',
        'editorBracketHighlight.foreground3': '#66d9ef',
        'editorBracketHighlight.foreground4': '#fd971f',
        'editorBracketHighlight.foreground5': '#ae81ff',
        'editorBracketHighlight.foreground6': '#e6db74',
      },
    },
  };

  for (const [id, data] of Object.entries(themes)) {
    monaco.editor.defineTheme(id, data);
  }
}

function monacoThemeId(themeId) {
  // All our theme IDs match the Monaco-defined theme names
  return themeId;
}

function initMonaco() {
  return new Promise((resolve) => {
    require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], (monaco) => {
      defineMonacoThemes(monaco);
      state.editor = monaco.editor.create(dom.editorContainer, {
        value: '',
        language: 'plaintext',
        theme: monacoThemeId(state.theme),
        fontSize: 14,
        fontFamily: "'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
        minimap: { enabled: true },
        wordWrap: 'off',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        autoClosingBrackets: 'always',
        autoClosingQuotes: 'always',
        autoSurround: 'languageDefined',
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true },
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        cursorBlinking: 'smooth',
        padding: { top: 10 },
        lineNumbers: 'on',
        glyphMargin: true,
        folding: true,
        tabSize: 2,
      });
      // Add "File History" to editor right-click context menu
      state.editor.addAction({
        id: 'apexstudio.fileHistory',
        label: 'File History',
        contextMenuGroupId: '9_cutcopypaste',
        contextMenuOrder: 99,
        run: () => {
          const tab = state.tabs.find(t => t.id === state.activeTabId);
          if (tab?.filePath) showFileHistoryInPanel(tab.filePath);
        }
      });

      // Salesforce submenu in editor right-click
      state.editor.addAction({
        id: 'apexstudio.salesforce',
        label: '⚡ Salesforce',
        contextMenuGroupId: 'z_salesforce',
        contextMenuOrder: 0,
        run: () => {
          const tab = state.tabs.find(t => t.id === state.activeTabId);
          if (!tab?.filePath) return;
          showSfEditorSubmenu(tab.filePath);
        }
      });

      state.editor.onDidChangeCursorPosition(updateStatusPosition);
      state.editor.onDidChangeModelContent(() => {
        markTabModified(state.activeTabId, true);
        scheduleAutoSave(state.activeTabId);
        // Update markdown preview and outline on content change
        debounce(updateMarkdownPreview, 500)();
        debounce(updateOutline, 1000)();
        // Schedule git refresh
        scheduleGitRefresh();
      });
      resolve(monaco);
    });
  });
}

/* ================================================================
   2. TABS
   ================================================================ */
let tabIdCounter = 0;

function createTab(title, filePath, content = '', lang = null) {
  hideWelcome();
  hideEmptyTabShortcuts();
  const id = ++tabIdCounter;
  const uri = filePath
    ? monaco.Uri.file(filePath)
    : monaco.Uri.parse(`untitled:Untitled-${id}`);
  let model = monaco.editor.getModel(uri);
  if (!model) {
    const language = lang || guessLanguage(title || '');
    model = monaco.editor.createModel(content, language, uri);
  } else {
    // Update content if existing model
    model.setValue(content);
  }
  const tab = { id, title: title || `Untitled-${id}`, filePath, model, viewState: null, modified: false };
  state.tabs.push(tab);
  renderTabs();
  activateTab(id);
  saveSessionDebounced();
  return tab;
}

function activateTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  // Save current view state
  const prev = state.tabs.find((t) => t.id === state.activeTabId);
  if (prev && state.editor) prev.viewState = state.editor.saveViewState();
  // Save rich text HTML when switching away
  if (prev && prev._richTextMode && dom.richTextEditor) {
    prev._richTextHtml = dom.richTextEditor.innerHTML;
  }

window.activateTab = activateTab;
  state.activeTabId = id;
  saveSessionDebounced();

  // Handle special tabs (settings, image)
  hideSettingsUI();
  hideImagePreview();
  // Hide diff/commit editor if switching away
  hideDiffEditor();
  hideCommitViewer();

  if (tab._isSettings) {
    state.editor.setModel(tab.model);
    renderSettingsUI();
    renderTabs();
    updateTitleBar(tab);
    updateEmptyTabShortcuts();
    return;
  }

  // Handle commit viewer tabs
  if (tab._isCommitDiff) {
    renderCommitViewer(tab);
    renderTabs();
    updateTitleBar(tab);
    updateEmptyTabShortcuts();
    return;
  }

  // Handle diff tabs (Diff Checker)
  if (tab._isDiff) {
    renderDiffEditor(tab);
    renderTabs();
    updateTitleBar(tab);
    updateEmptyTabShortcuts();
    return;
  }

  // Handle image files
  if (tab.filePath && isImageFile(tab.title)) {
    showImagePreview(tab.filePath);
    state.editor.setModel(null);
    renderTabs();
    updateTitleBar(tab);
    updateEmptyTabShortcuts();
    return;
  }

  // Handle rich text mode
  if (tab._richTextMode) {
    enterRichTextMode(tab, false); // re-enter without overwriting content
    renderTabs();
    updateStatusLanguage(tab);
    updateTitleBar(tab);
    updateEmptyTabShortcuts();
    updateBreadcrumbs();
    return;
  } else {
    hideRichTextEditor();
  }

  // Restore main editor visibility (may have been hidden by diff/commit/richtext/image viewers)
  dom.editorSplitContainer.style.display = '';
  dom.editorContainer.style.display = '';
  state.editor.setModel(tab.model);
  if (tab.viewState) state.editor.restoreViewState(tab.viewState);
  state.editor.focus();
  showFileStatusItems();
  renderTabs();
  updateStatusLanguage(tab);
  updateTitleBar(tab);
  clearSearchDecorations();
  updateEmptyTabShortcuts();
  updateBreadcrumbs();
  updateOutline();
  updateMarkdownPreview();

  // Sync split editor model
  if (state.splitActive && state.splitEditor && tab.model) {
    state.splitEditor.setModel(tab.model);
  }
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  // Save to recently closed stack (skip settings & diff tabs)
  if (!tab._isSettings && !tab._isDiff) {
    const closedEntry = { title: tab.title, filePath: tab.filePath, content: tab.model.getValue() };
    state.recentlyClosed.push(closedEntry);
    if (state.recentlyClosed.length > 20) state.recentlyClosed.shift();
  }
  // Clean up
  hideSettingsUI();
  hideImagePreview();
  hideDiffEditor();
  hideCommitViewer();
  // Dispose diff editor resources
  if (tab._diffEditor) { tab._diffEditor.dispose(); }
  if (tab._diffOriginalModel) { tab._diffOriginalModel.dispose(); }
  if (tab._diffModifiedModel) { tab._diffModifiedModel.dispose(); }
  if (tab._commitEditor) { tab._commitEditor.dispose(); }
  tab.model.dispose();
  state.tabs.splice(idx, 1);
  clearAutoSave(id);
  if (state.tabs.length === 0) {
    state.activeTabId = null;
    state.editor.setModel(null);
    hideFileStatusItems();
    if (state.folderPath) {
      // Folder is open — show no-editor overlay, not the full welcome screen
      hideWelcome();
      showEmptyTabShortcuts();
    } else {
      hideEmptyTabShortcuts();
      showWelcome();
    }
    renderTabs();
    saveSessionDebounced();
    return;
  }
  if (state.activeTabId === id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    activateTab(next.id);
  } else {
    renderTabs();
  }
  saveSessionDebounced();
}

function renderTabs() {
  dom.tabsContainer.innerHTML = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');
    el.dataset.tabId = tab.id;
    el.innerHTML = `
      <span class="tab-icon">${getFileIcon(tab.title)}</span>
      <span class="tab-title">${escHtml(tab.title)}</span>
      ${tab.modified ? '<span class="tab-modified">●</span>' : ''}
      <button class="tab-close" title="Close">✕</button>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) { closeTab(tab.id); return; }
      activateTab(tab.id);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTabContextMenu(e.clientX, e.clientY, tab.id);
    });
    // Tab drag reorder
    makeTabDraggable(el, tab);
    dom.tabsContainer.appendChild(el);
  }
}

function markTabModified(id, modified) {
  const tab = state.tabs.find((t) => t.id === id);
  if (tab && tab.modified !== modified) {
    tab.modified = modified;
    renderTabs();
    updateTitleBar(tab);
  }
}

function updateTitleBar(tab) {
  const mod = tab && tab.modified ? '● ' : '';
  dom.titlebarTitle.textContent = tab ? `${mod}${tab.title} — Apex Debug Studio` : 'Apex Debug Studio';
}

/* ================================================================
   3. FILE OPERATIONS
   ================================================================ */

async function openFileDialog() {
  try {
    const filePaths = await window.apexStudio.openFileDialog();
    if (!filePaths || filePaths.length === 0) return;
    for (const fp of filePaths) {
      const content = await window.apexStudio.readFile(fp);
      if (content != null) await openFile(fp, content);
    }
  } catch (err) {
    console.error('openFileDialog error:', err);
  }
}

async function openFile(filePath, content) {
  // Check if already open
  const existing = state.tabs.find((t) => t.filePath === filePath);
  if (existing) { activateTab(existing.id); return; }
  const name = filePath.split(/[/\\]/).pop();

  // For image files, create a placeholder tab (content will be shown via image preview)
  if (isImageFile(name)) {
    createTab(name, filePath, '', 'plaintext');
    await window.apexStudio.addRecent(filePath);
    return;
  }

  createTab(name, filePath, content);
  await window.apexStudio.addRecent(filePath);
}
window.openFile = openFile;

async function saveFile(tabOrId) {
  const tab = typeof tabOrId === 'object' ? tabOrId : state.tabs.find((t) => t.id === tabOrId);
  if (!tab) return;
  // Never save diff / commit-diff tabs
  if (tab._isDiff || tab._isCommitDiff) return;
  // Sync rich text content to model before saving
  if (tab._richTextMode) saveRichTextContent(tab);
  let content = tab.model.getValue();
  // Trim trailing whitespace on each line
  if (state.settings?.trimTrailingWhitespace !== false) {
    const trimmed = content.split('\n').map(line => line.replace(/\s+$/, '')).join('\n');
    if (trimmed !== content) {
      const pos = state.editor?.getPosition();
      tab.model.setValue(trimmed);
      if (pos && state.editor && tab.id === state.activeTabId) state.editor.setPosition(pos);
      content = trimmed;
    }
  }
  // Ensure final newline
  if (state.settings?.insertFinalNewline !== false && content.length > 0 && !content.endsWith('\n')) {
    content += '\n';
  }
  if (!tab.filePath) {
    // Untitled — auto-save to ~/ApexDebugStudio/AutoSave/YYYY-MM-DD/
    const today = new Date().toISOString().slice(0, 10);
    const dir = await window.apexStudio.getAutoSavePath(today);
    // Use tab title, sanitize it, and add .txt extension
    const safeName = (tab.title || 'Untitled').replace(/[^a-zA-Z0-9._\- ]/g, '_').trim() || 'Untitled';
    const baseName = safeName.includes('.') ? safeName : `${safeName}.txt`;
    let filePath = `${dir}/${baseName}`;
    // Avoid collisions: append -1, -2, etc.
    const ext = baseName.substring(baseName.lastIndexOf('.'));
    const stem = baseName.substring(0, baseName.lastIndexOf('.'));
    let i = 1;
    while (await window.apexStudio.stat(filePath)) {
      filePath = `${dir}/${stem}-${i}${ext}`;
      i++;
    }
    await window.apexStudio.writeFile(filePath, content);
    tab.filePath = filePath;
    tab.title = filePath.split(/[/\\]/).pop();
    renderTabs();
    updateTitleBar(tab);
    updateBreadcrumbs();
    // Add to recent files so it appears on the welcome page
    await window.apexStudio.addRecent(filePath);
  } else {
    await window.apexStudio.writeFile(tab.filePath, content);
  }
  markTabModified(tab.id, false);
  showAutoSaved();
}

async function saveAsFile() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) return;

  // If in rich text mode, get content from the rich text editor
  let content;
  if (tab._richTextMode && dom.richTextEditor) {
    content = dom.richTextEditor.innerText;
  } else {
    content = tab.model.getValue();
  }

  const defaultName = tab.filePath || tab.title;
  const newPath = await window.apexStudio.saveFileDialog(defaultName);
  if (!newPath) return;

  // Trim trailing whitespace if applicable
  if (state.settings?.trimTrailingWhitespace !== false) {
    content = content.split('\n').map(line => line.replace(/\s+$/, '')).join('\n');
  }
  if (state.settings?.insertFinalNewline !== false && content.length > 0 && !content.endsWith('\n')) {
    content += '\n';
  }

  await window.apexStudio.writeFile(newPath, content);

  const newName = newPath.split(/[/\\]/).pop();
  const oldWasRichText = tab._richTextMode;
  tab.filePath = newPath;
  tab.title = newName;

  // Update Monaco model with new URI and language
  const lang = guessLanguage(newName);
  const oldContent = tab.model.getValue();
  tab.model.dispose();
  const newUri = monaco.Uri.file(newPath);
  tab.model = monaco.editor.createModel(content, lang, newUri);

  // If extension changed from .txt to code file, exit rich text mode
  if (oldWasRichText && lang !== 'plaintext') {
    exitRichTextMode(tab);
  }
  // If changed to .txt and not in rich text mode, optionally enter
  // (user can toggle manually)

  if (state.activeTabId === tab.id && state.editor) {
    state.editor.setModel(tab.model);
  }

  markTabModified(tab.id, false);
  renderTabs();
  updateTitleBar(tab);
  updateBreadcrumbs();
  updateStatusLanguage(tab);
  if (state.folderPath) await refreshTree();
  showToast(`Saved as ${newName}`, 'success', 2000);
  await window.apexStudio.addRecent(newPath);
}

function showAutoSaved() {
  dom.statusAutosave.classList.add('visible');
  setTimeout(() => dom.statusAutosave.classList.remove('visible'), 2000);
}

/* ================================================================
   4. AUTO-SAVE
   ================================================================ */
function scheduleAutoSave(tabId) {
  clearAutoSave(tabId);
  const t = state.tabs.find((t) => t.id === tabId);
  if (t && (t._isDiff || t._isCommitDiff)) return; // never auto-save diff/commit tabs
  state.autoSaveTimers[tabId] = setTimeout(() => {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (tab && tab.modified) saveFile(tab);
  }, 3000);
}

function clearAutoSave(tabId) {
  if (state.autoSaveTimers[tabId]) {
    clearTimeout(state.autoSaveTimers[tabId]);
    delete state.autoSaveTimers[tabId];
  }
}

/* ================================================================
   5. SESSION MANAGEMENT
   ================================================================ */
async function saveSession() {
  // Never overwrite the saved session while we're in the middle of restoring it —
  // a partial state (folder open, tabs not yet reopened) would clobber the good copy.
  if (state._restoringSession) return;
  try {
    // Only persist REAL editor tabs. Settings / diff / commit-diff tabs are transient
    // views with no file on disk — restoring them as untitled buffers would be noise.
    const restorable = state.tabs.filter((t) => !t._isSettings && !t._isDiff && !t._isCommitDiff);
    const tabs = restorable.map((t) => ({
      title: t.title,
      filePath: t.filePath || null,
      // File-backed tabs are re-read from disk on restore (never store stale/huge
      // bodies); only unsaved/untitled buffers keep their content inline.
      content: t.filePath ? null : (t.model ? t.model.getValue() : ''),
    }));
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    await window.apexStudio.saveSession({
      tabs,
      activeIndex: restorable.findIndex((t) => t.id === state.activeTabId),
      activeFilePath: activeTab && activeTab.filePath ? activeTab.filePath : null,
      folderPath: state.folderPath,
      theme: state.theme,
      sidebarVisible: state.sidebarVisible,
      sidebarWidth: state.sidebarWidth,
    });
  } catch (err) {
    console.error('saveSession error:', err);
  }
}

const saveSessionDebounced = debounce(saveSession, 1000);

// A reload/close fires beforeunload — flush the latest workspace shape (best-effort;
// the 1s debounced saves already keep the file fresh for the common case).
window.addEventListener('beforeunload', () => { try { saveSession(); } catch {} });

async function restoreSession() {
  const params = new URLSearchParams(window.location.search);
  const isNewWindow = params.get('new') === '1';

  // Close the one-time GitHub-Dark migration window on the very first boot after
  // this update. We capture whether it was pending, then immediately set the flag
  // so anything the user picks from here on is respected (see migrateLegacyTheme).
  try {
    ghdMigrationPending = !localStorage.getItem('apexstudio-theme-ghd-migrated');
    localStorage.setItem('apexstudio-theme-ghd-migrated', '1');
  } catch { ghdMigrationPending = false; }

  // Tell a WINDOW RELOAD (Cmd/Ctrl+R · "Reload Window") apart from a cold app launch.
  // sessionStorage survives a renderer reload but is empty in a brand-new process /
  // window — so finding the flag means "this document was reloaded". We fully restore
  // the workspace only on reload; a cold start keeps the deliberate welcome screen.
  let isReload = false;
  try {
    isReload = sessionStorage.getItem('apexstudio-window-live') === '1';
    sessionStorage.setItem('apexstudio-window-live', '1');
  } catch {}

  // New windows are always a clean slate (but keep the theme preference).
  if (isNewWindow) {
    try {
      const session = await window.apexStudio.loadSession();
      if (session?.theme) { state.theme = migrateLegacyTheme(session.theme); applyTheme(state.theme); }
    } catch {}
    state.sidebarVisible = false;
    applySidebarState();
    return;
  }

  try {
    const session = await window.apexStudio.loadSession();
    if (!session) return;
    // User preferences always come back.
    if (session.theme) { state.theme = migrateLegacyTheme(session.theme); applyTheme(state.theme); }
    if (session.sidebarWidth) state.sidebarWidth = session.sidebarWidth;

    if (isReload) {
      // Reload → bring the workspace back exactly: folder, open files, active tab.
      await restoreWorkspace(session);
    } else {
      // Cold start → sidebar stays hidden until a folder is opened (welcome screen).
      state.sidebarVisible = false;
      applySidebarState();
    }
  } catch (err) {
    console.error('restoreSession error:', err);
  }
}

// Reopen the folder + file tabs saved in the last session. Used on a window reload so
// the developer lands back exactly where they were instead of the welcome screen. Every
// step is best-effort: a folder or file that has since moved/deleted is skipped, never
// blocking the rest of the restore.
async function restoreWorkspace(session) {
  state._restoringSession = true;
  try {
    if (session.folderPath) {
      try { await openFolder(session.folderPath); }
      catch (e) { console.error('restore folder failed:', e); }
    } else {
      state.sidebarVisible = false;
      applySidebarState();
    }

    const savedTabs = Array.isArray(session.tabs) ? session.tabs : [];
    for (const t of savedTabs) {
      if (!t) continue;
      try {
        if (t.filePath) {
          const content = await window.apexStudio.readFile(t.filePath);
          if (content != null) await openFile(t.filePath, content); // skip files that vanished
        } else if (t.content != null) {
          createTab(t.title || null, null, t.content); // unsaved/untitled buffer
        }
      } catch (e) { /* skip a tab that can't be reopened; keep restoring the rest */ }
    }

    // Re-activate the tab the user was last on — match by path first (robust to
    // skipped tabs), then fall back to the saved index.
    let target = null;
    if (session.activeFilePath) target = state.tabs.find((t) => t.filePath === session.activeFilePath);
    if (!target && Number.isInteger(session.activeIndex) && session.activeIndex >= 0) {
      target = state.tabs[session.activeIndex];
    }
    if (target) activateTab(target.id);
  } catch (err) {
    console.error('restoreWorkspace error:', err);
  } finally {
    state._restoringSession = false;
    saveSession(); // persist the freshly-restored shape right away
  }
}

/* ================================================================
   6. FILE TREE
   ================================================================ */

async function openFolder(dirPath) {
  if (!dirPath) return;
  hideWelcome();
  // Ensure sidebar is visible when opening a folder
  if (!state.sidebarVisible) {
    state.sidebarVisible = true;
    applySidebarState();
  }
  try {
    // Stop watching previous folder
    if (state.folderPath && state.folderPath !== dirPath) {
      await stopWatching(state.folderPath);
    }
    state.folderPath = dirPath;
    // Start watching new folder
    await startWatching(dirPath);
    // Refresh git status
    refreshGitStatus();
    // Refresh Salesforce org (loads saved org for this folder)
    if (window.refreshSalesforceOrgs) window.refreshSalesforceOrgs();
    // Update terminal CWD if terminal is open
    if (state.terminalVisible && !state.terminalCwd) {
      state.terminalCwd = dirPath;
      window.apexStudio.terminalSetCwd(dirPath);
      updateTerminalCwd();
    }
    // Add folder to recent list
    await window.apexStudio.addRecent(dirPath);
    dom.fileTreeEmpty.classList.add('hidden');
    dom.fileTree.innerHTML = '';
    dom.rootFolderBar.classList.remove('hidden');
    dom.rootFolderName.textContent = dirPath.split(/[/\\]/).pop();
    await renderTreeDir(dirPath, dom.fileTree, 0);
    // If tree ended up empty, show a message
    if (dom.fileTree.children.length === 0) {
      dom.fileTree.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;">Empty folder</div>';
    }
    // Show no-editor overlay if no tabs are open
    if (state.tabs.length === 0) {
      hideFileStatusItems();
      showEmptyTabShortcuts();
    }
    saveSessionDebounced();
  } catch (err) {
    console.error('openFolder error:', err);
    dom.fileTree.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:12px;">Error loading folder</div>`;
  }
}

async function openFolderDialog() {
  try {
    const dirPath = await window.apexStudio.openFolderDialog();
    if (!dirPath) return;
    hideWelcome();
    await openFolder(dirPath);
  } catch (err) {
    console.error('openFolderDialog error:', err);
  }
}

async function renderTreeDir(dirPath, parentEl, depth) {
  let entries;
  try {
    entries = await window.apexStudio.readDir(dirPath);
  } catch (err) {
    console.error('readDir error:', err);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.setProperty('--depth', depth);
    item.dataset.path = entry.path;
    item.dataset.isDir = entry.isDirectory;

    let chevron = null;
    if (entry.isDirectory) {
      chevron = document.createElement('span');
      chevron.className = 'tree-chevron';
      chevron.textContent = '▶';
      item.appendChild(chevron);
    } else {
      // spacer to align files with folder names
      const spacer = document.createElement('span');
      spacer.className = 'tree-chevron-spacer';
      item.appendChild(spacer);
    }

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = entry.isDirectory ? '📁' : getFileIcon(entry.name);

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;

    item.appendChild(icon);
    item.appendChild(name);

    // Git status badge
    if (!entry.isDirectory) {
      const badge = getGitBadge(entry.path);
      if (badge) {
        const badgeEl = document.createElement('span');
        badgeEl.innerHTML = badge;
        const badgeNode = badgeEl.firstChild;
        badgeNode.style.cursor = 'pointer';
        badgeNode.title = 'Click to view diff';
        badgeNode.addEventListener('click', (e) => {
          e.stopPropagation();
          const relPath = entry.path.replace(state.folderPath + '/', '');
          showDiffView(relPath, entry.path);
        });
        item.appendChild(badgeNode);
      }
    }

    if (entry.isDirectory) {
      let expanded = false;
      let childContainer = null;
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        expanded = !expanded;
        chevron.textContent = expanded ? '▼' : '▶';
        chevron.classList.toggle('expanded', expanded);
        icon.textContent = expanded ? '📂' : '📁';
        if (expanded && !childContainer) {
          childContainer = document.createElement('div');
          childContainer.className = 'tree-children';
          item.after(childContainer);
          await renderTreeDir(entry.path, childContainer, depth + 1);
        } else if (childContainer) {
          childContainer.style.display = expanded ? '' : 'none';
        }
      });
    } else {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Highlight active
        dom.fileTree.querySelectorAll('.tree-item.active').forEach((el) => el.classList.remove('active'));
        item.classList.add('active');
        try {
          const content = await window.apexStudio.readFile(entry.path);
          await openFile(entry.path, content);
        } catch (err) {
          console.error('Failed to open file:', err);
        }
      });
    }

    // Context menu
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, entry.path, entry.isDirectory);
    });

    parentEl.appendChild(item);
  }
}

/* ================================================================
   7. CONTEXT MENU
   ================================================================ */
let contextTarget = { path: '', isDir: false };

function showContextMenu(x, y, targetPath, isDir) {
  contextTarget = { path: targetPath, isDir };
  // Hide "File History" for directories
  const historyItem = dom.contextMenu.querySelector('[data-action="file-history"]');
  if (historyItem) {
    historyItem.style.display = isDir ? 'none' : '';
    // Also hide the separator before it
    const prevSep = historyItem.previousElementSibling;
    if (prevSep && prevSep.classList.contains('ctx-separator')) prevSep.style.display = isDir ? 'none' : '';
  }
  // Show/hide Salesforce context menu items
  const ext = targetPath.split('.').pop().toLowerCase();
  const isSfFile = ['cls', 'trigger', 'page', 'component', 'cmp', 'js', 'html', 'css', 'xml'].includes(ext);
  const showSf = isSfFile || isDir;
  dom.contextMenu.querySelectorAll('.sf-ctx-item, .sf-ctx-sep').forEach(el => {
    el.style.display = showSf ? '' : 'none';
  });
  dom.contextMenu.classList.remove('hidden');
  dom.contextMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  dom.contextMenu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
}

function hideContextMenu() {
  dom.contextMenu.classList.add('hidden');
}

/* ---- Salesforce editor submenu ---- */
let _lastContextMenuPos = { x: 0, y: 0 };
// Track where user right-clicks in the editor
document.addEventListener('contextmenu', (e) => {
  _lastContextMenuPos = { x: e.clientX, y: e.clientY };
}, true);

function showSfEditorSubmenu(filePath) {
  const submenu = document.getElementById('sf-editor-submenu');
  if (!submenu) return;

  const ext = filePath.split('.').pop().toLowerCase();
  // Show/hide items based on file type
  submenu.querySelectorAll('[data-sf-action]').forEach(el => {
    const action = el.dataset.sfAction;
    if (action === 'sf-flow-viz' || action === 'sf-impact') {
      el.style.display = (ext === 'cls' || ext === 'trigger') ? '' : 'none';
    } else if (action === 'sf-api-view' || action === 'sf-test-runner') {
      el.style.display = ext === 'cls' ? '' : 'none';
    }
  });

  // Position at the last right-click location
  let x = _lastContextMenuPos.x;
  let y = _lastContextMenuPos.y;
  // Clamp to viewport
  if (x + 220 > window.innerWidth) x = window.innerWidth - 230;
  if (y + 220 > window.innerHeight) y = window.innerHeight - 230;

  submenu.style.left = x + 'px';
  submenu.style.top = y + 'px';
  submenu.classList.remove('hidden');
}

function hideSfEditorSubmenu() {
  document.getElementById('sf-editor-submenu')?.classList.add('hidden');
}

// Dismiss on outside click
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#sf-editor-submenu')) hideSfEditorSubmenu();
});

// Submenu click handler
document.getElementById('sf-editor-submenu')?.addEventListener('click', (e) => {
  const action = e.target.closest('[data-sf-action]')?.dataset.sfAction;
  if (!action) return;
  hideSfEditorSubmenu();
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab?.filePath && window.handleSfContextAction) {
    window.handleSfContextAction(action, tab.filePath);
  }
});

function initContextMenu() {
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.tree-item')) hideContextMenu();
  });

  dom.contextMenu.addEventListener('click', async (e) => {
    const action = e.target.closest('.ctx-item')?.dataset.action;
    if (!action) return;
    hideContextMenu();
    const tp = contextTarget.path;
    const parentDir = contextTarget.isDir ? tp : dirName(tp);

    switch (action) {
      case 'new-file': {
        const name = await showInputDialog('New File', 'New file name:');
        if (!name) return;
        const fp = `${parentDir}/${name}`;
        await window.apexStudio.writeFile(fp, '');
        await refreshTree();
        break;
      }
      case 'new-folder': {
        const name = await showInputDialog('New Folder', 'New folder name:');
        if (!name) return;
        await window.apexStudio.createDir(`${parentDir}/${name}`);
        await refreshTree();
        break;
      }
      case 'rename': {
        const oldName = tp.split(/[/\\]/).pop();
        const newName = await showInputDialog('Rename', 'Rename to:', oldName);
        if (!newName || newName === oldName) return;
        const newPath = dirName(tp) + '/' + newName;
        await window.apexStudio.rename(tp, newPath);
        await refreshTree();
        break;
      }
      case 'delete': {
        if (!(await showConfirmDialog('Delete', `Delete "${tp.split(/[/\\]/).pop()}"?`))) return;
        await window.apexStudio.deleteFile(tp);
        await refreshTree();
        break;
      }
      case 'copy-path': {
        await navigator.clipboard.writeText(tp);
        break;
      }
      case 'reveal-finder': {
        try { await window.apexStudio.revealInFinder(tp); } catch (err) { console.error('reveal error:', err); }
        break;
      }
      case 'file-history': {
        if (!contextTarget.isDir) {
          showFileHistoryInPanel(tp);
        }
        break;
      }
      case 'open-terminal': {
        try { await window.apexStudio.openInTerminal(parentDir); } catch (err) { console.error('open terminal error:', err); }
        break;
      }
      // Salesforce context actions
      case 'sf-flow-viz':
      case 'sf-impact':
      case 'sf-api-view':
      case 'sf-test-runner':
      case 'sf-deploy-file': {
        if (window.handleSfContextAction) window.handleSfContextAction(action, tp);
        break;
      }
    }
  });
}

async function refreshTree() {
  if (state.folderPath) await openFolder(state.folderPath);
}

/* ================================================================
   7b. TAB CONTEXT MENU
   ================================================================ */
let tabContextTargetId = null;

function showTabContextMenu(x, y, tabId) {
  tabContextTargetId = tabId;
  const menu = $('#tab-context-menu');
  const tab = state.tabs.find(t => t.id === tabId);

  // Hide path-related options for untitled tabs
  menu.querySelectorAll('[data-action="tab-rename"], [data-action="tab-copy-path"], [data-action="tab-reveal-finder"], [data-action="tab-open-terminal"], [data-action="tab-delete"], [data-action="tab-file-history"]').forEach(el => {
    el.style.display = tab?.filePath ? '' : 'none';
  });
  // Also hide separators for path actions / delete if no file
  const seps = menu.querySelectorAll('.ctx-separator:not(.sf-tab-ctx-sep)');
  seps.forEach((sep, i) => { if (i >= 1) sep.style.display = tab?.filePath ? '' : 'none'; });

  // Show/hide Salesforce items based on file extension
  const ext = tab?.filePath ? tab.filePath.split('.').pop().toLowerCase() : '';
  const isSfFile = ['cls', 'trigger', 'page', 'component', 'cmp', 'js', 'html', 'css', 'xml'].includes(ext);
  menu.querySelectorAll('.sf-tab-ctx-item, .sf-tab-ctx-sep').forEach(el => {
    el.style.display = (tab?.filePath && isSfFile) ? '' : 'none';
  });

  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
}

function hideTabContextMenu() {
  $('#tab-context-menu').classList.add('hidden');
}

function initTabContextMenu() {
  document.addEventListener('click', hideTabContextMenu);

  $('#tab-context-menu').addEventListener('click', async (e) => {
    const action = e.target.closest('.ctx-item')?.dataset.action;
    if (!action) return;
    hideTabContextMenu();

    const tab = state.tabs.find(t => t.id === tabContextTargetId);
    if (!tab) return;

    switch (action) {
      case 'tab-close':
        closeTab(tab.id);
        break;
      case 'tab-close-others':
        const others = state.tabs.filter(t => t.id !== tab.id).map(t => t.id);
        others.forEach(id => closeTab(id));
        break;
      case 'tab-close-all':
        const allIds = state.tabs.map(t => t.id);
        allIds.forEach(id => closeTab(id));
        break;
      case 'tab-rename': {
        if (tab.filePath) {
          startInlineTabRename(tab);
        }
        break;
      }
      case 'tab-copy-path':
        if (tab.filePath) await navigator.clipboard.writeText(tab.filePath);
        break;
      case 'tab-reveal-finder':
        if (tab.filePath) {
          try { await window.apexStudio.revealInFinder(tab.filePath); } catch (err) { console.error(err); }
        }
        break;
      case 'tab-file-history':
        if (tab.filePath) {
          showFileHistoryInPanel(tab.filePath);
        }
        break;
      case 'tab-open-terminal': {
        if (tab.filePath) {
          const dir = dirName(tab.filePath);
          try { await window.apexStudio.openInTerminal(dir); } catch (err) { console.error(err); }
        }
        break;
      }
      case 'tab-delete': {
        if (tab.filePath) {
          const confirmed = await showConfirmDialog('Delete File', `Are you sure you want to permanently delete "${tab.title}"? This action cannot be undone.`);
          if (!confirmed) break;
          try {
            const ok = await window.apexStudio.deleteFile(tab.filePath);
            if (ok) {
              closeTab(tab.id);
              if (state.folderPath) await refreshTree();
              showToast(`Deleted ${tab.title}`, 'success', 2000);
            } else {
              showToast('Delete failed', 'error', 3000);
            }
          } catch (err) {
            showToast(`Delete failed: ${err.message}`, 'error', 3000);
          }
        }
        break;
      }
      // Salesforce tab context actions
      case 'tab-sf-flow-viz':
      case 'tab-sf-impact':
      case 'tab-sf-deploy': {
        if (tab.filePath && window.handleSfContextAction) {
          window.handleSfContextAction(action, tab.filePath);
        }
        break;
      }
    }
  });
}

/* ================================================================
   8. SEARCH & REPLACE (In-File)
   ================================================================ */

/* ---- Inline Tab Rename ---- */
function startInlineTabRename(tab) {
  if (!tab || !tab.filePath) return;
  const tabEl = dom.tabsContainer.querySelector(`.tab[data-tab-id="${tab.id}"]`);
  if (!tabEl) return;

  const titleSpan = tabEl.querySelector('.tab-title');
  if (!titleSpan) return;

  const oldName = tab.title;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-rename-input';
  input.value = oldName;

  // Select the filename without extension
  const dotIdx = oldName.lastIndexOf('.');
  titleSpan.replaceWith(input);
  input.focus();
  if (dotIdx > 0) {
    input.setSelectionRange(0, dotIdx);
  } else {
    input.select();
  }

  let committed = false;

  async function commitRename() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      renderTabs();
      return;
    }
    const dir = dirName(tab.filePath);
    const newPath = dir + '/' + newName;
    try {
      const ok = await window.apexStudio.rename(tab.filePath, newPath);
      if (!ok) { showToast('Rename failed', 'error', 3000); renderTabs(); return; }
      tab.filePath = newPath;
      tab.title = newName;
      if (tab.model) {
        const content = tab.model.getValue();
        tab.model.dispose();
        const lang = guessLanguage(newName);
        const newUri = monaco.Uri.file(newPath);
        tab.model = monaco.editor.createModel(content, lang, newUri);
        if (state.activeTabId === tab.id && state.editor) {
          state.editor.setModel(tab.model);
        }
      }
      renderTabs();
      updateTitleBar(tab);
      updateBreadcrumbs();
      updateStatusLanguage(tab);
      if (state.folderPath) await refreshTree();
      showToast(`Renamed to ${newName}`, 'success', 2000);
      await window.apexStudio.addRecent(newPath);
    } catch (err) {
      showToast(`Rename failed: ${err.message}`, 'error', 3000);
      renderTabs();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    if (e.key === 'Escape') { e.preventDefault(); committed = true; renderTabs(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => commitRename());
  // Prevent click events from bubbling to tab click handler
  input.addEventListener('click', (e) => e.stopPropagation());
}

function showSearchBar(withReplace = false) {
  dom.searchBar.classList.remove('hidden');
  dom.replaceRow.classList.toggle('hidden', !withReplace);
  dom.searchInput.focus();
  const sel = state.editor?.getSelection();
  if (sel && !sel.isEmpty()) {
    const text = state.editor.getModel().getValueInRange(sel);
    if (text && !text.includes('\n')) dom.searchInput.value = text;
  }
  dom.searchInput.select();
  doSearch();
}

function hideSearchBar() {
  dom.searchBar.classList.add('hidden');
  clearSearchDecorations();
  state.editor?.focus();
}

function clearSearchDecorations() {
  if (state.editor) {
    try {
      // Always attempt to clear, regardless of array state
      state.searchDecorations = state.editor.deltaDecorations(state.searchDecorations, []);
    } catch {
      state.searchDecorations = [];
    }
  } else {
    state.searchDecorations = [];
  }
}

function doSearch() {
  clearSearchDecorations();
  const query = dom.searchInput.value;
  if (!query || !state.editor) { dom.searchCount.textContent = ''; return; }

  const model = state.editor.getModel();
  if (!model) return;

  const isCase = dom.searchCase.checked;
  const isRegex = dom.searchRegex.checked;
  const isWhole = dom.searchWhole.checked;

  const matches = model.findMatches(query, true, isRegex, isCase, isWhole ? 'true' : null, false);
  if (matches.length === 0) { dom.searchCount.textContent = 'No results'; return; }

  const decorations = matches.map((m) => ({
    range: m.range,
    options: {
      className: 'findMatch',
      overviewRuler: { color: '#f9e2af', position: monaco.editor.OverviewRulerLane.Full },
    },
  }));

  state.searchDecorations = state.editor.deltaDecorations([], decorations);
  dom.searchCount.textContent = `${matches.length} results`;

  // Navigate to first match
  const pos = state.editor.getPosition();
  const after = matches.find((m) => m.range.startLineNumber >= pos.lineNumber);
  const target = after || matches[0];
  state.editor.revealRangeInCenter(target.range);
  state.editor.setSelection(target.range);
}

function searchNav(dir) {
  if (!state.editor || state.searchDecorations.length === 0) return;
  const model = state.editor.getModel();
  const query = dom.searchInput.value;
  if (!query) return;

  const isCase = dom.searchCase.checked;
  const isRegex = dom.searchRegex.checked;
  const isWhole = dom.searchWhole.checked;
  const matches = model.findMatches(query, true, isRegex, isCase, isWhole ? 'true' : null, false);
  if (matches.length === 0) return;

  const pos = state.editor.getPosition();
  let idx;
  if (dir === 'next') {
    idx = matches.findIndex((m) => m.range.startLineNumber > pos.lineNumber ||
      (m.range.startLineNumber === pos.lineNumber && m.range.startColumn > pos.column));
    if (idx === -1) idx = 0;
  } else {
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].range.startLineNumber < pos.lineNumber ||
        (matches[i].range.startLineNumber === pos.lineNumber && matches[i].range.startColumn < pos.column)) {
        idx = i; break;
      }
    }
    if (idx == null) idx = matches.length - 1;
  }
  const target = matches[idx];
  state.editor.revealRangeInCenter(target.range);
  state.editor.setSelection(target.range);
}

function replaceOne() {
  if (!state.editor) return;
  const sel = state.editor.getSelection();
  if (sel && !sel.isEmpty()) {
    state.editor.executeEdits('replace', [{ range: sel, text: dom.replaceInput.value }]);
  }
  doSearch();
}

function replaceAll() {
  if (!state.editor) return;
  const model = state.editor.getModel();
  const query = dom.searchInput.value;
  if (!query) return;
  const isCase = dom.searchCase.checked;
  const isRegex = dom.searchRegex.checked;
  const isWhole = dom.searchWhole.checked;
  const matches = model.findMatches(query, true, isRegex, isCase, isWhole ? 'true' : null, false);
  const edits = matches.map((m) => ({ range: m.range, text: dom.replaceInput.value }));
  state.editor.executeEdits('replaceAll', edits);
  clearSearchDecorations();
  dom.searchCount.textContent = `${edits.length} replaced`;
}

function initSearch() {
  dom.searchInput.addEventListener('input', debounce(doSearch, 150));
  dom.searchCase.addEventListener('change', doSearch);
  dom.searchRegex.addEventListener('change', doSearch);
  dom.searchWhole.addEventListener('change', doSearch);
  $('#btn-search-next').addEventListener('click', () => searchNav('next'));
  $('#btn-search-prev').addEventListener('click', () => searchNav('prev'));
  dom.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchNav(e.shiftKey ? 'prev' : 'next'); }
    if (e.key === 'Escape') hideSearchBar();
  });
  $('#btn-search-close').addEventListener('click', hideSearchBar);
  $('#btn-replace-one').addEventListener('click', replaceOne);
  $('#btn-replace-all').addEventListener('click', replaceAll);
}

/* ================================================================
   9. GO TO LINE
   ================================================================ */
function showGotoBar() {
  dom.gotoBar.classList.remove('hidden');
  dom.gotoInput.value = '';
  dom.gotoInput.focus();
}

function hideGotoBar() {
  dom.gotoBar.classList.add('hidden');
  state.editor?.focus();
}

function initGoto() {
  dom.gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { doGoto(); e.preventDefault(); }
    if (e.key === 'Escape') hideGotoBar();
  });
  $('#btn-goto-go').addEventListener('click', doGoto);
  $('#btn-goto-close').addEventListener('click', hideGotoBar);
}

function doGoto() {
  const line = parseInt(dom.gotoInput.value, 10);
  if (isNaN(line) || !state.editor) return;
  state.editor.revealLineInCenter(line);
  state.editor.setPosition({ lineNumber: line, column: 1 });
  hideGotoBar();
}

/* ================================================================
   10. QUICK OPEN (Cmd+P)
   ================================================================ */
let quickOpenFiles = [];
let quickOpenSelectedIndex = -1;

function showQuickOpen() {
  dom.quickOpenOverlay.classList.remove('hidden');
  dom.quickOpenInput.value = '';
  dom.quickOpenInput.focus();
  dom.quickOpenResults.innerHTML = '';
  quickOpenSelectedIndex = -1;
  loadQuickOpenFiles().then(async () => {
    // Show recent files by default when opening
    const recentPaths = await getRecentFilePaths();
    if (recentPaths.length > 0) {
      renderQuickOpenResults(recentPaths);
    } else {
      renderQuickOpenResults(quickOpenFiles.slice(0, 50));
    }
  });
}

async function getRecentFilePaths() {
  // Gather recently opened files scoped to the CURRENT project/repo: open tabs
  // first (most relevant), then the persistent recent-files store. The store holds
  // plain path strings (and some folder paths), so we intersect with the project's
  // file list to keep only real files that belong to the open folder.
  const seen = new Set();
  const result = [];
  const inProject = state.folderPath && quickOpenFiles.length ? new Set(quickOpenFiles) : null;
  const belongs = (fp) => !inProject || inProject.has(fp) || fp.startsWith(state.folderPath + '/');
  for (const t of state.tabs) {
    if (t.filePath && !seen.has(t.filePath) && belongs(t.filePath)) {
      seen.add(t.filePath);
      result.push(t.filePath);
    }
  }
  try {
    const recents = await window.apexStudio.getRecent();
    for (const entry of (recents || [])) {
      const fp = typeof entry === 'string' ? entry : (entry && entry.path);
      if (!fp || seen.has(fp)) continue;
      if (!belongs(fp)) continue;                 // scope to the current project/repo
      if (inProject && !inProject.has(fp)) continue; // and only real files in the project
      seen.add(fp);
      result.push(fp);
    }
  } catch (_) { /* store unavailable — fall back to tabs only */ }
  return result.slice(0, 50);
}

function hideQuickOpen() {
  dom.quickOpenOverlay.classList.add('hidden');
  quickOpenSelectedIndex = -1;
}

async function loadQuickOpenFiles() {
  if (state.folderPath) {
    try {
      quickOpenFiles = await window.apexStudio.getAllFiles(state.folderPath);
    } catch {
      quickOpenFiles = [];
    }
  } else {
    quickOpenFiles = state.tabs.filter((t) => t.filePath).map((t) => t.filePath);
  }
}

function filterQuickOpen(query) {
  if (!query) return quickOpenFiles.slice(0, 50);
  const q = query.toLowerCase();
  return quickOpenFiles
    .filter((fp) => fp.toLowerCase().includes(q))
    .slice(0, 50);
}

function renderQuickOpenResults(files) {
  dom.quickOpenResults.innerHTML = '';
  quickOpenSelectedIndex = files.length > 0 ? 0 : -1;
  for (let i = 0; i < files.length; i++) {
    const fp = files[i];
    const item = document.createElement('div');
    item.className = 'qo-item' + (i === 0 ? ' selected' : '');
    const name = fp.split(/[/\\]/).pop();
    const relPath = state.folderPath ? fp.replace(state.folderPath + '/', '') : fp;
    item.innerHTML = `<span class="qo-icon">${getFileIcon(name)}</span><span>${escHtml(name)}</span><span class="path">${escHtml(relPath)}</span>`;
    item.addEventListener('click', async () => {
      hideQuickOpen();
      try {
        const content = await window.apexStudio.readFile(fp);
        await openFile(fp, content);
      } catch (err) { console.error('quick open error:', err); }
    });
    item.addEventListener('mouseenter', () => {
      quickOpenUpdateSelected(i, false);
    });
    dom.quickOpenResults.appendChild(item);
  }
}

function quickOpenUpdateSelected(idx, scroll = true) {
  const items = dom.quickOpenResults.querySelectorAll('.qo-item');
  if (items.length === 0) return;
  items.forEach((el) => el.classList.remove('selected'));
  quickOpenSelectedIndex = Math.max(0, Math.min(idx, items.length - 1));
  items[quickOpenSelectedIndex].classList.add('selected');
  // Hover must not scroll (it would shift the list under the cursor → jitter loop).
  if (scroll) items[quickOpenSelectedIndex].scrollIntoView({ block: 'nearest' });
}

function initQuickOpen() {
  dom.quickOpenInput.addEventListener('input', () => {
    const results = filterQuickOpen(dom.quickOpenInput.value);
    renderQuickOpenResults(results);
  });
  dom.quickOpenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideQuickOpen(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const items = dom.quickOpenResults.querySelectorAll('.qo-item');
      if (items.length > 0) quickOpenUpdateSelected(quickOpenSelectedIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const items = dom.quickOpenResults.querySelectorAll('.qo-item');
      if (items.length > 0) quickOpenUpdateSelected(quickOpenSelectedIndex - 1);
      return;
    }
    if (e.key === 'Enter') {
      const items = dom.quickOpenResults.querySelectorAll('.qo-item');
      const target = quickOpenSelectedIndex >= 0 && items[quickOpenSelectedIndex]
        ? items[quickOpenSelectedIndex]
        : items[0];
      if (target) target.click();
    }
  });
  dom.quickOpenOverlay.addEventListener('click', (e) => {
    if (e.target === dom.quickOpenOverlay) hideQuickOpen();
  });
}

/* ================================================================
   11. COMMAND PALETTE (Cmd+Shift+P)
   ================================================================ */

const COMMANDS = [
  { id: 'new-tab',        label: 'New Tab',            shortcut: '⌘N',    action: () => createTab() },
  { id: 'new-window',     label: 'New Window',         shortcut: '⇧⌘N',   action: () => window.apexStudio.newWindow() },
  { id: 'open-file',      label: 'Open File',          shortcut: '⌘O',    action: openFileDialog },
  { id: 'open-folder',    label: 'Open Folder',        shortcut: '⇧⌘O',   action: openFolderDialog },
  { id: 'save',           label: 'Save',               shortcut: '⌘S',    action: () => { const t = state.tabs.find((t) => t.id === state.activeTabId); if (t) saveFile(t); } },
  { id: 'save-as',        label: 'Save As...',         shortcut: '⇧⌘S',   action: saveAsFile },
  { id: 'close-tab',      label: 'Close Tab',          shortcut: '⌘W',    action: () => closeTab(state.activeTabId) },
  { id: 'close-others',   label: 'Close Other Tabs',   shortcut: '',      action: closeOtherTabs },
  { id: 'close-all',      label: 'Close All Tabs',     shortcut: '',      action: closeAllTabs },
  { id: 'reopen-tab',     label: 'Reopen Closed Tab',  shortcut: '⇧⌘T',   action: reopenClosedTab },
  { id: 'find',           label: 'Find',               shortcut: '⌘F',    action: () => showSearchBar(false) },
  { id: 'replace',        label: 'Find and Replace',   shortcut: '⌘H',    action: () => showSearchBar(true) },
  { id: 'find-in-files',  label: 'Find in Files',      shortcut: '⇧⌘F',   action: showGlobalSearch },
  { id: 'goto-line',      label: 'Go to Line',         shortcut: '⌘G',    action: showGotoBar },
  { id: 'quick-open',     label: 'Quick Open',         shortcut: '⌘P',    action: showQuickOpen },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar',     shortcut: '⌘B',    action: toggleSidebar },
  { id: 'toggle-wrap',    label: 'Toggle Word Wrap',   shortcut: '⌥Z',    action: () => toggleWordWrap() },
  { id: 'change-theme',   label: 'Change Theme',       shortcut: '',      action: showThemePicker },
  { id: 'toggle-minimap', label: 'Toggle Minimap',     shortcut: '',      action: toggleMinimap },
  { id: 'increase-font',  label: 'Increase Font Size', shortcut: '⌘+',    action: () => changeFontSize(1) },
  { id: 'decrease-font',  label: 'Decrease Font Size', shortcut: '⌘-',    action: () => changeFontSize(-1) },
  { id: 'reset-font',     label: 'Reset Font Size',    shortcut: '⌘0',    action: () => { if (state.editor) state.editor.updateOptions({ fontSize: 14 }); } },
  { id: 'format-doc',     label: 'Format Document',    shortcut: '⇧⌥F',   action: () => state.editor?.getAction('editor.action.formatDocument')?.run() },
  { id: 'delete-line',    label: 'Delete Line',        shortcut: '⇧⌘K',   action: () => state.editor?.getAction('editor.action.deleteLines')?.run() },
  { id: 'select-line',    label: 'Select Line',        shortcut: '⌘L',    action: () => state.editor?.getAction('editor.action.selectLine')?.run() },
  { id: 'add-cursor',     label: 'Add Next Occurrence', shortcut: '⌘D',   action: () => state.editor?.getAction('editor.action.addSelectionToNextFindMatch')?.run() },
  { id: 'select-all-occ', label: 'Select All Occurrences', shortcut: '⇧⌘L', action: () => state.editor?.getAction('editor.action.selectHighlights')?.run() },
  { id: 'toggle-comment', label: 'Toggle Comment',     shortcut: '⌘/',    action: () => state.editor?.getAction('editor.action.commentLine')?.run() },
  { id: 'block-comment',  label: 'Toggle Block Comment', shortcut: '⇧⌘A', action: () => state.editor?.getAction('editor.action.blockComment')?.run() },
  { id: 'move-line-up',   label: 'Move Line Up',       shortcut: '⌥↑',    action: () => state.editor?.getAction('editor.action.moveLinesUpAction')?.run() },
  { id: 'move-line-down', label: 'Move Line Down',     shortcut: '⌥↓',    action: () => state.editor?.getAction('editor.action.moveLinesDownAction')?.run() },
  { id: 'copy-line-up',   label: 'Copy Line Up',       shortcut: '⇧⌥↑',   action: () => state.editor?.getAction('editor.action.copyLinesUpAction')?.run() },
  { id: 'copy-line-down', label: 'Duplicate Line Down', shortcut: '⇧⌥↓',  action: () => state.editor?.getAction('editor.action.copyLinesDownAction')?.run() },
  { id: 'indent',         label: 'Indent Line',        shortcut: '⌘]',    action: () => state.editor?.getAction('editor.action.indentLines')?.run() },
  { id: 'outdent',        label: 'Outdent Line',       shortcut: '⌘[',    action: () => state.editor?.getAction('editor.action.outdentLines')?.run() },
  { id: 'jump-bracket',   label: 'Jump to Bracket',    shortcut: '⇧⌘\\',  action: () => state.editor?.getAction('editor.action.jumpToBracket')?.run() },
  { id: 'cursor-undo',    label: 'Undo Cursor',        shortcut: '⌘U',    action: () => state.editor?.getAction('cursorUndo')?.run() },
  { id: 'zen-mode',       label: 'Toggle Zen Mode',    shortcut: '⌘K Z',  action: toggleZenMode },
  { id: 'split-editor',   label: 'Split Editor',       shortcut: '⌘\\',   action: toggleSplitEditor },
  { id: 'md-preview',     label: 'Markdown Preview',   shortcut: '⇧⌘V',   action: toggleMarkdownPreview },
  { id: 'settings',       label: 'Open Settings',      shortcut: '⌘,',    action: openSettingsTab },
  { id: 'outline',        label: 'Toggle Outline',     shortcut: '',      action: toggleOutlineSection },
  { id: 'terminal',       label: 'Toggle Terminal',    shortcut: '⌃`',    action: toggleTerminal },
  { id: 'change-lang',    label: 'Change Language Mode', shortcut: '',    action: showLanguagePicker },
  { id: 'git-blame',      label: 'Toggle Git Blame',   shortcut: '',      action: toggleGitBlame },
  { id: 'show-diff',      label: 'Show Git Diff',      shortcut: '',      action: showDiffForCurrentFile },
  { id: 'trim-ws',        label: 'Trim Trailing Whitespace', shortcut: '', action: trimTrailingWhitespaceNow },
  { id: 'git-info',       label: 'Show Git Info',  shortcut: '',      action: toggleGitInfoPopup },
  { id: 'richtext-mode',  label: 'Toggle Rich Text Mode', shortcut: '', action: toggleRichTextMode },
  { id: 'save-as-type',   label: 'Save As (Change File Type)...', shortcut: '⇧⌘S', action: saveAsFile },
  { id: 'recent-files',   label: 'Show Recent Files',  shortcut: '',      action: showRecentPanel },
  { id: 'reload-window',  label: 'Reload Window',     shortcut: '⇧⌘R',      action: () => location.reload() },
  { id: 'system-search',  label: 'Spotlight Search',  shortcut: '⇧⌘Space',  action: focusSystemSearch },
  { id: 'api-client',     label: 'API Client',        shortcut: '⌃⇧A',      action: () => toggleToolPanel('api-client-panel') },
  { id: 'regex-tester',    label: 'Regex Tester',       shortcut: '⌃⇧R',      action: () => toggleToolPanel('regex-panel') },
  { id: 'json-viewer',     label: 'JSON / Data Viewer', shortcut: '⌃⇧J',      action: () => openJsonViewer() },
  { id: 'bookmarks',       label: 'Toggle Bookmarks',   shortcut: '⌃⇧B',      action: () => toggleToolPanel('bookmarks-panel') },
  { id: 'screenshot',      label: 'Code Screenshot',    shortcut: '⌃⇧S',      action: () => openScreenshotPanel() },
  { id: 'db-client',       label: 'Database Client',    shortcut: '⌃⇧D',      action: () => toggleToolPanel('db-panel') },
  { id: 'snippets',         label: 'Snippet Manager',    shortcut: '⌃⇧E',      action: () => toggleToolPanel('snippet-panel') },
  { id: 'color-picker',     label: 'Color Picker',       shortcut: '⌃⇧K',      action: () => toggleToolPanel('color-panel') },
  { id: 'todo-tracker',     label: 'TODO Tracker',       shortcut: '⌃⇧G',      action: () => toggleToolPanel('todo-panel') },
  { id: 'pomodoro',         label: 'Pomodoro Timer',     shortcut: '⌃⇧Y',      action: () => toggleToolPanel('pomo-panel') },
  { id: 'diff-checker',      label: 'Diff Checker',       shortcut: '⌃⇧I',      action: () => toggleToolPanel('diff-panel') },
  { id: 'salesforce',        label: 'Salesforce Panel',   shortcut: '⌃⇧F',      action: () => toggleToolPanel('salesforce-panel') },
  { id: 'debug-start',        label: 'Debug: Start with Request', shortcut: 'F5', action: () => { if (window.debugState?.active) window.debugContinue?.(); } },
  { id: 'debug-stop',          label: 'Debug: Stop',              shortcut: '⇧F5', action: () => window.debugStop?.() },
  { id: 'debug-step-over',     label: 'Debug: Step Over',         shortcut: 'F10', action: () => window.debugStepOver?.() },
  { id: 'debug-step-into',     label: 'Debug: Step Into',         shortcut: 'F11', action: () => window.debugStepInto?.() },
  { id: 'debug-step-out',      label: 'Debug: Step Out',          shortcut: '⇧F11', action: () => window.debugStepOut?.() },
  { id: 'debug-step-back',     label: 'Debug: Step Back (replay)', shortcut: '⇧F10', action: () => window.debugStepBack?.() },
  { id: 'debug-toggle-bp',     label: 'Debug: Toggle Breakpoint', shortcut: 'F9', action: () => {
    const editor = state.editor;
    if (!editor) return;
    const pos = editor.getPosition();
    const model = editor.getModel();
    if (!pos || !model) return;
    const filePath = model.uri.fsPath || model.uri.path;
    if (filePath.endsWith('.cls') || filePath.endsWith('.trigger')) {
      window.debugState && window.debugState.breakpoints && (typeof toggleBreakpoint === 'function' ? toggleBreakpoint(filePath, pos.lineNumber) : null);
    }
  }},
];

function showCommandPalette() {
  dom.cmdPaletteOverlay.classList.remove('hidden');
  dom.cmdPaletteInput.value = '';
  dom.cmdPaletteInput.focus();
  renderCommandResults(COMMANDS);
}

function hideCommandPalette() {
  dom.cmdPaletteOverlay.classList.add('hidden');
}

let cmdPaletteSelectedIndex = -1;

function renderCommandResults(commands) {
  dom.cmdPaletteResults.innerHTML = '';
  cmdPaletteSelectedIndex = commands.length > 0 ? 0 : -1;
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const item = document.createElement('div');
    item.className = 'cp-item' + (i === 0 ? ' selected' : '');
    item.innerHTML = `<span>${escHtml(cmd.label)}</span><span class="shortcut">${cmd.shortcut}</span>`;
    item.addEventListener('click', () => { hideCommandPalette(); cmd.action(); });
    item.addEventListener('mouseenter', () => cmdPaletteUpdateSelected(i, false));
    dom.cmdPaletteResults.appendChild(item);
  }
}

function cmdPaletteUpdateSelected(idx, scroll = true) {
  const items = dom.cmdPaletteResults.querySelectorAll('.cp-item');
  if (items.length === 0) return;
  items.forEach(el => el.classList.remove('selected'));
  cmdPaletteSelectedIndex = Math.max(0, Math.min(idx, items.length - 1));
  items[cmdPaletteSelectedIndex].classList.add('selected');
  if (scroll) items[cmdPaletteSelectedIndex].scrollIntoView({ block: 'nearest' });
}

function initCommandPalette() {
  dom.cmdPaletteInput.addEventListener('input', () => {
    const q = dom.cmdPaletteInput.value.toLowerCase().replace(/^>\s*/, '');
    const filtered = q ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q)) : COMMANDS;
    renderCommandResults(filtered);
  });
  dom.cmdPaletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideCommandPalette(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdPaletteUpdateSelected(cmdPaletteSelectedIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdPaletteUpdateSelected(cmdPaletteSelectedIndex - 1);
      return;
    }
    if (e.key === 'Enter') {
      const items = dom.cmdPaletteResults.querySelectorAll('.cp-item');
      const target = cmdPaletteSelectedIndex >= 0 && items[cmdPaletteSelectedIndex]
        ? items[cmdPaletteSelectedIndex]
        : items[0];
      if (target) target.click();
    }
  });
  dom.cmdPaletteOverlay.addEventListener('click', (e) => {
    if (e.target === dom.cmdPaletteOverlay) hideCommandPalette();
  });
}

/* ================================================================
   12. GLOBAL SEARCH (Cmd+Shift+F) - Top overlay
   ================================================================ */

function showGlobalSearch() {
  if (!dom.globalSearchOverlay.classList.contains('hidden')) {
    // Already open — just focus input
    dom.globalSearchInput.focus();
    dom.globalSearchInput.select();
    return;
  }
  dom.globalSearchOverlay.classList.remove('hidden');
  // Preserve previous search query & results — only show placeholder if empty
  if (!dom.globalSearchInput.value.trim()) {
    dom.globalSearchStatus.textContent = state.folderPath ? 'Type to search across files…' : 'Open a folder first to search across files';
  }
  dom.globalSearchInput.focus();
  dom.globalSearchInput.select();
}

function hideGlobalSearch() {
  dom.globalSearchOverlay.classList.add('hidden');
  // Cancel any pending search
  if (state.globalSearchAbort) {
    state.globalSearchAbort.abort();
    state.globalSearchAbort = null;
  }
}

async function doGlobalSearch() {
  const query = dom.globalSearchInput.value.trim();
  if (!query || !state.folderPath) {
    dom.globalSearchResults.innerHTML = '';
    dom.globalSearchStatus.textContent = query ? 'Open a folder first' : '';
    return;
  }

  dom.globalSearchStatus.textContent = 'Searching…';
  dom.globalSearchResults.innerHTML = '';

  // Cancel previous search
  if (state.globalSearchAbort) state.globalSearchAbort.abort();
  const controller = new AbortController();
  state.globalSearchAbort = controller;

  try {
    const caseSensitive = dom.globalSearchCase.checked;
    const isRegex = dom.globalSearchRegex.checked;
    const results = await window.apexStudio.searchInFiles(state.folderPath, query, { caseSensitive, isRegex });

    // Check if this search was aborted
    if (controller.signal.aborted) return;

    if (!results || results.length === 0) {
      dom.globalSearchStatus.textContent = 'No results found';
      return;
    }

    let totalMatches = 0;
    for (const file of results) {
      totalMatches += file.matches.length;
      const group = document.createElement('div');
      group.className = 'gs-file-group';

      const relPath = file.filePath.replace(state.folderPath + '/', '');
      const header = document.createElement('div');
      header.className = 'gs-file-header';
      header.innerHTML = `<span class="gs-file-icon">${getFileIcon(relPath.split(/[/\\]/).pop())}</span><span>${escHtml(relPath)}</span><span class="gs-file-count">${file.matches.length} matches</span>`;

      const matchesEl = document.createElement('div');
      let matchesVisible = true;
      header.addEventListener('click', () => {
        matchesVisible = !matchesVisible;
        matchesEl.style.display = matchesVisible ? '' : 'none';
      });

      for (const match of file.matches) {
        const matchEl = document.createElement('div');
        matchEl.className = 'gs-match';
        const lineText = escHtml(match.text || match.line || '');
        // Highlight the match within the line
        const highlighted = highlightMatch(lineText, escHtml(query), caseSensitive);
        matchEl.innerHTML = `<span class="gs-line-num">${match.line || match.lineNumber}</span><span class="gs-match-text">${highlighted}</span>`;
        matchEl.addEventListener('click', async () => {
          // Hide overlay so user can see the file, results stay for when they come back
          dom.globalSearchOverlay.classList.add('hidden');
          try {
            const content = await window.apexStudio.readFile(file.filePath);
            await openFile(file.filePath, content);
            // Jump to the line
            const ln = match.line || match.lineNumber;
            setTimeout(() => {
              if (state.editor) {
                state.editor.revealLineInCenter(ln);
                state.editor.setPosition({ lineNumber: ln, column: 1 });
                state.editor.focus();
              }
            }, 100);
          } catch (err) { console.error('global search open error:', err); }
        });
        matchesEl.appendChild(matchEl);
      }

      group.appendChild(header);
      group.appendChild(matchesEl);
      dom.globalSearchResults.appendChild(group);
    }
    dom.globalSearchStatus.textContent = `${totalMatches} results in ${results.length} files`;
  } catch (err) {
    if (!controller.signal.aborted) {
      dom.globalSearchStatus.textContent = 'Search error';
      console.error('Global search error:', err);
    }
  }
}

function highlightMatch(text, queryHtml, caseSensitive) {
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    const escaped = queryHtml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(escaped, flags), '<span class="gs-highlight">$&</span>');
  } catch {
    return text;
  }
}

function initGlobalSearch() {
  let searchTimer = null;

  function scheduleSearch() {
    // Immediately cancel any in-flight search
    if (state.globalSearchAbort) {
      state.globalSearchAbort.abort();
      state.globalSearchAbort = null;
    }
    // Clear any pending debounce timer
    clearTimeout(searchTimer);
    const query = dom.globalSearchInput.value.trim();
    if (!query) {
      dom.globalSearchResults.innerHTML = '';
      dom.globalSearchStatus.textContent = state.folderPath ? 'Type to search across files…' : 'Open a folder first to search across files';
      return;
    }
    dom.globalSearchStatus.textContent = 'Waiting…';
    // Wait for user to stop typing, then search
    searchTimer = setTimeout(() => doGlobalSearch(), 300);
  }

  let gsSelectedIndex = -1;

  function gsUpdateSelected(idx) {
    const matches = dom.globalSearchResults.querySelectorAll('.gs-match');
    if (matches.length === 0) return;
    matches.forEach(el => el.classList.remove('gs-selected'));
    gsSelectedIndex = Math.max(0, Math.min(idx, matches.length - 1));
    matches[gsSelectedIndex].classList.add('gs-selected');
    matches[gsSelectedIndex].scrollIntoView({ block: 'nearest' });
  }

  dom.globalSearchInput.addEventListener('input', scheduleSearch);
  dom.globalSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideGlobalSearch(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      gsUpdateSelected(gsSelectedIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      gsUpdateSelected(gsSelectedIndex - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const matches = dom.globalSearchResults.querySelectorAll('.gs-match');
      const target = gsSelectedIndex >= 0 && matches[gsSelectedIndex]
        ? matches[gsSelectedIndex]
        : matches[0];
      if (target) target.click();
    }
  });
  dom.globalSearchCase.addEventListener('change', scheduleSearch);
  dom.globalSearchRegex.addEventListener('change', scheduleSearch);
  $('#btn-close-global-search').addEventListener('click', hideGlobalSearch);
  dom.globalSearchOverlay.addEventListener('click', (e) => {
    if (e.target === dom.globalSearchOverlay) hideGlobalSearch();
  });
}

/* ================================================================
   13. THEME PICKER
   ================================================================ */

function showThemePicker() {
  dom.themePickerOverlay.classList.remove('hidden');
  dom.themePickerInput.value = '';
  dom.themePickerInput.focus();
  renderThemeList(THEMES);
}

function hideThemePicker() {
  dom.themePickerOverlay.classList.add('hidden');
}

let themePickerSelectedIndex = -1;
let themePickerCurrentThemes = [];

function renderThemeList(themes) {
  dom.themePickerResults.innerHTML = '';
  themePickerCurrentThemes = themes;
  // Default selection: find the current theme, or first item
  const currentIdx = themes.findIndex(t => t.id === state.theme);
  themePickerSelectedIndex = currentIdx >= 0 ? currentIdx : (themes.length > 0 ? 0 : -1);
  for (let i = 0; i < themes.length; i++) {
    const t = themes[i];
    const item = document.createElement('div');
    item.className = 'cp-item' + (i === themePickerSelectedIndex ? ' selected' : '');
    item.innerHTML = `<span>${t.id === state.theme ? '✓ ' : ''}${escHtml(t.label)}</span>`;
    item.addEventListener('click', () => {
      applyTheme(t.id);
      hideThemePicker();
    });
    item.addEventListener('mouseenter', () => {
      themePickerUpdateSelected(i, false);
      // Live preview on hover
      applyTheme(themes[i].id);
    });
    dom.themePickerResults.appendChild(item);
  }
}

// One-time upgrade of the legacy default theme ('dark') to the new GitHub Dark
// default. `ghdMigrationPending` (captured once at boot in restoreSession) is true
// only on the first launch after this update, so it never overrides a theme the
// user explicitly selects afterward.
let ghdMigrationPending = false;
function migrateLegacyTheme(themeId) {
  if (ghdMigrationPending && (!themeId || themeId === 'dark')) themeId = 'github-dark';
  return themeId === 'conga' ? 'apex' : themeId;
}

function applyTheme(themeId) {
  // Legacy rebrand migration: the old "conga" theme id is now "apex".
  if (themeId === 'conga') themeId = 'apex';
  state.theme = themeId;
  document.documentElement.setAttribute('data-theme', themeId);
  // Persist theme to localStorage for instant load on next startup
  try { localStorage.setItem('apexstudio-theme', themeId); } catch(e) {}
  if (state.editor) {
    monaco.editor.setTheme(monacoThemeId(themeId));
  }
  dom.statusTheme.textContent = `Theme: ${THEMES.find((t) => t.id === themeId)?.label || themeId}`;
  saveSessionDebounced();
}

function themePickerUpdateSelected(idx, scroll = true) {
  const items = dom.themePickerResults.querySelectorAll('.cp-item');
  if (items.length === 0) return;
  items.forEach(el => el.classList.remove('selected'));
  themePickerSelectedIndex = Math.max(0, Math.min(idx, items.length - 1));
  items[themePickerSelectedIndex].classList.add('selected');
  if (scroll) items[themePickerSelectedIndex].scrollIntoView({ block: 'nearest' });
}

function initThemePicker() {
  let originalTheme = state.theme; // Remember theme when opening picker

  const origShow = showThemePicker;
  // Wrap showThemePicker to remember original theme
  const _openPicker = () => {
    originalTheme = state.theme;
    origShow();
  };

  dom.themePickerInput.addEventListener('input', () => {
    const q = dom.themePickerInput.value.toLowerCase();
    const filtered = q ? THEMES.filter((t) => t.label.toLowerCase().includes(q)) : THEMES;
    renderThemeList(filtered);
  });
  dom.themePickerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Revert to original theme on cancel
      applyTheme(originalTheme);
      hideThemePicker();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      themePickerUpdateSelected(themePickerSelectedIndex + 1);
      // Live preview
      if (themePickerCurrentThemes[themePickerSelectedIndex]) {
        applyTheme(themePickerCurrentThemes[themePickerSelectedIndex].id);
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      themePickerUpdateSelected(themePickerSelectedIndex - 1);
      // Live preview
      if (themePickerCurrentThemes[themePickerSelectedIndex]) {
        applyTheme(themePickerCurrentThemes[themePickerSelectedIndex].id);
      }
      return;
    }
    if (e.key === 'Enter') {
      const items = dom.themePickerResults.querySelectorAll('.cp-item');
      const target = themePickerSelectedIndex >= 0 && items[themePickerSelectedIndex]
        ? items[themePickerSelectedIndex]
        : items[0];
      if (target) target.click();
    }
  });
  dom.themePickerOverlay.addEventListener('click', (e) => {
    if (e.target === dom.themePickerOverlay) {
      applyTheme(originalTheme);
      hideThemePicker();
    }
  });
  dom.statusTheme.addEventListener('click', () => {
    originalTheme = state.theme;
    showThemePicker();
  });
}

/* ================================================================
   14. SIDEBAR CONTROLS
   ================================================================ */

function toggleSidebar() {
  state.sidebarVisible = !state.sidebarVisible;
  applySidebarState();
  saveSessionDebounced();
}

function applySidebarState() {
  const toggleBtn = $('#btn-toggle-sidebar');
  if (!state.sidebarVisible) {
    // Save current width before collapsing
    const currentWidth = dom.sidebar.getBoundingClientRect().width;
    if (currentWidth > 0) state.sidebarWidth = currentWidth;
    // Clear any inline width set by the resizer so CSS can take effect
    dom.sidebar.style.width = '';
    dom.sidebar.classList.add('sidebar-collapsed');
    dom.sidebarResizer.classList.add('resizer-hidden');
    if (toggleBtn) toggleBtn.classList.add('sidebar-hidden');
  } else {
    dom.sidebar.classList.remove('sidebar-collapsed');
    dom.sidebarResizer.classList.remove('resizer-hidden');
    if (toggleBtn) toggleBtn.classList.remove('sidebar-hidden');
    // Restore previous width
    dom.sidebar.style.width = state.sidebarWidth + 'px';
  }
}

function toggleRecentSection() {
  state.recentSectionOpen = !state.recentSectionOpen;
  dom.recentToggleIcon.textContent = state.recentSectionOpen ? '▼' : '▶';
  dom.recentList.classList.toggle('collapsed', !state.recentSectionOpen);
}

/* ================================================================
   15. RECENT FILES
   ================================================================ */

async function loadRecentFiles() {
  try {
    const recentFiles = await window.apexStudio.getRecent();
    renderRecentList(recentFiles || []);
    renderWelcomeRecent(recentFiles || []);
  } catch {
    renderRecentList([]);
    renderWelcomeRecent([]);
  }
}

function renderRecentList(files) {
  dom.recentList.innerHTML = '';
  if (files.length === 0) {
    dom.recentList.innerHTML = '<div style="padding:8px 12px;color:var(--text-muted);font-size:12px;">No recent files</div>';
    return;
  }
  const grouped = groupRecentFiles(files);
  let count = 0;
  for (const entry of grouped) {
    if (count >= 20) break;
    if (entry.type === 'folder-group') {
      // Show folder group
      const item = document.createElement('div');
      item.className = 'recent-item recent-item-folder';
      item.innerHTML = `<span class="recent-item-name">📁 ${escHtml(entry.name)}</span><span class="recent-item-path">${escHtml(entry.shortDir)}</span>`;
      item.addEventListener('click', async () => {
        try { await openFolder(entry.dir); } catch (err) { console.error('open recent error:', err); }
      });
      dom.recentList.appendChild(item);
      count++;
    } else if (entry.type === 'directory') {
      const item = document.createElement('div');
      item.className = 'recent-item recent-item-folder';
      item.innerHTML = `<span class="recent-item-name">📁 ${escHtml(entry.name)}</span><span class="recent-item-path">${escHtml(entry.shortDir)}</span>`;
      item.addEventListener('click', async () => {
        try { await openFolder(entry.path); } catch (err) { console.error('open recent error:', err); }
      });
      dom.recentList.appendChild(item);
      count++;
    } else {
      const item = document.createElement('div');
      item.className = 'recent-item';
      item.innerHTML = `<span class="recent-item-name">${escHtml(entry.name)}</span><span class="recent-item-path">${escHtml(entry.shortDir)}</span>`;
      item.addEventListener('click', async () => {
        try {
          const content = await window.apexStudio.readFile(entry.path);
          await openFile(entry.path, content);
        } catch (err) { console.error('open recent error:', err); }
      });
      dom.recentList.appendChild(item);
      count++;
    }
  }
  // Add "More..." link at bottom
  if (files.length > 8) {
    const more = document.createElement('div');
    more.className = 'recent-item recent-item-more';
    more.innerHTML = '<span class="recent-item-name" style="color:var(--accent);font-size:12px;">More...</span>';
    more.addEventListener('click', () => showRecentPanel());
    dom.recentList.appendChild(more);
  }
}

function renderWelcomeRecent(files) {
  const container = $('#welcome-recent');
  if (!container) return;
  container.innerHTML = '';
  if (files.length === 0) {
    container.innerHTML = '<div class="welcome-recent-empty">No recent files yet</div>';
    return;
  }

  // Smart grouping: group files by parent folder
  const grouped = groupRecentFiles(files);
  let count = 0;
  for (const entry of grouped) {
    if (count >= 8) break;
    if (entry.type === 'folder-group') {
      // Multiple files from same folder → show folder
      const item = document.createElement('div');
      item.className = 'welcome-recent-item welcome-recent-folder';
      item.innerHTML = `<span class="recent-icon">📁</span><span class="recent-name">${escHtml(entry.name)}</span><span class="recent-dir">${escHtml(entry.shortDir)}</span><span class="recent-badge">${entry.files.length} files</span>`;
      item.title = entry.dir;
      item.addEventListener('click', async () => {
        try { await openFolder(entry.dir); } catch (err) { console.error('open folder error:', err); }
      });
      container.appendChild(item);
      count++;
    } else if (entry.type === 'directory') {
      // A project folder that was opened directly
      const item = document.createElement('div');
      item.className = 'welcome-recent-item welcome-recent-folder';
      item.innerHTML = `<span class="recent-icon">📁</span><span class="recent-name">${escHtml(entry.name)}</span><span class="recent-dir">${escHtml(entry.shortDir)}</span>`;
      item.title = entry.path;
      item.addEventListener('click', async () => {
        try { await openFolder(entry.path); } catch (err) { console.error('open folder error:', err); }
      });
      container.appendChild(item);
      count++;
    } else {
      // Single standalone file
      const item = document.createElement('div');
      item.className = 'welcome-recent-item';
      item.innerHTML = `<span class="recent-name">${escHtml(entry.name)}</span><span class="recent-dir">${escHtml(entry.shortDir)}</span>`;
      item.title = entry.path;
      item.addEventListener('click', async () => {
        try {
          const content = await window.apexStudio.readFile(entry.path);
          await openFile(entry.path, content);
        } catch (err) { console.error('open recent error:', err); }
      });
      container.appendChild(item);
      count++;
    }
  }
}

/**
 * Group recent files intelligently:
 * - Directories (opened folders) → show as-is (unless already covered by a folder group)
 * - Multiple files from the same project root → group into one folder entry
 * - Single standalone files → show as-is
 *
 * Project root = first directory level after home (e.g. ~/cpq-admin).
 * For well-known containers (Documents, Desktop, Downloads…), go one level deeper.
 */
function groupRecentFiles(files) {
  const { home, sep } = _homeAndSep(files[0] || '');
  const shorten = (p) => p.replace(new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '~');

  // Common containers — not meaningful project roots on their own
  const containers = new Set([
    'Documents', 'Desktop', 'Downloads', 'Library',
    'Applications', 'Pictures', 'Music', 'Movies', 'Public',
  ]);

  // Track the earliest MRU index for each entry to preserve recency order
  const directoryPaths = []; // { path, mruIndex }
  const fileItems = [];      // { path, mruIndex }

  for (let i = 0; i < files.length; i++) {
    const fp = files[i];
    const name = fp.split(/[/\\]/).pop();
    if (!name.includes('.')) {
      directoryPaths.push({ path: fp, mruIndex: i });
    } else {
      fileItems.push({ path: fp, mruIndex: i });
    }
  }

  // Determine project root for each file
  const projectMap = new Map(); // projectRoot → [filepath, …]
  const projectMruIndex = new Map(); // projectRoot → earliest mruIndex

  for (const item of fileItems) {
    const fp = item.path;
    const rel = fp.substring(home.length + 1); // e.g. "cpq-admin/resources/file.js"
    const segments = rel.split(/[/\\]/);

    let projectRoot;
    if (segments.length <= 1) {
      projectRoot = home; // file directly in home
    } else if (containers.has(segments[0]) && segments.length >= 3) {
      projectRoot = home + sep + segments[0] + sep + segments[1];
    } else {
      projectRoot = home + sep + segments[0];
    }

    if (!projectMap.has(projectRoot)) {
      projectMap.set(projectRoot, []);
      projectMruIndex.set(projectRoot, item.mruIndex);
    } else {
      // Keep the earliest (lowest) MRU index for this project group
      projectMruIndex.set(projectRoot, Math.min(projectMruIndex.get(projectRoot), item.mruIndex));
    }
    projectMap.get(projectRoot).push(fp);
  }

  const coveredRoots = new Set(projectMap.keys());

  // Build all entries with their MRU index for proper ordering
  const allEntries = [];

  // Directory entries (those not already represented by a file group)
  for (const d of directoryPaths) {
    if (coveredRoots.has(d.path)) continue;
    allEntries.push({
      mruIndex: d.mruIndex,
      entry: {
        type: 'directory',
        path: d.path,
        name: d.path.split(/[/\\]/).pop(),
        shortDir: shorten(dirName(d.path)),
      },
    });
  }

  // File groups / individual files
  for (const [root, fps] of projectMap) {
    const name = root.split(/[/\\]/).pop();
    const shortDir = shorten(dirName(root));
    const mruIdx = projectMruIndex.get(root);

    if (fps.length > 1) {
      allEntries.push({
        mruIndex: mruIdx,
        entry: {
          type: 'folder-group',
          dir: root,
          name: name,
          shortDir: shortDir,
          files: fps,
        },
      });
    } else {
      const fp = fps[0];
      allEntries.push({
        mruIndex: mruIdx,
        entry: {
          type: 'file',
          path: fp,
          name: fp.split(/[/\\]/).pop(),
          shortDir: shorten(dirName(fp)),
        },
      });
    }
  }

  // Sort by MRU index (most recent first)
  allEntries.sort((a, b) => a.mruIndex - b.mruIndex);

  return allEntries.map(e => e.entry);
}

/**
 * Show the full recent files panel with all entries
 */
async function showRecentPanel() {
  const panel = $('#recent-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  const list = $('#recent-panel-list');
  list.innerHTML = '<div style="padding:16px;color:var(--text-muted);">Loading...</div>';

  const files = await window.apexStudio.getRecent() || [];
  list.innerHTML = '';

  if (files.length === 0) {
    list.innerHTML = '<div class="recent-panel-empty">No recent files</div>';
    return;
  }

  // Use stat to accurately determine directory vs file
  const grouped = await groupRecentFilesWithStat(files);

  for (const entry of grouped) {
    if (entry.type === 'folder-group') {
      // Folder group header
      const group = document.createElement('div');
      group.className = 'recent-panel-group';
      const header = document.createElement('div');
      header.className = 'recent-panel-group-header';
      header.innerHTML = `<span class="recent-icon">📁</span><span class="recent-panel-name">${escHtml(entry.name)}</span><span class="recent-panel-dir">${escHtml(entry.shortDir)}</span><span class="recent-badge">${entry.files.length} files</span>`;
      header.addEventListener('click', async () => {
        try { await openFolder(entry.dir); hideRecentPanel(); } catch {}
      });
      group.appendChild(header);

      // Individual files in this group
      for (const fp of entry.files) {
        const item = document.createElement('div');
        item.className = 'recent-panel-item recent-panel-subitem';
        item.innerHTML = `<span class="recent-panel-name">${escHtml(fp.split(/[/\\]/).pop())}</span>`;
        item.title = fp;
        item.addEventListener('click', async () => {
          try {
            const content = await window.apexStudio.readFile(fp);
            await openFile(fp, content);
            hideRecentPanel();
          } catch (err) { console.error('open recent error:', err); }
        });
        group.appendChild(item);
      }
      list.appendChild(group);
    } else if (entry.type === 'directory') {
      const item = document.createElement('div');
      item.className = 'recent-panel-item recent-panel-folder';
      item.innerHTML = `<span class="recent-icon">📁</span><span class="recent-panel-name">${escHtml(entry.name)}</span><span class="recent-panel-dir">${escHtml(entry.shortDir)}</span>`;
      item.title = entry.path;
      item.addEventListener('click', async () => {
        try { await openFolder(entry.path); hideRecentPanel(); } catch {}
      });
      list.appendChild(item);
    } else {
      const item = document.createElement('div');
      item.className = 'recent-panel-item';
      item.innerHTML = `<span class="recent-panel-name">${escHtml(entry.name)}</span><span class="recent-panel-dir">${escHtml(entry.shortDir)}</span>`;
      item.title = entry.path;
      item.addEventListener('click', async () => {
        try {
          const content = await window.apexStudio.readFile(entry.path);
          await openFile(entry.path, content);
          hideRecentPanel();
        } catch (err) { console.error('open recent error:', err); }
      });
      list.appendChild(item);
    }
  }
}

/**
 * Group recent files using stat to accurately detect directories.
 * Uses project-root grouping (first dir level after home) instead of
 * immediate-parent grouping, so files scattered across subdirectories
 * of the same project are merged into one folder entry.
 */
async function groupRecentFilesWithStat(files) {
  const { home, sep } = _homeAndSep(files[0] || '');
  const shorten = (p) => p.replace(new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '~');

  const containers = new Set([
    'Documents', 'Desktop', 'Downloads', 'Library',
    'Applications', 'Pictures', 'Music', 'Movies', 'Public',
  ]);

  const directoryPaths = [];
  const fileItems = [];

  for (const fp of files) {
    try {
      const stat = await window.apexStudio.stat(fp);
      if (stat && stat.isDirectory) {
        directoryPaths.push(fp);
        continue;
      }
    } catch {
      continue; // file may not exist anymore
    }
    fileItems.push(fp);
  }

  // Determine project root for each file
  const projectMap = new Map();
  const projectOrder = [];

  for (const fp of fileItems) {
    const rel = fp.substring(home.length + 1);
    const segments = rel.split(/[/\\]/);

    let projectRoot;
    if (segments.length <= 1) {
      projectRoot = home;
    } else if (containers.has(segments[0]) && segments.length >= 3) {
      projectRoot = home + sep + segments[0] + sep + segments[1];
    } else {
      projectRoot = home + sep + segments[0];
    }

    if (!projectMap.has(projectRoot)) {
      projectMap.set(projectRoot, []);
      projectOrder.push(projectRoot);
    }
    projectMap.get(projectRoot).push(fp);
  }

  const entries = [];
  const coveredRoots = new Set(projectOrder);

  // Output directory entries not already covered by a file group
  for (const fp of directoryPaths) {
    if (coveredRoots.has(fp)) continue;
    entries.push({
      type: 'directory',
      path: fp,
      name: fp.split(/[/\\]/).pop(),
      shortDir: shorten(dirName(fp)),
    });
  }

  // Output file groups
  for (const root of projectOrder) {
    const fps = projectMap.get(root);
    const name = root.split(/[/\\]/).pop();
    const shortDir = shorten(dirName(root));

    if (fps.length > 1) {
      entries.push({
        type: 'folder-group',
        dir: root,
        name: name,
        shortDir: shortDir,
        files: fps,
      });
    } else {
      const fp = fps[0];
      entries.push({
        type: 'file',
        path: fp,
        name: fp.split(/[/\\]/).pop(),
        shortDir: shorten(dirName(fp)),
      });
    }
  }

  return entries;
}

function hideRecentPanel() {
  const panel = $('#recent-panel');
  if (panel) panel.classList.add('hidden');
}

/* ================================================================
   15b. SYSTEM-WIDE FILE SEARCH (title bar)
   ================================================================ */
let _sysSearchTimer = null;
let _sysSearchActive = -1;
let _sysSearchResults = [];
let _sysSearchGen = 0;

function initSystemSearch() {
  const input = $('#titlebar-search-input');
  const dropdown = $('#titlebar-search-results');
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    clearTimeout(_sysSearchTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      hideSystemSearch();
      return;
    }
    // Show loading state
    dropdown.classList.remove('hidden');
    dropdown.innerHTML = '<div class="sys-search-loading">Searching...</div>';
    const gen = ++_sysSearchGen;
    _sysSearchTimer = setTimeout(() => runSystemSearch(q, gen), 250);
  });

  input.addEventListener('focus', () => {
    const q = input.value.trim();
    if (q.length >= 2 && _sysSearchResults.length > 0) {
      dropdown.classList.remove('hidden');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (!dropdown || dropdown.classList.contains('hidden')) {
      if (e.key === 'Escape') { input.blur(); return; }
      return;
    }
    const items = dropdown.querySelectorAll('.sys-search-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _sysSearchActive = Math.min(_sysSearchActive + 1, items.length - 1);
      updateSysSearchActive(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _sysSearchActive = Math.max(_sysSearchActive - 1, 0);
      updateSysSearchActive(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (_sysSearchActive >= 0 && _sysSearchActive < _sysSearchResults.length) {
        openSystemSearchResult(_sysSearchResults[_sysSearchActive]);
      }
    } else if (e.key === 'Escape') {
      hideSystemSearch();
      input.blur();
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#titlebar-search')) {
      hideSystemSearch();
    }
  });
}

async function runSystemSearch(query, gen) {
  const dropdown = $('#titlebar-search-results');
  if (!dropdown) return;

  try {
    // Run searches in parallel: file name search + workspace content search
    const fileSearchPromise = window.apexStudio.systemSearch(query);
    const contentSearchPromise = state.folderPath
      ? window.apexStudio.searchInFiles(state.folderPath, query, { caseSensitive: false, isRegex: false })
      : Promise.resolve([]);

    const [fileResults, contentResults] = await Promise.all([fileSearchPromise, contentSearchPromise]);

    // Discard stale results if a newer search was started
    if (gen !== _sysSearchGen) return;

    const lowerQ = query.toLowerCase();
    let html = '';
    const allResults = []; // unified result list for keyboard navigation

    // Section 0: Search open tabs/buffers (always works, even without a folder)
    const openTabMatches = [];
    const contentFilePaths = new Set((contentResults || []).map(f => f.filePath));
    for (const tab of state.tabs) {
      if (!tab.model) continue;
      // Skip tabs already covered by workspace grep results
      if (tab.filePath && contentFilePaths.has(tab.filePath)) continue;
      const text = tab.model.getValue();
      if (!text) continue;
      const lines = text.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQ)) {
          matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
          if (matches.length >= 10) break; // cap per file
        }
      }
      if (matches.length > 0) {
        openTabMatches.push({
          filePath: tab.filePath || null,
          tabId: tab.id,
          title: tab.title || 'Untitled',
          matches,
        });
      }
    }

    if (openTabMatches.length > 0) {
      html += '<div class="sys-search-section-header">📝 Open Tabs</div>';
      for (const file of openTabMatches) {
        const icon = getFileIcon(file.title);
        html += `<div class="sys-search-content-file">${icon} ${escHtml(file.title)} <span class="sys-search-match-count">${file.matches.length} match${file.matches.length > 1 ? 'es' : ''}</span></div>`;
        for (const match of file.matches.slice(0, 3)) {
          const matchResult = {
            path: file.filePath,
            name: file.title,
            dir: '',
            isDirectory: false,
            _contentMatch: true,
            _line: match.line,
            _tabId: file.tabId,
          };
          allResults.push(matchResult);
          const lineText = match.text.length > 120 ? match.text.substring(0, 120) + '…' : match.text;
          const highlightedText = highlightMatch(lineText, lowerQ);
          html += `<div class="sys-search-item sys-search-content-match" data-idx="${allResults.length - 1}">
            <span class="sys-search-line-num">L${match.line}</span>
            <span class="sys-search-match-text">${highlightedText}</span>
          </div>`;
        }
        if (file.matches.length > 3) {
          html += `<div class="sys-search-more">… ${file.matches.length - 3} more matches</div>`;
        }
      }
    }

    // Section 1: File name matches
    const filteredFiles = fileResults || [];
    if (filteredFiles.length > 0) {
      html += '<div class="sys-search-section-header">📄 File Matches</div>';
      for (const r of filteredFiles.slice(0, 15)) {
        const icon = r.isDirectory ? '📁' : getFileIcon(r.name);
        const nameHtml = highlightMatch(r.name, lowerQ);
        allResults.push(r);
        html += `<div class="sys-search-item" data-idx="${allResults.length - 1}">
          <span class="sys-search-icon">${icon}</span>
          <span class="sys-search-name">${nameHtml}</span>
          <span class="sys-search-dir">${escHtml(r.dir)}</span>
        </div>`;
      }
    }

    // Section 2: Content matches within workspace
    const validContent = (contentResults || []).filter(f => f.matches && f.matches.length > 0);
    if (validContent.length > 0) {
      html += '<div class="sys-search-section-header">🔍 Content Matches</div>';
      const basePath = state.folderPath || '';
      for (const file of validContent.slice(0, 20)) {
        const relPath = file.filePath.replace(basePath + '/', '');
        const fileName = relPath.split(/[/\\]/).pop();
        const icon = getFileIcon(fileName);
        // Show the file header
        html += `<div class="sys-search-content-file">${icon} ${escHtml(relPath)} <span class="sys-search-match-count">${file.matches.length} match${file.matches.length > 1 ? 'es' : ''}</span></div>`;
        // Show up to 3 matching lines per file
        for (const match of file.matches.slice(0, 3)) {
          const matchResult = {
            path: file.filePath,
            name: fileName,
            dir: relPath,
            isDirectory: false,
            _contentMatch: true,
            _line: match.line,
          };
          allResults.push(matchResult);
          const lineText = match.text.length > 120 ? match.text.substring(0, 120) + '…' : match.text;
          const highlightedText = highlightMatch(lineText, lowerQ);
          html += `<div class="sys-search-item sys-search-content-match" data-idx="${allResults.length - 1}">
            <span class="sys-search-line-num">L${match.line}</span>
            <span class="sys-search-match-text">${highlightedText}</span>
          </div>`;
        }
        if (file.matches.length > 3) {
          html += `<div class="sys-search-more">… ${file.matches.length - 3} more matches</div>`;
        }
      }
    }

    _sysSearchResults = allResults;
    _sysSearchActive = -1;

    if (allResults.length === 0) {
      dropdown.innerHTML = '<div class="sys-search-empty">No results found</div>';
      return;
    }

    html += '<div class="sys-search-hint"><span><kbd>↑↓</kbd> Navigate <kbd>↵</kbd> Open</span><span><kbd>esc</kbd> Close</span></div>';
    dropdown.innerHTML = html;

    // Click handlers
    dropdown.querySelectorAll('.sys-search-item').forEach((el) => {
      const idx = parseInt(el.dataset.idx, 10);
      el.addEventListener('click', () => openSystemSearchResult(allResults[idx]));
      el.addEventListener('mouseenter', () => {
        _sysSearchActive = idx;
        updateSysSearchActive(dropdown.querySelectorAll('.sys-search-item'), false);
      });
    });
  } catch (err) {
    console.error('System search error:', err);
    dropdown.innerHTML = '<div class="sys-search-empty">Search error</div>';
  }
}

function highlightMatch(text, query) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx === -1) return escHtml(text);
  const before = text.substring(0, idx);
  const match = text.substring(idx, idx + query.length);
  const after = text.substring(idx + query.length);
  return escHtml(before) + '<em>' + escHtml(match) + '</em>' + escHtml(after);
}

function updateSysSearchActive(items, scroll = true) {
  items.forEach((el, i) => el.classList.toggle('active', i === _sysSearchActive));
  if (scroll && _sysSearchActive >= 0 && items[_sysSearchActive]) {
    items[_sysSearchActive].scrollIntoView({ block: 'nearest' });
  }
}

async function openSystemSearchResult(result) {
  hideSystemSearch();
  $('#titlebar-search-input').value = '';
  $('#titlebar-search-input').blur();

  if (result.isDirectory) {
    await openFolder(result.path);
  } else {
    try {
      // If it's a match from an open tab, just switch to that tab
      if (result._tabId) {
        const tab = state.tabs.find(t => t.id === result._tabId);
        if (tab) {
          switchToTab(tab.id);
          if (result._contentMatch && result._line && state.editor) {
            setTimeout(() => {
              state.editor.revealLineInCenter(result._line);
              state.editor.setPosition({ lineNumber: result._line, column: 1 });
              state.editor.focus();
              const decs = state.editor.deltaDecorations([], [{
                range: new monaco.Range(result._line, 1, result._line, 1),
                options: { isWholeLine: true, className: 'line-highlight-flash' },
              }]);
              setTimeout(() => state.editor.deltaDecorations(decs, []), 1500);
            }, 150);
          }
          return;
        }
      }

      const content = await window.apexStudio.readFile(result.path);
      await openFile(result.path, content);
      // If this was a content match, jump to the matching line
      if (result._contentMatch && result._line && state.editor) {
        setTimeout(() => {
          state.editor.revealLineInCenter(result._line);
          state.editor.setPosition({ lineNumber: result._line, column: 1 });
          state.editor.focus();
          // Flash highlight
          const decs = state.editor.deltaDecorations([], [{
            range: new monaco.Range(result._line, 1, result._line, 1),
            options: { isWholeLine: true, className: 'line-highlight-flash' },
          }]);
          setTimeout(() => state.editor.deltaDecorations(decs, []), 1500);
        }, 150);
      }
    } catch (err) {
      console.error('Failed to open search result:', err);
    }
  }
}

function hideSystemSearch() {
  const dropdown = $('#titlebar-search-results');
  if (dropdown) dropdown.classList.add('hidden');
  _sysSearchActive = -1;
}

function focusSystemSearch() {
  // If on welcome screen, focus the welcome search; otherwise the titlebar search
  const welcomeScreen = $('#welcome-screen');
  if (welcomeScreen && !welcomeScreen.classList.contains('hidden')) {
    const wsInput = $('#welcome-search-input');
    if (wsInput) { wsInput.focus(); wsInput.select(); return; }
  }
  const input = $('#titlebar-search-input');
  if (input) { input.focus(); input.select(); }
}

/* ================================================================
   15c. WELCOME PANEL SPOTLIGHT SEARCH
   ================================================================ */
let _wsSearchTimer = null;
let _wsSearchActive = -1;
let _wsSearchResults = [];
let _wsSearchGen = 0;

function initWelcomeSearch() {
  const input   = $('#welcome-search-input');
  const results = $('#welcome-search-results');
  const shimmer = $('#welcome-search-shimmer');
  const list    = $('#welcome-search-list');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    clearTimeout(_wsSearchTimer);
    const q = input.value.trim();
    if (q.length < 2) { hideWelcomeSearch(); return; }
    // Show shimmer loading
    results.classList.remove('hidden');
    if (shimmer) shimmer.classList.remove('hidden');
    if (list) list.innerHTML = '';
    const gen = ++_wsSearchGen;
    _wsSearchTimer = setTimeout(() => runWelcomeSearch(q, gen), 250);
  });

  input.addEventListener('focus', () => {
    const q = input.value.trim();
    if (q.length >= 2 && _wsSearchResults.length > 0) {
      results.classList.remove('hidden');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (results.classList.contains('hidden')) {
      if (e.key === 'Escape') { input.blur(); return; }
      return;
    }
    const items = results.querySelectorAll('.ws-result-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _wsSearchActive = Math.min(_wsSearchActive + 1, items.length - 1);
      updateWsSearchActive(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _wsSearchActive = Math.max(_wsSearchActive - 1, 0);
      updateWsSearchActive(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (_wsSearchActive >= 0 && _wsSearchActive < _wsSearchResults.length) {
        openWelcomeSearchResult(_wsSearchResults[_wsSearchActive]);
      }
    } else if (e.key === 'Escape') {
      hideWelcomeSearch();
      input.blur();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.welcome-search-container')) {
      hideWelcomeSearch();
    }
  });
}

async function runWelcomeSearch(query, gen) {
  const results = $('#welcome-search-results');
  const shimmer = $('#welcome-search-shimmer');
  const list    = $('#welcome-search-list');
  if (!results || !list) return;

  try {
    const items = await window.apexStudio.systemSearch(query);
    // Discard stale results if a newer search was started
    if (gen !== _wsSearchGen) return;
    _wsSearchResults = items;
    _wsSearchActive = -1;
    if (shimmer) shimmer.classList.add('hidden');

    if (items.length === 0) {
      list.innerHTML = '<div class="ws-result-empty">No files found</div>';
      return;
    }

    const lowerQ = query.toLowerCase();
    let html = '';
    items.forEach((r, i) => {
      const icon = r.isDirectory ? '📁' : getFileIcon(r.name);
      const nameHtml = highlightMatch(r.name, lowerQ);
      html += `<div class="ws-result-item" data-path="${escHtml(r.path)}" style="animation-delay:${i * 30}ms">
        <span class="ws-result-icon">${icon}</span>
        <span class="ws-result-name">${nameHtml}</span>
        <span class="ws-result-dir">${escHtml(r.dir)}</span>
      </div>`;
    });
    html += '<div class="ws-result-hint"><span><kbd>↑↓</kbd> Navigate <kbd>↵</kbd> Open</span><span><kbd>esc</kbd> Close</span></div>';
    list.innerHTML = html;

    list.querySelectorAll('.ws-result-item').forEach((el, i) => {
      el.addEventListener('click', () => openWelcomeSearchResult(items[i]));
      el.addEventListener('mouseenter', () => {
        _wsSearchActive = i;
        updateWsSearchActive(list.querySelectorAll('.ws-result-item'), false);
      });
    });
  } catch (err) {
    console.error('Welcome search error:', err);
    if (shimmer) shimmer.classList.add('hidden');
    list.innerHTML = '<div class="ws-result-empty">Search error</div>';
  }
}

function updateWsSearchActive(items, scroll = true) {
  items.forEach((el, i) => el.classList.toggle('active', i === _wsSearchActive));
  if (scroll && _wsSearchActive >= 0 && items[_wsSearchActive]) {
    items[_wsSearchActive].scrollIntoView({ block: 'nearest' });
  }
}

async function openWelcomeSearchResult(result) {
  hideWelcomeSearch();
  const input = $('#welcome-search-input');
  if (input) { input.value = ''; input.blur(); }

  if (result.isDirectory) {
    await openFolder(result.path);
  } else {
    try {
      const content = await window.apexStudio.readFile(result.path);
      await openFile(result.path, content);
    } catch (err) {
      console.error('Failed to open welcome search result:', err);
    }
  }
}

function hideWelcomeSearch() {
  const results = $('#welcome-search-results');
  const shimmer = $('#welcome-search-shimmer');
  if (results) results.classList.add('hidden');
  if (shimmer) shimmer.classList.add('hidden');
  _wsSearchActive = -1;
}

/* ================================================================
   16. RESIZER (sidebar)
   ================================================================ */
function initResizer() {
  let isResizing = false;

  dom.sidebarResizer.addEventListener('mousedown', (e) => {
    if (!state.sidebarVisible) return;
    isResizing = true;
    dom.sidebarResizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const width = Math.max(180, Math.min(500, e.clientX));
    dom.sidebar.style.width = width + 'px';
    state.sidebarWidth = width;
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      dom.sidebarResizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveSessionDebounced();
    }
  });
}

/* ================================================================
   16b. RESIZER (recent section)
   ================================================================ */
function initRecentResizer() {
  let isResizing = false;
  let startY = 0;
  let startHeight = 0;

  dom.recentResizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startY = e.clientY;
    startHeight = dom.recentSection.getBoundingClientRect().height;
    dom.recentResizer.classList.add('active');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const delta = startY - e.clientY;
    const newHeight = Math.max(30, Math.min(400, startHeight + delta));
    dom.recentSection.style.height = newHeight + 'px';
    dom.recentSection.style.maxHeight = newHeight + 'px';
    state.recentHeight = newHeight;
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      dom.recentResizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

/* ================================================================
   17. STATUS BAR
   ================================================================ */

/** Hide file-specific status items when no tab is open */
function hideFileStatusItems() {
  if (dom.statusPosition) dom.statusPosition.classList.add('hidden');
  if (dom.statusEncoding) dom.statusEncoding.classList.add('hidden');
  if (dom.statusLanguage) dom.statusLanguage.classList.add('hidden');
  if (dom.statusEol) dom.statusEol.classList.add('hidden');
  if (dom.statusIndent) dom.statusIndent.classList.add('hidden');
  const rt = $('#status-richtext');
  if (rt) rt.classList.add('hidden');
}

/** Show file-specific status items when a tab is active */
function showFileStatusItems() {
  if (dom.statusPosition) dom.statusPosition.classList.remove('hidden');
  if (dom.statusEncoding) dom.statusEncoding.classList.remove('hidden');
  if (dom.statusLanguage) dom.statusLanguage.classList.remove('hidden');
  if (dom.statusEol) dom.statusEol.classList.remove('hidden');
  if (dom.statusIndent) dom.statusIndent.classList.remove('hidden');
}

function updateStatusPosition() {
  if (!state.editor) return;
  const pos = state.editor.getPosition();
  dom.statusPosition.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
}

function updateStatusLanguage(tab) {
  if (!tab) return;
  const lang = tab.model.getLanguageId?.() || tab.model.getModeId?.() || 'plaintext';
  dom.statusLanguage.textContent = lang.charAt(0).toUpperCase() + lang.slice(1);
  updateRichTextIndicator();
}

/* ================================================================
   18. WELCOME SCREEN
   ================================================================ */
function showWelcome() {
  state.welcomeVisible = true;
  dom.welcomeScreen.classList.remove('hidden');
  hideEmptyTabShortcuts();
  const tbs = $('#titlebar-search');
  if (tbs) tbs.style.display = 'none';
}

function hideWelcome() {
  if (state.welcomeVisible) {
    state.welcomeVisible = false;
    dom.welcomeScreen.classList.add('hidden');
    const tbs = $('#titlebar-search');
    if (tbs) tbs.style.display = '';
    // Only show sidebar if a folder is open
    if (state.folderPath && !state.sidebarVisible) {
      state.sidebarVisible = true;
    }
    applySidebarState();
  }
}

function showEmptyTabShortcuts() {
  if (dom.emptyTabShortcuts) dom.emptyTabShortcuts.classList.remove('hidden');
}

function hideEmptyTabShortcuts() {
  if (dom.emptyTabShortcuts) dom.emptyTabShortcuts.classList.add('hidden');
}

function updateEmptyTabShortcuts() {
  // Only show shortcut overlay when there are absolutely no tabs open
  if (state.tabs.length === 0) {
    showEmptyTabShortcuts();
  } else {
    hideEmptyTabShortcuts();
  }
}

function initWelcome() {
  $('#btn-welcome-new')?.addEventListener('click', () => createTab());
  $('#btn-welcome-open')?.addEventListener('click', openFileDialog);
  $('#btn-welcome-folder')?.addEventListener('click', openFolderDialog);
  $('#btn-welcome-new-window')?.addEventListener('click', () => window.apexStudio.newWindow());
  // "More..." button to show full recent panel
  $('#btn-welcome-more-recent')?.addEventListener('click', () => showRecentPanel());
  // Recent panel close & clear
  $('#btn-recent-close')?.addEventListener('click', () => hideRecentPanel());
  $('#btn-recent-clear')?.addEventListener('click', async () => {
    await window.apexStudio.clearRecent();
    hideRecentPanel();
    await loadRecentFiles();
  });
  // Click outside recent panel to close
  $('#recent-panel')?.addEventListener('click', (e) => {
    if (e.target.id === 'recent-panel') hideRecentPanel();
  });
  // Wire up "no editor" overlay shortcut clicks
  initNoEditorShortcuts();
}

function initNoEditorShortcuts() {
  const el = dom.emptyTabShortcuts;
  if (!el) return;
  el.addEventListener('click', (e) => {
    const item = e.target.closest('.ets-shortcut-item');
    if (!item) return;
    const action = item.dataset.action;
    switch (action) {
      case 'quick-open':      showQuickOpen();      break;
      case 'new-file':        createTab();          break;
      case 'open-file':       openFileDialog();     break;
      case 'open-folder':     openFolderDialog();   break;
      case 'command-palette': showCommandPalette(); break;
      case 'search-files':    showGlobalSearch();   break;
      case 'toggle-terminal': {
        if (state.folderPath) { window.apexStudio.openInTerminal(state.folderPath); }
        break;
      }
    }
  });
}

/* ================================================================
   19. EDITOR ACTIONS
   ================================================================ */
function toggleWordWrap() {
  if (!state.editor) return;
  const current = state.editor.getOption(monaco.editor.EditorOption.wordWrap);
  state.editor.updateOptions({ wordWrap: current === 'on' ? 'off' : 'on' });
}

function toggleMinimap() {
  if (!state.editor) return;
  const current = state.editor.getOption(monaco.editor.EditorOption.minimap);
  state.editor.updateOptions({ minimap: { enabled: !current.enabled } });
  updateMinimapIndicator();
}

function changeFontSize(delta) {
  if (!state.editor) return;
  const current = state.editor.getOption(monaco.editor.EditorOption.fontSize);
  state.editor.updateOptions({ fontSize: Math.max(8, Math.min(40, current + delta)) });
}

function reopenClosedTab() {
  if (state.recentlyClosed.length === 0) return;
  const entry = state.recentlyClosed.pop();
  if (entry.filePath) {
    // Check if already open
    const existing = state.tabs.find((t) => t.filePath === entry.filePath);
    if (existing) { activateTab(existing.id); return; }
  }
  createTab(entry.title, entry.filePath, entry.content);
}

function closeOtherTabs() {
  const keep = state.tabs.find((t) => t.id === state.activeTabId);
  if (!keep) return;
  const toClose = state.tabs.filter((t) => t.id !== keep.id).map((t) => t.id);
  toClose.forEach((id) => closeTab(id));
}

function closeAllTabs() {
  const ids = state.tabs.map((t) => t.id);
  ids.forEach((id) => closeTab(id));
}

/* ================================================================
   20. KEYBOARD SHORTCUTS
   ================================================================ */
function initKeyboard() {
  // --- Ctrl+Tab / Ctrl+Shift+Tab tab switcher ---
  let tabSwitchOrder = []; // MRU order of tab IDs
  const origActivateTab = activateTab;
  // Wrap activateTab to track MRU order
  activateTab = function(id) {
    tabSwitchOrder = tabSwitchOrder.filter((x) => x !== id);
    tabSwitchOrder.unshift(id);
    origActivateTab(id);
  };

  document.addEventListener('keydown', (e) => {
    const cmd = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;
    const alt = e.altKey;

    // Escape → close recent panel if open
    if (e.key === 'Escape') {
      const rp = $('#recent-panel');
      if (rp && !rp.classList.contains('hidden')) {
        e.preventDefault(); hideRecentPanel(); return;
      }
      const sd = $('#titlebar-search-results');
      if (sd && !sd.classList.contains('hidden')) {
        e.preventDefault(); hideSystemSearch(); $('#titlebar-search-input')?.blur(); return;
      }
    }

    // Ctrl+Tab → Next recent tab (MRU)
    if (e.ctrlKey && !e.metaKey && !alt && e.key === 'Tab') {
      e.preventDefault();
      if (state.tabs.length < 2) return;
      // Build MRU list from tracked order, add any missing tabs
      const mru = [...tabSwitchOrder.filter((id) => state.tabs.some((t) => t.id === id))];
      state.tabs.forEach((t) => { if (!mru.includes(t.id)) mru.push(t.id); });
      const currentIdx = mru.indexOf(state.activeTabId);
      const nextIdx = shift
        ? (currentIdx - 1 + mru.length) % mru.length
        : (currentIdx + 1) % mru.length;
      activateTab(mru[nextIdx]);
      return;
    }

    // Cmd+N → New tab
    if (cmd && !shift && !alt && e.key === 'n') { e.preventDefault(); createTab(); return; }
    // Cmd+Shift+N → New window
    if (cmd && shift && !alt && e.key === 'N') { e.preventDefault(); window.apexStudio.newWindow(); return; }
    // Cmd+O → Open file
    if (cmd && !shift && !alt && e.key === 'o') { e.preventDefault(); openFileDialog(); return; }
    // Cmd+Shift+O → Open folder
    if (cmd && shift && !alt && e.key === 'O') { e.preventDefault(); openFolderDialog(); return; }
    // Cmd+S → Save
    if (cmd && !shift && !alt && e.key === 's') {
      e.preventDefault();
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (tab) saveFile(tab);
      return;
    }
    // Cmd+Shift+S → Save As
    if (cmd && shift && !alt && e.key === 'S') { e.preventDefault(); saveAsFile(); return; }
    // Cmd+W → Close tab
    if (cmd && !shift && !alt && e.key === 'w') { e.preventDefault(); closeTab(state.activeTabId); return; }
    // Cmd+Shift+T → Reopen closed tab
    if (cmd && shift && !alt && e.key === 'T') { e.preventDefault(); reopenClosedTab(); return; }
    // Cmd+Shift+W → Close window (let OS handle)
    // Cmd+K Cmd+W → Close all tabs
    // Cmd+Shift+Space → System-wide file search
    if (cmd && shift && !alt && e.key === ' ') { e.preventDefault(); focusSystemSearch(); return; }
    // Ctrl+Shift+A → API Client
    if (e.ctrlKey && shift && !alt && e.key === 'A') { e.preventDefault(); toggleToolPanel('api-client-panel'); return; }
    // Ctrl+Shift+R → Regex Tester
    if (e.ctrlKey && shift && !alt && e.key === 'R') { e.preventDefault(); toggleToolPanel('regex-panel'); return; }
    // Ctrl+Shift+J → JSON Viewer
    if (e.ctrlKey && shift && !alt && e.key === 'J') { e.preventDefault(); openJsonViewer(); return; }
    // Ctrl+Shift+B → Bookmarks
    if (e.ctrlKey && shift && !alt && (e.key === 'B' || e.key === 'b') && !e.metaKey) { e.preventDefault(); toggleToolPanel('bookmarks-panel'); return; }
    // Ctrl+Shift+D → Database Client
    if (e.ctrlKey && shift && !alt && e.key === 'D') { e.preventDefault(); toggleToolPanel('db-panel'); return; }
    // Ctrl+Shift+E → Snippets
    if (e.ctrlKey && shift && !alt && e.key === 'E') { e.preventDefault(); toggleToolPanel('snippet-panel'); return; }
    // Ctrl+Shift+K → Color Picker
    if (e.ctrlKey && shift && !alt && e.key === 'K') { e.preventDefault(); toggleToolPanel('color-panel'); return; }
    // Ctrl+Shift+G → TODO Tracker
    if (e.ctrlKey && shift && !alt && e.key === 'G') { e.preventDefault(); toggleToolPanel('todo-panel'); return; }
    // Ctrl+Shift+Y → Pomodoro Timer
    if (e.ctrlKey && shift && !alt && e.key === 'Y') { e.preventDefault(); toggleToolPanel('pomo-panel'); return; }
    // Ctrl+Shift+I → Diff Checker
    if (e.ctrlKey && shift && !alt && e.key === 'I') { e.preventDefault(); toggleToolPanel('diff-panel'); return; }
    // Ctrl+Shift+F → Salesforce
    if (e.ctrlKey && shift && !alt && e.key === 'F') { e.preventDefault(); toggleToolPanel('salesforce-panel'); return; }
    // F5 → Continue debugging (when active) 
    if (!cmd && !shift && !alt && !e.ctrlKey && e.key === 'F5') { e.preventDefault(); if (window.debugState?.active) window.debugContinue?.(); return; }
    // Shift+F5 → Stop debugging
    if (!cmd && shift && !alt && !e.ctrlKey && e.key === 'F5') { e.preventDefault(); window.debugStop?.(); return; }
    // F10 → Step Over
    if (!cmd && !shift && !alt && !e.ctrlKey && e.key === 'F10') { e.preventDefault(); window.debugStepOver?.(); return; }
    // F11 → Step Into
    if (!cmd && !shift && !alt && !e.ctrlKey && e.key === 'F11') { e.preventDefault(); window.debugStepInto?.(); return; }
    // Shift+F11 → Step Out
    if (!cmd && shift && !alt && !e.ctrlKey && e.key === 'F11') { e.preventDefault(); window.debugStepOut?.(); return; }
    // Shift+F10 → Step Back (reverse through the recorded replay timeline)
    if (!cmd && shift && !alt && !e.ctrlKey && e.key === 'F10') { e.preventDefault(); window.debugStepBack?.(); return; }
    // F9 → Toggle Breakpoint
    if (!cmd && !shift && !alt && !e.ctrlKey && e.key === 'F9') {
      e.preventDefault();
      const editor = state.editor;
      if (editor && window.debugState) {
        const pos = editor.getPosition();
        const model = editor.getModel();
        if (pos && model) {
          const fp = model.uri.fsPath || model.uri.path;
          if (fp.endsWith('.cls') || fp.endsWith('.trigger')) {
            const ev = new CustomEvent('apexstudio-toggle-breakpoint', { detail: { filePath: fp, line: pos.lineNumber } });
            document.dispatchEvent(ev);
          }
        }
      }
      return;
    }
    // Ctrl+Shift+U → Run menu
    if (e.ctrlKey && shift && !alt && e.key === 'U') { e.preventDefault(); if (window.toggleRunMenu) window.toggleRunMenu(); return; }
    // Cmd+P → Quick Open
    if (cmd && !shift && !alt && e.key === 'p') { e.preventDefault(); showQuickOpen(); return; }
    // Cmd+Shift+P → Command Palette
    if (cmd && shift && !alt && e.key === 'P') { e.preventDefault(); showCommandPalette(); return; }
    // Cmd+F → Find
    if (cmd && !shift && !alt && e.key === 'f') { e.preventDefault(); showSearchBar(false); return; }
    // Cmd+H → Find and Replace
    if (cmd && !shift && !alt && e.key === 'h') { e.preventDefault(); showSearchBar(true); return; }
    // Cmd+Shift+F → Global Search
    if (cmd && shift && !alt && e.key === 'F') { e.preventDefault(); showGlobalSearch(); return; }
    // Cmd+G → Go to Line
    if (cmd && !shift && !alt && e.key === 'g') { e.preventDefault(); showGotoBar(); return; }
    // Cmd+B → Toggle Sidebar
    if (cmd && !shift && !alt && e.key === 'b') { e.preventDefault(); toggleSidebar(); return; }
    // Alt+Z → Toggle Word Wrap
    if (alt && !cmd && !shift && e.key === 'z') { e.preventDefault(); toggleWordWrap(); return; }
    // Cmd+= → Increase Font
    if (cmd && !shift && (e.key === '=' || e.key === '+')) { e.preventDefault(); changeFontSize(1); return; }
    // Cmd+- → Decrease Font
    if (cmd && !shift && e.key === '-') { e.preventDefault(); changeFontSize(-1); return; }
    // Cmd+0 → Reset Font Size
    if (cmd && !shift && !alt && e.key === '0') { e.preventDefault(); if (state.editor) state.editor.updateOptions({ fontSize: 14 }); return; }
    // Cmd+Shift+T → Reopen recent
    // Escape → Close modals
    if (e.key === 'Escape') {
      // Close active tool panel if any
      if (state.activeToolPanel) { toggleToolPanel(state.activeToolPanel); return; }
      if (!dom.quickOpenOverlay.classList.contains('hidden')) { hideQuickOpen(); return; }
      if (!dom.cmdPaletteOverlay.classList.contains('hidden')) { hideCommandPalette(); return; }
      if (!dom.themePickerOverlay.classList.contains('hidden')) { hideThemePicker(); return; }
      if (!dom.languagePickerOverlay.classList.contains('hidden')) { hideLanguagePicker(); return; }
      if (dom.gitInfoPopup && !dom.gitInfoPopup.classList.contains('hidden')) { hideGitInfoPopup(); return; }
      if (!dom.globalSearchOverlay.classList.contains('hidden')) { hideGlobalSearch(); return; }
      if (!dom.searchBar.classList.contains('hidden')) { hideSearchBar(); return; }
      if (!dom.gotoBar.classList.contains('hidden')) { hideGotoBar(); return; }
    }
    // Tab navigation: Cmd+Shift+] / [
    if (cmd && shift && e.key === ']') {
      e.preventDefault();
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      if (idx >= 0 && idx < state.tabs.length - 1) activateTab(state.tabs[idx + 1].id);
      return;
    }
    if (cmd && shift && e.key === '[') {
      e.preventDefault();
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      if (idx > 0) activateTab(state.tabs[idx - 1].id);
      return;
    }
    // Cmd+1-9 → Jump to tab N
    if (cmd && !shift && !alt && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const n = parseInt(e.key);
      if (n === 9) {
        // Cmd+9 → Last tab
        if (state.tabs.length > 0) activateTab(state.tabs[state.tabs.length - 1].id);
      } else if (state.tabs[n - 1]) {
        activateTab(state.tabs[n - 1].id);
      }
      return;
    }
    // Alt+Cmd+→/← → Switch tab (VS Code style alias)
    if (cmd && alt && !shift && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      if (e.key === 'ArrowRight' && idx < state.tabs.length - 1) activateTab(state.tabs[idx + 1].id);
      if (e.key === 'ArrowLeft' && idx > 0) activateTab(state.tabs[idx - 1].id);
      return;
    }
    // Cmd+Shift+K → Delete line
    if (cmd && shift && !alt && e.key === 'K') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.deleteLines')?.run();
      return;
    }
    // Cmd+L → Select line
    if (cmd && !shift && !alt && e.key === 'l') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.selectLine')?.run();
      return;
    }
    // Cmd+D → Add selection to next find match
    if (cmd && !shift && !alt && e.key === 'd') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.addSelectionToNextFindMatch')?.run();
      return;
    }
    // Cmd+Shift+L → Select all occurrences
    if (cmd && shift && !alt && e.key === 'L') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.selectHighlights')?.run();
      return;
    }
    // Cmd+/ → Toggle line comment
    if (cmd && !shift && !alt && e.key === '/') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.commentLine')?.run();
      return;
    }
    // Cmd+Shift+A → Toggle block comment
    if (cmd && shift && !alt && e.key === 'A') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.blockComment')?.run();
      return;
    }
    // Cmd+[ → Outdent line
    if (cmd && !shift && !alt && e.key === '[') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.outdentLines')?.run();
      return;
    }
    // Cmd+] → Indent line
    if (cmd && !shift && !alt && e.key === ']') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.indentLines')?.run();
      return;
    }
    // Alt+Up → Move line up
    if (alt && !cmd && !shift && e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.moveLinesUpAction')?.run();
      return;
    }
    // Alt+Down → Move line down
    if (alt && !cmd && !shift && e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.moveLinesDownAction')?.run();
      return;
    }
    // Shift+Alt+Up → Copy line up
    if (alt && shift && !cmd && e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.copyLinesUpAction')?.run();
      return;
    }
    // Shift+Alt+Down → Copy line down (duplicate)
    if (alt && shift && !cmd && e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.copyLinesDownAction')?.run();
      return;
    }
    // Cmd+Shift+\ → Jump to matching bracket
    if (cmd && shift && !alt && e.key === '\\') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.jumpToBracket')?.run();
      return;
    }
    // Cmd+Enter → Insert line below
    if (cmd && !shift && !alt && e.key === 'Enter') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.insertLineAfter')?.run();
      return;
    }
    // Cmd+Shift+Enter → Insert line above
    if (cmd && shift && !alt && e.key === 'Enter') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.insertLineBefore')?.run();
      return;
    }
    // Shift+Alt+F → Format document
    if (alt && shift && !cmd && e.key === 'f') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.formatDocument')?.run();
      return;
    }
    // Cmd+K Cmd+F → Format selection (partial — just Cmd+Shift+F is global search)
    // Cmd+U → Undo cursor
    if (cmd && !shift && !alt && e.key === 'u') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('cursorUndo')?.run();
      return;
    }
    // Cmd+\ → Split editor
    if (cmd && !shift && !alt && e.key === '\\') {
      e.preventDefault();
      toggleSplitEditor();
      return;
    }
    // Cmd+Shift+V → Markdown preview
    if (cmd && shift && !alt && e.key === 'V') {
      e.preventDefault();
      toggleMarkdownPreview();
      return;
    }
    // Ctrl+` → Toggle Terminal
    if (e.ctrlKey && !e.metaKey && !shift && !alt && e.key === '`') {
      e.preventDefault();
      toggleTerminal();
      return;
    }
    // Cmd+, → Settings
    if (cmd && !shift && !alt && e.key === ',') {
      e.preventDefault();
      openSettingsTab();
      return;
    }
    // Escape in zen mode → exit zen mode
    if (e.key === 'Escape' && state.zenMode) {
      toggleZenMode();
      return;
    }
  });
}

/* ================================================================
   21. IPC HANDLERS (from main process)
   ================================================================ */
function initIpcHandlers() {
  const api = window.apexStudio;
  // File menu
  api.on('file:new', () => createTab());
  api.on('file:open-dialog', () => openFileDialog());
  api.on('file:open-path', async (fp) => {
    try {
      const content = await api.readFile(fp);
      if (content != null) await openFile(fp, content);
    } catch (err) { console.error('open-path error:', err); }
  });
  api.on('folder:open-dialog', () => openFolderDialog());
  api.on('file:save', () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab) saveFile(tab);
  });
  api.on('file:save-as', () => saveAsFile());
  api.on('file:close-tab', () => closeTab(state.activeTabId));
  // Edit menu
  api.on('edit:find', () => showSearchBar(false));
  api.on('edit:replace', () => showSearchBar(true));
  api.on('edit:find-in-files', () => showGlobalSearch());
  api.on('edit:spotlight-search', () => focusSystemSearch());
  api.on('edit:goto-line', () => showGotoBar());
  api.on('edit:quick-open', () => showQuickOpen());
  api.on('edit:command-palette', () => showCommandPalette());
  // View menu
  api.on('view:toggle-sidebar', () => toggleSidebar());
  api.on('view:toggle-wordwrap', () => toggleWordWrap());
  api.on('view:toggle-minimap', () => toggleMinimap());
  api.on('view:zoom-in', () => changeFontSize(1));
  api.on('view:zoom-out', () => changeFontSize(-1));
  api.on('view:zoom-reset', () => { if (state.editor) state.editor.updateOptions({ fontSize: 14 }); });
  api.on('view:change-theme', () => showThemePicker());
  api.on('view:zen-mode', () => toggleZenMode());
  api.on('view:split-editor', () => toggleSplitEditor());
  api.on('view:markdown-preview', () => toggleMarkdownPreview());
  api.on('view:toggle-terminal', () => toggleTerminal());
  // Tool panels
  api.on('view:api-client', () => toggleToolPanel('api-client-panel'));
  api.on('view:regex-tester', () => toggleToolPanel('regex-panel'));
  api.on('view:json-viewer', () => openJsonViewer());
  api.on('view:bookmarks', () => toggleToolPanel('bookmarks-panel'));
  api.on('view:screenshot', () => openScreenshotPanel());
  api.on('view:db-client', () => toggleToolPanel('db-panel'));
  api.on('view:snippets', () => toggleToolPanel('snippet-panel'));
  api.on('view:color-picker', () => toggleToolPanel('color-panel'));
  api.on('view:todo-tracker', () => toggleToolPanel('todo-panel'));
  api.on('view:pomodoro', () => toggleToolPanel('pomo-panel'));
  api.on('view:diff-checker', () => toggleToolPanel('diff-panel'));
  // Terminal output streaming
  api.on('terminal:output', (text) => {
    if (dom.terminalOutput) appendTerminalText(text);
  });
  api.on('terminal:exit', () => {
    appendTerminalLine('Terminal session ended.', 'term-info');
  });
}

/* ================================================================
   22. DRAG & DROP
   ================================================================ */
function initDragDrop() {
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    for (const file of e.dataTransfer.files) {
      try {
        const stats = await window.apexStudio.stat(file.path);
        if (stats && stats.isDirectory) {
          await openFolder(file.path);
          return; // open first dropped folder and stop
        } else {
          const content = await window.apexStudio.readFile(file.path);
          await openFile(file.path, content);
        }
      } catch (err) { console.error('drag drop error:', err); }
    }
  });
}

/* ================================================================
   23. UTILITIES
   ================================================================ */
function escHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- Custom dialog helpers (Electron blocks native prompt/confirm) ---------- */
function showInputDialog(title, message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = $('#input-dialog-overlay');
    const titleEl = $('#input-dialog-title');
    const msgEl = $('#input-dialog-message');
    const input = $('#input-dialog-input');
    const okBtn = $('#btn-input-dialog-ok');
    const cancelBtn = $('#btn-input-dialog-cancel');
    const closeBtn = $('#btn-input-dialog-close');

    titleEl.textContent = title || 'Input';
    msgEl.textContent = message || '';
    input.value = defaultValue;
    overlay.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 50);

    function cleanup() {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
    }
    function onOk() { const v = input.value; cleanup(); resolve(v); }
    function onCancel() { cleanup(); resolve(null); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    const overlay = $('#input-dialog-overlay');
    const titleEl = $('#input-dialog-title');
    const msgEl = $('#input-dialog-message');
    const input = $('#input-dialog-input');
    const okBtn = $('#btn-input-dialog-ok');
    const cancelBtn = $('#btn-input-dialog-cancel');
    const closeBtn = $('#btn-input-dialog-close');

    titleEl.textContent = title || 'Confirm';
    msgEl.textContent = message || '';
    input.style.display = 'none';
    overlay.classList.remove('hidden');
    setTimeout(() => okBtn.focus(), 50);

    function cleanup() {
      overlay.classList.add('hidden');
      input.style.display = '';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}
// Expose for modules
window.showInputDialog = showInputDialog;
window.showConfirmDialog = showConfirmDialog;

function guessLanguage(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
    php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
    dockerfile: 'dockerfile', makefile: 'makefile',
    lua: 'lua', r: 'r', perl: 'perl', dart: 'dart',
    vue: 'html', svelte: 'html',
    cls: 'apex', trigger: 'apex',
  };
  return map[ext] || 'plaintext';
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    js: '📜', jsx: '⚛️', ts: '🔷', tsx: '⚛️', py: '🐍',
    html: '🌐', css: '🎨', scss: '🎨', json: '📋', md: '📝',
    yaml: '⚙️', yml: '⚙️', sh: '⚡', rs: '🦀', go: '🐹',
    java: '☕', rb: '💎', php: '🐘', swift: '🍎', kt: '🟣',
    sql: '🗃️', xml: '📄', toml: '⚙️', lock: '🔒', env: '🔐',
    png: '🖼️', jpg: '🖼️', gif: '🖼️', svg: '🖼️', ico: '🖼️',
    mp3: '🎵', wav: '🎵', mp4: '🎬', zip: '📦', tar: '📦',
    vue: '💚', svelte: '🧡',
    cls: '⚡', trigger: '⚡',
  };
  return icons[ext] || '📄';
}

function isImageFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif'].includes(ext);
}

/* ================================================================
   25. TOAST NOTIFICATIONS
   ================================================================ */
function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-msg">${escHtml(message)}</span>
    <button class="toast-close" title="Dismiss">✕</button>
  `;
  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  dom.toastContainer.appendChild(toast);
  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
  return toast;
}
window.showToast = showToast;

function dismissToast(toast) {
  toast.classList.add('toast-out');
  setTimeout(() => toast.remove(), 250);
}

/* ================================================================
   26. BREADCRUMBS
   ================================================================ */
function updateBreadcrumbs() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !tab.filePath || state.imagePreviewActive) {
    dom.breadcrumbsBar.classList.add('hidden');
    return;
  }
  dom.breadcrumbsBar.classList.remove('hidden');
  dom.breadcrumbs.innerHTML = '';

  const fullPath = tab.filePath;
  const psep = _pathSep(fullPath);
  const pathParts = fullPath.split(/[/\\]/);

  // Determine display parts (relative if folder is open)
  let displayStart = 0;
  if (state.folderPath) {
    const folderParts = state.folderPath.split(/[/\\]/);
    if (fullPath.startsWith(state.folderPath + '/') || fullPath.startsWith(state.folderPath + '\\')) {
      displayStart = folderParts.length;
    }
  }

  // If no folder open, show from root (skip empty first element from leading /)
  if (displayStart === 0 && pathParts[0] === '') displayStart = 1;

  for (let i = displayStart; i < pathParts.length; i++) {
    if (i > displayStart) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      dom.breadcrumbs.appendChild(sep);
    }
    const isLast = i === pathParts.length - 1;
    const crumb = document.createElement('span');
    crumb.className = 'breadcrumb-item' + (isLast ? ' active' : '');
    crumb.textContent = pathParts[i];

    // Store the full absolute path up to this segment
    const segmentPath = pathParts.slice(0, i + 1).join(psep);
    crumb.dataset.fullPath = segmentPath;
    crumb.dataset.isFile = isLast ? '1' : '0';

    // Right-click context menu
    crumb.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showBreadcrumbContextMenu(e.clientX, e.clientY, segmentPath, isLast);
    });

    // Left-click: reveal folder in Finder / open file
    crumb.addEventListener('click', () => {
      if (!isLast) {
        window.apexStudio.revealInFinder(segmentPath);
      }
    });

    dom.breadcrumbs.appendChild(crumb);
  }
}

/* ---- Breadcrumb Context Menu ---- */
let bcContextPath = null;
let bcContextIsFile = false;

function showBreadcrumbContextMenu(x, y, fullPath, isFile) {
  bcContextPath = fullPath;
  bcContextIsFile = isFile;
  const menu = $('#breadcrumb-context-menu');
  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 150) + 'px';
}

function hideBreadcrumbContextMenu() {
  $('#breadcrumb-context-menu').classList.add('hidden');
}

function initBreadcrumbContextMenu() {
  document.addEventListener('click', hideBreadcrumbContextMenu);

  $('#breadcrumb-context-menu').addEventListener('click', async (e) => {
    const action = e.target.closest('.ctx-item')?.dataset.action;
    if (!action) return;
    hideBreadcrumbContextMenu();
    if (!bcContextPath) return;

    // For file items, get the parent directory for terminal/finder operations
    const dirPath = bcContextIsFile
      ? dirName(bcContextPath)
      : bcContextPath;

    switch (action) {
      case 'bc-reveal-finder':
        try { await window.apexStudio.revealInFinder(bcContextPath); } catch (err) { console.error(err); }
        break;
      case 'bc-open-terminal':
        try { await window.apexStudio.openInTerminal(dirPath); } catch (err) { console.error(err); }
        break;
      case 'bc-copy-path':
        await navigator.clipboard.writeText(bcContextPath);
        showToast('Path copied', 'success', 1500);
        break;
    }
  });
}

/* ================================================================
   27. IMAGE PREVIEW
   ================================================================ */
async function showImagePreview(filePath) {
  state.imagePreviewActive = true;
  dom.imagePreview.classList.remove('hidden');
  dom.editorSplitContainer.style.display = 'none';
  dom.breadcrumbsBar.classList.add('hidden');

  const ext = filePath.split('.').pop().toLowerCase();
  if (ext === 'svg') {
    // SVG can be loaded directly
    const content = await window.apexStudio.readFile(filePath);
    dom.imagePreviewImg.src = 'data:image/svg+xml;base64,' + btoa(content);
  } else {
    const base64 = await window.apexStudio.readBinary(filePath);
    if (base64) {
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', tiff: 'image/tiff', tif: 'image/tiff' };
      dom.imagePreviewImg.src = `data:${mime[ext] || 'image/png'};base64,${base64}`;
    }
  }

  // Show file info
  try {
    const stat = await window.apexStudio.stat(filePath);
    const size = stat?.size || 0;
    const sizeStr = size > 1024*1024 ? (size/1024/1024).toFixed(1) + ' MB' : size > 1024 ? (size/1024).toFixed(1) + ' KB' : size + ' B';
    dom.imagePreviewInfo.textContent = `${filePath.split(/[/\\]/).pop()} — ${sizeStr}`;
  } catch {
    dom.imagePreviewInfo.textContent = filePath.split(/[/\\]/).pop();
  }
}

function hideImagePreview() {
  if (!state.imagePreviewActive) return;
  state.imagePreviewActive = false;
  dom.imagePreview.classList.add('hidden');
  dom.editorSplitContainer.style.display = '';
  updateBreadcrumbs();
}

/* ================================================================
   28. MARKDOWN PREVIEW
   ================================================================ */
async function toggleMarkdownPreview() {
  state.markdownPreviewVisible = !state.markdownPreviewVisible;
  if (state.markdownPreviewVisible) {
    dom.markdownPreview.classList.remove('hidden');
    await updateMarkdownPreview();
  } else {
    dom.markdownPreview.classList.add('hidden');
  }
  // Trigger editor relayout since space changed
  if (state.editor) state.editor.layout();
  if (state.splitEditor) state.splitEditor.layout();
}

async function updateMarkdownPreview() {
  if (!state.markdownPreviewVisible) return;
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;
  const lang = tab.model.getLanguageId?.() || '';
  if (lang !== 'markdown') {
    dom.markdownContent.innerHTML = '<div class="outline-empty">Open a Markdown file to see preview</div>';
    return;
  }
  const content = tab.model.getValue();
  try {
    const html = await window.apexStudio.renderMarkdown(content);
    dom.markdownContent.innerHTML = html || '';
  } catch {
    dom.markdownContent.innerHTML = '<div class="outline-empty">Error rendering markdown</div>';
  }
}

function initMarkdownPreview() {
  $('#btn-close-md-preview')?.addEventListener('click', () => {
    state.markdownPreviewVisible = false;
    dom.markdownPreview.classList.add('hidden');
  });
}

/* ================================================================
   29. OUTLINE / SYMBOL VIEW
   ================================================================ */
function toggleOutlineSection() {
  state.outlineSectionOpen = !state.outlineSectionOpen;
  dom.outlineToggleIcon.textContent = state.outlineSectionOpen ? '▼' : '▶';
  dom.outlineList.classList.toggle('collapsed', !state.outlineSectionOpen);
  if (state.outlineSectionOpen) updateOutline();
}

async function updateOutline() {
  if (!state.outlineSectionOpen) return;
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !tab.model) {
    dom.outlineList.innerHTML = '<div class="outline-empty">No symbols</div>';
    return;
  }

  // Use simple regex-based symbol extraction (Monaco's getDocumentSymbols requires LSP)
  const content = tab.model.getValue();
  const symbols = extractSymbols(content, tab.model.getLanguageId?.() || 'plaintext');

  dom.outlineList.innerHTML = '';
  if (symbols.length === 0) {
    dom.outlineList.innerHTML = '<div class="outline-empty">No symbols found</div>';
    return;
  }

  for (const sym of symbols) {
    const item = document.createElement('div');
    item.className = 'outline-item';
    item.style.paddingLeft = `${12 + (sym.depth || 0) * 12}px`;
    item.innerHTML = `
      <span class="outline-icon">${sym.icon}</span>
      <span class="outline-name">${escHtml(sym.name)}</span>
      <span class="outline-detail">${sym.detail || ''}</span>
    `;
    item.addEventListener('click', () => {
      if (state.editor && sym.line) {
        state.editor.revealLineInCenter(sym.line);
        state.editor.setPosition({ lineNumber: sym.line, column: 1 });
        state.editor.focus();
      }
    });
    dom.outlineList.appendChild(item);
  }
}

function extractSymbols(content, lang) {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Functions
    let m;
    if ((m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/))) {
      symbols.push({ name: m[1], icon: 'ƒ', detail: 'function', line: lineNum, depth: 0 });
    }
    // Arrow functions / const functions
    else if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/))) {
      symbols.push({ name: m[1], icon: 'ƒ', detail: 'arrow fn', line: lineNum, depth: 0 });
    }
    // Classes
    else if ((m = line.match(/^\s*(?:export\s+)?class\s+(\w+)/))) {
      symbols.push({ name: m[1], icon: 'C', detail: 'class', line: lineNum, depth: 0 });
    }
    // Methods (inside class)
    else if ((m = line.match(/^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/)) && !line.match(/^\s*(if|for|while|switch|catch)\s/)) {
      symbols.push({ name: m[1], icon: 'm', detail: 'method', line: lineNum, depth: 1 });
    }
    // Python def/class
    else if (lang === 'python') {
      if ((m = line.match(/^(\s*)def\s+(\w+)/))) {
        symbols.push({ name: m[2], icon: 'ƒ', detail: 'def', line: lineNum, depth: m[1].length > 0 ? 1 : 0 });
      } else if ((m = line.match(/^class\s+(\w+)/))) {
        symbols.push({ name: m[1], icon: 'C', detail: 'class', line: lineNum, depth: 0 });
      }
    }
    // Markdown headings
    else if (lang === 'markdown' && (m = line.match(/^(#{1,6})\s+(.+)/))) {
      symbols.push({ name: m[2], icon: 'H', detail: `h${m[1].length}`, line: lineNum, depth: m[1].length - 1 });
    }
    // HTML/JSX tags (top-level components)
    else if (['html', 'xml'].includes(lang) && (m = line.match(/^<(\w+)[\s>]/))) {
      if (!['div', 'span', 'p', 'br', 'hr', 'a', 'li', 'ul', 'ol', 'img'].includes(m[1].toLowerCase())) {
        symbols.push({ name: `<${m[1]}>`, icon: '◇', detail: 'element', line: lineNum, depth: 0 });
      }
    }
    // CSS selectors
    else if (lang === 'css' || lang === 'scss') {
      if ((m = line.match(/^([.#]?[\w-]+(?:\s*[,>+~]\s*[.#]?[\w-]+)*)\s*\{/))) {
        symbols.push({ name: m[1].trim(), icon: '◻', detail: 'rule', line: lineNum, depth: 0 });
      }
    }
    // Interface / type (TypeScript)
    else if (lang === 'typescript' && (m = line.match(/^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/))) {
      symbols.push({ name: m[1], icon: 'I', detail: m[0].includes('interface') ? 'interface' : 'type', line: lineNum, depth: 0 });
    }
  }
  return symbols;
}

/* ================================================================
   29b. FILE HISTORY (Git Commit History)
   ================================================================ */

function toggleHistorySection() {
  state.historySectionOpen = !state.historySectionOpen;
  dom.historyToggleIcon.textContent = state.historySectionOpen ? '▼' : '▶';
  dom.historyList.classList.toggle('collapsed', !state.historySectionOpen);
  if (state.historySectionOpen) {
    // Auto-show history for current file
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab?.filePath) {
      showFileHistoryInPanel(tab.filePath);
    } else {
      dom.historyList.innerHTML = '<div class="history-empty">Open a file to see its git history</div>';
    }
  }
}

async function showFileHistoryInPanel(filePath) {
  // Open history section if not already open
  if (!state.historySectionOpen) {
    state.historySectionOpen = true;
    dom.historyToggleIcon.textContent = '▼';
    dom.historyList.classList.remove('collapsed');
  }
  // Make sure sidebar is visible
  if (!state.sidebarVisible) {
    state.sidebarVisible = true;
    applySidebarState();
  }

  if (!filePath || !state.folderPath) {
    dom.historyList.innerHTML = '<div class="history-empty">No git repository open</div>';
    return;
  }

  const name = filePath.split(/[/\\]/).pop();
  const relPath = filePath.replace(state.folderPath + '/', '');

  // Show loading state
  dom.historyList.innerHTML = `<div class="history-empty">Loading git history for ${escHtml(name)}…</div>`;

  try {
    const commits = await window.apexStudio.gitFileLog(state.folderPath, relPath, 50);
    if (!commits || commits.length === 0) {
      dom.historyList.innerHTML = `<div class="history-empty">No git history for ${escHtml(name)}</div>`;
      return;
    }

    dom.historyList.innerHTML = '';

    // File header
    const fileHeader = document.createElement('div');
    fileHeader.className = 'history-day-header';
    fileHeader.style.display = 'flex';
    fileHeader.style.justifyContent = 'space-between';
    fileHeader.style.alignItems = 'center';
    fileHeader.innerHTML = `<span>📄 ${escHtml(name)}</span><span class="history-commit-count">${commits.length} commit${commits.length > 1 ? 's' : ''}</span>`;
    dom.historyList.appendChild(fileHeader);

    // Group commits by date
    const groups = {};
    for (const commit of commits) {
      const d = new Date(commit.date);
      const key = d.toDateString();
      if (!groups[key]) groups[key] = [];
      groups[key].push(commit);
    }

    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    for (const [day, dayCommits] of Object.entries(groups)) {
      const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : day;
      const dayHeader = document.createElement('div');
      dayHeader.className = 'history-day-header';
      dayHeader.textContent = label;
      dom.historyList.appendChild(dayHeader);

      for (const commit of dayCommits) {
        const item = document.createElement('div');
        item.className = 'history-commit-item';
        const timeStr = new Date(commit.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const shortMsg = commit.message.length > 60 ? commit.message.slice(0, 57) + '…' : commit.message;
        item.innerHTML = `
          <div class="history-commit-row">
            <span class="history-commit-hash">${commit.hash}</span>
            <span class="history-commit-time">${timeStr}</span>
          </div>
          <div class="history-commit-msg">${escHtml(shortMsg)}</div>
          <div class="history-commit-author">${escHtml(commit.author)}</div>
        `;
        item.title = `${commit.hash} — ${commit.message}\nby ${commit.author}`;
        item.addEventListener('click', () => {
          showCommitDiff(filePath, relPath, commit);
        });
        dom.historyList.appendChild(item);
      }
    }
  } catch (err) {
    dom.historyList.innerHTML = `<div class="history-empty">Error loading history: ${escHtml(err.message)}</div>`;
  }
}

async function showCommitDiff(absPath, relPath, commit) {
  try {
    // Fetch the file content at this commit
    const content = await window.apexStudio.gitShowAt(
      state.folderPath, commit.fullHash, relPath
    );

    if (content === null || content === undefined) {
      showToast(`Cannot load file at commit ${commit.hash}`, 'error', 3000);
      return;
    }

    const fileName = relPath.split(/[/\\]/).pop();
    const viewTitle = `${commit.hash} — ${fileName}`;
    const existingTab = state.tabs.find(t => t.title === viewTitle);
    if (existingTab) { activateTab(existingTab.id); return; }

    const lang = guessLanguage(relPath);
    const tab = createTab(viewTitle, null, '', lang);
    tab._isDiff = true;
    tab._isCommitDiff = true;
    tab._commitContent = content;
    tab._commitLang = lang;
    tab._commitInfo = commit;
    renderCommitViewer(tab);
  } catch (err) {
    console.error('[FileHistory] showCommitDiff error', err);
    showToast(`Diff error: ${err.message}`, 'error', 5000);
  }
}

/* ================================================================
   30. ZEN MODE
   ================================================================ */
function toggleZenMode() {
  state.zenMode = !state.zenMode;
  document.body.classList.toggle('zen-mode', state.zenMode);
  if (state.zenMode) {
    showToast('Zen Mode enabled. Press Escape to exit.', 'info', 3000);
  }
  // Re-layout editor
  if (state.editor) state.editor.layout();
  if (state.splitEditor) state.splitEditor.layout();
}

/* ================================================================
   31. SPLIT EDITOR
   ================================================================ */
function toggleSplitEditor() {
  if (state.splitActive) {
    closeSplitEditor();
  } else {
    openSplitEditor();
  }
}

function openSplitEditor() {
  if (state.splitActive || !state.editor) return;
  state.splitActive = true;
  dom.splitResizer.classList.remove('hidden');
  dom.editorSecondary.classList.remove('hidden');

  const tab = state.tabs.find(t => t.id === state.activeTabId);
  state.splitEditor = monaco.editor.create(dom.editorSecondary, {
    value: '',
    language: 'plaintext',
    theme: monacoThemeId(state.theme),
    fontSize: state.editor.getOption(monaco.editor.EditorOption.fontSize),
    fontFamily: "'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
    minimap: { enabled: false },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    readOnly: false,
    autoClosingBrackets: 'always',
    autoClosingQuotes: 'always',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true },
  });

  // Share the same model as the primary editor
  if (tab && tab.model) {
    state.splitEditor.setModel(tab.model);
  }

  initSplitResizer();
  state.editor.layout();
  state.splitEditor.layout();
  showToast('Split editor opened', 'info', 2000);
}

function closeSplitEditor() {
  if (!state.splitActive) return;
  state.splitActive = false;
  if (state.splitEditor) {
    state.splitEditor.dispose();
    state.splitEditor = null;
  }
  dom.splitResizer.classList.add('hidden');
  dom.editorSecondary.classList.add('hidden');
  dom.editorSecondary.innerHTML = '';
  state.editor?.layout();
}

function initSplitResizer() {
  let isResizing = false;
  const resizer = dom.splitResizer;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  const onMove = (e) => {
    if (!isResizing) return;
    const rect = dom.editorSplitContainer.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const clamped = Math.max(20, Math.min(80, pct));
    dom.editorContainer.style.flex = `0 0 ${clamped}%`;
    dom.editorSecondary.style.flex = `0 0 ${100 - clamped}%`;
    state.editor?.layout();
    state.splitEditor?.layout();
  };

  const onUp = () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/* ================================================================
   32. TAB DRAG REORDER
   ================================================================ */
function makeTabDraggable(el, tab) {
  el.setAttribute('draggable', 'true');

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', tab.id.toString());
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    $$('.tab').forEach(t => { t.classList.remove('drag-over-left', 'drag-over-right'); });
  });

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    el.classList.toggle('drag-over-left', e.clientX < midX);
    el.classList.toggle('drag-over-right', e.clientX >= midX);
  });

  el.addEventListener('dragleave', () => {
    el.classList.remove('drag-over-left', 'drag-over-right');
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over-left', 'drag-over-right');
    const draggedId = parseInt(e.dataTransfer.getData('text/plain'));
    const targetId = tab.id;
    if (draggedId === targetId) return;

    const fromIdx = state.tabs.findIndex(t => t.id === draggedId);
    const toIdx = state.tabs.findIndex(t => t.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const rect = el.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const insertBefore = e.clientX < midX;

    // Remove from current position
    const [moved] = state.tabs.splice(fromIdx, 1);
    // Insert at new position
    let newIdx = state.tabs.findIndex(t => t.id === targetId);
    if (!insertBefore) newIdx++;
    state.tabs.splice(newIdx, 0, moved);
    renderTabs();
  });
}

/* ================================================================
   33. FILE WATCHER
   ================================================================ */
let fileWatchDebounce = null;

function initFileWatcher() {
  window.apexStudio.on('watch:change', (data) => {
    // Debounce tree refresh to avoid excessive updates
    clearTimeout(fileWatchDebounce);
    fileWatchDebounce = setTimeout(async () => {
      if (state.folderPath) {
        await refreshTree();
        // Also check if any open file was modified externally
        const tab = state.tabs.find(t => t.filePath === data.path);
        if (tab && data.event === 'change') {
          try {
            const content = await window.apexStudio.readFile(data.path);
            if (content !== null && content !== tab.model.getValue()) {
              // File changed externally — update if not modified by user
              if (!tab.modified) {
                tab.model.setValue(content);
                showToast(`${tab.title} changed on disk`, 'info', 2000);
              }
            }
          } catch {}
        }
      }
    }, 500);
  });
}

async function startWatching(dirPath) {
  try {
    await window.apexStudio.watchFolder(dirPath);
  } catch (err) {
    console.error('startWatching error:', err);
  }
}

async function stopWatching(dirPath) {
  try {
    await window.apexStudio.unwatchFolder(dirPath);
  } catch {}
}

/* ================================================================
   34. GIT INTEGRATION
   ================================================================ */
let gitRefreshTimer = null;

async function refreshGitStatus() {
  if (!state.folderPath) {
    state.gitStatus = null;
    dom.statusGit.classList.add('hidden');
    return;
  }
  try {
    const status = await window.apexStudio.gitStatus(state.folderPath);
    state.gitStatus = status;
    if (status) {
      dom.statusGit.classList.remove('hidden');
      let text = `⎇ ${status.branch || 'unknown'}`;
      if (status.ahead > 0) text += ` ↑${status.ahead}`;
      if (status.behind > 0) text += ` ↓${status.behind}`;
      const changedCount = Object.keys(status.files).length;
      if (changedCount > 0) text += ` · ${changedCount} changed`;
      dom.statusGit.textContent = text;
    } else {
      dom.statusGit.classList.add('hidden');
    }
  } catch {
    dom.statusGit.classList.add('hidden');
  }
}

function scheduleGitRefresh() {
  clearTimeout(gitRefreshTimer);
  gitRefreshTimer = setTimeout(refreshGitStatus, 2000);
}

function getGitBadge(filePath) {
  if (!state.gitStatus || !state.gitStatus.files || !state.folderPath) return '';
  const rel = filePath.replace(state.folderPath + '/', '');
  const status = state.gitStatus.files[rel];
  if (!status) return '';
  const classes = {
    modified: 'git-badge-modified',
    added: 'git-badge-added',
    deleted: 'git-badge-deleted',
    untracked: 'git-badge-untracked',
  };
  const labels = { modified: 'M', added: 'A', deleted: 'D', untracked: 'U' };
  return `<span class="git-badge ${classes[status] || ''}">${labels[status] || '?'}</span>`;
}

/* ================================================================
   35. SETTINGS UI
   ================================================================ */
async function loadSettings() {
  try {
    state.settings = await window.apexStudio.readSettings();
  } catch {
    state.settings = {};
  }
  return state.settings;
}

async function saveSettings(newSettings) {
  state.settings = { ...state.settings, ...newSettings };
  await window.apexStudio.writeSettings(state.settings);
}

function openSettingsTab() {
  // Create a special settings tab
  const existing = state.tabs.find(t => t.title === '⚙ Settings');
  if (existing) { activateTab(existing.id); return; }

  const tab = createTab('⚙ Settings', null, '', 'plaintext');
  // Mark settings tab specially
  tab._isSettings = true;
  renderSettingsUI();
}

function renderSettingsUI() {
  const tab = state.tabs.find(t => t._isSettings && t.id === state.activeTabId);
  if (!tab) return;

  // Hide editor, show settings in its place
  dom.editorContainer.style.display = 'none';
  dom.imagePreview.classList.add('hidden');

  // Create settings container (reuse or create)
  let container = $('#settings-ui');
  if (!container) {
    container = document.createElement('div');
    container.id = 'settings-ui';
    container.className = 'settings-container';
    dom.editorSplitContainer.appendChild(container);
  }
  container.style.display = '';

  const s = state.settings || {};
  container.innerHTML = `
    <h2>Settings</h2>
    <div class="settings-group">
      <div class="settings-group-title">Editor</div>
      <div class="setting-row">
        <div><div class="setting-label">Font Size</div><div class="setting-desc">Controls the font size in pixels</div></div>
        <div class="setting-control"><input type="number" id="set-fontSize" value="${s.fontSize || 14}" min="8" max="40" /></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Tab Size</div><div class="setting-desc">Number of spaces per tab</div></div>
        <div class="setting-control"><input type="number" id="set-tabSize" value="${s.tabSize || 2}" min="1" max="8" /></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Word Wrap</div><div class="setting-desc">Controls how lines should wrap</div></div>
        <div class="setting-control">
          <select id="set-wordWrap">
            <option value="off" ${s.wordWrap === 'off' ? 'selected' : ''}>Off</option>
            <option value="on" ${s.wordWrap === 'on' ? 'selected' : ''}>On</option>
            <option value="wordWrapColumn" ${s.wordWrap === 'wordWrapColumn' ? 'selected' : ''}>Word Wrap Column</option>
            <option value="bounded" ${s.wordWrap === 'bounded' ? 'selected' : ''}>Bounded</option>
          </select>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Minimap</div><div class="setting-desc">Show minimap overview</div></div>
        <div class="setting-control"><input type="checkbox" id="set-minimap" ${s.minimap !== false ? 'checked' : ''} /></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Line Numbers</div><div class="setting-desc">Controls line number visibility</div></div>
        <div class="setting-control">
          <select id="set-lineNumbers">
            <option value="on" ${s.lineNumbers === 'on' ? 'selected' : ''}>On</option>
            <option value="off" ${s.lineNumbers === 'off' ? 'selected' : ''}>Off</option>
            <option value="relative" ${s.lineNumbers === 'relative' ? 'selected' : ''}>Relative</option>
          </select>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Bracket Pair Colorization</div><div class="setting-desc">Color matching brackets</div></div>
        <div class="setting-control"><input type="checkbox" id="set-bracketColor" ${s.bracketPairColorization !== false ? 'checked' : ''} /></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Smooth Scrolling</div><div class="setting-desc">Animate scrolling</div></div>
        <div class="setting-control"><input type="checkbox" id="set-smoothScroll" ${s.smoothScrolling !== false ? 'checked' : ''} /></div>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">Files</div>
      <div class="setting-row">
        <div><div class="setting-label">Auto Save</div><div class="setting-desc">Automatically save files after editing</div></div>
        <div class="setting-control"><input type="checkbox" id="set-autoSave" ${s.autoSave !== false ? 'checked' : ''} /></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Auto Save Delay</div><div class="setting-desc">Delay in ms before auto saving</div></div>
        <div class="setting-control"><input type="number" id="set-autoSaveDelay" value="${s.autoSaveDelay || 3000}" min="500" max="30000" step="500" /></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Trim Trailing Whitespace</div><div class="setting-desc">Remove trailing whitespace on save</div></div>
        <div class="setting-control"><input type="checkbox" id="set-trimWhitespace" ${s.trimTrailingWhitespace !== false ? 'checked' : ''} /></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Insert Final Newline</div><div class="setting-desc">Ensure file ends with a newline on save</div></div>
        <div class="setting-control"><input type="checkbox" id="set-finalNewline" ${s.insertFinalNewline !== false ? 'checked' : ''} /></div>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">Appearance</div>
      <div class="setting-row">
        <div><div class="setting-label">Theme</div><div class="setting-desc">Current color theme</div></div>
        <div class="setting-control">
          <select id="set-theme">
            ${THEMES.map(t => `<option value="${t.id}" ${state.theme === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Cursor Blinking</div><div class="setting-desc">Controls cursor animation style</div></div>
        <div class="setting-control">
          <select id="set-cursorBlinking">
            <option value="blink" ${s.cursorBlinking === 'blink' ? 'selected' : ''}>Blink</option>
            <option value="smooth" ${s.cursorBlinking === 'smooth' ? 'selected' : ''}>Smooth</option>
            <option value="phase" ${s.cursorBlinking === 'phase' ? 'selected' : ''}>Phase</option>
            <option value="expand" ${s.cursorBlinking === 'expand' ? 'selected' : ''}>Expand</option>
            <option value="solid" ${s.cursorBlinking === 'solid' ? 'selected' : ''}>Solid</option>
          </select>
        </div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Render Whitespace</div><div class="setting-desc">How to render whitespace characters</div></div>
        <div class="setting-control">
          <select id="set-renderWhitespace">
            <option value="none" ${s.renderWhitespace === 'none' ? 'selected' : ''}>None</option>
            <option value="selection" ${s.renderWhitespace === 'selection' ? 'selected' : ''}>Selection</option>
            <option value="boundary" ${s.renderWhitespace === 'boundary' ? 'selected' : ''}>Boundary</option>
            <option value="all" ${s.renderWhitespace === 'all' ? 'selected' : ''}>All</option>
          </select>
        </div>
      </div>
    </div>
  `;

  // Wire up change handlers
  const onChange = debounce(async () => {
    const newSettings = {
      fontSize: parseInt($('#set-fontSize').value) || 14,
      tabSize: parseInt($('#set-tabSize').value) || 2,
      wordWrap: $('#set-wordWrap').value,
      minimap: $('#set-minimap').checked,
      lineNumbers: $('#set-lineNumbers').value,
      bracketPairColorization: $('#set-bracketColor').checked,
      smoothScrolling: $('#set-smoothScroll').checked,
      autoSave: $('#set-autoSave').checked,
      autoSaveDelay: parseInt($('#set-autoSaveDelay').value) || 3000,
      trimTrailingWhitespace: $('#set-trimWhitespace').checked,
      insertFinalNewline: $('#set-finalNewline').checked,
      theme: $('#set-theme').value,
      cursorBlinking: $('#set-cursorBlinking').value,
      renderWhitespace: $('#set-renderWhitespace').value,
    };

    await saveSettings(newSettings);

    // Apply settings to editor
    if (state.editor) {
      state.editor.updateOptions({
        fontSize: newSettings.fontSize,
        tabSize: newSettings.tabSize,
        wordWrap: newSettings.wordWrap,
        minimap: { enabled: newSettings.minimap },
        lineNumbers: newSettings.lineNumbers,
        bracketPairColorization: { enabled: newSettings.bracketPairColorization },
        smoothScrolling: newSettings.smoothScrolling,
        cursorBlinking: newSettings.cursorBlinking,
        renderWhitespace: newSettings.renderWhitespace,
      });
    }

    // Apply theme if changed
    if (newSettings.theme !== state.theme) {
      applyTheme(newSettings.theme);
    }

    showToast('Settings saved', 'success', 1500);
  }, 500);

  container.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('change', onChange);
    el.addEventListener('input', onChange);
  });
}

function hideSettingsUI() {
  const container = $('#settings-ui');
  if (container) container.style.display = 'none';
  dom.editorContainer.style.display = '';
}

/* ================================================================
   36. COLOR PICKER (Monaco built-in)
   ================================================================ */
function registerColorProvider() {
  // Monaco has built-in color detection for CSS/SCSS/LESS
  // Register a color provider for other languages that use hex colors
  if (typeof monaco === 'undefined') return;
  const colorLangs = ['javascript', 'typescript', 'json', 'html', 'python'];
  for (const lang of colorLangs) {
    monaco.languages.registerColorProvider(lang, {
      provideDocumentColors(model) {
        const colors = [];
        const text = model.getValue();
        const hexRegex = /#([0-9a-fA-F]{3,8})\b/g;
        let match;
        while ((match = hexRegex.exec(text))) {
          const hex = match[1];
          let r, g, b, a = 1;
          if (hex.length === 3) {
            r = parseInt(hex[0]+hex[0], 16) / 255;
            g = parseInt(hex[1]+hex[1], 16) / 255;
            b = parseInt(hex[2]+hex[2], 16) / 255;
          } else if (hex.length === 6) {
            r = parseInt(hex.slice(0,2), 16) / 255;
            g = parseInt(hex.slice(2,4), 16) / 255;
            b = parseInt(hex.slice(4,6), 16) / 255;
          } else if (hex.length === 8) {
            r = parseInt(hex.slice(0,2), 16) / 255;
            g = parseInt(hex.slice(2,4), 16) / 255;
            b = parseInt(hex.slice(4,6), 16) / 255;
            a = parseInt(hex.slice(6,8), 16) / 255;
          } else continue;

          const pos = model.getPositionAt(match.index);
          const endPos = model.getPositionAt(match.index + match[0].length);
          colors.push({
            color: { red: r, green: g, blue: b, alpha: a },
            range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: endPos.lineNumber, endColumn: endPos.column },
          });
        }
        return colors;
      },
      provideColorPresentations(model, colorInfo) {
        const { red, green, blue, alpha } = colorInfo.color;
        const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
        const hex = alpha < 1
          ? `#${toHex(red)}${toHex(green)}${toHex(blue)}${toHex(alpha)}`
          : `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
        return [{ label: hex }];
      },
    });
  }
}

/* ================================================================
   37. TERMINAL PANEL
   ================================================================ */
let terminalRunning = false;

function toggleTerminal() {
  state.terminalVisible = !state.terminalVisible;
  if (state.terminalVisible) {
    showTerminal();
  } else {
    hideTerminal();
  }
}

function showTerminal() {
  state.terminalVisible = true;
  dom.terminalPanel.classList.remove('hidden');
  dom.terminalResizer.classList.remove('hidden');
  if (!state.terminalCwd) {
    state.terminalCwd = state.folderPath || '';
    if (state.terminalCwd) window.apexStudio.terminalSetCwd(state.terminalCwd);
  }
  updateTerminalCwd();
  dom.terminalInput.focus();
  if (state.editor) state.editor.layout();
  if (state.splitEditor) state.splitEditor.layout();
}

function hideTerminal() {
  state.terminalVisible = false;
  dom.terminalPanel.classList.add('hidden');
  dom.terminalResizer.classList.add('hidden');
  if (state.editor) state.editor.layout();
  if (state.splitEditor) state.splitEditor.layout();
  state.editor?.focus();
}

function updateTerminalCwd() {
  const cwd = state.terminalCwd || '~';
  const short = cwd.replace(/^\/Users\/[^/]+/, '~');
  dom.terminalCwd.textContent = short;
  dom.terminalCwd.title = cwd;
}

async function runTerminalCommand(cmd) {
  if (!cmd.trim() || terminalRunning) return;
  terminalRunning = true;
  state.terminalHistory.push(cmd);
  state.terminalHistoryIdx = state.terminalHistory.length;
  const cwd = state.terminalCwd || '~';
  const shortCwd = cwd.replace(/^\/Users\/[^/]+/, '~');
  appendTerminalLine(`${shortCwd} $ ${cmd}`, 'term-cmd');
  dom.terminalInput.value = '';
  dom.terminalInput.disabled = true;
  try {
    const result = await window.apexStudio.terminalRun(cmd);
    if (result.clear) dom.terminalOutput.innerHTML = '';
    if (result.error) appendTerminalLine(result.error, 'term-error');
    if (result.cwd) {
      state.terminalCwd = result.cwd;
      updateTerminalCwd();
    }
    if (result.code && result.code !== 0) appendTerminalLine(`exit ${result.code}`, 'term-exit');
  } catch (err) {
    appendTerminalLine(`Error: ${err.message}`, 'term-error');
  }
  terminalRunning = false;
  dom.terminalInput.disabled = false;
  dom.terminalInput.focus();
}

function appendTerminalLine(text, className) {
  const line = document.createElement('div');
  if (className) line.className = className;
  line.textContent = text;
  dom.terminalOutput.appendChild(line);
  dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
}

function appendTerminalText(text) {
  const stripped = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  if (!stripped) return;
  const span = document.createElement('span');
  span.textContent = stripped;
  dom.terminalOutput.appendChild(span);
  dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
}

function initTerminal() {
  dom.terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runTerminalCommand(dom.terminalInput.value);
      return;
    }
    if (e.ctrlKey && e.key === 'c') {
      if (terminalRunning) {
        window.apexStudio.terminalKill();
        appendTerminalLine('^C', 'term-error');
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.terminalHistoryIdx > 0) {
        state.terminalHistoryIdx--;
        dom.terminalInput.value = state.terminalHistory[state.terminalHistoryIdx] || '';
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.terminalHistoryIdx < state.terminalHistory.length - 1) {
        state.terminalHistoryIdx++;
        dom.terminalInput.value = state.terminalHistory[state.terminalHistoryIdx] || '';
      } else {
        state.terminalHistoryIdx = state.terminalHistory.length;
        dom.terminalInput.value = '';
      }
      return;
    }
  });
  $('#btn-terminal-close').addEventListener('click', hideTerminal);
  $('#btn-terminal-clear').addEventListener('click', () => { dom.terminalOutput.innerHTML = ''; });
  $('#btn-terminal-kill').addEventListener('click', () => {
    window.apexStudio.terminalKill();
    appendTerminalLine('^C (killed)', 'term-error');
  });
  // Terminal resizer
  let isResizing = false, startY = 0, startHeight = 0;
  dom.terminalResizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startY = e.clientY;
    startHeight = dom.terminalPanel.getBoundingClientRect().height;
    dom.terminalResizer.classList.add('active');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const delta = startY - e.clientY;
    const newH = Math.max(100, Math.min(600, startHeight + delta));
    dom.terminalPanel.style.height = newH + 'px';
    if (state.editor) state.editor.layout();
    if (state.splitEditor) state.splitEditor.layout();
  });
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      dom.terminalResizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

/* ================================================================
   38. LANGUAGE MODE SELECTOR
   ================================================================ */
let langPickerSelectedIndex = -1;
let langPickerAllLangs = [];

function showLanguagePicker() {
  dom.languagePickerOverlay.classList.remove('hidden');
  dom.languagePickerInput.value = '';
  dom.languagePickerInput.focus();
  langPickerAllLangs = monaco.languages.getLanguages()
    .map(l => ({ id: l.id, label: l.aliases?.[0] || l.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
  renderLanguageList(langPickerAllLangs);
}

function hideLanguagePicker() {
  dom.languagePickerOverlay.classList.add('hidden');
}

function renderLanguageList(langs) {
  dom.languagePickerResults.innerHTML = '';
  langPickerSelectedIndex = langs.length > 0 ? 0 : -1;
  const currentLang = state.editor?.getModel()?.getLanguageId?.() || 'plaintext';
  for (let i = 0; i < langs.length; i++) {
    const l = langs[i];
    const item = document.createElement('div');
    item.className = 'cp-item' + (i === 0 ? ' selected' : '');
    const check = l.id === currentLang ? '\u2713 ' : '';
    item.innerHTML = `<span>${check}${escHtml(l.label)}</span><span class="shortcut">${l.id}</span>`;
    item.addEventListener('click', () => { changeLanguage(l.id, l.label); hideLanguagePicker(); });
    item.addEventListener('mouseenter', () => langPickerUpdateSelected(i, false));
    dom.languagePickerResults.appendChild(item);
  }
}

function langPickerUpdateSelected(idx, scroll = true) {
  const items = dom.languagePickerResults.querySelectorAll('.cp-item');
  if (items.length === 0) return;
  items.forEach(el => el.classList.remove('selected'));
  langPickerSelectedIndex = Math.max(0, Math.min(idx, items.length - 1));
  items[langPickerSelectedIndex].classList.add('selected');
  if (scroll) items[langPickerSelectedIndex].scrollIntoView({ block: 'nearest' });
}

function changeLanguage(langId, label) {
  const model = state.editor?.getModel();
  if (!model) return;
  monaco.editor.setModelLanguage(model, langId);
  dom.statusLanguage.textContent = label || langId;
  showToast(`Language mode: ${label || langId}`, 'info', 2000);
}

function initLanguagePicker() {
  dom.languagePickerInput.addEventListener('input', () => {
    const q = dom.languagePickerInput.value.toLowerCase();
    const filtered = q
      ? langPickerAllLangs.filter(l => l.label.toLowerCase().includes(q) || l.id.toLowerCase().includes(q))
      : langPickerAllLangs;
    renderLanguageList(filtered);
  });
  dom.languagePickerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideLanguagePicker(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); langPickerUpdateSelected(langPickerSelectedIndex + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); langPickerUpdateSelected(langPickerSelectedIndex - 1); return; }
    if (e.key === 'Enter') {
      const items = dom.languagePickerResults.querySelectorAll('.cp-item');
      const target = langPickerSelectedIndex >= 0 && items[langPickerSelectedIndex] ? items[langPickerSelectedIndex] : items[0];
      if (target) target.click();
    }
  });
  dom.languagePickerOverlay.addEventListener('click', (e) => {
    if (e.target === dom.languagePickerOverlay) hideLanguagePicker();
  });
  dom.statusLanguage.addEventListener('click', showLanguagePicker);
}

/* ================================================================
   39. DIFF VIEWER
   ================================================================ */
async function showDiffForCurrentFile() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !tab.filePath || !state.folderPath) {
    showToast('Open a file in a git repository first', 'warning', 3000);
    return;
  }
  const relPath = tab.filePath.replace(state.folderPath + '/', '');
  await showDiffView(relPath, tab.filePath);
}

async function showDiffView(relPath, absPath) {
  try {
    const original = await window.apexStudio.gitShow(state.folderPath, relPath);
    if (original == null) {
      showToast('No previous version found (new file or not in git)', 'info', 3000);
      return;
    }
    const current = await window.apexStudio.readFile(absPath);
    if (current == null) return;
    const diffTitle = `\u2194 ${relPath.split(/[/\\]/).pop()}`;
    const existingDiff = state.tabs.find(t => t.title === diffTitle);
    if (existingDiff) { activateTab(existingDiff.id); return; }
    const tab = createTab(diffTitle, null, '', guessLanguage(relPath));
    tab._isDiff = true;
    tab._diffOriginal = original;
    tab._diffModified = current;
    tab._diffLang = guessLanguage(relPath);
    renderDiffEditor(tab);
  } catch (err) {
    showToast(`Diff error: ${err.message}`, 'error', 3000);
  }
}

// Render a read-only Monaco editor showing file content at a specific commit
function renderCommitViewer(tab) {
  dom.editorContainer.style.display = 'none';
  hideSettingsUI();
  hideImagePreview();
  hideDiffEditor();
  let commitContainer = $('#commit-viewer-container');
  if (!commitContainer) {
    commitContainer = document.createElement('div');
    commitContainer.id = 'commit-viewer-container';
    commitContainer.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';
    dom.editorSplitContainer.appendChild(commitContainer);
  }
  commitContainer.style.display = 'flex';
  if (tab._commitEditor) { try { tab._commitEditor.dispose(); } catch {} tab._commitEditor = null; }
  commitContainer.innerHTML = '';

  // Commit info banner
  if (tab._commitInfo) {
    const ci = tab._commitInfo;
    const d = new Date(ci.date);
    const dateStr = d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const banner = document.createElement('div');
    banner.className = 'diff-commit-banner';
    banner.innerHTML = `
      <div class="diff-commit-banner-row">
        <span class="diff-commit-banner-hash">${escHtml(ci.hash)}</span>
        <span class="diff-commit-banner-date">${escHtml(dateStr)}</span>
      </div>
      <div class="diff-commit-banner-msg">${escHtml(ci.message)}</div>
      <div class="diff-commit-banner-author">by ${escHtml(ci.author)}</div>
    `;
    commitContainer.appendChild(banner);
  }

  const editorWrapper = document.createElement('div');
  editorWrapper.style.cssText = 'flex:1;overflow:hidden;';
  commitContainer.appendChild(editorWrapper);

  const commitEditor = monaco.editor.create(editorWrapper, {
    value: tab._commitContent || '',
    language: tab._commitLang || 'plaintext',
    theme: monacoThemeId(state.theme),
    automaticLayout: true,
    readOnly: true,
    fontSize: state.editor.getOption(monaco.editor.EditorOption.fontSize),
    fontFamily: "'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
  });
  tab._commitEditor = commitEditor;
}

function hideCommitViewer() {
  for (const t of state.tabs) {
    if (t._commitEditor) { try { t._commitEditor.dispose(); } catch {} t._commitEditor = null; }
  }
  const c = $('#commit-viewer-container');
  if (c) c.style.display = 'none';
}

function renderDiffEditor(tab) {
  dom.editorContainer.style.display = 'none';
  hideSettingsUI();
  hideImagePreview();
  hideCommitViewer();
  let diffContainer = $('#diff-container');
  if (!diffContainer) {
    diffContainer = document.createElement('div');
    diffContainer.id = 'diff-container';
    diffContainer.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';
    dom.editorSplitContainer.appendChild(diffContainer);
  }
  diffContainer.style.display = 'flex';
  if (tab._diffEditor) { try { tab._diffEditor.dispose(); } catch {} tab._diffEditor = null; }
  diffContainer.innerHTML = '';

  // Commit info banner (only for commit diffs)
  if (tab._commitInfo) {
    const ci = tab._commitInfo;
    const d = new Date(ci.date);
    const dateStr = d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const banner = document.createElement('div');
    banner.className = 'diff-commit-banner';
    banner.innerHTML = `
      <div class="diff-commit-banner-row">
        <span class="diff-commit-banner-hash">${escHtml(ci.hash)}</span>
        <span class="diff-commit-banner-date">${escHtml(dateStr)}</span>
      </div>
      <div class="diff-commit-banner-msg">${escHtml(ci.message)}</div>
      <div class="diff-commit-banner-author">by ${escHtml(ci.author)}</div>
    `;
    diffContainer.appendChild(banner);
  }

  const editorWrapper = document.createElement('div');
  editorWrapper.style.cssText = 'flex:1;overflow:hidden;';
  diffContainer.appendChild(editorWrapper);

  if (!tab._diffOriginalModel) tab._diffOriginalModel = monaco.editor.createModel(tab._diffOriginal, tab._diffLang);
  if (!tab._diffModifiedModel) tab._diffModifiedModel = monaco.editor.createModel(tab._diffModified, tab._diffLang);
  const diffEditor = monaco.editor.createDiffEditor(editorWrapper, {
    theme: monacoThemeId(state.theme),
    automaticLayout: true,
    readOnly: true,
    renderSideBySide: false,
    fontSize: state.editor.getOption(monaco.editor.EditorOption.fontSize),
    fontFamily: "'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
    scrollBeyondLastLine: false,
  });
  diffEditor.setModel({ original: tab._diffOriginalModel, modified: tab._diffModifiedModel });
  tab._diffEditor = diffEditor;
}

function hideDiffEditor() {
  for (const t of state.tabs) {
    if (t._diffEditor) { try { t._diffEditor.dispose(); } catch {} t._diffEditor = null; }
  }
  const diffContainer = $('#diff-container');
  if (diffContainer) diffContainer.style.display = 'none';
}

/* ================================================================
   40. GIT BLAME (Current Line)
   ================================================================ */
let blameDisposable = null;

async function toggleGitBlame() {
  state.blameVisible = !state.blameVisible;
  if (state.blameVisible) {
    await loadBlameData();
    if (!state.blameData) {
      showToast('Git blame not available for this file', 'warning', 3000);
      state.blameVisible = false;
      return;
    }
    updateCurrentLineBlame();
    blameDisposable = state.editor.onDidChangeCursorPosition(() => updateCurrentLineBlame());
    showToast('Git blame enabled', 'info', 2000);
  } else {
    if (blameDisposable) { blameDisposable.dispose(); blameDisposable = null; }
    clearBlameDecorations();
    showToast('Git blame disabled', 'info', 2000);
  }
}

async function loadBlameData() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !tab.filePath || !state.folderPath) { state.blameData = null; return; }
  try {
    state.blameData = await window.apexStudio.gitBlame(state.folderPath, tab.filePath);
  } catch { state.blameData = null; }
}

function updateCurrentLineBlame() {
  if (!state.blameVisible || !state.blameData || !state.editor) { clearBlameDecorations(); return; }
  const pos = state.editor.getPosition();
  if (!pos) return;
  const lineBlame = state.blameData.find(b => b.line === pos.lineNumber);
  const decorations = [];
  if (lineBlame && lineBlame.hash !== '0000000') {
    decorations.push({
      range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, 1),
      options: {
        after: {
          content: `    ${lineBlame.author || 'Unknown'}, ${lineBlame.date || ''} \u2022 ${(lineBlame.summary || '').slice(0, 60)}`,
          inlineClassName: 'blame-annotation',
        },
        isWholeLine: true,
      },
    });
  }
  state.blameDecorations = state.editor.deltaDecorations(state.blameDecorations || [], decorations);
}

function clearBlameDecorations() {
  if (state.editor && state.blameDecorations?.length) {
    state.blameDecorations = state.editor.deltaDecorations(state.blameDecorations, []);
  }
}

/* ================================================================
   41. TRIM WHITESPACE (Manual command)
   ================================================================ */
function trimTrailingWhitespaceNow() {
  if (!state.editor) return;
  const model = state.editor.getModel();
  if (!model) return;
  const content = model.getValue();
  const trimmed = content.split('\n').map(line => line.replace(/\s+$/, '')).join('\n');
  if (trimmed !== content) {
    model.setValue(trimmed);
    showToast('Trimmed trailing whitespace', 'success', 2000);
  } else {
    showToast('No trailing whitespace found', 'info', 2000);
  }
}

/* ================================================================
   42. MINIMAP STATUS BAR
   ================================================================ */
function updateMinimapIndicator() {
  if (!state.editor || !dom.statusMinimap) return;
  const minimapEnabled = state.editor.getOption(monaco.editor.EditorOption.minimap).enabled;
  dom.statusMinimap.classList.toggle('minimap-off', !minimapEnabled);
}

function initMinimapToggle() {
  if (dom.statusMinimap) {
    dom.statusMinimap.addEventListener('click', () => {
      toggleMinimap();
    });
  }
}

/* ================================================================
   43. GIT INFO POPUP
   ================================================================ */
let gitInfoVisible = false;

function toggleGitInfoPopup() {
  if (gitInfoVisible) {
    hideGitInfoPopup();
  } else {
    showGitInfoPopup();
  }
}

function hideGitInfoPopup() {
  gitInfoVisible = false;
  if (dom.gitInfoPopup) dom.gitInfoPopup.classList.add('hidden');
}

async function showGitInfoPopup() {
  if (!state.folderPath) {
    showToast('Open a folder first', 'warning', 2000);
    return;
  }
  gitInfoVisible = true;
  dom.gitInfoPopup.classList.remove('hidden');

  // Show loading state
  dom.gitInfoBranch.textContent = 'Loading…';
  dom.gitInfoTracking.textContent = '';
  dom.gitInfoSync.innerHTML = '';
  dom.gitInfoRemote.textContent = '';
  dom.gitInfoStash.classList.add('hidden');
  dom.gitInfoFiles.innerHTML = '<div class="git-info-empty">Loading…</div>';
  dom.gitInfoCommits.innerHTML = '<div class="git-info-empty">Loading…</div>';

  // Fetch info & log in parallel
  const [info, commits] = await Promise.all([
    window.apexStudio.gitInfo(state.folderPath).catch(() => null),
    window.apexStudio.gitLog(state.folderPath, 10).catch(() => null),
  ]);

  if (!info) {
    dom.gitInfoBranch.textContent = 'Not a git repository';
    dom.gitInfoFiles.innerHTML = '';
    dom.gitInfoCommits.innerHTML = '';
    return;
  }

  // Branch
  dom.gitInfoBranch.textContent = `⎇ ${info.branch || 'HEAD (detached)'}`;

  // Tracking
  if (info.tracking) {
    dom.gitInfoTracking.textContent = `→ ${info.tracking}`;
  } else {
    dom.gitInfoTracking.textContent = '(no upstream)';
  }

  // Sync status
  const syncParts = [];
  if (info.ahead > 0) syncParts.push(`<span class="git-sync-ahead">↑ ${info.ahead} ahead</span>`);
  if (info.behind > 0) syncParts.push(`<span class="git-sync-behind">↓ ${info.behind} behind</span>`);
  if (info.ahead === 0 && info.behind === 0 && info.tracking) {
    syncParts.push('<span class="git-sync-ok">✓ Up to date</span>');
  }
  dom.gitInfoSync.innerHTML = syncParts.join(' · ');

  // Remote URL
  if (info.remoteUrl) {
    dom.gitInfoRemote.textContent = `Remote: ${info.remoteUrl}`;
  } else {
    dom.gitInfoRemote.textContent = '';
  }

  // Stash
  if (info.stashCount > 0) {
    dom.gitInfoStash.classList.remove('hidden');
    dom.gitInfoStash.textContent = `📦 ${info.stashCount} stash${info.stashCount > 1 ? 'es' : ''}`;
  } else {
    dom.gitInfoStash.classList.add('hidden');
  }

  // Changed files
  const fileEntries = Object.entries(info.files);
  if (fileEntries.length === 0) {
    dom.gitInfoFiles.innerHTML = '<div class="git-info-empty">Working tree clean</div>';
  } else {
    const statusLabels = { modified: 'M', added: 'A', deleted: 'D', untracked: 'U', renamed: 'R', conflicted: 'C' };
    const statusClass  = { modified: 'M', added: 'A', deleted: 'D', untracked: 'U', renamed: 'R', conflicted: 'C' };
    dom.gitInfoFiles.innerHTML = fileEntries.map(([filePath, status]) => {
      const fileName = filePath.split(/[/\\]/).pop();
      const dirPath = /[/\\]/.test(filePath) ? dirName(filePath) : '';
      const label = statusLabels[status] || '?';
      const cls = statusClass[status] || 'M';
      return `<div class="git-info-file-item" data-rel-path="${filePath}" data-abs-path="${state.folderPath}/${filePath}" title="${filePath}">
        <span class="git-file-status git-file-status-${cls}">${label}</span>
        <span class="git-file-name">${fileName}</span>
        ${dirPath ? `<span class="git-file-path">${dirPath}</span>` : ''}
      </div>`;
    }).join('');
  }

  // Recent commits
  if (!commits || commits.length === 0) {
    dom.gitInfoCommits.innerHTML = '<div class="git-info-empty">No commits found</div>';
  } else {
    dom.gitInfoCommits.innerHTML = commits.map(c => {
      const relTime = formatRelativeTime(c.date);
      const shortMsg = c.message.length > 50 ? c.message.slice(0, 47) + '…' : c.message;
      return `<div class="git-info-commit-item" title="${escHtml(c.message)}\n${c.author} · ${c.date}">
        <span class="git-commit-hash">${c.hash}</span>
        <span class="git-commit-msg">${escHtml(shortMsg)}</span>
        <span class="git-commit-meta">${relTime}</span>
      </div>`;
    }).join('');
  }
}

function formatRelativeTime(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 30) return `${diffD}d ago`;
    const diffM = Math.floor(diffD / 30);
    if (diffM < 12) return `${diffM}mo ago`;
    return `${Math.floor(diffM / 12)}y ago`;
  } catch {
    return dateStr;
  }
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function initGitInfoPopup() {
  if (!dom.gitInfoPopup) return;

  // Click on branch in status bar opens the popup
  dom.statusGit.addEventListener('click', toggleGitInfoPopup);

  // Close button
  $('#btn-git-info-close').addEventListener('click', hideGitInfoPopup);

  // Click outside popup to close
  document.addEventListener('mousedown', (e) => {
    if (gitInfoVisible && dom.gitInfoPopup && !dom.gitInfoPopup.contains(e.target) && !dom.statusGit.contains(e.target)) {
      hideGitInfoPopup();
    }
  });

  // File item click → open diff
  dom.gitInfoFiles.addEventListener('click', (e) => {
    const item = e.target.closest('.git-info-file-item');
    if (!item) return;
    const relPath = item.dataset.relPath;
    const absPath = item.dataset.absPath;
    if (relPath && absPath) {
      hideGitInfoPopup();
      showDiffView(relPath, absPath);
    }
  });

  // Quick action buttons (run via terminal)
  $('#btn-git-pull').addEventListener('click', () => {
    hideGitInfoPopup();
    showTerminal();
    runTerminalCommand('git pull');
  });
  $('#btn-git-push').addEventListener('click', () => {
    hideGitInfoPopup();
    showTerminal();
    runTerminalCommand('git push');
  });
  $('#btn-git-fetch').addEventListener('click', () => {
    hideGitInfoPopup();
    showTerminal();
    runTerminalCommand('git fetch');
  });
}

/* ================================================================
   44. RICH TEXT EDITOR
   ================================================================ */

function isPlainTextFile(filename) {
  if (!filename) return false;
  const ext = filename.split('.').pop().toLowerCase();
  return ext === 'txt' || ext === filename.toLowerCase(); // no extension = treat as plain
}

function toggleRichTextMode() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;
  if (tab._richTextMode) {
    exitRichTextMode(tab);
  } else {
    enterRichTextMode(tab, true);
  }
}

function enterRichTextMode(tab, loadFromModel = true) {
  tab._richTextMode = true;

  // Hide Monaco, show Rich Text
  dom.editorSplitContainer.style.display = 'none';
  dom.richTextContainer.classList.remove('hidden');

  if (loadFromModel) {
    if (tab._richTextHtml) {
      // Restore previously saved rich HTML (preserves images, formatting, etc.)
      dom.richTextEditor.innerHTML = tab._richTextHtml;
    } else {
      // First time: convert plain text to HTML paragraphs
      const text = tab.model.getValue();
      dom.richTextEditor.innerHTML = text
        .split('\n')
        .map(line => `<div>${line || '<br>'}</div>`)
        .join('');
    }
  } else if (tab._richTextHtml) {
    // Re-entering from tab switch — restore saved HTML
    dom.richTextEditor.innerHTML = tab._richTextHtml;
  }

  dom.richTextEditor.focus();

  // Update status bar
  if (dom.statusRichText) {
    dom.statusRichText.classList.remove('hidden');
    dom.statusRichText.textContent = '✎ Rich Text';
  }

  // Track changes
  dom.richTextEditor.oninput = () => {
    tab._richTextHtml = dom.richTextEditor.innerHTML;
    markTabModified(tab.id, true);
    scheduleAutoSave(tab.id);
  };
}

function exitRichTextMode(tab) {
  if (!tab) tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;

  // Save the rich HTML so we can restore it on re-enter (undo-friendly)
  tab._richTextHtml = dom.richTextEditor.innerHTML;

  // Save the plain text representation to Monaco model
  // Use a smarter conversion that preserves structure better
  const plainText = richHtmlToPlainText(dom.richTextEditor);
  tab.model.setValue(plainText);
  tab._richTextMode = false;
  // NOTE: We do NOT null out _richTextHtml — this lets Ctrl+Z work
  // by preserving the full rich content when switching back.

  hideRichTextEditor();

  // Show Monaco
  dom.editorSplitContainer.style.display = '';
  if (state.editor && state.activeTabId === tab.id) {
    state.editor.setModel(tab.model);
    state.editor.focus();
  }

  // Re-show the status bar indicator so user can toggle back
  updateRichTextIndicator();
}

function hideRichTextEditor() {
  if (dom.richTextContainer) dom.richTextContainer.classList.add('hidden');
  if (dom.statusRichText) dom.statusRichText.classList.add('hidden');
  if (dom.richTextEditor) dom.richTextEditor.oninput = null;
  // Restore editor split container (enterRichTextMode hides it)
  if (dom.editorSplitContainer) dom.editorSplitContainer.style.display = '';
}

function saveRichTextContent(tab) {
  // When saving from rich text mode, save plain text to file
  if (tab._richTextMode && dom.richTextEditor) {
    tab._richTextHtml = dom.richTextEditor.innerHTML;
    const plainText = richHtmlToPlainText(dom.richTextEditor);
    tab.model.setValue(plainText);
  }
}

/**
 * Convert rich HTML content to plain text, preserving structure.
 * Handles images (alt text / [image] placeholder), lists, headings, etc.
 */
function richHtmlToPlainText(el) {
  if (!el) return '';
  const lines = [];

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      lines.push(node.textContent);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();

    // Images — preserve as placeholder
    if (tag === 'img') {
      const alt = node.getAttribute('alt') || '';
      const src = node.getAttribute('src') || '';
      if (alt) {
        lines.push(`[image: ${alt}]`);
      } else if (src.startsWith('data:')) {
        lines.push('[embedded image]');
      } else {
        lines.push(`[image: ${src}]`);
      }
      return;
    }

    // Line break
    if (tag === 'br') {
      lines.push('\n');
      return;
    }

    // Block-level elements get newlines
    const blockTags = ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre', 'hr'];
    const isBlock = blockTags.includes(tag);

    if (tag === 'hr') {
      lines.push('\n---\n');
      return;
    }

    // List item prefix
    if (tag === 'li') {
      const parent = node.parentElement;
      if (parent && parent.tagName.toLowerCase() === 'ol') {
        const idx = Array.from(parent.children).indexOf(node) + 1;
        lines.push(`${idx}. `);
      } else {
        lines.push('• ');
      }
    }

    // Heading prefix
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10);
      lines.push('#'.repeat(level) + ' ');
    }

    for (const child of node.childNodes) {
      walk(child);
    }

    if (isBlock) {
      lines.push('\n');
    }
  }

  walk(el);

  // Clean up: collapse multiple newlines, trim
  return lines.join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function initRichTextEditor() {
  if (!dom.richTextToolbar || !dom.richTextEditor) return;

  // Toolbar button commands
  dom.richTextToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.rt-btn');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    if (!cmd) return;
    e.preventDefault();
    document.execCommand(cmd, false, null);
    dom.richTextEditor.focus();
  });

  // Heading select
  const headingSelect = $('#rt-heading');
  if (headingSelect) {
    headingSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) {
        document.execCommand('formatBlock', false, `<${val}>`);
      } else {
        document.execCommand('formatBlock', false, '<div>');
      }
      dom.richTextEditor.focus();
    });
  }

  // Font size select
  const fontSizeSelect = $('#rt-fontsize');
  if (fontSizeSelect) {
    fontSizeSelect.addEventListener('change', (e) => {
      document.execCommand('fontSize', false, e.target.value);
      dom.richTextEditor.focus();
    });
  }

  // Text color
  const foreColor = $('#rt-forecolor');
  if (foreColor) {
    foreColor.addEventListener('input', (e) => {
      document.execCommand('foreColor', false, e.target.value);
      dom.richTextEditor.focus();
    });
  }

  // Background/highlight color
  const backColor = $('#rt-backcolor');
  if (backColor) {
    backColor.addEventListener('input', (e) => {
      document.execCommand('hiliteColor', false, e.target.value);
      dom.richTextEditor.focus();
    });
  }

  // Exit button
  const exitBtn = $('#btn-exit-richtext');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab) exitRichTextMode(tab);
    });
  }

  // Status bar toggle
  if (dom.statusRichText) {
    dom.statusRichText.addEventListener('click', toggleRichTextMode);
  }

  // Auto-list continuation on Enter (numbered and bullet lists)
  // When a line starts with "1. " or "- " / "* ", pressing Enter auto-continues the list.
  // Pressing Enter on an empty list item (only the prefix) breaks out of the list.
  dom.richTextEditor.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    // Walk up to the current block element; bail if inside a native <li>
    let block = sel.getRangeAt(0).startContainer;
    while (block && block !== dom.richTextEditor) {
      if (block.nodeType === Node.ELEMENT_NODE) {
        if (block.tagName === 'LI') return; // browser handles native ordered/unordered lists
        if (['DIV', 'P'].includes(block.tagName)) break;
      }
      block = block.parentNode;
    }
    if (!block || block === dom.richTextEditor) return;

    const lineText = (block.innerText || block.textContent || '').replace(/\n$/, '');

    // Detect list pattern at the start of the line
    const numMatch   = lineText.match(/^(\d+)([.)]) /);               // "1. " or "1) "
    const bulletMatch = !numMatch && lineText.match(/^([-*+]) /);     // "- " / "* " / "+ "
    if (!numMatch && !bulletMatch) return;

    e.preventDefault();

    const prefixTrimmed = numMatch ? `${numMatch[1]}${numMatch[2]}` : bulletMatch[1];

    // Empty list item (only prefix typed, no content) → break out of the list
    if (lineText.trim() === prefixTrimmed) {
      block.innerHTML = '<br>';
      const r = document.createRange();
      r.setStart(block, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }

    // Continue the list on the next line with the appropriate next prefix
    const nextPrefix = numMatch
      ? `${parseInt(numMatch[1]) + 1}${numMatch[2]} `
      : `${bulletMatch[1]} `;

    document.execCommand('insertParagraph');
    document.execCommand('insertText', false, nextPrefix);
  });

  // Rich text context menu (right-click)
  initRichTextContextMenu();

  // Show Rich Text indicator for plain text files
  updateRichTextIndicator();
}

function initRichTextContextMenu() {
  const rtEditor = dom.richTextEditor;
  const ctxMenu = $('#richtext-context-menu');
  if (!rtEditor || !ctxMenu) return;

  rtEditor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Position the menu
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top = e.clientY + 'px';
    ctxMenu.classList.remove('hidden');

    // Adjust if menu goes off-screen
    requestAnimationFrame(() => {
      const rect = ctxMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) ctxMenu.style.left = (e.clientX - rect.width) + 'px';
      if (rect.bottom > window.innerHeight) ctxMenu.style.top = (e.clientY - rect.height) + 'px';
    });
  });

  // Close on click outside
  document.addEventListener('mousedown', (e) => {
    if (!ctxMenu.contains(e.target)) ctxMenu.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ctxMenu.classList.add('hidden');
  });

  // Handle context menu actions
  ctxMenu.querySelectorAll('[data-rt-action]').forEach(item => {
    item.addEventListener('click', () => {
      ctxMenu.classList.add('hidden');
      const action = item.dataset.rtAction;
      rtEditor.focus();

      switch (action) {
        case 'rt-cut':
          document.execCommand('cut');
          break;
        case 'rt-copy':
          document.execCommand('copy');
          break;
        case 'rt-paste':
          navigator.clipboard.readText().then(text => {
            document.execCommand('insertText', false, text);
          }).catch(() => {
            document.execCommand('paste');
          });
          break;
        case 'rt-select-all':
          document.execCommand('selectAll');
          break;
        case 'rt-bold':
          document.execCommand('bold');
          break;
        case 'rt-italic':
          document.execCommand('italic');
          break;
        case 'rt-underline':
          document.execCommand('underline');
          break;
        case 'rt-strikethrough':
          document.execCommand('strikeThrough');
          break;
        case 'rt-unordered-list':
          document.execCommand('insertUnorderedList');
          break;
        case 'rt-ordered-list':
          document.execCommand('insertOrderedList');
          break;
        case 'rt-align-left':
          document.execCommand('justifyLeft');
          break;
        case 'rt-align-center':
          document.execCommand('justifyCenter');
          break;
        case 'rt-align-right':
          document.execCommand('justifyRight');
          break;
        case 'rt-clear-format':
          document.execCommand('removeFormat');
          break;
      }
    });
  });
}

function updateRichTextIndicator() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!dom.statusRichText) return;
  if (tab && (isPlainTextFile(tab.title) || tab._richTextMode)) {
    dom.statusRichText.classList.remove('hidden');
    dom.statusRichText.textContent = tab._richTextMode ? '✎ Rich Text' : '✎ Plain';
  } else {
    dom.statusRichText.classList.add('hidden');
  }
}


/* ================================================================
   24. TOOL PANELS — API Client, Regex Tester, JSON Viewer,
       Bookmarks, Code Screenshot, Database Client
   ================================================================ */

// ---- Generic Tool Panel Toggle ----
const toolBtnMap = {
  'api-client-panel': 'tbtn-api',
  'regex-panel': 'tbtn-regex',
  'json-viewer-panel': 'tbtn-json',
  'bookmarks-panel': 'tbtn-bookmarks',
  'screenshot-panel': 'tbtn-screenshot',
  'db-panel': 'tbtn-db',
  'snippet-panel': 'tbtn-snippets',
  'color-panel': 'tbtn-color',
  'todo-panel': 'tbtn-todo',
  'pomo-panel': 'tbtn-pomo',
  'diff-panel': 'tbtn-diff',
  'salesforce-panel': 'tbtn-salesforce',
};

function toggleToolPanel(panelId) {
  const panels = ['api-client-panel', 'regex-panel', 'json-viewer-panel', 'bookmarks-panel', 'screenshot-panel', 'db-panel', 'snippet-panel', 'color-panel', 'todo-panel', 'pomo-panel', 'diff-panel', 'salesforce-panel'];
  const target = $('#' + panelId);
  const isVisible = target && !target.classList.contains('hidden');

  // Animate-close visible panels, then hide
  panels.forEach(id => {
    const p = $('#' + id);
    if (p && !p.classList.contains('hidden')) {
      p.classList.add('panel-closing');
      p.addEventListener('animationend', function onEnd() {
        p.classList.remove('panel-closing');
        p.classList.add('hidden');
        p.removeEventListener('animationend', onEnd);
      }, { once: true });
    }
    const btn = $('#' + toolBtnMap[id]);
    if (btn) btn.classList.remove('active');
  });
  state.activeToolPanel = null;

  // If it was hidden, show it (after clearing the closing animation)
  if (!isVisible && target) {
    // Cancel any pending close animation and show immediately
    target.classList.remove('panel-closing', 'hidden');
    // Re-trigger open animation
    target.style.animation = 'none';
    target.offsetHeight; // force reflow
    target.style.animation = '';
    state.activeToolPanel = panelId;
    const btn = $('#' + toolBtnMap[panelId]);
    if (btn) btn.classList.add('active');

    // Auto-scan hook for TODO Tracker
    if (panelId === 'todo-panel' && typeof window.todoTrackerOnOpen === 'function') {
      window.todoTrackerOnOpen();
    }
  }
}
window.toggleToolPanel = toggleToolPanel;

// ================================================================
// 24a. API CLIENT
// ================================================================
function initToolbarButtons() {
  $('#tbtn-api')?.addEventListener('click', () => toggleToolPanel('api-client-panel'));
  $('#tbtn-regex')?.addEventListener('click', () => toggleToolPanel('regex-panel'));
  $('#tbtn-json')?.addEventListener('click', () => openJsonViewer());
  $('#tbtn-bookmarks')?.addEventListener('click', () => toggleToolPanel('bookmarks-panel'));
  $('#tbtn-screenshot')?.addEventListener('click', () => openScreenshotPanel());
  $('#tbtn-db')?.addEventListener('click', () => toggleToolPanel('db-panel'));
  $('#tbtn-snippets')?.addEventListener('click', () => toggleToolPanel('snippet-panel'));
  $('#tbtn-color')?.addEventListener('click', () => toggleToolPanel('color-panel'));
  $('#tbtn-todo')?.addEventListener('click', () => toggleToolPanel('todo-panel'));
  $('#tbtn-pomo')?.addEventListener('click', () => toggleToolPanel('pomo-panel'));
  $('#tbtn-diff')?.addEventListener('click', () => toggleToolPanel('diff-panel'));
  $('#tbtn-salesforce')?.addEventListener('click', () => toggleToolPanel('salesforce-panel'));

  // Kebab overflow menu
  initKebabMenu();
}

function initKebabMenu() {
  const kebabBtn = $('#tbtn-kebab');
  const kebabMenu = $('#titlebar-kebab-menu');
  if (!kebabBtn || !kebabMenu) return;

  const toolDefs = [
    { id: 'tbtn-api',        label: 'API Client',     shortcut: '⌃⇧A', panel: 'api-client-panel' },
    { id: 'tbtn-regex',      label: 'Regex Tester',   shortcut: '⌃⇧R', panel: 'regex-panel' },
    { id: 'tbtn-json',       label: 'JSON / YAML',    shortcut: '⌃⇧J', panel: 'json-viewer-panel', action: () => openJsonViewer() },
    { id: 'tbtn-bookmarks',  label: 'Bookmarks',      shortcut: '⌃⇧B', panel: 'bookmarks-panel' },
    { id: 'tbtn-screenshot', label: 'Screenshot',     shortcut: '⌃⇧S', panel: 'screenshot-panel', action: () => openScreenshotPanel() },
    { id: 'tbtn-db',         label: 'Database',       shortcut: '⌃⇧D', panel: 'db-panel' },
    { sep: true },
    { id: 'tbtn-snippets',   label: 'Snippets',       shortcut: '⌃⇧E', panel: 'snippet-panel' },
    { id: 'tbtn-color',      label: 'Color Picker',   shortcut: '⌃⇧K', panel: 'color-panel' },
    { id: 'tbtn-todo',       label: 'TODO Tracker',   shortcut: '⌃⇧G', panel: 'todo-panel' },
    { id: 'tbtn-pomo',       label: 'Pomodoro Timer', shortcut: '⌃⇧Y', panel: 'pomo-panel' },
    { id: 'tbtn-diff',       label: 'Diff Checker',   shortcut: '⌃⇧I', panel: 'diff-panel' },
    { sep: true },
    { id: 'tbtn-salesforce', label: 'Salesforce',     shortcut: '⌃⇧F', panel: 'salesforce-panel' },
  ];

  // Build menu items
  toolDefs.forEach(def => {
    if (def.sep) {
      const sep = document.createElement('div');
      sep.className = 'titlebar-kebab-sep';
      kebabMenu.appendChild(sep);
      return;
    }
    const srcBtn = $(`#${def.id}`);
    if (!srcBtn) return;

    const item = document.createElement('button');
    item.className = 'titlebar-kebab-item';
    item.dataset.toolId = def.id;
    // Clone the SVG icon from the original button
    const iconSvg = srcBtn.querySelector('svg');
    const clonedSvg = iconSvg ? iconSvg.cloneNode(true) : '';
    if (clonedSvg) item.appendChild(clonedSvg);
    const labelSpan = document.createElement('span');
    labelSpan.textContent = def.label;
    item.appendChild(labelSpan);
    const kbdSpan = document.createElement('kbd');
    kbdSpan.style.cssText = 'margin-left:auto;font-size:10px;color:var(--text-muted);font-family:inherit;';
    kbdSpan.textContent = def.shortcut;
    item.appendChild(kbdSpan);

    item.addEventListener('click', () => {
      kebabMenu.classList.add('hidden');
      if (def.action) { def.action(); }
      else { toggleToolPanel(def.panel); }
    });

    kebabMenu.appendChild(item);
  });

  // Toggle menu on kebab button click
  kebabBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Sync active states
    kebabMenu.querySelectorAll('.titlebar-kebab-item').forEach(item => {
      const srcBtn = $(`#${item.dataset.toolId}`);
      item.classList.toggle('active', srcBtn?.classList.contains('active'));
    });
    kebabMenu.classList.toggle('hidden');
    // Position menu near kebab button
    const rect = kebabBtn.getBoundingClientRect();
    kebabMenu.style.top = rect.bottom + 4 + 'px';
    kebabMenu.style.right = (window.innerWidth - rect.right) + 'px';
  });

  // Close menu on outside click
  document.addEventListener('click', (e) => {
    if (!kebabMenu.contains(e.target) && e.target !== kebabBtn) {
      kebabMenu.classList.add('hidden');
    }
  });

  // Detect overflow on resize — switch to kebab when tools would overlap
  const toolsContainer = $('#titlebar-tools');
  const titlebar = $('#titlebar');
  function checkToolbarOverflow() {
    // Temporarily show all buttons to measure
    toolsContainer.classList.remove('tools-overflow');
    kebabMenu.classList.add('hidden');
    requestAnimationFrame(() => {
      const titleEl = $('#titlebar-title');
      const searchEl = $('#titlebar-search');
      const pomoEl = $('#pomo-titlebar');
      const titleRight = titleEl ? titleEl.getBoundingClientRect().right : 0;
      const pomoRight = pomoEl && !pomoEl.classList.contains('hidden') ? pomoEl.getBoundingClientRect().right : titleRight;
      const leftEdge = Math.max(titleRight, pomoRight) + 12;
      const searchLeft = searchEl ? searchEl.getBoundingClientRect().left : window.innerWidth;
      const toolsWidth = toolsContainer.scrollWidth;
      const availableWidth = searchLeft - leftEdge - 16;
      if (toolsWidth > availableWidth) {
        toolsContainer.classList.add('tools-overflow');
      }
    });
  }
  window.addEventListener('resize', checkToolbarOverflow);
  checkToolbarOverflow();
}

function initApiClient() {
  const methodEl    = $('#api-method');
  const urlEl       = $('#api-url');
  const sendBtn     = $('#btn-api-send');
  const saveBtn     = $('#btn-api-save');
  const closeBtn    = $('#btn-api-close');
  const historyBtn  = $('#btn-api-history');
  const collectBtn  = $('#btn-api-collections');
  if (!sendBtn) return;

  // Close
  closeBtn?.addEventListener('click', () => toggleToolPanel('api-client-panel'));

  // Send request
  sendBtn.addEventListener('click', sendApiRequest);
  urlEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendApiRequest(); });

  // Save to collection
  saveBtn?.addEventListener('click', saveApiToCollection);

  // Copy as cURL
  $('#btn-api-curl-copy')?.addEventListener('click', copyAsCurl);

  // Import cURL modal
  $('#btn-api-curl-import')?.addEventListener('click', showCurlImportModal);
  initCurlImportModal();

  // Request tabs
  $$('.api-client-body .api-tabs .api-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.api-client-body .api-tabs .api-tab').forEach(t => t.classList.remove('active'));
      $$('.api-tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = $('#api-panel-' + tab.dataset.panel);
      if (panel) panel.classList.add('active');
    });
  });

  // Response tabs
  $$('.api-response-tabs .api-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.api-response-tabs .api-tab').forEach(t => t.classList.remove('active'));
      $$('.api-response-body').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = $('#api-resp-' + tab.dataset.rpanel);
      if (panel) panel.classList.add('active');
    });
  });

  // Auth type change
  $('#api-auth-type')?.addEventListener('change', updateAuthFields);
  updateAuthFields();

  // Add row buttons
  $$('.api-add-row-btn').forEach(btn => {
    btn.addEventListener('click', () => addKvRow(btn.dataset.target));
  });

  // Add initial empty rows
  addKvRow('api-params-table');
  addKvRow('api-headers-table');

  // History toggle
  historyBtn?.addEventListener('click', () => {
    const panel = $('#api-history-panel');
    panel?.classList.toggle('hidden');
    $('#api-collections-panel')?.classList.add('hidden');
    renderApiHistory();
  });

  // Collections toggle
  collectBtn?.addEventListener('click', () => {
    const panel = $('#api-collections-panel');
    panel?.classList.toggle('hidden');
    $('#api-history-panel')?.classList.add('hidden');
    renderApiCollections();
  });

  // Clear history
  $('#btn-api-clear-history')?.addEventListener('click', () => {
    state.apiHistory = [];
    renderApiHistory();
  });

  // New collection — create and optionally save current request
  $('#btn-api-new-collection')?.addEventListener('click', async () => {
    const name = await showInputDialog('New Collection', 'Collection name:');
    if (!name || !name.trim()) return;
    const col = { name: name.trim(), requests: [] };
    // If there's a URL in the request bar, offer to add it
    const currentUrl = $('#api-url')?.value?.trim();
    if (currentUrl) {
      const addCurrent = await showConfirmDialog('Add Request', `Add the current request (${currentUrl}) to "${name}"?`);
      if (addCurrent) {
        const method = $('#api-method')?.value || 'GET';
        const headers = getKvPairs('api-headers-table');
        const params = getKvPairs('api-params-table');
        const bodyType = $('#api-body-type')?.value || 'none';
        const bodyContent = $('#api-body-content')?.value || '';
        const authType = $('#api-auth-type')?.value || 'none';
        let auth = { type: authType };
        if (authType === 'bearer') auth.token = $('#api-auth-token')?.value || '';
        else if (authType === 'basic') { auth.username = $('#api-auth-user')?.value || ''; auth.password = $('#api-auth-pass')?.value || ''; }
        else if (authType === 'apikey') { auth.keyName = $('#api-auth-key-name')?.value || ''; auth.keyValue = $('#api-auth-key-val')?.value || ''; }
        const reqName = await showInputDialog('Request Name', 'Name for this request:', currentUrl.split(/[/\\]/).pop() || currentUrl) || currentUrl;
        col.requests.push({ method, url: currentUrl, name: reqName, headers, params, bodyType, body: bodyContent, auth });
      }
    }
    state.apiCollections.push(col);
    renderApiCollections();
    showToast(`Collection "${name}" created${col.requests.length ? ' with 1 request' : ''}`, 'info');
  });

  // Import collection (Postman JSON)
  $('#btn-api-import')?.addEventListener('click', importApiCollection);

  // Export collection (Postman JSON)
  $('#btn-api-export')?.addEventListener('click', exportApiCollection);

  // Close collections/history panels on click outside the API client panel
  document.addEventListener('mousedown', (e) => {
    const apiPanel = $('#api-client-panel');
    if (!apiPanel || apiPanel.classList.contains('hidden')) return;
    const colPanel = $('#api-collections-panel');
    const histPanel = $('#api-history-panel');
    // If click is outside the entire API client panel, close sidebars
    if (!apiPanel.contains(e.target)) {
      if (colPanel && !colPanel.classList.contains('hidden')) colPanel.classList.add('hidden');
      if (histPanel && !histPanel.classList.contains('hidden')) histPanel.classList.add('hidden');
    }
    // If click is inside the main API area but outside the sidebar panels themselves, also close them
    else {
      if (colPanel && !colPanel.classList.contains('hidden') && !colPanel.contains(e.target) && e.target !== collectBtn && !collectBtn?.contains(e.target)) {
        colPanel.classList.add('hidden');
      }
      if (histPanel && !histPanel.classList.contains('hidden') && !histPanel.contains(e.target) && e.target !== historyBtn && !historyBtn?.contains(e.target)) {
        histPanel.classList.add('hidden');
      }
    }
  });
}

function addKvRow(tableId) {
  const table = $('#' + tableId);
  if (!table) return;
  const row = document.createElement('div');
  row.className = 'api-kv-row';
  row.innerHTML = `
    <input type="text" class="api-kv-key" placeholder="Key" spellcheck="false" />
    <input type="text" class="api-kv-value" placeholder="Value" spellcheck="false" />
    <button class="api-kv-del" title="Remove">✕</button>
  `;
  row.querySelector('.api-kv-del').addEventListener('click', () => row.remove());
  table.appendChild(row);
}

function getKvPairs(tableId) {
  const rows = $$(`#${tableId} .api-kv-row`);
  const result = {};
  rows.forEach(row => {
    const k = row.querySelector('.api-kv-key')?.value.trim();
    const v = row.querySelector('.api-kv-value')?.value.trim();
    if (k) result[k] = v;
  });
  return result;
}

function updateAuthFields() {
  const type = $('#api-auth-type')?.value || 'none';
  const container = $('#api-auth-fields');
  if (!container) return;
  container.innerHTML = '';
  if (type === 'bearer') {
    container.innerHTML = '<input id="api-auth-token" class="api-auth-input" placeholder="Bearer Token" spellcheck="false" />';
  } else if (type === 'basic') {
    container.innerHTML = '<input id="api-auth-user" class="api-auth-input" placeholder="Username" spellcheck="false" /><input id="api-auth-pass" class="api-auth-input" placeholder="Password" type="password" spellcheck="false" />';
  } else if (type === 'apikey') {
    container.innerHTML = '<input id="api-auth-key-name" class="api-auth-input" placeholder="Header Name (e.g. X-API-Key)" spellcheck="false" /><input id="api-auth-key-val" class="api-auth-input" placeholder="API Key Value" spellcheck="false" />';
  }
}

async function sendApiRequest() {
  const method = $('#api-method')?.value || 'GET';
  const url    = $('#api-url')?.value.trim();
  if (!url) { showToast('Please enter a URL', 'warning'); return; }

  const sendBtn = $('#btn-api-send');
  sendBtn.textContent = '...';
  sendBtn.disabled = true;

  // Gather headers
  const headers = getKvPairs('api-headers-table');
  const params  = getKvPairs('api-params-table');

  // Add auth
  const authType = $('#api-auth-type')?.value;
  if (authType === 'bearer') {
    const token = $('#api-auth-token')?.value;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else if (authType === 'basic') {
    const user = $('#api-auth-user')?.value || '';
    const pass = $('#api-auth-pass')?.value || '';
    headers['Authorization'] = `Basic ${btoa(user + ':' + pass)}`;
  } else if (authType === 'apikey') {
    const keyName = $('#api-auth-key-name')?.value;
    const keyVal  = $('#api-auth-key-val')?.value;
    if (keyName && keyVal) headers[keyName] = keyVal;
  }

  // Add query params to URL
  let fullUrl = url;
  const paramStr = new URLSearchParams(params).toString();
  if (paramStr) fullUrl += (url.includes('?') ? '&' : '?') + paramStr;

  // Body
  const bodyType    = $('#api-body-type')?.value || 'none';
  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    if (bodyType === 'json') {
      body = $('#api-body-content')?.value || '';
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    } else if (bodyType === 'text') {
      body = $('#api-body-content')?.value || '';
      if (!headers['Content-Type']) headers['Content-Type'] = 'text/plain';
    } else if (bodyType === 'form') {
      body = $('#api-body-content')?.value || '';
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  try {
    const res = await window.apexStudio.sendApiRequest({ method, url: fullUrl, headers, body });

    // Status
    const statusEl = $('#api-response-status');
    if (statusEl) {
      statusEl.textContent = `${res.status} ${res.statusText || ''}`;
      statusEl.className = 'api-response-status ' + (res.status >= 200 && res.status < 300 ? 'status-ok' : res.status >= 400 ? 'status-err' : 'status-warn');
    }

    // Time & size
    const timeEl = $('#api-response-time');
    if (timeEl) timeEl.textContent = `${res.time}ms`;
    const sizeEl = $('#api-response-size');
    if (sizeEl) sizeEl.textContent = formatBytes(res.size);

    // Response body — try to prettify JSON
    const bodyEl = $('#api-response-content');
    if (bodyEl) {
      try {
        const parsed = JSON.parse(res.body);
        bodyEl.textContent = JSON.stringify(parsed, null, 2);
      } catch {
        bodyEl.textContent = res.body;
      }
    }

    // Response headers
    const headersEl = $('#api-response-headers-content');
    if (headersEl) {
      headersEl.textContent = Object.entries(res.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    }

    // Add to history
    state.apiHistory.unshift({
      method, url: fullUrl, status: res.status, time: res.time,
      timestamp: new Date().toLocaleTimeString(),
    });
    if (state.apiHistory.length > 50) state.apiHistory.pop();

  } catch (err) {
    $('#api-response-content').textContent = 'Error: ' + err.message;
    $('#api-response-status').textContent = 'Error';
    $('#api-response-status').className = 'api-response-status status-err';
  }

  sendBtn.textContent = 'Send';
  sendBtn.disabled = false;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function renderApiHistory() {
  const list = $('#api-history-list');
  if (!list) return;
  if (state.apiHistory.length === 0) {
    list.innerHTML = '<div class="api-history-empty">No requests yet</div>';
    return;
  }
  list.innerHTML = state.apiHistory.map((h, i) => `
    <div class="api-history-item" data-idx="${i}">
      <span class="api-hist-method method-${h.method.toLowerCase()}">${h.method}</span>
      <span class="api-hist-url">${escHtml(h.url)}</span>
      <span class="api-hist-status ${h.status >= 200 && h.status < 300 ? 'status-ok' : 'status-err'}">${h.status}</span>
      <span class="api-hist-time">${h.time}ms</span>
    </div>
  `).join('');
  list.querySelectorAll('.api-history-item').forEach(el => {
    el.addEventListener('click', () => {
      const h = state.apiHistory[+el.dataset.idx];
      if (h) {
        const u = new URL(h.url);
        $('#api-method').value = h.method;
        $('#api-url').value = u.origin + u.pathname;
      }
    });
  });
}

async function saveApiToCollection() {
  if (state.apiCollections.length === 0) {
    const name = await showInputDialog('New Collection', 'Create a collection first. Name:');
    if (!name) return;
    state.apiCollections.push({ name, requests: [] });
  }
  const method  = $('#api-method')?.value || 'GET';
  const url     = $('#api-url')?.value?.trim() || '';
  const headers = getKvPairs('api-headers-table');
  const params  = getKvPairs('api-params-table');
  const bodyType = $('#api-body-type')?.value || 'none';
  const bodyContent = $('#api-body-content')?.value || '';
  const authType = $('#api-auth-type')?.value || 'none';
  let auth = { type: authType };
  if (authType === 'bearer') auth.token = $('#api-auth-token')?.value || '';
  else if (authType === 'basic') { auth.username = $('#api-auth-user')?.value || ''; auth.password = $('#api-auth-pass')?.value || ''; }
  else if (authType === 'apikey') { auth.keyName = $('#api-auth-key-name')?.value || ''; auth.keyValue = $('#api-auth-key-val')?.value || ''; }

  let colIdx = 0;
  if (state.apiCollections.length > 1) {
    const names = state.apiCollections.map((c, i) => `${i}: ${c.name}`).join('\n');
    const picked = await showInputDialog('Choose Collection', `Which collection?\n${names}`, '0');
    if (picked === null) return;
    colIdx = parseInt(picked, 10);
  }
  if (isNaN(colIdx) || !state.apiCollections[colIdx]) return;
  const reqName = await showInputDialog('Request Name', 'Name for this request:', url.split(/[/\\]/).pop() || url) || url;
  state.apiCollections[colIdx].requests.push({ method, url, name: reqName, headers, params, bodyType, body: bodyContent, auth });
  showToast(`Saved to "${state.apiCollections[colIdx].name}"`, 'info');
  renderApiCollections();
}

function renderApiCollections() {
  const list = $('#api-collections-list');
  if (!list) return;
  if (state.apiCollections.length === 0) {
    list.innerHTML = '<div class="api-history-empty">No collections</div>';
    return;
  }
  list.innerHTML = state.apiCollections.map((col, ci) => `
    <div class="api-collection-group">
      <div class="api-collection-name">📁 ${escHtml(col.name)} (${col.requests.length})</div>
      ${col.requests.map((r, ri) => `
        <div class="api-collection-item" data-ci="${ci}" data-ri="${ri}">
          <span class="api-hist-method method-${r.method.toLowerCase()}">${r.method}</span>
          <span class="api-hist-url">${escHtml(r.name || r.url)}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
  list.querySelectorAll('.api-collection-item').forEach(el => {
    el.addEventListener('click', () => {
      const r = state.apiCollections[+el.dataset.ci]?.requests[+el.dataset.ri];
      if (!r) return;
      $('#api-method').value = r.method;
      $('#api-url').value = r.url;
      // Restore headers
      const hTable = $('#api-headers-table');
      if (hTable) { hTable.innerHTML = ''; Object.entries(r.headers || {}).forEach(([k, v]) => { addKvRow('api-headers-table'); const rows = hTable.querySelectorAll('.api-kv-row'); const last = rows[rows.length - 1]; if (last) { last.querySelector('.api-kv-key').value = k; last.querySelector('.api-kv-value').value = v; } }); if (Object.keys(r.headers || {}).length === 0) addKvRow('api-headers-table'); }
      // Restore params
      const pTable = $('#api-params-table');
      if (pTable) { pTable.innerHTML = ''; Object.entries(r.params || {}).forEach(([k, v]) => { addKvRow('api-params-table'); const rows = pTable.querySelectorAll('.api-kv-row'); const last = rows[rows.length - 1]; if (last) { last.querySelector('.api-kv-key').value = k; last.querySelector('.api-kv-value').value = v; } }); if (Object.keys(r.params || {}).length === 0) addKvRow('api-params-table'); }
      // Restore body
      if (r.bodyType && $('#api-body-type')) { $('#api-body-type').value = r.bodyType; }
      if (r.body && $('#api-body-content')) { $('#api-body-content').value = r.body; }
      // Restore auth
      if (r.auth && r.auth.type && $('#api-auth-type')) {
        $('#api-auth-type').value = r.auth.type;
        updateAuthFields();
        if (r.auth.type === 'bearer' && $('#api-auth-token')) $('#api-auth-token').value = r.auth.token || '';
        else if (r.auth.type === 'basic') { if ($('#api-auth-user')) $('#api-auth-user').value = r.auth.username || ''; if ($('#api-auth-pass')) $('#api-auth-pass').value = r.auth.password || ''; }
        else if (r.auth.type === 'apikey') { if ($('#api-auth-key-name')) $('#api-auth-key-name').value = r.auth.keyName || ''; if ($('#api-auth-key-val')) $('#api-auth-key-val').value = r.auth.keyValue || ''; }
      }
    });
  });
}

// ----------------------------------------------------------------
// Postman Import / Export
// ----------------------------------------------------------------

/** Parse a Postman v2.0/v2.1 item (possibly nested folders) into flat request list */
function flattenPostmanItems(items, folderPrefix = '') {
  const result = [];
  if (!Array.isArray(items)) return result;
  for (const item of items) {
    if (item.item && Array.isArray(item.item)) {
      // It's a folder — recurse
      const prefix = folderPrefix ? `${folderPrefix}/${item.name || 'Folder'}` : (item.name || 'Folder');
      result.push(...flattenPostmanItems(item.item, prefix));
    } else if (item.request) {
      const req = item.request;
      // Method
      const method = (typeof req === 'string' ? 'GET' : (req.method || 'GET')).toUpperCase();
      // URL
      let url = '';
      if (typeof req.url === 'string') url = req.url;
      else if (req.url?.raw) url = req.url.raw;
      // Name
      const name = item.name || url.split(/[/\\]/).pop() || url;
      // Headers
      const headers = {};
      if (Array.isArray(req.header)) {
        req.header.forEach(h => { if (h.key) headers[h.key] = h.value || ''; });
      }
      // Params from URL query
      const params = {};
      if (req.url?.query && Array.isArray(req.url.query)) {
        req.url.query.forEach(q => { if (q.key) params[q.key] = q.value || ''; });
      }
      // Body
      let bodyType = 'none', body = '';
      if (req.body) {
        if (req.body.mode === 'raw') {
          body = req.body.raw || '';
          const lang = req.body.options?.raw?.language || '';
          bodyType = lang === 'json' ? 'json' : (lang === 'text' ? 'text' : 'json');
        } else if (req.body.mode === 'urlencoded') {
          bodyType = 'form';
          body = (req.body.urlencoded || []).map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value || '')}`).join('&');
        } else if (req.body.mode === 'formdata') {
          bodyType = 'form';
          body = (req.body.formdata || []).map(p => `${p.key}=${p.value || ''}`).join('&');
        }
      }
      // Auth
      let auth = { type: 'none' };
      const a = req.auth;
      if (a) {
        if (a.type === 'bearer') {
          const tokenArr = a.bearer || [];
          const tokenObj = tokenArr.find(b => b.key === 'token');
          auth = { type: 'bearer', token: tokenObj?.value || '' };
        } else if (a.type === 'basic') {
          const ba = a.basic || [];
          auth = { type: 'basic', username: (ba.find(b => b.key === 'username')?.value || ''), password: (ba.find(b => b.key === 'password')?.value || '') };
        } else if (a.type === 'apikey') {
          const ak = a.apikey || [];
          auth = { type: 'apikey', keyName: (ak.find(b => b.key === 'key')?.value || ''), keyValue: (ak.find(b => b.key === 'value')?.value || '') };
        }
      }
      // Strip query params from URL for clean display (params are separate)
      let cleanUrl = url;
      if (Object.keys(params).length > 0) {
        try { const u = new URL(url); cleanUrl = u.origin + u.pathname; } catch { /* keep raw */ }
      }
      result.push({ method, url: cleanUrl, name: (folderPrefix ? `${folderPrefix}/${name}` : name), headers, params, bodyType, body, auth });
    }
  }
  return result;
}

async function importApiCollection() {
  try {
    const paths = await window.apexStudio.openFileDialog();
    if (!paths || paths.length === 0) return;
    // Only pick .json files
    const jsonPaths = paths.filter(p => p.endsWith('.json'));
    if (jsonPaths.length === 0) { showToast('Please select a JSON file', 'warning'); return; }

    let imported = 0;
    for (const fp of jsonPaths) {
      const raw = await window.apexStudio.readFile(fp);
      if (!raw) { showToast(`Could not read ${fp}`, 'error'); continue; }
      let data;
      try { data = JSON.parse(raw); } catch { showToast(`Invalid JSON: ${fp}`, 'error'); continue; }

      // Detect format: Postman Collection v2.x
      if (data.info && data.item) {
        const name = data.info.name || 'Imported Collection';
        const requests = flattenPostmanItems(data.item);
        state.apiCollections.push({ name, requests });
        imported += requests.length;
      }
      // Detect format: Apex Debug Studio native export (accepts legacy marker too)
      else if ((data._apexdebugstudio || data._congacode) && Array.isArray(data.collections)) {
        data.collections.forEach(col => {
          state.apiCollections.push({ name: col.name || 'Imported', requests: col.requests || [] });
          imported += (col.requests || []).length;
        });
      }
      // Detect format: Array of Postman collections
      else if (Array.isArray(data)) {
        data.forEach(col => {
          if (col.info && col.item) {
            const name = col.info.name || 'Imported';
            state.apiCollections.push({ name, requests: flattenPostmanItems(col.item) });
            imported++;
          }
        });
      }
      // Try as a bare array of items
      else if (data.item && !data.info) {
        const requests = flattenPostmanItems(data.item);
        state.apiCollections.push({ name: 'Imported Collection', requests });
        imported += requests.length;
      }
      else {
        showToast('Unrecognized collection format', 'warning');
        continue;
      }
    }
    if (imported > 0) {
      renderApiCollections();
      showToast(`Imported ${imported} request(s) successfully`, 'info');
    }
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  }
}

async function exportApiCollection() {
  if (state.apiCollections.length === 0) {
    showToast('No collections to export', 'warning');
    return;
  }

  // If multiple collections, let user choose or export all
  let colIdx = 0;
  if (state.apiCollections.length > 1) {
    const names = state.apiCollections.map((c, i) => `${i}: ${c.name}`).join('\n');
    const choice = await showInputDialog('Export Collection', `Export which collection? (or "all" for all)\n${names}`, '0');
    if (choice === null) return;
    if (choice.toLowerCase() === 'all') {
      colIdx = -1; // export all
    } else {
      colIdx = parseInt(choice, 10);
      if (isNaN(colIdx) || !state.apiCollections[colIdx]) { showToast('Invalid selection', 'warning'); return; }
    }
  }

  const collectionsToExport = colIdx === -1 ? state.apiCollections : [state.apiCollections[colIdx]];

  // Build Postman v2.1 format for each collection
  for (const col of collectionsToExport) {
    const postmanCollection = buildPostmanExport(col);
    const json = JSON.stringify(postmanCollection, null, 2);
    const defaultName = col.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.postman_collection.json';
    const savePath = await window.apexStudio.saveFileDialog(defaultName);
    if (!savePath) continue;
    const ok = await window.apexStudio.writeFile(savePath, json);
    if (ok) showToast(`Exported "${col.name}" successfully`, 'info');
    else showToast('Export failed', 'error');
  }
}

function buildPostmanExport(collection) {
  const genId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });

  const items = (collection.requests || []).map(r => {
    // Build URL object
    let urlObj;
    try {
      const u = new URL(r.url);
      const query = Object.entries(r.params || {}).map(([k, v]) => ({ key: k, value: v }));
      // Also include query params from the URL itself
      for (const [k, v] of u.searchParams) {
        if (!query.find(q => q.key === k)) query.push({ key: k, value: v });
      }
      urlObj = {
        raw: r.url + (query.length ? '?' + query.map(q => `${q.key}=${q.value}`).join('&') : ''),
        protocol: u.protocol.replace(':', ''),
        host: u.hostname.split('.'),
        port: u.port || undefined,
        path: u.pathname.split('/').filter(Boolean),
        query: query.length ? query : undefined,
      };
    } catch {
      urlObj = { raw: r.url };
    }

    // Headers
    const header = Object.entries(r.headers || {}).map(([k, v]) => ({ key: k, value: v, type: 'text' }));

    // Body
    let body = undefined;
    if (r.bodyType && r.bodyType !== 'none' && r.body) {
      if (r.bodyType === 'json') {
        body = { mode: 'raw', raw: r.body, options: { raw: { language: 'json' } } };
      } else if (r.bodyType === 'text') {
        body = { mode: 'raw', raw: r.body, options: { raw: { language: 'text' } } };
      } else if (r.bodyType === 'form') {
        const pairs = (r.body || '').split('&').map(p => { const [k, ...v] = p.split('='); return { key: decodeURIComponent(k || ''), value: decodeURIComponent(v.join('=') || ''), type: 'text' }; });
        body = { mode: 'urlencoded', urlencoded: pairs };
      }
    }

    // Auth
    let auth = undefined;
    if (r.auth && r.auth.type && r.auth.type !== 'none') {
      if (r.auth.type === 'bearer') {
        auth = { type: 'bearer', bearer: [{ key: 'token', value: r.auth.token || '', type: 'string' }] };
      } else if (r.auth.type === 'basic') {
        auth = { type: 'basic', basic: [{ key: 'username', value: r.auth.username || '', type: 'string' }, { key: 'password', value: r.auth.password || '', type: 'string' }] };
      } else if (r.auth.type === 'apikey') {
        auth = { type: 'apikey', apikey: [{ key: 'key', value: r.auth.keyName || '', type: 'string' }, { key: 'value', value: r.auth.keyValue || '', type: 'string' }] };
      }
    }

    return {
      name: r.name || r.url,
      request: {
        method: r.method || 'GET',
        header,
        url: urlObj,
        body,
        auth,
      },
      response: [],
    };
  });

  return {
    info: {
      _postman_id: genId(),
      name: collection.name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
  };
}

// ----------------------------------------------------------------
// cURL Copy / Import
// ----------------------------------------------------------------

/** Build a cURL command string from the current API client state */
function buildCurlCommand() {
  const method = $('#api-method')?.value || 'GET';
  const url = $('#api-url')?.value?.trim() || '';
  if (!url) return '';

  const headers = getKvPairs('api-headers-table');
  const params = getKvPairs('api-params-table');

  // Auth headers
  const authType = $('#api-auth-type')?.value;
  if (authType === 'bearer') {
    const token = $('#api-auth-token')?.value;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else if (authType === 'basic') {
    const user = $('#api-auth-user')?.value || '';
    const pass = $('#api-auth-pass')?.value || '';
    headers['Authorization'] = `Basic ${btoa(user + ':' + pass)}`;
  } else if (authType === 'apikey') {
    const keyName = $('#api-auth-key-name')?.value;
    const keyVal = $('#api-auth-key-val')?.value;
    if (keyName && keyVal) headers[keyName] = keyVal;
  }

  // Build full URL with params
  let fullUrl = url;
  const paramStr = new URLSearchParams(params).toString();
  if (paramStr) fullUrl += (url.includes('?') ? '&' : '?') + paramStr;

  const parts = ['curl'];
  if (method !== 'GET') parts.push(`-X ${method}`);
  parts.push(`'${fullUrl}'`);

  for (const [k, v] of Object.entries(headers)) {
    parts.push(`-H '${k}: ${v}'`);
  }

  const bodyType = $('#api-body-type')?.value || 'none';
  if (['POST', 'PUT', 'PATCH'].includes(method) && bodyType !== 'none') {
    const body = $('#api-body-content')?.value || '';
    if (body) {
      parts.push(`-d '${body.replace(/'/g, "'\\''")}'`);
    }
  }

  return parts.join(' \\\n  ');
}

/** Copy the current request as a cURL command */
function copyAsCurl() {
  const curl = buildCurlCommand();
  if (!curl) { showToast('Enter a URL first', 'warning'); return; }
  navigator.clipboard.writeText(curl).then(() => {
    showToast('cURL copied to clipboard', 'info');
  }).catch(() => {
    showToast('Failed to copy to clipboard', 'error');
  });
}

// ----------------------------------------------------------------
// cURL Import Modal
// ----------------------------------------------------------------
function showCurlImportModal() {
  const overlay = $('#curl-import-overlay');
  const input = $('#curl-import-input');
  if (!overlay || !input) return;
  overlay.classList.remove('hidden');
  input.value = '';
  input.focus();
}

function hideCurlImportModal() {
  const overlay = $('#curl-import-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function initCurlImportModal() {
  const overlay = $('#curl-import-overlay');
  const input = $('#curl-import-input');
  const applyBtn = $('#btn-curl-import-apply');
  const cancelBtn = $('#btn-curl-import-cancel');
  const closeBtn = $('#btn-curl-import-close');
  if (!overlay) return;

  // Close actions
  cancelBtn?.addEventListener('click', hideCurlImportModal);
  closeBtn?.addEventListener('click', hideCurlImportModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideCurlImportModal();
  });

  // Auto-detect paste: immediately enable Import button when curl is pasted
  input?.addEventListener('input', () => {
    const val = (input.value || '').trim();
    if (applyBtn) {
      applyBtn.disabled = !val;
    }
  });

  // Import button
  applyBtn?.addEventListener('click', () => {
    const val = (input?.value || '').trim();
    if (!val) { showToast('Paste a cURL command first', 'warning'); return; }
    parseCurlAndPopulate(val);
    hideCurlImportModal();
    // Ensure the API client panel is visible after import
    const panel = $('#api-client-panel');
    if (panel && panel.classList.contains('hidden')) {
      toggleToolPanel('api-client-panel');
    }
  });

  // Cmd/Ctrl+Enter to import quickly
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideCurlImportModal(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      applyBtn?.click();
    }
  });
}

/** Parse a cURL command string and populate the API client fields */
function parseCurlAndPopulate(curlStr) {
  if (!curlStr) return;
  // Normalize: remove line continuations
  const normalized = curlStr.replace(/\\\s*\n/g, ' ').trim();

  // Extract method
  let method = 'GET';
  const methodMatch = normalized.match(/-X\s+(\w+)/i);
  if (methodMatch) method = methodMatch[1].toUpperCase();

  // Extract URL — find the first http:// or https:// URL in the command
  let url = '';
  // Look for quoted URLs first
  const quotedUrlMatch = normalized.match(/(?:'(https?:\/\/[^']+)'|"(https?:\/\/[^"]+)")/);
  if (quotedUrlMatch) {
    url = quotedUrlMatch[1] || quotedUrlMatch[2] || '';
  } else {
    // Look for unquoted URL
    const unquotedUrlMatch = normalized.match(/\s(https?:\/\/\S+)/);
    if (unquotedUrlMatch) url = unquotedUrlMatch[1];
  }

  // Extract headers
  const headers = {};
  const headerRegex = /-H\s+(?:'([^']*)'|"([^"]*)")/gi;
  let hm;
  while ((hm = headerRegex.exec(normalized)) !== null) {
    const headerStr = hm[1] || hm[2] || '';
    const colonIdx = headerStr.indexOf(':');
    if (colonIdx > 0) {
      headers[headerStr.substring(0, colonIdx).trim()] = headerStr.substring(colonIdx + 1).trim();
    }
  }

  // Extract body data
  let body = '';
  const dataMatch = normalized.match(/(?:-d|--data|--data-raw|--data-binary)\s+(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/);
  if (dataMatch) {
    body = dataMatch[1] || dataMatch[2] || '';
    if (!method || method === 'GET') method = 'POST';
  }

  // Detect auth from headers
  let authType = 'none';
  if (headers['Authorization']) {
    const authVal = headers['Authorization'];
    if (authVal.startsWith('Bearer ')) {
      authType = 'bearer';
    } else if (authVal.startsWith('Basic ')) {
      authType = 'basic';
    }
  }
  // Check -u flag for basic auth
  const userMatch = normalized.match(/-u\s+(?:'([^']*)'|"([^"]*)"|([\S]+))/);
  if (userMatch) {
    const userPass = userMatch[1] || userMatch[2] || userMatch[3] || '';
    const [user, pass] = userPass.split(':');
    headers['Authorization'] = `Basic ${btoa((user || '') + ':' + (pass || ''))}`;
    authType = 'basic';
  }

  // Populate the UI
  if ($('#api-method')) $('#api-method').value = method;
  if ($('#api-url')) $('#api-url').value = url;

  // Clear and populate headers
  const hTable = $('#api-headers-table');
  if (hTable) {
    // Keep the header row, remove all data rows
    hTable.querySelectorAll('.api-kv-row').forEach(r => r.remove());
    const nonAuthHeaders = Object.entries(headers).filter(([k]) => k !== 'Authorization');
    if (nonAuthHeaders.length > 0) {
      nonAuthHeaders.forEach(([k, v]) => {
        addKvRow('api-headers-table');
        const rows = hTable.querySelectorAll('.api-kv-row');
        const last = rows[rows.length - 1];
        if (last) { last.querySelector('.api-kv-key').value = k; last.querySelector('.api-kv-value').value = v; }
      });
    } else {
      addKvRow('api-headers-table');
    }
  }

  // Set body
  if (body) {
    let bodyType = 'text';
    try { JSON.parse(body); bodyType = 'json'; } catch {}
    if (headers['Content-Type']?.includes('x-www-form-urlencoded')) bodyType = 'form';
    if ($('#api-body-type')) $('#api-body-type').value = bodyType;
    if ($('#api-body-content')) $('#api-body-content').value = body;
  }

  // Set auth
  if ($('#api-auth-type')) {
    $('#api-auth-type').value = authType;
    updateAuthFields();
    if (authType === 'bearer') {
      const token = headers['Authorization']?.replace('Bearer ', '') || '';
      setTimeout(() => { if ($('#api-auth-token')) $('#api-auth-token').value = token; }, 50);
    } else if (authType === 'basic') {
      const b64 = headers['Authorization']?.replace('Basic ', '') || '';
      try {
        const decoded = atob(b64);
        const [user, pass] = decoded.split(':');
        setTimeout(() => {
          if ($('#api-auth-user')) $('#api-auth-user').value = user || '';
          if ($('#api-auth-pass')) $('#api-auth-pass').value = pass || '';
        }, 50);
      } catch {}
    }
  }

  showToast('cURL command imported successfully', 'info');
}

// ================================================================
// 24b. REGEX TESTER
// ================================================================
function initRegexTester() {
  const patternEl = $('#regex-pattern');
  const flagsEl   = $('#regex-flags');
  const testEl    = $('#regex-test-string');
  const closeBtn  = $('#btn-regex-close');
  if (!patternEl) return;

  closeBtn?.addEventListener('click', () => toggleToolPanel('regex-panel'));

  const update = debounce(() => runRegex(), 150);
  patternEl.addEventListener('input', update);
  flagsEl?.addEventListener('input', update);
  testEl?.addEventListener('input', update);
}

function runRegex() {
  const pattern    = $('#regex-pattern')?.value || '';
  const flags      = $('#regex-flags')?.value || 'g';
  const testStr    = $('#regex-test-string')?.value || '';
  const resultsEl  = $('#regex-results');
  const infoEl     = $('#regex-match-info');
  const explainEl  = $('#regex-explanation');

  if (!pattern) {
    if (infoEl) infoEl.textContent = '0 matches';
    if (resultsEl) resultsEl.innerHTML = '';
    if (explainEl) explainEl.innerHTML = '<span class="text-muted">Enter a pattern to see explanation</span>';
    return;
  }

  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    if (infoEl) infoEl.textContent = 'Invalid regex';
    if (infoEl) infoEl.style.color = 'var(--accent)';
    if (explainEl) explainEl.innerHTML = `<span style="color:var(--accent)">${escHtml(err.message)}</span>`;
    return;
  }
  if (infoEl) infoEl.style.color = '';

  // Find all matches
  const matches = [];
  let m;
  const safeRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = safeRegex.exec(testStr)) !== null) {
    matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
    if (matches.length > 200) break;
    if (m.index === safeRegex.lastIndex) safeRegex.lastIndex++;
  }

  if (infoEl) infoEl.textContent = `${matches.length} match${matches.length !== 1 ? 'es' : ''}`;

  // Render results with highlighting
  if (resultsEl) {
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="regex-no-match">No matches</div>';
    } else {
      resultsEl.innerHTML = matches.map((m, i) => `
        <div class="regex-match-item">
          <span class="regex-match-idx">${i + 1}</span>
          <span class="regex-match-text">"${escHtml(m.match)}"</span>
          <span class="regex-match-pos">at ${m.index}</span>
          ${m.groups.length > 0 ? `<span class="regex-match-groups">Groups: ${m.groups.map((g, j) => `<span class="regex-group">$${j + 1}="${escHtml(g || '')}"</span>`).join(' ')}</span>` : ''}
        </div>
      `).join('');
    }
  }

  // Explanation
  if (explainEl) {
    explainEl.innerHTML = explainRegex(pattern);
  }
}

function explainRegex(pattern) {
  const explanations = [];
  const tokens = {
    '^': 'Start of string',
    '$': 'End of string',
    '.': 'Any character (except newline)',
    '*': 'Zero or more of previous',
    '+': 'One or more of previous',
    '?': 'Zero or one of previous (optional)',
    '\\d': 'Digit (0-9)',
    '\\D': 'Non-digit',
    '\\w': 'Word character (a-z, A-Z, 0-9, _)',
    '\\W': 'Non-word character',
    '\\s': 'Whitespace',
    '\\S': 'Non-whitespace',
    '\\b': 'Word boundary',
    '\\B': 'Non-word boundary',
    '\\n': 'Newline',
    '\\t': 'Tab',
  };
  for (const [tok, desc] of Object.entries(tokens)) {
    if (pattern.includes(tok)) {
      explanations.push(`<div class="regex-explain-item"><code>${escHtml(tok)}</code> — ${desc}</div>`);
    }
  }
  // Character classes
  const classMatch = pattern.match(/\[([^\]]+)\]/g);
  if (classMatch) {
    classMatch.forEach(c => explanations.push(`<div class="regex-explain-item"><code>${escHtml(c)}</code> — Character class: one of ${escHtml(c.slice(1, -1))}</div>`));
  }
  // Groups
  const groupMatch = pattern.match(/\(([^)]+)\)/g);
  if (groupMatch) {
    groupMatch.forEach((g, i) => explanations.push(`<div class="regex-explain-item"><code>${escHtml(g)}</code> — Capture group ${i + 1}</div>`));
  }
  // Quantifiers
  const quantMatch = pattern.match(/\{(\d+(?:,\d*)?)\}/g);
  if (quantMatch) {
    quantMatch.forEach(q => explanations.push(`<div class="regex-explain-item"><code>${escHtml(q)}</code> — Repeat ${q.slice(1, -1)} times</div>`));
  }
  // Alternation
  if (pattern.includes('|')) {
    explanations.push(`<div class="regex-explain-item"><code>|</code> — OR (alternation)</div>`);
  }
  return explanations.length > 0 ? explanations.join('') : '<span class="text-muted">Basic literal text match</span>';
}

// ================================================================
// 24c. JSON / YAML TREE VIEWER
// ================================================================
function initJsonViewer() {
  const closeBtn  = $('#btn-json-close');
  const formatBtn = $('#btn-json-format');
  const minifyBtn = $('#btn-json-minify');
  const convertBtn = $('#btn-json-to-yaml');
  const copyBtn   = $('#btn-json-copy');
  const searchEl  = $('#json-viewer-search');
  if (!closeBtn) return;

  closeBtn.addEventListener('click', () => toggleToolPanel('json-viewer-panel'));

  formatBtn?.addEventListener('click', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab) return;
    try {
      const val = tab.model.getValue();
      const parsed = JSON.parse(val);
      const formatted = JSON.stringify(parsed, null, 2);
      tab.model.setValue(formatted);
      showToast('JSON formatted', 'info');
    } catch {
      showToast('Not valid JSON', 'warning');
    }
  });

  minifyBtn?.addEventListener('click', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab) return;
    try {
      const val = tab.model.getValue();
      const parsed = JSON.parse(val);
      tab.model.setValue(JSON.stringify(parsed));
      showToast('JSON minified', 'info');
    } catch {
      showToast('Not valid JSON', 'warning');
    }
  });

  convertBtn?.addEventListener('click', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (!tab) return;
    const val = tab.model.getValue().trim();
    // Detect if YAML or JSON
    try {
      const parsed = JSON.parse(val);
      // Convert JSON -> simple YAML
      const yaml = jsonToYaml(parsed);
      tab.model.setValue(yaml);
      monaco.editor.setModelLanguage(tab.model, 'yaml');
      showToast('Converted to YAML', 'info');
    } catch {
      // Try YAML -> JSON (basic)
      try {
        const obj = basicYamlParse(val);
        tab.model.setValue(JSON.stringify(obj, null, 2));
        monaco.editor.setModelLanguage(tab.model, 'json');
        showToast('Converted to JSON', 'info');
      } catch {
        showToast('Cannot convert — invalid format', 'warning');
      }
    }
  });

  copyBtn?.addEventListener('click', () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab) {
      navigator.clipboard.writeText(tab.model.getValue());
      showToast('Copied to clipboard', 'info');
    }
  });

  searchEl?.addEventListener('input', debounce(() => {
    const q = searchEl.value.trim().toLowerCase();
    $$('.json-tree-item').forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = !q || text.includes(q) ? '' : 'none';
    });
  }, 200));
}

function openJsonViewer() {
  toggleToolPanel('json-viewer-panel');
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;
  const val = tab.model.getValue().trim();
  const treeEl = $('#json-tree');
  if (!treeEl) return;
  try {
    const parsed = JSON.parse(val);
    treeEl.innerHTML = '';
    treeEl.appendChild(renderJsonNode(parsed, 'root'));
  } catch {
    try {
      const obj = basicYamlParse(val);
      treeEl.innerHTML = '';
      treeEl.appendChild(renderJsonNode(obj, 'root'));
    } catch {
      treeEl.innerHTML = '<div class="json-error">Cannot parse as JSON or YAML</div>';
    }
  }
}

function renderJsonNode(value, key, depth = 0) {
  const container = document.createElement('div');
  container.className = 'json-tree-item';
  container.style.paddingLeft = (depth * 16) + 'px';

  if (value === null) {
    container.innerHTML = `<span class="json-key">${escHtml(key)}</span>: <span class="json-null">null</span>`;
  } else if (typeof value === 'boolean') {
    container.innerHTML = `<span class="json-key">${escHtml(key)}</span>: <span class="json-bool">${value}</span>`;
  } else if (typeof value === 'number') {
    container.innerHTML = `<span class="json-key">${escHtml(key)}</span>: <span class="json-number">${value}</span>`;
  } else if (typeof value === 'string') {
    container.innerHTML = `<span class="json-key">${escHtml(key)}</span>: <span class="json-string">"${escHtml(value)}"</span>`;
  } else if (Array.isArray(value)) {
    const toggle = document.createElement('span');
    toggle.className = 'json-toggle';
    toggle.textContent = '▾';
    const keySpan = document.createElement('span');
    keySpan.className = 'json-key';
    keySpan.textContent = `${key} `;
    const info = document.createElement('span');
    info.className = 'json-info';
    info.textContent = `Array(${value.length})`;
    container.appendChild(toggle);
    container.appendChild(keySpan);
    container.appendChild(info);
    const children = document.createElement('div');
    children.className = 'json-children';
    value.forEach((v, i) => children.appendChild(renderJsonNode(v, String(i), depth + 1)));
    container.appendChild(children);
    toggle.addEventListener('click', () => {
      children.classList.toggle('collapsed');
      toggle.textContent = children.classList.contains('collapsed') ? '▸' : '▾';
    });
  } else if (typeof value === 'object') {
    const keys = Object.keys(value);
    const toggle = document.createElement('span');
    toggle.className = 'json-toggle';
    toggle.textContent = '▾';
    const keySpan = document.createElement('span');
    keySpan.className = 'json-key';
    keySpan.textContent = `${key} `;
    const info = document.createElement('span');
    info.className = 'json-info';
    info.textContent = `{${keys.length}}`;
    container.appendChild(toggle);
    container.appendChild(keySpan);
    container.appendChild(info);
    const children = document.createElement('div');
    children.className = 'json-children';
    keys.forEach(k => children.appendChild(renderJsonNode(value[k], k, depth + 1)));
    container.appendChild(children);
    toggle.addEventListener('click', () => {
      children.classList.toggle('collapsed');
      toggle.textContent = children.classList.contains('collapsed') ? '▸' : '▾';
    });
  }
  return container;
}

function jsonToYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  if (obj === null) return 'null';
  if (typeof obj !== 'object') return typeof obj === 'string' ? `"${obj}"` : String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(v => pad + '- ' + jsonToYaml(v, indent + 1).trimStart()).join('\n');
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) return '{}';
  return entries.map(([k, v]) => {
    if (typeof v === 'object' && v !== null) {
      return pad + k + ':\n' + jsonToYaml(v, indent + 1);
    }
    return pad + k + ': ' + jsonToYaml(v, indent + 1);
  }).join('\n');
}

function basicYamlParse(text) {
  const result = {};
  const lines = text.split('\n');
  let currentKey = null;
  let currentArr = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      if (currentArr) currentArr.push(parseYamlValue(trimmed.slice(2)));
      continue;
    }
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (val === '' || val === '|' || val === '>') {
        result[key] = [];
        currentKey = key;
        currentArr = result[key];
      } else {
        result[key] = parseYamlValue(val);
        currentArr = null;
      }
    }
  }
  return result;
}

function parseYamlValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v.replace(/^["']|["']$/g, '');
}

// ================================================================
// 24d. SMART BOOKMARKS
// ================================================================
function initBookmarks() {
  const addBtn   = $('#btn-bookmark-add');
  const clearBtn = $('#btn-bookmark-clear');
  const closeBtn = $('#btn-bookmark-close');
  const input    = $('#bookmark-input');
  if (!closeBtn) return;

  closeBtn.addEventListener('click', () => toggleToolPanel('bookmarks-panel'));

  // "📌 Line" button — bookmarks the current cursor position
  addBtn?.addEventListener('click', addLineBookmark);

  // Text input — press Enter to add a free-form bookmark
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      addFreeBookmark(text);
      input.value = '';
    }
  });

  clearBtn?.addEventListener('click', async () => {
    state.bookmarks = [];
    await window.apexStudio.saveBookmarks([]);
    renderBookmarks();
    showToast('All bookmarks cleared', 'info');
  });

  // Load saved bookmarks
  loadBookmarks();
}

async function loadBookmarks() {
  try {
    state.bookmarks = await window.apexStudio.loadBookmarks() || [];
  } catch { state.bookmarks = []; }
}

// Bookmark the current cursor line in the active file
function addLineBookmark() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab || !state.editor) { showToast('Open a file and place your cursor on a line first', 'warning'); return; }

  const pos = state.editor.getPosition();
  const line = pos.lineNumber;
  const lineContent = tab.model.getLineContent(line).trim();

  const existing = state.bookmarks.find(b => b.filePath === (tab.filePath || tab.title) && b.line === line);
  if (existing) { showToast(`Line ${line} already bookmarked`, 'info'); return; }

  const bookmark = {
    id: Date.now(),
    type: 'line',
    filePath: tab.filePath || tab.title,
    fileName: tab.title,
    line,
    column: pos.column,
    preview: lineContent.substring(0, 80),
    note: '',
    created: new Date().toISOString(),
  };

  state.bookmarks.push(bookmark);
  window.apexStudio.saveBookmarks(state.bookmarks);
  renderBookmarks();
  showToast(`Bookmarked line ${line} in ${tab.title}`, 'info');
}

// Add a free-form text bookmark (no file required)
function addFreeBookmark(text) {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  const bookmark = {
    id: Date.now(),
    type: 'note',
    filePath: tab?.filePath || '',
    fileName: tab?.title || '',
    line: tab && state.editor ? state.editor.getPosition().lineNumber : 0,
    column: 0,
    preview: '',
    note: text,
    created: new Date().toISOString(),
  };

  state.bookmarks.push(bookmark);
  window.apexStudio.saveBookmarks(state.bookmarks);
  renderBookmarks();
  showToast('Bookmark added', 'info');
}

function renderBookmarks() {
  const list = $('#bookmarks-list');
  if (!list) return;

  if (state.bookmarks.length === 0) {
    list.innerHTML = '<div class="bookmarks-empty">No bookmarks yet.<br>Type above or click 📌 Line to bookmark your cursor position.</div>';
    return;
  }

  list.innerHTML = state.bookmarks.map((b, i) => {
    const isNote = b.type === 'note';
    const fileInfo = b.fileName ? `${getFileIcon(b.fileName)} ${escHtml(b.fileName)}` : '';
    const lineInfo = b.line > 0 ? `L${b.line}` : '';
    return `
    <div class="bookmark-item ${isNote ? 'bookmark-note-type' : ''}" data-idx="${i}">
      <div class="bookmark-header">
        ${isNote
          ? `<span class="bookmark-note-icon">📝</span><span class="bookmark-note-text">${escHtml(b.note)}</span>`
          : `<span class="bookmark-file">${fileInfo}</span><span class="bookmark-line">${lineInfo}</span>`
        }
        <button class="bookmark-del" data-idx="${i}" title="Remove">✕</button>
      </div>
      ${!isNote && b.preview ? `<div class="bookmark-preview">${escHtml(b.preview)}</div>` : ''}
      ${!isNote && b.note ? `<div class="bookmark-note">📝 ${escHtml(b.note)}</div>` : ''}
      ${isNote && b.fileName ? `<div class="bookmark-context">${fileInfo} ${lineInfo}</div>` : ''}
    </div>`;
  }).join('');

  // Jump to bookmark on click
  list.querySelectorAll('.bookmark-item').forEach(el => {
    el.addEventListener('click', async (e) => {
      if (e.target.classList.contains('bookmark-del')) return;
      const b = state.bookmarks[+el.dataset.idx];
      if (!b) return;
      // Open the file if not already open
      const tab = state.tabs.find(t => t.filePath === b.filePath);
      if (tab) {
        activateTab(tab.id);
      } else if (b.filePath && !b.filePath.startsWith('Untitled')) {
        try {
          const content = await window.apexStudio.readFile(b.filePath);
          if (content != null) await openFile(b.filePath, content);
        } catch {}
      }
      // Go to line
      setTimeout(() => {
        if (state.editor) {
          state.editor.revealLineInCenter(b.line);
          state.editor.setPosition({ lineNumber: b.line, column: b.column || 1 });
          state.editor.focus();
        }
      }, 100);
    });
  });

  // Delete buttons
  list.querySelectorAll('.bookmark-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.bookmarks.splice(+btn.dataset.idx, 1);
      window.apexStudio.saveBookmarks(state.bookmarks);
      renderBookmarks();
    });
  });
}

// ================================================================
// 24e. CODE SCREENSHOT
// ================================================================
function initScreenshot() {
  const closeBtn  = $('#btn-screenshot-close');
  const exportBtn = $('#btn-screenshot-export');
  const copyBtn   = $('#btn-screenshot-copy');
  if (!closeBtn) return;

  closeBtn.addEventListener('click', () => toggleToolPanel('screenshot-panel'));

  // Live preview update
  ['screenshot-bg', 'screenshot-padding', 'screenshot-radius', 'screenshot-watermark', 'screenshot-linenums'].forEach(id => {
    $('#' + id)?.addEventListener('input', updateScreenshotPreview);
    $('#' + id)?.addEventListener('change', updateScreenshotPreview);
  });

  exportBtn?.addEventListener('click', exportScreenshot);
  copyBtn?.addEventListener('click', copyScreenshot);
}

function openScreenshotPanel() {
  toggleToolPanel('screenshot-panel');
  updateScreenshotPreview();
}

function updateScreenshotPreview() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;

  const codeEl = $('#screenshot-code');
  const previewEl = $('#screenshot-preview');
  const watermarkEl = $('#screenshot-watermark-text');
  if (!codeEl || !previewEl) return;

  // Get selected text or visible lines
  let code = '';
  if (state.editor) {
    const sel = state.editor.getSelection();
    if (sel && !sel.isEmpty()) {
      code = state.editor.getModel().getValueInRange(sel);
    } else {
      // Use first 30 visible lines
      const lines = tab.model.getLinesContent().slice(0, 30);
      code = lines.join('\n');
    }
  }

  const showLineNums = $('#screenshot-linenums')?.checked;
  if (showLineNums) {
    const lines = code.split('\n');
    code = lines.map((l, i) => `${String(i + 1).padStart(3)} │ ${l}`).join('\n');
  }

  codeEl.textContent = code;

  // Apply styles
  const bg = $('#screenshot-bg')?.value || '#1e1e2e';
  const padding = ($('#screenshot-padding')?.value || 40) + 'px';
  const radius = ($('#screenshot-radius')?.value || 12) + 'px';
  const showWatermark = $('#screenshot-watermark')?.checked;

  previewEl.style.background = bg;
  previewEl.style.padding = padding;
  previewEl.style.borderRadius = radius;
  if (watermarkEl) watermarkEl.style.display = showWatermark ? '' : 'none';
}

async function exportScreenshot() {
  const canvas = await renderScreenshotCanvas();
  if (!canvas) return;
  const dataUrl = canvas.toDataURL('image/png');
  const saved = await window.apexStudio.saveScreenshot(dataUrl);
  if (saved) showToast('Screenshot saved to ' + saved, 'info');
}

async function copyScreenshot() {
  const canvas = await renderScreenshotCanvas();
  if (!canvas) return;
  canvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Screenshot copied to clipboard', 'info');
    } catch (err) {
      showToast('Failed to copy: ' + err.message, 'warning');
    }
  });
}

function renderScreenshotCanvas() {
  return new Promise(resolve => {
    const previewEl = $('#screenshot-preview');
    if (!previewEl) { resolve(null); return; }

    const bg      = $('#screenshot-bg')?.value || '#1e1e2e';
    const padding = parseInt($('#screenshot-padding')?.value || 40);
    const radius  = parseInt($('#screenshot-radius')?.value || 12);
    const codeEl  = $('#screenshot-code');
    const code    = codeEl?.textContent || '';
    const lines   = code.split('\n');

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');

    const fontSize = 14;
    const lineHeight = 20;
    const font = '14px "SF Mono", SFMono-Regular, Menlo, Monaco, "Cascadia Code", Consolas, "Courier New", monospace';
    ctx.font = font;

    const maxLineWidth = Math.max(...lines.map(l => ctx.measureText(l).width), 300);
    const codeWidth = maxLineWidth + 40;
    const codeHeight = lines.length * lineHeight + 20;
    const dotBarHeight = 32;

    canvas.width  = codeWidth + padding * 2;
    canvas.height = codeHeight + dotBarHeight + padding * 2;

    // Background
    ctx.fillStyle = bg;
    ctx.beginPath();
    roundRect(ctx, 0, 0, canvas.width, canvas.height, radius);
    ctx.fill();

    // Window dots
    const dotY = padding + 14;
    [[12, '#ff5f56'], [28, '#ffbd2e'], [44, '#27c93f']].forEach(([x, color]) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(padding + x, dotY, 5, 0, Math.PI * 2);
      ctx.fill();
    });

    // Code text
    ctx.fillStyle = '#cdd6f4';
    ctx.font = font;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillText(line, padding + 16, padding + dotBarHeight + i * lineHeight + 8);
    });

    // Watermark
    if ($('#screenshot-watermark')?.checked) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('Apex Debug Studio', canvas.width - padding - 8, canvas.height - padding - 8);
    }

    resolve(canvas);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

// ================================================================
// 24f. DATABASE CLIENT
// ================================================================
function initDbClient() {
  const closeBtn   = $('#btn-db-close');
  const connectBtn = $('#btn-db-connect');
  const browseBtn  = $('#btn-db-browse');
  const openBtn    = $('#btn-db-open');
  const runBtn     = $('#btn-db-run');
  if (!closeBtn) return;

  closeBtn.addEventListener('click', () => toggleToolPanel('db-panel'));

  connectBtn?.addEventListener('click', () => {
    const connectForm = $('#db-connect-form');
    const queryArea   = $('#db-query-area');
    if (connectForm && queryArea) {
      connectForm.classList.toggle('hidden');
      queryArea.classList.add('hidden');
    }
    state.dbFilePath = null;
    state.dbTables = [];
    $('#db-filepath').textContent = 'No file selected';
  });

  browseBtn?.addEventListener('click', async () => {
    const files = await window.apexStudio.openFileDialog();
    if (files && files[0]) {
      state.dbFilePath = files[0];
      $('#db-filepath').textContent = files[0].split(/[/\\]/).pop();
    }
  });

  openBtn?.addEventListener('click', async () => {
    if (!state.dbFilePath) { showToast('Select a file first', 'warning'); return; }
    try {
      const result = await window.apexStudio.dbOpen(state.dbFilePath);
      if (!result.ok) { showToast(result.error, 'warning'); return; }
      state.dbType = result.type;
      state.dbTables = result.tables || [];
      // Show query area
      $('#db-connect-form')?.classList.add('hidden');
      $('#db-query-area')?.classList.remove('hidden');
      renderDbTables();
      showToast(`Opened ${result.type} database (${state.dbTables.length} tables)`, 'info');
    } catch (err) {
      showToast('Error: ' + err.message, 'warning');
    }
  });

  runBtn?.addEventListener('click', runDbQuery);

  // Ctrl+Enter to run query
  $('#db-query-input')?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runDbQuery();
    }
  });
}

function renderDbTables() {
  const list = $('#db-tables-list');
  if (!list) return;
  list.innerHTML = state.dbTables.map(t => `<div class="db-table-item" data-table="${escHtml(t)}">📋 ${escHtml(t)}</div>`).join('');
  list.querySelectorAll('.db-table-item').forEach(el => {
    el.addEventListener('click', () => {
      const table = el.dataset.table;
      const input = $('#db-query-input');
      if (state.dbType === 'sqlite') {
        input.value = `SELECT * FROM ${table} LIMIT 100;`;
      } else if (state.dbType === 'json') {
        input.value = table;
      } else {
        input.value = '';
      }
      runDbQuery(table);
    });
  });
}

async function runDbQuery(tableName) {
  const query = $('#db-query-input')?.value.trim();
  const statusEl = $('#db-query-status');
  if (!state.dbFilePath) return;

  if (statusEl) statusEl.textContent = 'Running...';
  try {
    const start = Date.now();
    const result = await window.apexStudio.dbQuery(state.dbFilePath, query, tableName || query);
    const elapsed = Date.now() - start;
    if (!result.ok) {
      if (statusEl) statusEl.textContent = 'Error: ' + result.error;
      return;
    }
    if (statusEl) statusEl.textContent = `${result.rows.length} rows (${elapsed}ms)`;
    renderDbResults(result.columns, result.rows);
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error: ' + err.message;
  }
}

function renderDbResults(columns, rows) {
  const container = $('#db-results');
  if (!container) return;

  if (rows.length === 0) {
    container.innerHTML = '<div class="db-results-empty">No results</div>';
    return;
  }

  let html = '<table class="db-table"><thead><tr>';
  columns.forEach(c => html += `<th>${escHtml(c)}</th>`);
  html += '</tr></thead><tbody>';
  rows.forEach(row => {
    html += '<tr>';
    columns.forEach(c => {
      const val = row[c];
      html += `<td>${val === null ? '<span class="json-null">null</span>' : escHtml(String(val))}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}


/* ================================================================
   25. INIT
   ================================================================ */
// Dismiss the branded boot splash with a fade-out. Idempotent.
function hideSplash() {
  const el = document.getElementById('app-splash');
  if (!el || el.classList.contains('splash-hidden')) return;
  el.classList.add('splash-hidden');
  setTimeout(() => el.classList.add('splash-done'), 480);
}

async function init() {
  cacheDom();
  applyTheme(state.theme);

  // Load settings
  await loadSettings();

  // Init Monaco
  await initMonaco();

  // Register color provider for non-CSS languages
  registerColorProvider();

  // Init all subsystems
  initSearch();
  initGoto();
  initQuickOpen();
  initCommandPalette();
  initGlobalSearch();
  initThemePicker();
  initContextMenu();
  initTabContextMenu();
  initBreadcrumbContextMenu();
  initResizer();
  initRecentResizer();
  initKeyboard();
  initIpcHandlers();
  initDragDrop();
  initWelcome();
  initSystemSearch();
  initWelcomeSearch();
  initMarkdownPreview();
  initFileWatcher();
  initTerminal();
  initLanguagePicker();
  initMinimapToggle();
  updateMinimapIndicator();
  initGitInfoPopup();
  initRichTextEditor();
  initApiClient();
  initRegexTester();
  initJsonViewer();
  initBookmarks();
  initScreenshot();
  initDbClient();
  initToolbarButtons();

  // Module-based features
  if (window.initSnippets)    initSnippets();
  if (window.initColorPicker) initColorPicker();
  if (window.initTodoTracker) initTodoTracker();
  if (window.initPomodoro)    initPomodoro();
  if (window.initDiffChecker) initDiffChecker();
  if (window.initSalesforce) initSalesforce();
  if (window.initApexDebugger) initApexDebugger();

  // Sidebar section toggles
  dom.recentSectionHeader.addEventListener('click', toggleRecentSection);
  dom.outlineSectionHeader.addEventListener('click', toggleOutlineSection);
  dom.historySectionHeader.addEventListener('click', toggleHistorySection);

  // Right-click on root folder bar => context menu for root folder
  dom.rootFolderBar.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (state.folderPath) {
      showContextMenu(e.clientX, e.clientY, state.folderPath, true);
    }
  });

  // Right-click on empty space in file-tree => context menu for root folder
  dom.fileTree.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.tree-item') && state.folderPath) {
      e.preventDefault(); e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, state.folderPath, true);
    }
  });

  // Right-click on tree-empty area => context menu for root (just new file/folder)
  dom.fileTreeEmpty.addEventListener('contextmenu', (e) => {
    if (state.folderPath) {
      e.preventDefault(); e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, state.folderPath, true);
    }
  });

  // Sidebar buttons
  $('#btn-collapse-sidebar').addEventListener('click', toggleSidebar);
  $('#btn-toggle-sidebar').addEventListener('click', toggleSidebar);
  $('#btn-open-folder').addEventListener('click', openFolderDialog);
  $('#btn-tree-open-folder').addEventListener('click', openFolderDialog);
  $('#btn-new-tab').addEventListener('click', () => createTab());
  // Double-click on empty area of tab bar to create a new tab
  $('#tab-bar').addEventListener('dblclick', (e) => {
    if (e.target.id === 'tab-bar' || e.target.id === 'tabs-container') {
      createTab();
    }
  });

  // Load recent & restore session
  await loadRecentFiles();
  await restoreSession();

  // Show welcome only if no tabs AND no folder open
  // (If a folder is restored but no tabs, show sidebar + shortcuts overlay instead)
  if (state.tabs.length === 0) {
    hideFileStatusItems();
    if (state.folderPath) {
      hideWelcome();
      showEmptyTabShortcuts();
    } else {
      showWelcome();
    }
  }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  // Safety net: never let the splash trap the user, even if init stalls.
  const splashSafety = setTimeout(hideSplash, 8000);
  Promise.resolve()
    .then(init)
    .catch((e) => console.error('init failed', e))
    .finally(() => { clearTimeout(splashSafety); hideSplash(); });
});

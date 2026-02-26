/* ========================================================================
   SplecNote — Renderer (app.js)
   ======================================================================== */

'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---- State ---- */
const state = {
  editor: null,
  tabs: [],               // { id, title, filePath, model, viewState, modified }
  activeTabId: null,
  folderPath: null,
  sidebarVisible: true,
  sidebarWidth: 260,      // remembered width before collapse
  searchDecorations: [],   // IDs for current in-file search decorations
  globalSearchAbort: null, // AbortController for async global search
  recentSectionOpen: false,
  recentHeight: 150,       // starting height for recent section
  autoSaveTimers: {},
  theme: 'dark',
  welcomeVisible: true,
  treeSectionOpen: true,
  recentlyClosed: [],      // stack of { title, filePath, content } for Cmd+Shift+T
};

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
  { id: 'splec',             label: 'Splec Theme',       base: 'vs-dark' },
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
    splec: {
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
        fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
        minimap: { enabled: true },
        wordWrap: 'off',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true },
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        cursorBlinking: 'smooth',
        padding: { top: 10 },
        lineNumbers: 'on',
        glyphMargin: false,
        folding: true,
        tabSize: 2,
      });
      state.editor.onDidChangeCursorPosition(updateStatusPosition);
      state.editor.onDidChangeModelContent(() => {
        markTabModified(state.activeTabId, true);
        scheduleAutoSave(state.activeTabId);
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
  return tab;
}

function activateTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  // Save current view state
  const prev = state.tabs.find((t) => t.id === state.activeTabId);
  if (prev && state.editor) prev.viewState = state.editor.saveViewState();
  state.activeTabId = id;
  state.editor.setModel(tab.model);
  if (tab.viewState) state.editor.restoreViewState(tab.viewState);
  state.editor.focus();
  renderTabs();
  updateStatusLanguage(tab);
  updateTitleBar(tab);
  clearSearchDecorations();
  updateEmptyTabShortcuts();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  // Save to recently closed stack
  const closedEntry = { title: tab.title, filePath: tab.filePath, content: tab.model.getValue() };
  state.recentlyClosed.push(closedEntry);
  if (state.recentlyClosed.length > 20) state.recentlyClosed.shift();
  // Clean up model
  tab.model.dispose();
  state.tabs.splice(idx, 1);
  clearAutoSave(id);
  if (state.tabs.length === 0) {
    state.activeTabId = null;
    state.editor.setModel(null);
    if (state.folderPath) {
      // Folder is open — show no-editor overlay, not the full welcome screen
      hideWelcome();
      showEmptyTabShortcuts();
    } else {
      hideEmptyTabShortcuts();
      showWelcome();
    }
    renderTabs();
    return;
  }
  if (state.activeTabId === id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    activateTab(next.id);
  } else {
    renderTabs();
  }
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
  dom.titlebarTitle.textContent = tab ? `${mod}${tab.title} — SplecNote` : 'SplecNote';
}

/* ================================================================
   3. FILE OPERATIONS
   ================================================================ */

async function openFileDialog() {
  try {
    const filePaths = await window.splecnote.openFileDialog();
    if (!filePaths || filePaths.length === 0) return;
    for (const fp of filePaths) {
      const content = await window.splecnote.readFile(fp);
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
  const name = filePath.split('/').pop();
  createTab(name, filePath, content);
  await window.splecnote.addRecent(filePath);
}

async function saveFile(tabOrId) {
  const tab = typeof tabOrId === 'object' ? tabOrId : state.tabs.find((t) => t.id === tabOrId);
  if (!tab) return;
  const content = tab.model.getValue();
  if (!tab.filePath) {
    // Untitled — auto-save to dedicated dir
    const today = new Date().toISOString().slice(0, 10);
    const safeName = tab.title.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = await window.splecnote.getAutoSavePath(today);
    const filePath = `${dir}/${safeName}`;
    await window.splecnote.writeFile(filePath, content);
    tab.filePath = filePath;
  } else {
    await window.splecnote.writeFile(tab.filePath, content);
  }
  markTabModified(tab.id, false);
  showAutoSaved();
}

async function saveAsFile() {
  // Use the existing writeFile after getting a new path via dialog
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) return;
  await saveFile(tab);
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
  try {
    const tabs = state.tabs.map((t) => ({
      title: t.title,
      filePath: t.filePath,
      content: t.filePath ? null : t.model.getValue(),
    }));
    await window.splecnote.saveSession({
      tabs,
      activeIndex: state.tabs.findIndex((t) => t.id === state.activeTabId),
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

async function restoreSession() {
  // Skip session restore for new windows (opened via New Window)
  const params = new URLSearchParams(window.location.search);
  if (params.get('new') === '1') {
    // Still restore theme preference
    try {
      const session = await window.splecnote.loadSession();
      if (session?.theme) { state.theme = session.theme; applyTheme(state.theme); }
    } catch {}
    // Ensure sidebar is visible in new windows
    state.sidebarVisible = true;
    applySidebarState();
    return;
  }
  try {
    const session = await window.splecnote.loadSession();
    if (!session) return;
    // Restore user preferences only — theme, sidebar
    if (session.theme) { state.theme = session.theme; applyTheme(state.theme); }
    if (session.sidebarVisible !== undefined) {
      state.sidebarVisible = session.sidebarVisible;
    }
    if (session.sidebarWidth) {
      state.sidebarWidth = session.sidebarWidth;
    }
    applySidebarState();
    // Do NOT restore folderPath or tabs — always start fresh with welcome screen
  } catch (err) {
    console.error('restoreSession error:', err);
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
    state.folderPath = dirPath;
    // Add folder to recent list
    await window.splecnote.addRecent(dirPath);
    dom.fileTreeEmpty.classList.add('hidden');
    dom.fileTree.innerHTML = '';
    dom.rootFolderBar.classList.remove('hidden');
    dom.rootFolderName.textContent = dirPath.split('/').pop();
    await renderTreeDir(dirPath, dom.fileTree, 0);
    // If tree ended up empty, show a message
    if (dom.fileTree.children.length === 0) {
      dom.fileTree.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;">Empty folder</div>';
    }
    // Show no-editor overlay if no tabs are open
    if (state.tabs.length === 0) {
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
    const dirPath = await window.splecnote.openFolderDialog();
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
    entries = await window.splecnote.readDir(dirPath);
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
          const content = await window.splecnote.readFile(entry.path);
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
  dom.contextMenu.classList.remove('hidden');
  dom.contextMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  dom.contextMenu.style.top = Math.min(y, window.innerHeight - 250) + 'px';
}

function hideContextMenu() {
  dom.contextMenu.classList.add('hidden');
}

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
    const parentDir = contextTarget.isDir ? tp : tp.substring(0, tp.lastIndexOf('/'));

    switch (action) {
      case 'new-file': {
        const name = prompt('New file name:');
        if (!name) return;
        const fp = `${parentDir}/${name}`;
        await window.splecnote.writeFile(fp, '');
        await refreshTree();
        break;
      }
      case 'new-folder': {
        const name = prompt('New folder name:');
        if (!name) return;
        await window.splecnote.createDir(`${parentDir}/${name}`);
        await refreshTree();
        break;
      }
      case 'rename': {
        const oldName = tp.split('/').pop();
        const newName = prompt('Rename to:', oldName);
        if (!newName || newName === oldName) return;
        const newPath = tp.substring(0, tp.lastIndexOf('/')) + '/' + newName;
        await window.splecnote.rename(tp, newPath);
        await refreshTree();
        break;
      }
      case 'delete': {
        if (!confirm(`Delete "${tp.split('/').pop()}"?`)) return;
        await window.splecnote.deleteFile(tp);
        await refreshTree();
        break;
      }
      case 'copy-path': {
        await navigator.clipboard.writeText(tp);
        break;
      }
      case 'reveal-finder': {
        try { await window.splecnote.revealInFinder(tp); } catch (err) { console.error('reveal error:', err); }
        break;
      }
      case 'open-terminal': {
        try { await window.splecnote.openInTerminal(parentDir); } catch (err) { console.error('open terminal error:', err); }
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
  menu.querySelectorAll('[data-action="tab-copy-path"], [data-action="tab-reveal-finder"], [data-action="tab-open-terminal"]').forEach(el => {
    el.style.display = tab?.filePath ? '' : 'none';
  });
  // Also hide separator before path actions if no file
  const seps = menu.querySelectorAll('.ctx-separator');
  if (seps.length >= 2) seps[1].style.display = tab?.filePath ? '' : 'none';

  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 250) + 'px';
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
      case 'tab-copy-path':
        if (tab.filePath) await navigator.clipboard.writeText(tab.filePath);
        break;
      case 'tab-reveal-finder':
        if (tab.filePath) {
          try { await window.splecnote.revealInFinder(tab.filePath); } catch (err) { console.error(err); }
        }
        break;
      case 'tab-open-terminal': {
        if (tab.filePath) {
          const dir = tab.filePath.substring(0, tab.filePath.lastIndexOf('/'));
          try { await window.splecnote.openInTerminal(dir); } catch (err) { console.error(err); }
        }
        break;
      }
    }
  });
}

/* ================================================================
   8. SEARCH & REPLACE (In-File)
   ================================================================ */

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
  loadQuickOpenFiles().then(() => {
    // Show recent files by default when opening
    const recentPaths = getRecentFilePaths();
    if (recentPaths.length > 0) {
      renderQuickOpenResults(recentPaths);
    } else {
      renderQuickOpenResults(quickOpenFiles.slice(0, 50));
    }
  });
}

function getRecentFilePaths() {
  // Gather recently opened tabs + recent files list
  const seen = new Set();
  const result = [];
  // Open tabs first (most relevant)
  for (const t of state.tabs) {
    if (t.filePath && !seen.has(t.filePath)) {
      seen.add(t.filePath);
      result.push(t.filePath);
    }
  }
  // Then add files from the recent list in sidebar
  const recentItems = document.querySelectorAll('#recent-list .recent-item');
  recentItems.forEach(el => {
    const fp = el.dataset?.path;
    if (fp && !seen.has(fp)) {
      seen.add(fp);
      result.push(fp);
    }
  });
  return result.slice(0, 50);
}

function hideQuickOpen() {
  dom.quickOpenOverlay.classList.add('hidden');
  quickOpenSelectedIndex = -1;
}

async function loadQuickOpenFiles() {
  if (state.folderPath) {
    try {
      quickOpenFiles = await window.splecnote.getAllFiles(state.folderPath);
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
    const name = fp.split('/').pop();
    const relPath = state.folderPath ? fp.replace(state.folderPath + '/', '') : fp;
    item.innerHTML = `<span class="qo-icon">${getFileIcon(name)}</span><span>${escHtml(name)}</span><span class="path">${escHtml(relPath)}</span>`;
    item.addEventListener('click', async () => {
      hideQuickOpen();
      try {
        const content = await window.splecnote.readFile(fp);
        await openFile(fp, content);
      } catch (err) { console.error('quick open error:', err); }
    });
    item.addEventListener('mouseenter', () => {
      quickOpenUpdateSelected(i);
    });
    dom.quickOpenResults.appendChild(item);
  }
}

function quickOpenUpdateSelected(idx) {
  const items = dom.quickOpenResults.querySelectorAll('.qo-item');
  if (items.length === 0) return;
  items.forEach((el) => el.classList.remove('selected'));
  quickOpenSelectedIndex = Math.max(0, Math.min(idx, items.length - 1));
  items[quickOpenSelectedIndex].classList.add('selected');
  items[quickOpenSelectedIndex].scrollIntoView({ block: 'nearest' });
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
  { id: 'new-window',     label: 'New Window',         shortcut: '⇧⌘N',   action: () => window.splecnote.newWindow() },
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
    item.addEventListener('mouseenter', () => cmdPaletteUpdateSelected(i));
    dom.cmdPaletteResults.appendChild(item);
  }
}

function cmdPaletteUpdateSelected(idx) {
  const items = dom.cmdPaletteResults.querySelectorAll('.cp-item');
  if (items.length === 0) return;
  items.forEach(el => el.classList.remove('selected'));
  cmdPaletteSelectedIndex = Math.max(0, Math.min(idx, items.length - 1));
  items[cmdPaletteSelectedIndex].classList.add('selected');
  items[cmdPaletteSelectedIndex].scrollIntoView({ block: 'nearest' });
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
  dom.globalSearchInput.value = '';
  dom.globalSearchInput.focus();
  dom.globalSearchResults.innerHTML = '';
  dom.globalSearchStatus.textContent = state.folderPath ? 'Type to search across files…' : 'Open a folder first to search across files';
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
    const results = await window.splecnote.searchInFiles(state.folderPath, query, { caseSensitive, isRegex });

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
      header.innerHTML = `<span class="gs-file-icon">${getFileIcon(relPath.split('/').pop())}</span><span>${escHtml(relPath)}</span><span class="gs-file-count">${file.matches.length} matches</span>`;

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
          // Don't hide — keep search persistent so user can click multiple results
          try {
            const content = await window.splecnote.readFile(file.filePath);
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
      themePickerUpdateSelected(i);
      // Live preview on hover
      applyTheme(themes[i].id);
    });
    dom.themePickerResults.appendChild(item);
  }
}

function applyTheme(themeId) {
  state.theme = themeId;
  document.documentElement.setAttribute('data-theme', themeId);
  if (state.editor) {
    monaco.editor.setTheme(monacoThemeId(themeId));
  }
  dom.statusTheme.textContent = `Theme: ${THEMES.find((t) => t.id === themeId)?.label || themeId}`;
  saveSessionDebounced();
}

function themePickerUpdateSelected(idx) {
  const items = dom.themePickerResults.querySelectorAll('.cp-item');
  if (items.length === 0) return;
  items.forEach(el => el.classList.remove('selected'));
  themePickerSelectedIndex = Math.max(0, Math.min(idx, items.length - 1));
  items[themePickerSelectedIndex].classList.add('selected');
  items[themePickerSelectedIndex].scrollIntoView({ block: 'nearest' });
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
    const recentFiles = await window.splecnote.getRecent();
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
  for (const fp of files.slice(0, 20)) {
    const name = fp.split('/').pop();
    const dir = fp.substring(0, fp.lastIndexOf('/'));
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.innerHTML = `<span class="recent-item-name">${escHtml(name)}</span><span class="recent-item-path">${escHtml(dir)}</span>`;
    item.addEventListener('click', async () => {
      try {
        // Check if it's a directory (folder) or a file
        const stat = await window.splecnote.stat(fp);
        if (stat && stat.isDirectory) {
          await openFolder(fp);
        } else {
          const content = await window.splecnote.readFile(fp);
          await openFile(fp, content);
        }
      } catch (err) { console.error('open recent error:', err); }
    });
    dom.recentList.appendChild(item);
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
  for (const fp of files.slice(0, 8)) {
    const name = fp.split('/').pop();
    const dir = fp.substring(0, fp.lastIndexOf('/'));
    const shortDir = dir.replace(/^\/Users\/[^/]+/, '~');
    const item = document.createElement('div');
    item.className = 'welcome-recent-item';
    item.innerHTML = `<span class="recent-name">${escHtml(name)}</span><span class="recent-dir">${escHtml(shortDir)}</span>`;
    item.title = fp;
    item.addEventListener('click', async () => {
      try {
        const stat = await window.splecnote.stat(fp);
        if (stat && stat.isDirectory) {
          await openFolder(fp);
        } else {
          const content = await window.splecnote.readFile(fp);
          await openFile(fp, content);
        }
      } catch (err) { console.error('open welcome recent error:', err); }
    });
    container.appendChild(item);
  }
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
function updateStatusPosition() {
  if (!state.editor) return;
  const pos = state.editor.getPosition();
  dom.statusPosition.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
}

function updateStatusLanguage(tab) {
  if (!tab) return;
  const lang = tab.model.getLanguageId?.() || tab.model.getModeId?.() || 'plaintext';
  dom.statusLanguage.textContent = lang.charAt(0).toUpperCase() + lang.slice(1);
}

/* ================================================================
   18. WELCOME SCREEN
   ================================================================ */
function showWelcome() {
  state.welcomeVisible = true;
  dom.welcomeScreen.classList.remove('hidden');
  hideEmptyTabShortcuts();
}

function hideWelcome() {
  if (state.welcomeVisible) {
    state.welcomeVisible = false;
    dom.welcomeScreen.classList.add('hidden');
    // Ensure sidebar is visible after dismissing welcome screen
    if (!state.sidebarVisible) {
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
  $('#btn-welcome-new-window')?.addEventListener('click', () => window.splecnote.newWindow());
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
        if (state.folderPath) { window.splecnote.openInTerminal(state.folderPath); }
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
    if (cmd && shift && !alt && e.key === 'N') { e.preventDefault(); window.splecnote.newWindow(); return; }
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
      if (!dom.quickOpenOverlay.classList.contains('hidden')) { hideQuickOpen(); return; }
      if (!dom.cmdPaletteOverlay.classList.contains('hidden')) { hideCommandPalette(); return; }
      if (!dom.themePickerOverlay.classList.contains('hidden')) { hideThemePicker(); return; }
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
    // Cmd+Shift+Space → Trigger parameter hints
    if (cmd && shift && !alt && e.key === ' ') {
      e.preventDefault();
      if (state.editor) state.editor.getAction('editor.action.triggerParameterHints')?.run();
      return;
    }
  });
}

/* ================================================================
   21. IPC HANDLERS (from main process)
   ================================================================ */
function initIpcHandlers() {
  const api = window.splecnote;
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
  api.on('edit:goto-line', () => showGotoBar());
  api.on('edit:quick-open', () => showQuickOpen());
  api.on('edit:command-palette', () => showCommandPalette());
  // View menu
  api.on('view:toggle-sidebar', () => toggleSidebar());
  api.on('view:toggle-wordwrap', () => toggleWordWrap());
  api.on('view:toggle-minimap', () => toggleMinimap());
  api.on('view:zoom-in', () => changeFontSize(1));
  api.on('view:zoom-out', () => changeFontSize(-1));
  api.on('view:change-theme', () => showThemePicker());
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
        const stats = await window.splecnote.stat(file.path);
        if (stats && stats.isDirectory) {
          await openFolder(file.path);
          return; // open first dropped folder and stop
        } else {
          const content = await window.splecnote.readFile(file.path);
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
  };
  return icons[ext] || '📄';
}

/* ================================================================
   24. INIT
   ================================================================ */
async function init() {
  cacheDom();
  applyTheme(state.theme);

  // Init Monaco
  await initMonaco();

  // Init all subsystems
  initSearch();
  initGoto();
  initQuickOpen();
  initCommandPalette();
  initGlobalSearch();
  initThemePicker();
  initContextMenu();
  initTabContextMenu();
  initResizer();
  initRecentResizer();
  initKeyboard();
  initIpcHandlers();
  initDragDrop();
  initWelcome();

  // Sidebar section toggles
  dom.recentSectionHeader.addEventListener('click', toggleRecentSection);

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
    if (state.folderPath) {
      hideWelcome();
      showEmptyTabShortcuts();
    } else {
      showWelcome();
    }
  }
}

// Boot
document.addEventListener('DOMContentLoaded', init);

/**
 * Apex Debug Studio — Preload Script
 * Secure IPC bridge with fs ops for context menus, global search, quick open, etc.
 */
const { contextBridge, ipcRenderer } = require('electron');

const apexStudioApi = {
  // Dialogs
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  saveFileDialog: (defaultPath) => ipcRenderer.invoke('dialog:save-file', defaultPath),

  // File system
  readFile: (fp) => ipcRenderer.invoke('fs:read-file', fp),
  writeFile: (fp, content) => ipcRenderer.invoke('fs:write-file', fp, content),
  readDir: (dp) => ipcRenderer.invoke('fs:read-dir', dp),
  stat: (fp) => ipcRenderer.invoke('fs:stat', fp),
  deleteFile: (tp) => ipcRenderer.invoke('fs:delete', tp),
  rename: (oldP, newP) => ipcRenderer.invoke('fs:rename', oldP, newP),
  createDir: (dp) => ipcRenderer.invoke('fs:create-dir', dp),
  getAllFiles: (dp) => ipcRenderer.invoke('fs:get-all-files', dp),
  searchInFiles: (dp, query, opts) => ipcRenderer.invoke('fs:search-in-files', dp, query, opts),
  readBinary: (fp) => ipcRenderer.invoke('fs:read-binary', fp),
  systemSearch: (query) => ipcRenderer.invoke('fs:system-search', query),

  // Auto-save
  getAutoSavePath: (title) => ipcRenderer.invoke('autosave:get-path', title),

  // Session
  saveSession: (data) => ipcRenderer.invoke('session:save', data),
  loadSession: () => ipcRenderer.invoke('session:load'),

  // Recent
  addRecent: (fp) => ipcRenderer.invoke('recent:add', fp),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),

  // App paths
  getPaths: () => ipcRenderer.invoke('app:get-paths'),

  // Window management
  newWindow: () => ipcRenderer.invoke('app:new-window'),

  // Shell
  revealInFinder: (fp) => ipcRenderer.invoke('shell:show-item', fp),
  openInTerminal: (dp) => ipcRenderer.invoke('shell:open-terminal', dp),

  // File watcher
  watchFolder: (dp) => ipcRenderer.invoke('watch:start', dp),
  unwatchFolder: (dp) => ipcRenderer.invoke('watch:stop', dp),

  // Git
  gitStatus: (dp) => ipcRenderer.invoke('git:status', dp),
  gitInfo: (dp) => ipcRenderer.invoke('git:info', dp),
  gitLog: (dp, count) => ipcRenderer.invoke('git:log', dp, count),
  gitDiff: (dp, fp) => ipcRenderer.invoke('git:diff', dp, fp),
  gitBlame: (dp, fp) => ipcRenderer.invoke('git:blame', dp, fp),
  gitShow: (dp, relPath) => ipcRenderer.invoke('git:show', dp, relPath),
  gitFileLog: (dp, relPath, count) => ipcRenderer.invoke('git:file-log', dp, relPath, count),
  gitShowAt: (dp, commitHash, relPath) => ipcRenderer.invoke('git:show-at', dp, commitHash, relPath),
  gitCommitFileDiff: (dp, commitHash, relPath) => ipcRenderer.invoke('git:commit-file-diff', dp, commitHash, relPath),

  // Terminal
  terminalRun: (command) => ipcRenderer.invoke('terminal:run', command),
  terminalKill: () => ipcRenderer.invoke('terminal:kill'),
  terminalSetCwd: (cwd) => ipcRenderer.invoke('terminal:set-cwd', cwd),

  // Salesforce CLI
  sfExec: (command, cwd, timeoutMs) => ipcRenderer.invoke('sf:exec', command, cwd, timeoutMs),
  sfCheckCli: () => ipcRenderer.invoke('sf:check-cli'),
  sfOrgInfo: (cwd) => ipcRenderer.invoke('sf:org-info', cwd),
  sfOrgList: (cwd) => ipcRenderer.invoke('sf:org-list', cwd),

  // Settings
  readSettings: () => ipcRenderer.invoke('settings:read'),
  writeSettings: (s) => ipcRenderer.invoke('settings:write', s),

  // Markdown rendering
  renderMarkdown: (content) => ipcRenderer.invoke('markdown:render', content),

  // API Client
  sendApiRequest: (opts) => ipcRenderer.invoke('api:send-request', opts),

  // Database Client
  dbOpen: (filePath) => ipcRenderer.invoke('db:open', filePath),
  dbQuery: (filePath, query, tableName) => ipcRenderer.invoke('db:query', filePath, query, tableName),

  // Bookmarks
  loadBookmarks: () => ipcRenderer.invoke('bookmarks:load'),
  saveBookmarks: (bookmarks) => ipcRenderer.invoke('bookmarks:save', bookmarks),

  // Screenshot
  saveScreenshot: (dataUrl) => ipcRenderer.invoke('screenshot:save', dataUrl),

  // TODO scanning
  scanTodos: (folderPath) => ipcRenderer.invoke('todos:scan', folderPath),

  // IPC listener
  on: (channel, callback) => {
    const valid = [
      'file:new', 'file:open-dialog', 'file:open-path', 'file:save',
      'file:save-as', 'file:close-tab', 'folder:open-dialog',
      'edit:find', 'edit:find-in-files', 'edit:replace', 'edit:goto-line',
      'edit:quick-open', 'edit:command-palette', 'edit:goto-symbol',
      'view:toggle-sidebar', 'view:toggle-minimap', 'view:toggle-wordwrap',
      'view:zoom-in', 'view:zoom-out', 'view:zoom-reset', 'view:change-theme',
      'view:zen-mode', 'view:split-editor', 'view:markdown-preview',
      'view:toggle-terminal', 'terminal:output', 'terminal:exit',
      'view:api-client', 'view:regex-tester', 'view:json-viewer',
      'view:bookmarks', 'view:screenshot', 'view:db-client',
      'view:snippets', 'view:color-picker', 'view:todo-tracker', 'view:pomodoro',
      'view:diff-checker',
      'view:salesforce',
      'selection:select-all', 'selection:expand', 'selection:duplicate-line',
      'selection:move-line-up', 'selection:move-line-down',
      'selection:cursor-above', 'selection:cursor-below',
      'selection:toggle-comment', 'selection:block-comment',
      'selection:indent', 'selection:outdent',
      'nav:back', 'nav:forward',
      'session:restore', 'app:before-quit', 'help:shortcuts',
      'watch:change',
      'sf:login-progress',
    ];
    if (valid.includes(channel)) {
      const listener = (_event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },
};

// Expose the bridge under the new brand name, plus a legacy `congacode` alias
// (same object) so any not-yet-migrated call sites keep working.
contextBridge.exposeInMainWorld('apexStudio', apexStudioApi);
contextBridge.exposeInMainWorld('congacode', apexStudioApi);

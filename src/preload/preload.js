/**
 * SplecNote — Preload Script
 * Secure IPC bridge with fs ops for context menus, global search, quick open, etc.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splecnote', {
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

  // Auto-save
  getAutoSavePath: (title) => ipcRenderer.invoke('autosave:get-path', title),

  // Session
  saveSession: (data) => ipcRenderer.invoke('session:save', data),
  loadSession: () => ipcRenderer.invoke('session:load'),

  // Recent
  addRecent: (fp) => ipcRenderer.invoke('recent:add', fp),
  getRecent: () => ipcRenderer.invoke('recent:get'),

  // App paths
  getPaths: () => ipcRenderer.invoke('app:get-paths'),

  // Window management
  newWindow: () => ipcRenderer.invoke('app:new-window'),

  // Shell
  revealInFinder: (fp) => ipcRenderer.invoke('shell:show-item', fp),
  openInTerminal: (dp) => ipcRenderer.invoke('shell:open-terminal', dp),

  // IPC listener
  on: (channel, callback) => {
    const valid = [
      'file:new', 'file:open-dialog', 'file:open-path', 'file:save',
      'file:save-as', 'file:close-tab', 'folder:open-dialog',
      'edit:find', 'edit:find-in-files', 'edit:replace', 'edit:goto-line',
      'edit:quick-open', 'edit:command-palette', 'edit:goto-symbol',
      'view:toggle-sidebar', 'view:toggle-minimap', 'view:toggle-wordwrap',
      'view:zoom-in', 'view:zoom-out', 'view:zoom-reset', 'view:change-theme',
      'selection:select-all', 'selection:expand', 'selection:duplicate-line',
      'selection:move-line-up', 'selection:move-line-down',
      'selection:cursor-above', 'selection:cursor-below',
      'selection:toggle-comment', 'selection:block-comment',
      'selection:indent', 'selection:outdent',
      'nav:back', 'nav:forward',
      'session:restore', 'app:before-quit', 'help:shortcuts',
    ];
    if (valid.includes(channel)) {
      const listener = (_event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },
});

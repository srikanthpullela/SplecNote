/**
 * SplecNote — Main Process
 * Window management, file I/O, auto-save, session, menus, global search, context menu support.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

// Set app name FIRST — fixes "Electron" in macOS menu bar
app.setName('SplecNote');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SPLECNOTE_DIR = path.join(os.homedir(), 'SplecNote');
const SESSION_FILE = path.join(SPLECNOTE_DIR, '.session.json');
const RECENT_FILE = path.join(SPLECNOTE_DIR, '.recent.json');
const AUTOSAVE_DIR = path.join(SPLECNOTE_DIR, 'AutoSave');

function ensureDirs() {
  for (const dir of [SPLECNOTE_DIR, AUTOSAVE_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Session / Recent helpers
// ---------------------------------------------------------------------------
function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return { tabs: [], activeTab: null, windowBounds: null };
}
function saveSession(data) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8'); } catch (e) { console.error('Session save error:', e); }
}
function loadRecent() {
  try { if (fs.existsSync(RECENT_FILE)) return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf-8')); } catch {}
  return [];
}
function saveRecent(list) {
  try { fs.writeFileSync(RECENT_FILE, JSON.stringify(list, null, 2), 'utf-8'); } catch {}
}
function addRecent(fp) {
  let recent = loadRecent().filter(r => r !== fp);
  recent.unshift(fp);
  if (recent.length > 25) recent = recent.slice(0, 25);
  saveRecent(recent);
}

// ---------------------------------------------------------------------------
// Auto-save path: ~/SplecNote/AutoSave/YYYY-MM-DD/Title.txt
// ---------------------------------------------------------------------------
function generateAutoSavePath(title) {
  const today = new Date().toISOString().slice(0, 10);
  const dayDir = path.join(AUTOSAVE_DIR, today);
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
  const safeName = (title || 'Untitled').replace(/[^a-zA-Z0-9_\- ]/g, '').trim().slice(0, 80) || 'Untitled';
  let candidate = path.join(dayDir, `${safeName}.txt`);
  let i = 1;
  while (fs.existsSync(candidate)) { candidate = path.join(dayDir, `${safeName}-${i}.txt`); i++; }
  return candidate;
}

// ---------------------------------------------------------------------------
// Recursive file list for global search & quick open
// ---------------------------------------------------------------------------
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store',
  'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', '.idea', '.vscode',
]);

function getAllFiles(dirPath, maxFiles = 5000) {
  const results = [];
  function walk(dir, depth) {
    if (results.length >= maxFiles || depth > 15) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.env') continue;
        if (IGNORED_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else results.push(full);
      }
    } catch {}
  }
  walk(dirPath, 0);
  return results;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;

function createNewWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 600, minHeight: 400,
    title: 'SplecNote',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
    show: false,
  });
  // Load with ?new=1 so the renderer skips session restore
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { new: '1' } });
  win.once('ready-to-show', () => win.show());

  // Open external links in default browser for new windows too
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return win;
}

function createWindow() {
  const session = loadSession();
  const bounds = session.windowBounds || { width: 1280, height: 800 };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 600,
    minHeight: 400,
    title: 'SplecNote',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.send('session:restore', session);
  });

  // Open external links in default browser, not inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow file:// for our own pages, block everything else
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  buildMenu();
}

// ---------------------------------------------------------------------------
// Application menu — with "SplecNote" as first menu label
// ---------------------------------------------------------------------------
// Helper: send IPC to the currently focused window (not just mainWindow)
function sendToFocused(channel, ...args) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  win?.webContents.send(channel, ...args);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const recentFiles = loadRecent();
  const recentMenu = recentFiles.length > 0
    ? recentFiles.slice(0, 15).map(fp => ({ label: path.basename(fp), sublabel: fp, click: () => sendToFocused('file:open-path', fp) }))
    : [{ label: 'No Recent Files', enabled: false }];

  const template = [
    ...(isMac ? [{
      label: 'SplecNote',
      submenu: [
        { label: 'About SplecNote', role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { label: 'Hide SplecNote', role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit SplecNote', role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+N', click: () => sendToFocused('file:new') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createNewWindow() },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => sendToFocused('file:open-dialog') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendToFocused('folder:open-dialog') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendToFocused('file:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendToFocused('file:save-as') },
        { type: 'separator' },
        { label: 'Open Recent', submenu: [...recentMenu, { type: 'separator' }, { label: 'Clear Recent', click: () => { saveRecent([]); buildMenu(); } }] },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendToFocused('file:close-tab') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => sendToFocused('edit:find') },
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendToFocused('edit:find-in-files') },
        { label: 'Replace', accelerator: 'CmdOrCtrl+H', click: () => sendToFocused('edit:replace') },
        { type: 'separator' },
        { label: 'Go to Line…', accelerator: 'CmdOrCtrl+G', click: () => sendToFocused('edit:goto-line') },
        { label: 'Go to File…', accelerator: 'CmdOrCtrl+P', click: () => sendToFocused('edit:quick-open') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => sendToFocused('edit:command-palette') },
      ],
    },
    {
      label: 'Selection',
      submenu: [
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendToFocused('selection:select-all') },
        { label: 'Duplicate Line', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendToFocused('selection:duplicate-line') },
        { label: 'Move Line Up', accelerator: 'Alt+Up', click: () => sendToFocused('selection:move-line-up') },
        { label: 'Move Line Down', accelerator: 'Alt+Down', click: () => sendToFocused('selection:move-line-down') },
        { label: 'Add Cursor Above', accelerator: 'CmdOrCtrl+Alt+Up', click: () => sendToFocused('selection:cursor-above') },
        { label: 'Add Cursor Below', accelerator: 'CmdOrCtrl+Alt+Down', click: () => sendToFocused('selection:cursor-below') },
        { type: 'separator' },
        { label: 'Toggle Comment', accelerator: 'CmdOrCtrl+/', click: () => sendToFocused('selection:toggle-comment') },
        { label: 'Block Comment', accelerator: 'CmdOrCtrl+Shift+/', click: () => sendToFocused('selection:block-comment') },
        { label: 'Indent', accelerator: 'CmdOrCtrl+]', click: () => sendToFocused('selection:indent') },
        { label: 'Outdent', accelerator: 'CmdOrCtrl+[', click: () => sendToFocused('selection:outdent') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendToFocused('view:toggle-sidebar') },
        { label: 'Toggle Minimap', click: () => sendToFocused('view:toggle-minimap') },
        { label: 'Toggle Word Wrap', accelerator: 'Alt+Z', click: () => sendToFocused('view:toggle-wordwrap') },
        { type: 'separator' },
        { label: 'Change Theme…', click: () => sendToFocused('view:change-theme') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => sendToFocused('view:zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendToFocused('view:zoom-out') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => sendToFocused('view:zoom-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Go to File…', accelerator: 'CmdOrCtrl+P', click: () => sendToFocused('edit:quick-open') },
        { label: 'Go to Line…', accelerator: 'CmdOrCtrl+G', click: () => sendToFocused('edit:goto-line') },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Open AutoSave Folder', click: () => shell.openPath(AUTOSAVE_DIR) },
        { label: 'Open SplecNote Folder', click: () => shell.openPath(SPLECNOTE_DIR) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
ipcMain.handle('dialog:open-file', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'All Files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths;
});
ipcMain.handle('dialog:open-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:save-file', async (e, defaultPath) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'All Files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('fs:read-file', async (_e, fp) => { try { return fs.readFileSync(fp, 'utf-8'); } catch { return null; } });
ipcMain.handle('fs:write-file', async (_e, fp, content) => {
  try { const d = path.dirname(fp); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(fp, content, 'utf-8'); return true; } catch { return false; }
});
ipcMain.handle('fs:read-dir', async (_e, dirPath) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({ name: e.name, isDirectory: e.isDirectory(), path: path.join(dirPath, e.name) }))
      .sort((a, b) => { if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1; return a.name.localeCompare(b.name); });
  } catch { return []; }
});
ipcMain.handle('fs:stat', async (_e, fp) => { try { const s = fs.statSync(fp); return { size: s.size, mtime: s.mtimeMs, isDirectory: s.isDirectory() }; } catch { return null; } });
ipcMain.handle('fs:delete', async (_e, tp) => {
  try { const s = fs.statSync(tp); if (s.isDirectory()) fs.rmSync(tp, { recursive: true, force: true }); else fs.unlinkSync(tp); return true; } catch { return false; }
});
ipcMain.handle('fs:rename', async (_e, oldP, newP) => { try { fs.renameSync(oldP, newP); return true; } catch { return false; } });
ipcMain.handle('fs:create-dir', async (_e, dp) => { try { fs.mkdirSync(dp, { recursive: true }); return true; } catch { return false; } });
ipcMain.handle('fs:get-all-files', async (_e, dp) => getAllFiles(dp));
ipcMain.handle('fs:search-in-files', async (_e, dirPath, query, options) => {
  if (!query || !dirPath) return [];
  const isRegex = options?.isRegex || false;
  const caseSensitive = options?.caseSensitive || options?.matchCase || false;

  return new Promise((resolve) => {
    // Detect search tool: prefer ripgrep, fallback to grep
    let cmd, args;
    const hasRg = (() => { try { execSync('which rg', { stdio: 'pipe' }); return true; } catch { return false; } })();

    if (hasRg) {
      // ripgrep: fast, respects .gitignore, skips binary
      args = [
        '--no-heading', '--line-number', '--color=never',
        '--max-count=100',        // max matches per file
        '--max-filesize=2M',      // skip files > 2MB
        '-g', '!node_modules', '-g', '!.git', '-g', '!dist',
        '-g', '!build', '-g', '!coverage', '-g', '!.cache',
        '-g', '!__pycache__', '-g', '!.next', '-g', '!.nuxt',
        '-g', '!.idea', '-g', '!.vscode', '-g', '!*.min.js',
        '-g', '!*.min.css', '-g', '!*.map', '-g', '!package-lock.json',
      ];
      if (!caseSensitive) args.push('-i');
      if (isRegex) {
        args.push('-e', query);
      } else {
        args.push('-F', '--', query);
      }
      args.push(dirPath);
      cmd = 'rg';
    } else {
      // BSD grep fallback (macOS built-in)
      args = ['-rn', '--color=never', '-I'];
      if (!caseSensitive) args.push('-i');
      for (const d of IGNORED_DIRS) args.push(`--exclude-dir=${d}`);
      args.push('--exclude=*.min.js', '--exclude=*.min.css', '--exclude=*.map', '--exclude=package-lock.json');
      if (isRegex) {
        args.push('-E', query);
      } else {
        args.push('-F', query);
      }
      args.push(dirPath);
      cmd = 'grep';
    }

    const proc = spawn(cmd, args, {
      cwd: dirPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' },
    });

    let output = '';
    let killed = false;

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
      // Hard limit: stop if output is huge (> 5MB)
      if (output.length > 5 * 1024 * 1024) {
        killed = true;
        proc.kill('SIGTERM');
      }
    });
    proc.stderr.on('data', () => {}); // ignore

    // Timeout: kill after 30s
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, 30000);

    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const results = parseSearchOutput(output, dirPath);
        resolve(results);
      } catch {
        resolve([]);
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
});

function parseSearchOutput(output, basePath) {
  if (!output) return [];
  const fileMap = new Map();
  const lines = output.split('\n');
  let totalMatches = 0;
  const MAX_TOTAL = 2000; // cap total matches for UI performance

  for (const line of lines) {
    if (totalMatches >= MAX_TOTAL) break;
    // Format: filepath:linenum:text (grep/rg --no-heading)
    // Use regex to reliably parse — handles paths with spaces etc.
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;

    const filePath = m[1];
    const lineNum = parseInt(m[2], 10);
    const text = m[3].trim().slice(0, 200);

    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, { filePath, matches: [] });
    }
    fileMap.get(filePath).matches.push({ line: lineNum, text });
    totalMatches++;
  }

  return Array.from(fileMap.values());
}

ipcMain.handle('autosave:get-path', async (_e, title) => generateAutoSavePath(title));
ipcMain.handle('session:save', async (e, data) => { const win = BrowserWindow.fromWebContents(e.sender) || mainWindow; if (win) data.windowBounds = win.getBounds(); saveSession(data); return true; });
ipcMain.handle('session:load', async () => loadSession());
ipcMain.handle('recent:add', async (_e, fp) => { addRecent(fp); buildMenu(); return true; });
ipcMain.handle('recent:get', async () => loadRecent());
ipcMain.handle('app:get-paths', async () => ({ splecnoteDir: SPLECNOTE_DIR, autosaveDir: AUTOSAVE_DIR, home: os.homedir() }));
ipcMain.handle('app:new-window', async () => { createNewWindow(); return true; });
ipcMain.handle('shell:show-item', async (_e, fp) => { shell.showItemInFolder(fp); return true; });
ipcMain.handle('shell:open-path', async (_e, dp) => { shell.openPath(dp); return true; });
ipcMain.handle('shell:open-terminal', async (_e, dp) => {
  const { exec } = require('child_process');
  if (process.platform === 'darwin') {
    exec(`open -a Terminal "${dp}"`);
  } else if (process.platform === 'win32') {
    exec(`start cmd /K "cd /d ${dp}"`);
  } else {
    exec(`x-terminal-emulator --working-directory="${dp}"`);
  }
  return true;
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => { ensureDirs(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { BrowserWindow.getAllWindows().forEach(w => w.webContents.send('app:before-quit')); });

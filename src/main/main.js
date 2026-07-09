/**
 * CongaCode — Main Process
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
const chokidar = require('chokidar');
const simpleGit = require('simple-git');

// marked is ESM-only, loaded via dynamic import
let markedFn = null;
async function getMarked() {
  if (!markedFn) {
    const m = await import('marked');
    markedFn = m.marked;
    markedFn.setOptions({ breaks: true, gfm: true });
  }
  return markedFn;
}

// Set app name FIRST — fixes "Electron" in macOS menu bar
app.setName('CongaCode');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const CONGACODE_DIR = path.join(os.homedir(), 'CongaCode');
const SESSION_FILE = path.join(CONGACODE_DIR, '.session.json');
const RECENT_FILE = path.join(CONGACODE_DIR, '.recent.json');
const SETTINGS_FILE = path.join(CONGACODE_DIR, 'settings.json');
const AUTOSAVE_DIR = path.join(CONGACODE_DIR, 'AutoSave');

// File watcher instances (per watched directory)
const watchers = new Map();

function ensureDirs() {
  for (const dir of [CONGACODE_DIR, AUTOSAVE_DIR]) {
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
  if (recent.length > 50) recent = recent.slice(0, 50);
  saveRecent(recent);
}

/**
 * Build a smart grouped recent menu for the menu bar.
 * - If multiple files share the same parent folder → show folder as a submenu
 * - Standalone files → show directly
 */
function buildSmartRecentMenu(recentFiles) {
  const home = os.homedir();
  const shorten = (p) => p.replace(new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '~');

  const containers = new Set([
    'Documents', 'Desktop', 'Downloads', 'Library',
    'Applications', 'Pictures', 'Music', 'Movies', 'Public',
  ]);

  const directoryPaths = [];
  const fileItems = [];

  for (const fp of recentFiles) {
    try {
      if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) {
        directoryPaths.push(fp);
        continue;
      }
    } catch {}
    fileItems.push(fp);
  }

  // Determine project root for each file
  const projectMap = new Map();
  const projectOrder = [];

  for (const fp of fileItems) {
    const rel = fp.substring(home.length + 1);
    const segments = rel.split('/');

    let projectRoot;
    if (segments.length <= 1) {
      projectRoot = home;
    } else if (containers.has(segments[0]) && segments.length >= 3) {
      projectRoot = home + '/' + segments[0] + '/' + segments[1];
    } else {
      projectRoot = home + '/' + segments[0];
    }

    if (!projectMap.has(projectRoot)) {
      projectMap.set(projectRoot, []);
      projectOrder.push(projectRoot);
    }
    projectMap.get(projectRoot).push(fp);
  }

  const items = [];
  const coveredRoots = new Set(projectOrder);

  // Directory entries not covered by a file group
  for (const fp of directoryPaths) {
    if (coveredRoots.has(fp)) continue;
    items.push({
      label: '📁 ' + path.basename(fp),
      sublabel: shorten(fp),
      click: () => sendToFocused('file:open-path', fp),
    });
  }

  // File groups by project root
  for (const root of projectOrder) {
    const fps = projectMap.get(root);
    const name = path.basename(root);

    if (fps.length > 1) {
      const submenuItems = fps.map(fp => ({
        label: path.basename(fp),
        click: () => sendToFocused('file:open-path', fp),
      }));
      submenuItems.unshift(
        { label: 'Open Folder', click: () => sendToFocused('file:open-path', root) },
        { type: 'separator' }
      );
      items.push({
        label: '📁 ' + name,
        sublabel: shorten(root),
        submenu: submenuItems,
      });
    } else {
      const fp = fps[0];
      items.push({
        label: path.basename(fp),
        sublabel: shorten(path.dirname(fp)),
        click: () => sendToFocused('file:open-path', fp),
      });
    }
    if (items.length >= 20) break;
  }
  return items;
}

/**
 * Update macOS dock right-click menu with recent files
 */
function updateDockMenu() {
  if (process.platform !== 'darwin') return;
  const recentFiles = loadRecent();
  const items = recentFiles.slice(0, 10).map(fp => ({
    label: path.basename(fp),
    click: () => openFileInNewWindow(fp),
  }));
  if (items.length === 0) {
    items.push({ label: 'No Recent Files', enabled: false });
  }
  const dockMenu = Menu.buildFromTemplate([
    { label: 'New Window', click: () => createNewWindow() },
    { type: 'separator' },
    ...items,
  ]);
  app.dock.setMenu(dockMenu);
}

// ---------------------------------------------------------------------------
// Auto-save path: ~/CongaCode/AutoSave/YYYY-MM-DD/
// Returns the day directory, creating it if needed.
// ---------------------------------------------------------------------------
function generateAutoSavePath(dateStr) {
  const dayDir = path.join(AUTOSAVE_DIR, dateStr || new Date().toISOString().slice(0, 10));
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
  return dayDir;
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
    title: 'CongaCode',
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
    title: 'CongaCode',
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

  mainWindow.on('closed', () => {
    // Clean up any file watchers belonging to this window
    const winId = mainWindow?.id;
    if (winId) {
      for (const [key, watcher] of watchers) {
        if (key.startsWith(`${winId}:`)) {
          watcher.close().catch(() => {});
          watchers.delete(key);
        }
      }
    }
    mainWindow = null;
  });
  buildMenu();
}

// ---------------------------------------------------------------------------
// Application menu — with "CongaCode" as first menu label
// ---------------------------------------------------------------------------
// Helper: send IPC to the currently focused window (not just mainWindow)
function sendToFocused(channel, ...args) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  win?.webContents.send(channel, ...args);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const recentFiles = loadRecent();
  // Smart grouping: group files from the same folder, show standalone files separately
  const recentMenuItems = buildSmartRecentMenu(recentFiles);
  const recentMenu = recentMenuItems.length > 0
    ? recentMenuItems
    : [{ label: 'No Recent Files', enabled: false }];

  const template = [
    ...(isMac ? [{
      label: 'CongaCode',
      submenu: [
        { label: 'About CongaCode', role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { label: 'Hide CongaCode', role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit CongaCode', role: 'quit' },
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
        { label: 'Spotlight Search', accelerator: 'CmdOrCtrl+Shift+Space', click: () => sendToFocused('edit:spotlight-search') },
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
        { label: 'Zen Mode', accelerator: 'CmdOrCtrl+K Z', click: () => sendToFocused('view:zen-mode') },
        { label: 'Split Editor', accelerator: 'CmdOrCtrl+\\', click: () => sendToFocused('view:split-editor') },
        { label: 'Toggle Markdown Preview', accelerator: 'CmdOrCtrl+Shift+V', click: () => sendToFocused('view:markdown-preview') },
        { label: 'Toggle Terminal', accelerator: 'Ctrl+`', click: () => sendToFocused('view:toggle-terminal') },
        { type: 'separator' },
        {
          label: 'Tools',
          submenu: [
            { label: 'API Client', accelerator: 'Ctrl+Shift+A', click: () => sendToFocused('view:api-client') },
            { label: 'Regex Tester', accelerator: 'Ctrl+Shift+R', click: () => sendToFocused('view:regex-tester') },
            { label: 'JSON / Data Viewer', accelerator: 'Ctrl+Shift+J', click: () => sendToFocused('view:json-viewer') },
            { label: 'Bookmarks', accelerator: 'Ctrl+Shift+B', click: () => sendToFocused('view:bookmarks') },
            { label: 'Code Screenshot', accelerator: 'Ctrl+Shift+S', click: () => sendToFocused('view:screenshot') },
            { label: 'Database Client', accelerator: 'Ctrl+Shift+D', click: () => sendToFocused('view:db-client') },
            { type: 'separator' },
            { label: 'Snippet Manager', accelerator: 'Ctrl+Shift+E', click: () => sendToFocused('view:snippets') },
            { label: 'Color Picker', accelerator: 'Ctrl+Shift+K', click: () => sendToFocused('view:color-picker') },
            { label: 'TODO Tracker', accelerator: 'Ctrl+Shift+G', click: () => sendToFocused('view:todo-tracker') },
            { label: 'Pomodoro Timer', accelerator: 'Ctrl+Shift+Y', click: () => sendToFocused('view:pomodoro') },
            { label: 'Diff Checker', accelerator: 'Ctrl+Shift+I', click: () => sendToFocused('view:diff-checker') },
          ],
        },
        { type: 'separator' },
        { label: 'Change Theme…', click: () => sendToFocused('view:change-theme') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => sendToFocused('view:zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendToFocused('view:zoom-out') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => sendToFocused('view:zoom-reset') },
        { type: 'separator' },
        { label: 'Reload Window', accelerator: 'CmdOrCtrl+Shift+R', click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win) win.webContents.reloadIgnoringCache();
        }},
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
        { label: 'Open CongaCode Folder', click: () => shell.openPath(CONGACODE_DIR) },
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
ipcMain.handle('dialog:save-file', async (e, defaultPath, filters) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const fileFilters = filters || [
    { name: 'Text Files', extensions: ['txt'] },
    { name: 'JavaScript', extensions: ['js', 'jsx', 'mjs'] },
    { name: 'TypeScript', extensions: ['ts', 'tsx'] },
    { name: 'JSON', extensions: ['json'] },
    { name: 'HTML', extensions: ['html', 'htm'] },
    { name: 'CSS', extensions: ['css', 'scss', 'less'] },
    { name: 'Python', extensions: ['py'] },
    { name: 'Markdown', extensions: ['md'] },
    { name: 'Shell Script', extensions: ['sh', 'bash', 'zsh'] },
    { name: 'YAML', extensions: ['yaml', 'yml'] },
    { name: 'XML', extensions: ['xml'] },
    { name: 'SQL', extensions: ['sql'] },
    { name: 'All Files', extensions: ['*'] },
  ];
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: fileFilters });
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

// ---------------------------------------------------------------------------
// System-wide file search using macOS Spotlight (mdfind)
// ---------------------------------------------------------------------------
ipcMain.handle('fs:system-search', async (_e, query) => {
  if (!query || query.length < 2) return [];
  return new Promise((resolve) => {
    const home = os.homedir();
    // Use mdfind with -name for filename matching, scoped to home directory
    const args = ['-name', query, '-onlyin', home];
    const proc = spawn('mdfind', args);
    let output = '';

    // Timeout after 3 seconds
    const timer = setTimeout(() => { proc.kill(); }, 3000);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
      // Cap early to stay fast
      if (output.split('\n').length > 500) proc.kill();
    });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      clearTimeout(timer);
      const shorten = (p) => p.replace(new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '~');

      // Noise patterns to exclude
      const noisePatterns = [
        '/Library/',
        '/Application Support/',
        '/Caches/',
        '/node_modules/',
        '/.git/',
        '/.Trash/',
        '/dist/',
        '/build/',
        '/__pycache__/',
        '/.cache/',
        '/.npm/',
        '/.nvm/',
        '/.cargo/',
        '/venv/',
        '/.venv/',
      ];

      const filtered = output
        .split('\n')
        .filter(line => line.trim().length > 0)
        .filter(fp => {
          const rel = fp.substring(home.length);
          return !noisePatterns.some(p => rel.includes(p)) && !rel.startsWith('/.');
        });

      // Sort: prioritize shorter paths (closer to home), then alphabetical
      filtered.sort((a, b) => {
        const depthA = a.split('/').length;
        const depthB = b.split('/').length;
        if (depthA !== depthB) return depthA - depthB;
        return a.localeCompare(b);
      });

      const results = filtered
        .slice(0, 40)
        .map(fp => {
          let isDir = false;
          try { isDir = fs.statSync(fp).isDirectory(); } catch {}
          return {
            path: fp,
            name: path.basename(fp),
            dir: shorten(path.dirname(fp)),
            isDirectory: isDir,
          };
        });
      resolve(results);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
});

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
ipcMain.handle('recent:add', async (_e, fp) => { addRecent(fp); buildMenu(); updateDockMenu(); return true; });
ipcMain.handle('recent:get', async () => loadRecent());
ipcMain.handle('recent:clear', async () => { saveRecent([]); buildMenu(); updateDockMenu(); return true; });
ipcMain.handle('app:get-paths', async () => ({ congacodeDir: CONGACODE_DIR, autosaveDir: AUTOSAVE_DIR, home: os.homedir() }));
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
// File Watcher (chokidar)
// ---------------------------------------------------------------------------
ipcMain.handle('watch:start', async (e, dirPath) => {
  const winId = BrowserWindow.fromWebContents(e.sender)?.id;
  const key = `${winId}:${dirPath}`;
  if (watchers.has(key)) return true; // already watching
  try {
    const watcher = chokidar.watch(dirPath, {
      ignored: /(^|[/\\])(\.|node_modules|\.git|dist|build|\.next|\.nuxt|coverage|\.cache|__pycache__)/,
      persistent: true,
      ignoreInitial: true,
      depth: 10,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    watcher.on('all', (event, changedPath) => {
      const win = BrowserWindow.fromId(winId);
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('watch:change', { event, path: changedPath });
      } else {
        // Window gone — clean up this watcher
        watcher.close().catch(() => {});
        watchers.delete(key);
      }
    });
    watchers.set(key, watcher);
    return true;
  } catch (err) {
    console.error('watch:start error:', err);
    return false;
  }
});

ipcMain.handle('watch:stop', async (e, dirPath) => {
  const winId = BrowserWindow.fromWebContents(e.sender)?.id;
  const key = `${winId}:${dirPath}`;
  const watcher = watchers.get(key);
  if (watcher) {
    await watcher.close();
    watchers.delete(key);
  }
  return true;
});

// ---------------------------------------------------------------------------
// Git Integration (simple-git)
// ---------------------------------------------------------------------------

// Rich git info — branch, tracking, remote, stashes, etc.
ipcMain.handle('git:info', async (_e, dirPath) => {
  try {
    const git = simpleGit(dirPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;

    const status = await git.status();
    const branch = status.current;
    const ahead = status.ahead;
    const behind = status.behind;
    const tracking = status.tracking || null;

    // Remote URL
    let remoteUrl = null;
    try {
      const remotes = await git.getRemotes(true);
      const origin = remotes.find(r => r.name === 'origin') || remotes[0];
      if (origin) remoteUrl = origin.refs.fetch || origin.refs.push || null;
    } catch {}

    // Stash count
    let stashCount = 0;
    try {
      const stashList = await git.stashList();
      stashCount = stashList.total || 0;
    } catch {}

    // Last commit on current branch
    let lastCommit = null;
    try {
      const log = await git.log({ maxCount: 1 });
      if (log.latest) {
        lastCommit = {
          hash: log.latest.hash.slice(0, 7),
          message: log.latest.message,
          author: log.latest.author_name,
          date: log.latest.date,
        };
      }
    } catch {}

    // Changed files with detailed status
    const files = {};
    for (const f of status.modified) files[f] = 'modified';
    for (const f of status.not_added) files[f] = 'untracked';
    for (const f of status.created) files[f] = 'added';
    for (const f of status.deleted) files[f] = 'deleted';
    for (const f of status.renamed) files[f.to] = 'renamed';
    for (const f of status.conflicted) files[f] = 'conflicted';

    // Staged files
    const staged = [];
    for (const f of status.staged) staged.push(f);

    return {
      branch,
      tracking,
      remoteUrl,
      ahead,
      behind,
      stashCount,
      lastCommit,
      files,
      staged,
    };
  } catch {
    return null;
  }
});

ipcMain.handle('git:status', async (_e, dirPath) => {
  try {
    const git = simpleGit(dirPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;
    const status = await git.status();
    const branch = status.current;
    const files = {};
    for (const f of status.modified) files[f] = 'modified';
    for (const f of status.not_added) files[f] = 'untracked';
    for (const f of status.created) files[f] = 'added';
    for (const f of status.deleted) files[f] = 'deleted';
    for (const f of status.renamed) files[f.to] = 'modified';
    return { branch, files, ahead: status.ahead, behind: status.behind };
  } catch {
    return null;
  }
});

ipcMain.handle('git:log', async (_e, dirPath, count = 20) => {
  try {
    const git = simpleGit(dirPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;
    const log = await git.log({ maxCount: count });
    return log.all.map(c => ({ hash: c.hash.slice(0, 7), message: c.message, author: c.author_name, date: c.date }));
  } catch { return null; }
});

ipcMain.handle('git:diff', async (_e, dirPath, filePath) => {
  try {
    const git = simpleGit(dirPath);
    const diff = await git.diff([filePath]);
    return diff;
  } catch { return null; }
});

ipcMain.handle('git:blame', async (_e, dirPath, filePath) => {
  try {
    const git = simpleGit(dirPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;
    const relPath = path.relative(dirPath, filePath);
    const result = await git.raw(['blame', '--line-porcelain', relPath]);
    const lines = result.split('\n');
    const blameData = [];
    let current = {};
    for (const line of lines) {
      if (line.match(/^[0-9a-f]{40} \d+ \d+/)) {
        if (current.hash) blameData.push({ ...current });
        const parts = line.split(' ');
        current = { hash: parts[0].slice(0, 7), line: parseInt(parts[2]) };
      } else if (line.startsWith('author ')) {
        current.author = line.slice(7);
      } else if (line.startsWith('author-time ')) {
        const ts = parseInt(line.slice(12)) * 1000;
        const d = new Date(ts);
        current.date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } else if (line.startsWith('summary ')) {
        current.summary = line.slice(8);
      }
    }
    if (current.hash) blameData.push({ ...current });
    return blameData;
  } catch { return null; }
});

ipcMain.handle('git:show', async (_e, dirPath, relPath) => {
  try {
    const git = simpleGit(dirPath);
    return await git.show([`HEAD:${relPath}`]);
  } catch { return null; }
});

ipcMain.handle('git:file-log', async (_e, dirPath, relPath, count = 50) => {
  try {
    const git = simpleGit(dirPath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;
    // Use raw git log with --follow --no-merges to get commits that touched this file
    const SEP = '---COMMIT---';
    const format = `${SEP}%n%H%n%h%n%s%n%an%n%aI`;
    const raw = await git.raw([
      'log', '--follow', '--no-merges',
      `--max-count=${count}`, `--format=${format}`, '--', relPath
    ]);
    if (!raw || !raw.trim()) return [];
    const blocks = raw.split(SEP).filter(b => b.trim());
    const commits = [];
    for (const block of blocks) {
      const lines = block.split('\n').filter(l => l !== '');
      if (lines.length < 5) continue;
      commits.push({
        hash: lines[1],
        fullHash: lines[0],
        message: lines[2],
        author: lines[3],
        date: lines[4],
      });
    }
    return commits;
  } catch { return null; }
});

ipcMain.handle('git:show-at', async (_e, dirPath, commitHash, relPath) => {
  try {
    const git = simpleGit(dirPath);
    // relPath is relative to dirPath; git show needs repo-root-relative path
    const prefix = (await git.raw(['rev-parse', '--show-prefix'])).trim();
    const repoPath = prefix ? prefix + relPath : relPath;
    const result = await git.show([`${commitHash}:${repoPath}`]);
    return result || '';
  } catch (err) {
    console.error('[git:show-at] FAILED:', err.message.slice(0, 300));
    return null;
  }
});

// Get both parent and commit versions of a file for diff viewing
ipcMain.handle('git:commit-file-diff', async (_e, dirPath, commitHash, relPath) => {
  try {
    const git = simpleGit(dirPath);

    // relPath is relative to the opened folder (dirPath), but git show needs
    // paths relative to the repo root. Resolve by prepending the prefix.
    const prefix = (await git.raw(['rev-parse', '--show-prefix'])).trim();
    const repoPath = prefix ? prefix + relPath : relPath;

    let modified = '', original = '';

    // Get file content at this commit
    try { modified = await git.show([`${commitHash}:${repoPath}`]); } catch { modified = ''; }

    // Get file content at parent commit (same path first)
    try {
      original = await git.show([`${commitHash}~1:${repoPath}`]);
    } catch {
      // Parent path might differ (rename). Try diff-tree to find old name
      try {
        const diffRaw = await git.raw([
          'diff-tree', '--no-commit-id', '-r', '-M', '--name-status', commitHash
        ]);
        for (const line of diffRaw.split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3 && parts[0].startsWith('R')) {
            const newP = parts[2].trim();
            if (newP === repoPath) {
              const oldP = parts[1].trim();
              try { original = await git.show([`${commitHash}~1:${oldP}`]); } catch { /* */ }
              break;
            }
          }
        }
      } catch { /* initial commit — no parent */ }
    }

    return { original, modified };
  } catch { return { original: '', modified: '' }; }
});

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
let terminalCwd = null;
let terminalProc = null;

ipcMain.handle('terminal:run', async (e, command) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!terminalCwd) terminalCwd = os.homedir();
  const trimmed = command.trim();

  // Handle cd
  const cdMatch = trimmed.match(/^cd\s+([\s\S]*)/);
  if (cdMatch) {
    let target = cdMatch[1].trim().replace(/^["']|["']$/g, '');
    if (target === '' || target === '~') target = os.homedir();
    else if (target === '-') target = os.homedir();
    else if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
    else if (!path.isAbsolute(target)) target = path.resolve(terminalCwd, target);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      terminalCwd = target;
      return { code: 0, cwd: terminalCwd };
    }
    return { code: 1, error: `cd: no such file or directory: ${cdMatch[1].trim()}`, cwd: terminalCwd };
  }

  if (trimmed === 'clear' || trimmed === 'cls') {
    return { code: 0, cwd: terminalCwd, clear: true };
  }

  return new Promise((resolve) => {
    const proc = spawn('/bin/zsh', ['-l', '-c', command], {
      cwd: terminalCwd,
      env: { ...process.env, TERM: 'dumb', CLICOLOR: '0', NO_COLOR: '1' },
    });
    terminalProc = proc;

    proc.stdout.on('data', (chunk) => {
      if (win && !win.isDestroyed()) win.webContents.send('terminal:output', chunk.toString());
    });
    proc.stderr.on('data', (chunk) => {
      if (win && !win.isDestroyed()) win.webContents.send('terminal:output', chunk.toString());
    });
    proc.on('close', (code) => {
      terminalProc = null;
      resolve({ code, cwd: terminalCwd });
    });
    proc.on('error', (err) => {
      terminalProc = null;
      resolve({ code: 1, error: err.message, cwd: terminalCwd });
    });
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        resolve({ code: 137, error: 'Command timed out (60s)', cwd: terminalCwd });
      }
    }, 60000);
  });
});

ipcMain.handle('terminal:kill', async () => {
  if (terminalProc && !terminalProc.killed) {
    terminalProc.kill('SIGINT');
    return true;
  }
  return false;
});

ipcMain.handle('terminal:set-cwd', async (_e, cwd) => {
  if (cwd) terminalCwd = cwd;
  return terminalCwd;
});

// ---------------------------------------------------------------------------
// Salesforce CLI helpers — execute commands and return captured output
// ---------------------------------------------------------------------------
ipcMain.handle('sf:exec', async (_e, command, cwd, timeoutMs) => {
  const timeout = timeoutMs || 120000;
  const isLoginCmd = /\borg\s+login\s+web\b/.test(command);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };

    // For login commands: don't suppress output/color, allow browser opening
    const env = isLoginCmd
      ? { ...process.env, BROWSER: process.env.BROWSER || '' }
      : { ...process.env, TERM: 'dumb', CLICOLOR: '0', NO_COLOR: '1', SF_JSON_RESULT: '1' };

    const proc = spawn('/bin/zsh', ['-l', '-c', command], {
      cwd: cwd || os.homedir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      // For login: detect the auth URL and open it in the default browser
      if (isLoginCmd) {
        const urlMatch = text.match(/(https?:\/\/[^\s]+login[^\s]*)/i)
          || text.match(/(https?:\/\/localhost:\d+[^\s]*)/i)
          || text.match(/(https?:\/\/[^\s]+)/i);
        if (urlMatch && urlMatch[1]) {
          shell.openExternal(urlMatch[1]).catch(() => {});
        }
      }
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Also check stderr for URLs (some CLI versions print there)
      if (isLoginCmd) {
        const urlMatch = text.match(/(https?:\/\/[^\s]+login[^\s]*)/i)
          || text.match(/(https?:\/\/localhost:\d+[^\s]*)/i)
          || text.match(/(https?:\/\/[^\s]+)/i);
        if (urlMatch && urlMatch[1]) {
          shell.openExternal(urlMatch[1]).catch(() => {});
        }
      }
    });
    proc.on('close', (code) => {
      done({ code, stdout, stderr });
    });
    proc.on('error', (err) => {
      done({ code: 1, stdout, stderr: err.message });
    });
    setTimeout(() => {
      if (!resolved && proc && !proc.killed) {
        proc.kill('SIGTERM');
        done({ code: 137, stdout, stderr: 'Command timed out' });
      }
    }, timeout);
  });
});

ipcMain.handle('sf:check-cli', async () => {
  try {
    const { execSync } = require('child_process');
    const version = execSync('/bin/zsh -l -c "sf --version 2>/dev/null || sfdx --version 2>/dev/null"', {
      timeout: 10000, encoding: 'utf8',
    }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
});

ipcMain.handle('sf:org-info', async (_e, cwd) => {
  try {
    const { execSync } = require('child_process');
    const result = execSync('/bin/zsh -l -c "sf org display --json 2>/dev/null"', {
      timeout: 15000, encoding: 'utf8', cwd: cwd || os.homedir(),
    });
    const json = JSON.parse(result);
    if (json.status === 0 && json.result) {
      return {
        connected: true,
        username: json.result.username,
        orgId: json.result.id,
        instanceUrl: json.result.instanceUrl,
        alias: json.result.alias || null,
        apiVersion: json.result.apiVersion || null,
      };
    }
    return { connected: false };
  } catch {
    return { connected: false };
  }
});

ipcMain.handle('sf:org-list', async (_e, cwd) => {
  try {
    const { exec, execSync } = require('child_process');
    const effectiveCwd = cwd || os.homedir();
    // Use 'sf org list auth' — reads local auth files only, takes ~1-2s
    // vs 'sf org list' which contacts every org and takes 30-60s
    const result = await new Promise((resolve, reject) => {
      exec('/bin/zsh -l -c "sf org list auth --json 2>/dev/null"', {
        timeout: 15000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
        cwd: effectiveCwd,
      }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve(stdout);
      });
    });
    const json = JSON.parse(result);
    // sf org list auth returns a flat array in result
    const rawList = Array.isArray(json.result) ? json.result : [];
    const seen = new Set();
    const orgs = [];
    for (const o of rawList) {
      const u = o.username || '';
      if (!u || seen.has(u)) continue;
      seen.add(u);
      const hasError = !!(o.error);
      orgs.push({
        username: u,
        alias: o.alias || '',
        orgId: o.orgId || '',
        instanceUrl: o.instanceUrl || '',
        isDefault: false,
        connectedStatus: hasError ? 'AuthError' : 'Connected',
        type: 'auth',
      });
    }
    // Get default org from project-local or global config
    let defaultUsername = null;
    try {
      const dResult = execSync('/bin/zsh -l -c "sf config get target-org --json 2>/dev/null"', {
        timeout: 5000, encoding: 'utf8', cwd: effectiveCwd,
      });
      const dJson = JSON.parse(dResult);
      if (dJson.result && dJson.result[0] && dJson.result[0].value) {
        defaultUsername = dJson.result[0].value;
      }
    } catch { /* no default set */ }
    if (defaultUsername) {
      const dl = defaultUsername.toLowerCase();
      for (const o of orgs) {
        if (o.username.toLowerCase() === dl || o.alias.toLowerCase() === dl
          || o.alias.toLowerCase().split(',').some(a => a.trim() === dl)) {
          o.isDefault = true;
        }
      }
    }
    return { orgs };
  } catch {
    return { orgs: [] };
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  fontSize: 14,
  fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
  tabSize: 2,
  wordWrap: 'off',
  minimap: true,
  autoSave: true,
  autoSaveDelay: 3000,
  bracketPairColorization: true,
  renderWhitespace: 'selection',
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  lineNumbers: 'on',
  theme: 'dark',
  trimTrailingWhitespace: true,
  insertFinalNewline: true,
};

ipcMain.handle('settings:read', async () => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      return { ...DEFAULT_SETTINGS, ...data };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
});

ipcMain.handle('settings:write', async (_e, settings) => {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch { return false; }
});

// ---------------------------------------------------------------------------
// Binary file reading (for image preview)
// ---------------------------------------------------------------------------
ipcMain.handle('fs:read-binary', async (_e, fp) => {
  try {
    const buf = fs.readFileSync(fp);
    return buf.toString('base64');
  } catch { return null; }
});

// ---------------------------------------------------------------------------
// Markdown rendering (via marked library)
// ---------------------------------------------------------------------------
ipcMain.handle('markdown:render', async (_e, content) => {
  try {
    const marked = await getMarked();
    return marked(content);
  } catch (err) {
    console.error('markdown:render error:', err);
    return '<p>Error rendering markdown</p>';
  }
});

// ---------------------------------------------------------------------------
// API Client — send HTTP requests from main process (no CORS)
// ---------------------------------------------------------------------------
ipcMain.handle('api:send-request', async (_e, opts) => {
  const { method, url, headers, body } = opts;
  const http = url.startsWith('https') ? require('https') : require('http');
  const parsedUrl = new URL(url);
  const start = Date.now();

  return new Promise((resolve) => {
    const reqOpts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method.toUpperCase(),
      headers: headers || {},
      timeout: 30000,
    };

    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const time = Date.now() - start;
        const responseHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) {
          responseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: responseHeaders,
          body: rawBody.toString('utf-8'),
          time,
          size: rawBody.length,
        });
      });
    });

    req.on('error', (err) => {
      resolve({ status: 0, statusText: err.message, headers: {}, body: err.message, time: Date.now() - start, size: 0 });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, statusText: 'Request timed out', headers: {}, body: 'Request timed out after 30s', time: Date.now() - start, size: 0 });
    });

    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      req.write(body);
    }
    req.end();
  });
});

// ---------------------------------------------------------------------------
// Database Client — SQLite, JSON, CSV file-based queries
// ---------------------------------------------------------------------------
ipcMain.handle('db:open', async (_e, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      // Return table names (top-level keys if object, or ['data'] if array)
      if (Array.isArray(data)) return { ok: true, tables: ['data'], type: 'json' };
      return { ok: true, tables: Object.keys(data), type: 'json' };
    } else if (ext === '.csv') {
      return { ok: true, tables: ['csv'], type: 'csv' };
    } else if (ext === '.sqlite' || ext === '.db' || ext === '.sqlite3') {
      // We'll use better-sqlite3 if available, otherwise fallback to reading as binary
      try {
        const Database = require('better-sqlite3');
        const db = new Database(filePath, { readonly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        db.close();
        return { ok: true, tables, type: 'sqlite' };
      } catch {
        return { ok: false, error: 'SQLite support requires better-sqlite3 package. Install with: npm install better-sqlite3' };
      }
    }
    return { ok: false, error: 'Unsupported file type: ' + ext };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:query', async (_e, filePath, query, tableName) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let data = Array.isArray(raw) ? raw : (raw[tableName] || []);
      if (!Array.isArray(data)) data = [data];
      // Simple filter: if query looks like key=value
      if (query && query.includes('=')) {
        const [k, v] = query.split('=').map(s => s.trim());
        data = data.filter(row => String(row[k]) === v);
      }
      const columns = data.length > 0 ? Object.keys(data[0]) : [];
      return { ok: true, columns, rows: data.slice(0, 500) };
    } else if (ext === '.csv') {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
      if (lines.length === 0) return { ok: true, columns: [], rows: [] };
      const columns = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const rows = lines.slice(1, 501).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        columns.forEach((c, i) => row[c] = vals[i] || '');
        return row;
      });
      return { ok: true, columns, rows };
    } else if (ext === '.sqlite' || ext === '.db' || ext === '.sqlite3') {
      try {
        const Database = require('better-sqlite3');
        const db = new Database(filePath, { readonly: true });
        const stmt = db.prepare(query || `SELECT * FROM ${tableName} LIMIT 500`);
        const rows = stmt.all();
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        db.close();
        return { ok: true, columns, rows };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: 'Unsupported file type' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Bookmarks persistence
// ---------------------------------------------------------------------------
const BOOKMARKS_FILE = path.join(CONGACODE_DIR, '.bookmarks.json');

ipcMain.handle('bookmarks:load', async () => {
  try { return JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf-8')); } catch { return []; }
});

ipcMain.handle('bookmarks:save', async (_e, bookmarks) => {
  try { fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarks, null, 2)); return true; } catch { return false; }
});

// ---------------------------------------------------------------------------
// Code Screenshot — export dialog
// ---------------------------------------------------------------------------
ipcMain.handle('screenshot:save', async (e, dataUrl) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showSaveDialog(win, {
    title: 'Save Screenshot',
    defaultPath: 'code-screenshot.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return false;
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(result.filePath, base64, 'base64');
  return result.filePath;
});

// ---------------------------------------------------------------------------
// TODO / FIXME scanner — search workspace files via grep
// ---------------------------------------------------------------------------
ipcMain.handle('todos:scan', async (e, folderPath) => {
  const { execFile } = require('child_process');
  // Strong tags: always matched anywhere (they're unambiguous as comment markers)
  // Weak tags: NOTE, WARN — only matched when inside comments
  const STRONG_TAGS = ['TODO', 'FIXME', 'HACK', 'BUG', 'XXX', 'TO-DO', 'DEBUG'];
  const WEAK_TAGS = ['NOTE', 'WARN'];
  const ALL_TAGS = [...STRONG_TAGS, ...WEAK_TAGS];
  // Also match System.debug() calls in Apex files
  const SF_PATTERN = 'System\\.debug\\s*\\(';
  // Pattern matches any of these tags (case-insensitive) — filtering happens post-match
  const pattern = `(${ALL_TAGS.join('|')})[\\s:;\\-]*|${SF_PATTERN}`;
  // Regex to detect if a line is inside a comment
  const commentPrefixRegex = /^\s*(\/\/|\/\*+|<!--|\*|#|--|%|@|;|REM\b)/i;

  return new Promise((resolve) => {
    const rgPath = require('path').join(__dirname, '..', '..', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');
    const tryRg = fs.existsSync(rgPath);
    const cmd = tryRg ? rgPath : 'grep';
    const args = tryRg
      ? ['-n', '-i', '--no-heading', '-e', pattern, '-r',
         '--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist',
         '--glob', '!build', '--glob', '!*.min.js', '--glob', '!*.min.css',
         '--glob', '!package-lock.json', '--glob', '!yarn.lock',
         '--glob', '!*.map',
         folderPath]
      : ['-rni', '-E', pattern,
         '--exclude-dir=node_modules', '--exclude-dir=.git',
         '--exclude-dir=dist', '--exclude-dir=build',
         '--include=*.js', '--include=*.ts', '--include=*.jsx', '--include=*.tsx',
         '--include=*.py', '--include=*.java', '--include=*.c', '--include=*.cpp',
         '--include=*.h', '--include=*.cs', '--include=*.go', '--include=*.rb',
         '--include=*.php', '--include=*.swift', '--include=*.rs', '--include=*.kt',
         '--include=*.scala', '--include=*.vue', '--include=*.svelte',
         '--include=*.html', '--include=*.css', '--include=*.scss', '--include=*.less',
         '--include=*.json', '--include=*.yaml', '--include=*.yml',
         '--include=*.md', '--include=*.sh', '--include=*.bash',
         '--include=*.sql', '--include=*.xml',
         '--include=*.cls', '--include=*.trigger',
         folderPath];
    execFile(cmd, args, { timeout: 15000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
      if (!stdout) { resolve({ items: [] }); return; }
      const items = [];
      const lines = stdout.split('\n');
      const tagRegex = new RegExp(`\\b(${ALL_TAGS.join('|')})[\\s:;\\-]*(.*)`, 'i');
      const sfDebugRegex = /\bSystem\.debug\s*\(/i;
      const weakSet = new Set(WEAK_TAGS.map(t => t.toLowerCase()));
      for (const line of lines) {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m) continue;
        const filePath = m[1];
        const lineNum = parseInt(m[2], 10);
        const text = m[3];
        // Check for System.debug() calls
        if (sfDebugRegex.test(text)) {
          items.push({
            tag: 'DEBUG',
            text: text.trim().replace(/^.*System\.debug\s*\(/i, 'System.debug(').replace(/;\s*$/, ''),
            file: require('path').basename(filePath),
            filePath,
            line: lineNum,
          });
          continue;
        }
        const tagMatch = text.match(tagRegex);
        if (!tagMatch) continue;
        const rawTag = tagMatch[1].toUpperCase().replace('-', '');
        const isWeak = weakSet.has(tagMatch[1].toLowerCase());
        // For weak tags (NOTE, WARN), require the line to look like a comment
        if (isWeak) {
          const trimmed = text.trimStart();
          const hasCommentPrefix = commentPrefixRegex.test(trimmed);
          // Also check if tag is preceded by comment chars inline: e.g. code /* NOTE: ... */
          const beforeTag = text.substring(0, tagMatch.index);
          const hasInlineComment = /\/\/|\/\*|#|<!--/.test(beforeTag);
          if (!hasCommentPrefix && !hasInlineComment) continue;
        }
        const tag = rawTag;
        items.push({
          tag,
          text: tagMatch[2].trim().replace(/\*\/\s*$/, '').replace(/-->$/, '').trim(),
          file: require('path').basename(filePath),
          filePath,
          line: lineNum,
        });
      }
      resolve({ items });
    });
  });
});

// ---------------------------------------------------------------------------
// App lifecycle — macOS open-file support (Finder "Open With…")
// ---------------------------------------------------------------------------
// Queue file paths that arrive before the app is ready
let pendingFilesToOpen = [];
let appIsReady = false;

// macOS sends 'open-file' when user double-clicks a file or uses "Open With"
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (appIsReady) {
    openFileInNewWindow(filePath);
  } else {
    // App not ready yet — queue for later
    pendingFilesToOpen.push(filePath);
  }
});

/**
 * Open a file in a brand-new window.
 * Creates a new BrowserWindow, waits for it to load, then sends the file path.
 */
function openFileInNewWindow(filePath) {
  addRecent(filePath);
  const win = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 600, minHeight: 400,
    title: 'CongaCode',
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
  // Load with ?new=1 so the renderer skips session restore (starts clean)
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { new: '1' } });
  win.once('ready-to-show', () => win.show());

  // Once the renderer finishes loading, send the file to open
  win.webContents.once('did-finish-load', () => {
    // Small delay to let renderer init() complete and register IPC listeners
    setTimeout(() => {
      win.webContents.send('file:open-path', filePath);
    }, 500);
  });

  // Open external links in default browser
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

  // Clean up file watchers when this window closes
  win.on('closed', () => {
    const wId = win.id;
    for (const [key, w] of watchers) {
      if (key.startsWith(`${wId}:`)) {
        w.close().catch(() => {});
        watchers.delete(key);
      }
    }
  });
}

app.whenReady().then(() => {
  ensureDirs();
  appIsReady = true;

  // Detect if launched as a login item (macOS auto-launch on restart).
  // In that case, open the window hidden — user brings it up by clicking the dock icon.
  const loginItemSettings = process.platform === 'darwin'
    ? app.getLoginItemSettings()
    : { wasOpenedAsHidden: false, wasOpenedAtLogin: false };
  const openedAtLogin = loginItemSettings.wasOpenedAtLogin || loginItemSettings.wasOpenedAsHidden;

  // If files were queued (from open-file before ready), open each in a new window
  if (pendingFilesToOpen.length > 0) {
    pendingFilesToOpen.forEach(fp => openFileInNewWindow(fp));
    pendingFilesToOpen = [];
  } else if (!openedAtLogin) {
    // No file to open and not a login-item launch — show the normal main window
    createWindow();
  }
  // If openedAtLogin and no files pending, don't create a window; the app lives
  // in the dock and the user opens it from there when needed.

  // Set up dock menu with recent files
  updateDockMenu();

  // Also handle files passed via command line
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  args.forEach(arg => {
    if (!arg.startsWith('-') && fs.existsSync(arg)) {
      openFileInNewWindow(path.resolve(arg));
    }
  });

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked and no windows exist
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  // Clean up terminal
  if (terminalProc && !terminalProc.killed) terminalProc.kill('SIGTERM');
  // Clean up file watchers
  for (const [key, watcher] of watchers) {
    watcher.close();
    watchers.delete(key);
  }
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send('app:before-quit'));
});

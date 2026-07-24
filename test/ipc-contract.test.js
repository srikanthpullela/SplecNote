'use strict';
/**
 * SCENARIO: The preload IPC bridge stays in sync with the main process.
 *
 * The renderer talks to the OS only through channels the preload exposes. If the
 * preload invokes a channel that main.js never handles, that whole feature
 * (Salesforce CLI, file system, git, updates…) silently fails at runtime with an
 * unhandled-invoke rejection. This asserts every invoked channel has a handler.
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('./lib/source');

test('preload exposes the app bridge on window', () => {
  const preload = S.read('src/preload/preload.js');
  assert.match(
    preload,
    /contextBridge\.exposeInMainWorld\(\s*['"]apexStudio['"]/,
    'preload no longer exposes window.apexStudio — the renderer loses all IPC.'
  );
});

test('every ipcRenderer.invoke channel has an ipcMain.handle in the main process', () => {
  const preload = S.read('src/preload/preload.js');
  const main = S.mainProcessSource();

  const invoked = S.matchAll(preload, /ipcRenderer\.invoke\(\s*["']([^"']+)["']/g);
  const handled = S.matchAll(main, /ipcMain\.handle\(\s*["']([^"']+)["']/g);

  const missing = [...invoked].filter((ch) => !handled.has(ch)).sort();
  assert.strictEqual(
    missing.length,
    0,
    `Preload invokes channel(s) with no ipcMain.handle in the main process:\n  ${missing.join('\n  ')}`
  );
});

test('every ipcRenderer.send channel has an ipcMain.on in the main process', () => {
  const preload = S.read('src/preload/preload.js');
  const main = S.mainProcessSource();

  const sent = S.matchAll(preload, /ipcRenderer\.send\(\s*["']([^"']+)["']/g);
  const listened = S.matchAll(main, /ipcMain\.on\(\s*["']([^"']+)["']/g);

  const missing = [...sent].filter((ch) => !listened.has(ch)).sort();
  assert.strictEqual(
    missing.length,
    0,
    `Preload sends channel(s) with no ipcMain.on in the main process:\n  ${missing.join('\n  ')}`
  );
});

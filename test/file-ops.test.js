'use strict';
/**
 * SCENARIO: File-tree operations (New File, New Folder, Rename) and the context
 * menu that launches them. These also depend on showInputDialog, so they share
 * the failure mode that broke Add Org.
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('./lib/source');

test('file-tree context menu exists with its core actions', () => {
  const html = S.read('src/renderer/index.html');
  const htmlIds = S.extractDefinedIds(html);
  assert.ok(htmlIds.has('context-menu'), 'Missing #context-menu in index.html.');
  for (const action of ['new-file', 'new-folder', 'rename', 'delete', 'copy-path']) {
    assert.match(
      html,
      new RegExp(`data-action=["']${action}["']`),
      `Context menu is missing the "${action}" action.`
    );
  }
});

test('New File / New Folder / Rename prompt via showInputDialog', () => {
  const app = S.read('src/renderer/app.js');
  assert.match(app, /showInputDialog\(\s*['"]New File['"]/, 'New File no longer prompts via showInputDialog.');
  assert.match(app, /showInputDialog\(\s*['"]New Folder['"]/, 'New Folder no longer prompts via showInputDialog.');
  assert.match(app, /showInputDialog\(\s*['"]Rename['"]/, 'Rename no longer prompts via showInputDialog.');
});

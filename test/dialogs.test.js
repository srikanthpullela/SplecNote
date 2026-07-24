'use strict';
/**
 * SCENARIO: Generic input / confirm dialogs.
 *
 * `showInputDialog` / `showConfirmDialog` back many flows (Add Org alias prompt,
 * New File, New Folder, Rename, several debugger prompts). If their markup or
 * exposure regresses, all of those break at once — which is what happened.
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('./lib/source');

const DIALOG_IDS = [
  'input-dialog-overlay',
  'input-dialog-title',
  'input-dialog-message',
  'input-dialog-input',
  'btn-input-dialog-ok',
  'btn-input-dialog-cancel',
  'btn-input-dialog-close',
];

test('input-dialog markup exists in index.html', () => {
  const htmlIds = S.extractDefinedIds(S.read('src/renderer/index.html'));
  const missing = DIALOG_IDS.filter((id) => !htmlIds.has(id));
  assert.strictEqual(
    missing.length,
    0,
    `Missing input-dialog element(s) in index.html: ${missing.join(', ')}. ` +
      `showInputDialog()/showConfirmDialog() drive these — removing them breaks ` +
      `Add Org, New File, Rename, etc.`
  );
});

test('app.js defines and exposes showInputDialog and showConfirmDialog', () => {
  const app = S.read('src/renderer/app.js');
  assert.match(app, /function\s+showInputDialog\s*\(/, 'showInputDialog not defined');
  assert.match(app, /function\s+showConfirmDialog\s*\(/, 'showConfirmDialog not defined');
  assert.match(app, /window\.showInputDialog\s*=\s*showInputDialog/, 'showInputDialog not exposed on window');
  assert.match(app, /window\.showConfirmDialog\s*=\s*showConfirmDialog/, 'showConfirmDialog not exposed on window');
});

test('every id used inside the dialog functions exists in the HTML', () => {
  const app = S.read('src/renderer/app.js');
  const htmlIds = S.extractDefinedIds(S.read('src/renderer/index.html'));

  // Slice out the two function bodies and check their referenced ids resolve.
  const start = app.indexOf('function showInputDialog');
  const end = app.indexOf('window.showInputDialog');
  assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate dialog functions in app.js');
  const body = app.slice(start, end);

  const referenced = S.extractReferencedIds(body);
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.strictEqual(
    missing.length,
    0,
    `Dialog functions reference id(s) not present in index.html: ${missing.join(', ')}`
  );
});

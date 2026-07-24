'use strict';
/**
 * Shared source-analysis helpers for the regression test suite.
 *
 * These tests intentionally do NOT boot Electron or hit Salesforce. The app's
 * renderer is DOM code that can't run headless cheaply, so instead we assert
 * *contracts* over the source text: which DOM ids the JS references vs. which
 * ids actually exist in the HTML, which IPC channels are invoked vs. handled,
 * and that every wired-up scenario stays wired. That is exactly the class of
 * bug that broke the "Add Org" popup (JS referenced #input-dialog-* ids that
 * a commit had removed from index.html).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

/** Collect all `src="..."` values from <script> tags in index.html. */
function htmlScriptSrcs() {
  const html = read('src/renderer/index.html');
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/**
 * The app's own renderer scripts loaded by index.html, as repo-relative paths.
 * Excludes third-party bundles under node_modules (e.g. the Monaco loader).
 */
function appScriptFiles() {
  const out = [];
  for (const src of htmlScriptSrcs()) {
    if (src.includes('node_modules')) continue;
    const abs = path.resolve(RENDERER_DIR, src);
    out.push(path.relative(ROOT, abs));
  }
  return out;
}

/**
 * Files whose text may reference or define DOM ids: index.html (inline scripts +
 * markup) plus every app renderer script.
 */
function domSourceFiles() {
  return ['src/renderer/index.html', ...appScriptFiles()];
}

/**
 * Ids that are *available* at runtime from a chunk of source: static HTML
 * `id="..."` attributes, ids assigned in JS (`el.id = 'x'`, template literals
 * containing `id="x"`), and `setAttribute('id', 'x')`.
 */
function extractDefinedIds(text) {
  const ids = new Set();
  // id="x" / id='x' / escaped id=\"x\" (covers HTML attrs, template literals,
  // and `.id = "x"` assignments).
  const attrRe = /\bid\s*=\s*\\?["']([A-Za-z0-9_:-]+)\\?["']/g;
  let m;
  while ((m = attrRe.exec(text)) !== null) ids.add(m[1]);
  // setAttribute('id', 'x')
  const setRe = /setAttribute\(\s*["']id["']\s*,\s*["']([A-Za-z0-9_:-]+)["']/g;
  while ((m = setRe.exec(text)) !== null) ids.add(m[1]);
  return ids;
}

/**
 * Ids that are *looked up* from a chunk of source via a single-id selector:
 * `$('#x')`, `getElementById('x')`, `querySelector('#x')`, `querySelectorAll('#x')`.
 * Compound selectors (`#a .b`) and dynamic ones (`` `#${v}` ``) are ignored on
 * purpose — we can only assert on statically-known ids.
 */
function extractReferencedIds(text) {
  const ids = new Set();
  let m;
  const dollarRe = /\$\(\s*["']#([A-Za-z0-9_:-]+)["']\s*\)/g;
  while ((m = dollarRe.exec(text)) !== null) ids.add(m[1]);
  const byIdRe = /getElementById\(\s*["']([A-Za-z0-9_:-]+)["']\s*\)/g;
  while ((m = byIdRe.exec(text)) !== null) ids.add(m[1]);
  const qsRe = /querySelectorAll?\(\s*["']#([A-Za-z0-9_:-]+)["']\s*\)/g;
  while ((m = qsRe.exec(text)) !== null) ids.add(m[1]);
  return ids;
}

/** Every id referenced across the given repo-relative files. Returns id -> [files]. */
function collectReferencedIds(files) {
  const map = new Map();
  for (const f of files) {
    const refs = extractReferencedIds(read(f));
    for (const id of refs) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(f);
    }
  }
  return map;
}

/** Every id available (defined) across the given repo-relative files. */
function collectDefinedIds(files) {
  const ids = new Set();
  for (const f of files) {
    for (const id of extractDefinedIds(read(f))) ids.add(id);
  }
  return ids;
}

/** Return the set of first capture groups for every match of `re` in `text`. */
function matchAll(text, re) {
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

/** Concatenated source of every .js file in the main process (main.js, updater.js, …). */
function mainProcessSource() {
  const dir = path.join(ROOT, 'src', 'main');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

module.exports = {
  ROOT,
  RENDERER_DIR,
  read,
  exists,
  htmlScriptSrcs,
  appScriptFiles,
  domSourceFiles,
  extractDefinedIds,
  extractReferencedIds,
  collectReferencedIds,
  collectDefinedIds,
  matchAll,
  mainProcessSource,
};

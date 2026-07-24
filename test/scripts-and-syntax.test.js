'use strict';
/**
 * SCENARIO: The app actually loads. Two cheap-but-high-value guards:
 *   1. Every <script src> in index.html resolves to a file on disk. A renamed or
 *      deleted script include means the renderer never boots.
 *   2. Every JS file in the app parses without a syntax error (`node --check`).
 *      Catches a broken edit before it ships.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('node:child_process');
const S = require('./lib/source');

test('every <script src> in index.html resolves on disk', () => {
  const missing = [];
  for (const src of S.htmlScriptSrcs()) {
    const abs = path.resolve(S.RENDERER_DIR, src);
    const rel = path.relative(S.ROOT, abs);
    if (!S.exists(rel)) missing.push(`${src}  (resolved: ${rel})`);
  }
  assert.strictEqual(missing.length, 0, `Broken <script src> include(s):\n  ${missing.join('\n  ')}`);
});

test('all app JS files parse without syntax errors', () => {
  const files = [
    'src/main/main.js',
    'src/main/updater.js',
    'src/preload/preload.js',
    ...S.appScriptFiles(),
    'test/lib/source.js',
  ];
  const broken = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(S.ROOT, f)], { stdio: 'pipe' });
    } catch (err) {
      broken.push(`${f}: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }
  assert.strictEqual(broken.length, 0, `Syntax error(s):\n  ${broken.join('\n  ')}`);
});

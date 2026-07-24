'use strict';
/**
 * DOM CONTRACT — the primary regression guard.
 *
 * Every DOM id the renderer looks up (`$('#x')`, `getElementById('x')`,
 * `querySelector('#x')`) must either exist as a real element in index.html or be
 * created dynamically somewhere in the renderer JS. When a commit deleted the
 * `#input-dialog-overlay` markup but left `showInputDialog()` referencing it,
 * the "Add Org" alias popup silently broke. This test fails loudly on exactly
 * that situation.
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('./lib/source');

/**
 * Ids that are legitimately provided at runtime by something our static scan
 * can't see (third-party libs, ids built from variables, etc.). Keep this list
 * short and justified — every entry is a hole in the guard.
 */
const ALLOWLIST = new Set([
  // add ids here only with a comment explaining why they can't be detected
]);

test('every referenced DOM id exists in the HTML or is created dynamically', () => {
  const files = S.domSourceFiles();
  const defined = S.collectDefinedIds(files);
  const referenced = S.collectReferencedIds(files); // id -> [files]

  const missing = [];
  for (const [id, where] of referenced) {
    if (defined.has(id) || ALLOWLIST.has(id)) continue;
    missing.push(`  #${id}  — referenced in: ${where.join(', ')}`);
  }

  assert.strictEqual(
    missing.length,
    0,
    `\n${missing.length} DOM id(s) are referenced by JS but never defined in ` +
      `index.html or created dynamically.\nThis is the "removed element / dangling ` +
      `reference" bug that broke the org popup:\n\n${missing.join('\n')}\n`
  );
});

test('index.html exposes at least a reasonable number of ids (sanity)', () => {
  // Guards against index.html being truncated/emptied by a bad merge.
  const htmlIds = S.extractDefinedIds(S.read('src/renderer/index.html'));
  assert.ok(
    htmlIds.size > 100,
    `index.html defines only ${htmlIds.size} ids — expected many more. ` +
      `Was markup accidentally removed?`
  );
});

'use strict';
/**
 * SCENARIO: Salesforce org picker + "Add Org" authentication flow.
 *
 * This is the flow the user reported broken. The picker opens, but clicking
 * "Add Production/Sandbox/Custom Org" must reach startOrgAuthFlow(), which in
 * turn depends on window.showInputDialog() to ask for the alias. We guard the
 * whole chain plus the status-bar/panel elements it touches.
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('./lib/source');

const SF = () => S.read('src/renderer/modules/salesforce.js');

test('org picker markup exists in index.html', () => {
  const htmlIds = S.extractDefinedIds(S.read('src/renderer/index.html'));
  for (const id of ['org-picker-overlay', 'org-picker-input', 'org-picker-results']) {
    assert.ok(htmlIds.has(id), `Missing #${id} in index.html — the org picker cannot render.`);
  }
});

test('org panel / status-bar elements referenced by salesforce.js exist', () => {
  const htmlIds = S.extractDefinedIds(S.read('src/renderer/index.html'));
  for (const id of ['sf-org-select', 'sf-org-dot', 'sf-org-label']) {
    assert.ok(htmlIds.has(id), `Missing #${id} in index.html — org selection/status UI breaks.`);
  }
});

test('core org functions are defined', () => {
  const sf = SF();
  for (const fn of [
    'showOrgPicker',
    'hideOrgPicker',
    'renderOrgPickerResults',
    'startOrgAuthFlow',
    'selectOrgFromPicker',
    'loginNewOrg',
    'checkOrgConnection',
    'onOrgSelectChange',
  ]) {
    assert.match(sf, new RegExp(`function\\s+${fn}\\s*\\(`), `salesforce.js is missing ${fn}()`);
  }
});

test('Add Production/Sandbox/Custom Org each wire to startOrgAuthFlow', () => {
  const sf = SF();
  for (const type of ['production', 'sandbox', 'custom']) {
    assert.match(
      sf,
      new RegExp(`startOrgAuthFlow\\(\\s*['"]${type}['"]\\s*\\)`),
      `The "Add ${type} Org" item is not wired to startOrgAuthFlow('${type}').`
    );
  }
});

test('startOrgAuthFlow depends on showInputDialog (alias prompt)', () => {
  const sf = SF();
  // This cross-module dependency is exactly what broke: the picker was fine, but
  // the alias popup (showInputDialog) had no markup, so the flow died.
  assert.match(
    sf,
    /window\.showInputDialog\(/,
    'startOrgAuthFlow no longer calls window.showInputDialog — the alias popup will not open.'
  );
});

test('org picker click handler hides the picker then runs the item action', () => {
  const sf = SF();
  assert.match(
    sf,
    /addEventListener\(\s*['"]click['"]\s*,\s*\(\)\s*=>\s*\{\s*hideOrgPicker\(\);\s*item\.action\(\)/,
    'org picker items must hide the overlay and invoke their action on click.'
  );
});

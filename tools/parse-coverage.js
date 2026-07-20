#!/usr/bin/env node
/*
 * Apex engine parse-coverage harness.
 *
 * Runs the Apex Debug Studio ApexEngine over a corpus of .cls files entirely headless
 * (no org, no GUI) and reports how many the engine can PARSE/COMPILE, with a
 * categorized breakdown of failures. This is the objective baseline the engine
 * is improved against.
 *
 * Usage:
 *   node tools/parse-coverage.js [corpusDir] [--json out.json] [--fails N]
 *
 * Defaults corpusDir to /Users/spullela/cpq-core/src/classes
 */
'use strict';

const fs = require('fs');
const path = require('path');

const E = require('../src/renderer/modules/apexengine.js');

const args = process.argv.slice(2);
let corpusDir = '/Users/spullela/cpq-core/src/classes';
let jsonOut = null;
let showFails = 25;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') jsonOut = args[++i];
  else if (a === '--fails') showFails = parseInt(args[++i], 10) || 0;
  else if (!a.startsWith('--')) corpusDir = a;
}

// A no-op host — parsing/compiling never needs org callbacks.
function makeHost() {
  return {
    log() {}, query: async () => [], dml: async () => {},
    evalOrg: async () => ({ ok: false }), describeSObject: async () => ({ names: [] }),
    loadClassSource: async () => null, getBreakpoint: () => null,
    onPause() {}, onExecLine() {}, onDone() {}, onError() {},
  };
}

// Bucket a raw error message into a coarse category so we can see *what kind*
// of thing the parser chokes on (drives what to fix next).
function categorize(msg) {
  const m = (msg || '').toLowerCase();
  if (/unexpected (token|end|char)/.test(m)) return 'unexpected-token';
  if (/expected/.test(m)) return 'expected-syntax';
  if (/annotation|@/.test(m)) return 'annotation';
  if (/generic|<|>/.test(m)) return 'generics';
  if (/trigger/.test(m)) return 'trigger';
  if (/soql|\[select|query/.test(m)) return 'soql';
  if (/sosl|\[find/.test(m)) return 'sosl';
  if (/string|quote|literal/.test(m)) return 'string-literal';
  if (/enum/.test(m)) return 'enum';
  if (/interface/.test(m)) return 'interface';
  if (/modifier|access/.test(m)) return 'modifier';
  if (/registry|not.*regist|no class/.test(m)) return 'not-registered';
  if (/cannot read|undefined|null/.test(m)) return 'engine-crash';
  if (/maximum call stack|recursion/.test(m)) return 'recursion';
  return 'other';
}

function main() {
  if (!fs.existsSync(corpusDir)) {
    console.error(`Corpus dir not found: ${corpusDir}`);
    process.exit(2);
  }
  const files = fs.readdirSync(corpusDir).filter((f) => /\.(cls|trigger)$/.test(f)).sort();
  const results = [];
  const t0 = Date.now();

  for (const f of files) {
    const full = path.join(corpusDir, f);
    const name = f.replace(/\.(cls|trigger)$/, '');
    let src = '';
    try { src = fs.readFileSync(full, 'utf8'); } catch (e) {
      results.push({ name, file: f, status: 'read-error', error: e.message, category: 'read-error' });
      continue;
    }
    // Fresh engine per file to isolate failures (no cross-contamination).
    const eng = new E.ApexEngine(makeHost());
    try {
      eng.loadSource(full, src);
      const registered = !!eng.registry.get(name);
      if (registered) results.push({ name, file: f, status: 'ok', category: null });
      else results.push({ name, file: f, status: 'not-registered', error: 'parsed but class not registered', category: 'not-registered' });
    } catch (e) {
      const msg = (e && (e.message || e.apexMessage)) || String(e);
      results.push({ name, file: f, status: 'parse-fail', error: msg, category: categorize(msg) });
    }
  }

  const ms = Date.now() - t0;
  const total = results.length;
  const ok = results.filter((r) => r.status === 'ok').length;
  const fails = results.filter((r) => r.status !== 'ok');
  const pct = total ? ((ok / total) * 100).toFixed(1) : '0.0';

  // Category tally
  const byCat = {};
  for (const r of fails) byCat[r.category] = (byCat[r.category] || 0) + 1;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

  console.log('');
  console.log('=== Apex Engine Parse-Coverage ===');
  console.log(`Corpus : ${corpusDir}`);
  console.log(`Files  : ${total}   Time: ${ms}ms`);
  console.log(`PARSED : ${ok} / ${total}  (${pct}%)`);
  console.log(`FAILED : ${fails.length}`);
  console.log('');
  console.log('--- failures by category ---');
  for (const [cat, n] of cats) console.log(`  ${String(n).padStart(4)}  ${cat}`);
  console.log('');
  if (showFails > 0 && fails.length) {
    console.log(`--- first ${Math.min(showFails, fails.length)} failing classes ---`);
    for (const r of fails.slice(0, showFails)) {
      console.log(`  [${r.category}] ${r.name}: ${(r.error || '').replace(/\s+/g, ' ').slice(0, 110)}`);
    }
    console.log('');
  }

  if (jsonOut) {
    const report = {
      corpusDir, generatedAt: new Date().toISOString(), timeMs: ms,
      total, parsed: ok, failed: fails.length, parsePct: Number(pct),
      byCategory: byCat,
      failures: fails.map((r) => ({ name: r.name, category: r.category, error: r.error })),
    };
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`Wrote detailed report: ${jsonOut}`);
  }

  return { ok, total, pct };
}

main();

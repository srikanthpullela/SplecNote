#!/usr/bin/env node
/*
 * apexdebug-harness.js — headless driver for the Apex Debug Studio Apex live-interpreter.
 *
 * Runs the SAME engine the GUI debugger uses (src/renderer/modules/apexengine.js +
 * apexlang.js) against a REAL Salesforce org, with no Electron window and no manual
 * stepping. It implements the identical `host` bridge the app builds in
 * apexdebugger.js (query / evalOrg / describeSObject / dml / loadClassSource /
 * userInfo), delegating org work to the `sf` CLI. All engine output — System.debug,
 * org fetches, the final return value, and any uncaught Apex exception with its
 * stack — is printed to stdout and mirrored to a log file, so the run/inspect/fix
 * loop needs zero copy-paste. Exit code: 0 = completed, 1 = Apex error, 2 = harness error.
 *
 * Usage:
 *   node tools/apexdebug-harness.js --file <Foo.cls> --method <name> [options]
 *   node tools/apexdebug-harness.js --stdin --class <Foo> --method <name> [options]   (source on stdin)
 *
 * Options:
 *   --file <path>         Apex class/trigger file to run (.cls/.trigger).
 *   --stdin              Read Apex source from stdin instead of --file.
 *   --class <name>        Class name for the entry method (default: file basename or first class).
 *   --method <name>       Static method to invoke (default: first method found).
 *   --args '<json>'       JSON array of argument values for the method (default: nulls).
 *   --org <alias>         Target org alias/username (default: sf default target-org).
 *   --project <dir>       SFDX project dir for cross-class step-into + namespace (default: --file's dir).
 *   --namespace <ns>      Managed-package namespace for SOQL/Apex retry (default: auto-detect).
 *   --log <path>          Transcript log file (default: ~/ApexDebugStudio/logs/harness-<ts>.log).
 *   --no-org             Run without an org (SOQL returns 0 rows; useful for pure-logic bugs).
 *   --no-system-mode     Don't deploy/use the CCDebugQuery helper; run SOQL in user mode
 *                        (FLS-hidden managed-package fields will error with "No such column").
 *   --timeout <ms>        Per-sf-call timeout (default: 120000).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/* ------------------------------- args ------------------------------- */
function parseArgs(argv) {
  const a = { timeout: 120000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--file': a.file = next(); break;
      case '--stdin': a.stdin = true; break;
      case '--class': a.className = next(); break;
      case '--method': a.method = next(); break;
      case '--args': a.args = next(); break;
      case '--args-file': a.argsFile = next(); break;
      case '--org': a.org = next(); break;
      case '--project': a.project = next(); break;
      case '--namespace': a.namespace = next(); break;
      case '--log': a.log = next(); break;
      case '--no-org': a.noOrg = true; break;
      case '--no-system-mode': a.noSystemMode = true; break;
      case '--timeout': a.timeout = parseInt(next(), 10) || 120000; break;
      case '-h': case '--help': a.help = true; break;
      default: console.error(`Unknown option: ${k}`); a.help = true;
    }
  }
  return a;
}

const ARGS = parseArgs(process.argv);
if (ARGS.help || (!ARGS.file && !ARGS.stdin)) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 33).join('\n').replace(/^ \* ?/gm, ''));
  process.exit(ARGS.help ? 0 : 2);
}

/* ------------------------------ logging ----------------------------- */
const LOG_DIR = path.join(os.homedir(), 'ApexDebugStudio', 'logs');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = ARGS.log || path.join(LOG_DIR, `harness-${ts}.log`);
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (_) { /* best effort */ }
let _logStream = null;
try { _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' }); } catch (_) { /* stdout only */ }
function out(line) {
  process.stdout.write(line + '\n');
  if (_logStream) { try { _logStream.write(line + '\n'); } catch (_) {} }
}
function tag(t, msg) { out(`[${t}] ${msg}`); }

/* -------------------------- load the engine ------------------------- */
const MODDIR = path.join(__dirname, '..', 'src', 'renderer', 'modules');
let Lang, Engine;
try {
  Lang = require(path.join(MODDIR, 'apexlang.js'));
  globalThis.ApexLang = Lang;
  Engine = require(path.join(MODDIR, 'apexengine.js'));
  globalThis.ApexEngine = Engine;
} catch (e) {
  out(`=== HARNESS ERROR === failed to load engine: ${e && e.stack || e}`);
  process.exit(2);
}
const { ApexError } = Engine;

/* ---------------------------- sf CLI bridge ------------------------- */
function sf(args, { timeout } = {}) {
  return new Promise((resolve) => {
    execFile('sf', args, { timeout: timeout || ARGS.timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', error: err || null });
    });
  });
}
function parseSfJson(stdout) {
  if (!stdout) return null;
  try { return JSON.parse(stdout); } catch { /* fall through */ }
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stdout.slice(start, end + 1)); } catch { return null; }
}
function sfErrorText(cli, stderr, stdout, fallback) {
  if (cli) {
    const r = cli.result || cli.data || {};
    if (r.compileProblem) {
      const loc = r.line ? ` at line ${r.line}${r.column ? ' col ' + r.column : ''}` : '';
      return `Compile failed${loc}: ${r.compileProblem}`;
    }
    if (r.exceptionMessage) return r.exceptionMessage;
    if (cli.status && cli.status !== 0 && cli.message) {
      const afterErr = cli.message.match(/with the error:\s*([\s\S]+)/i);
      if (afterErr) return `Compile failed: ${afterErr[1].trim()}`;
      return cli.message;
    }
  }
  return (stderr && stderr.trim()) || (stdout && stdout.trim()) || fallback;
}

let TARGET_ORG = ARGS.org || null;
async function resolveDefaultOrg() {
  if (TARGET_ORG || ARGS.noOrg) return;
  const { stdout } = await sf(['config', 'get', 'target-org', '--json']);
  const j = parseSfJson(stdout);
  const v = j && j.result && j.result[0] && j.result[0].value;
  if (v) TARGET_ORG = v;
}
function orgFlag() { return TARGET_ORG ? ['--target-org', TARGET_ORG] : []; }
function liveOrg() { return !ARGS.noOrg && !!TARGET_ORG; }

/* ---- system-mode SOQL helper ------------------------------------------
 * Anonymous Apex resolves SOQL fields with the running user's field-level
 * security, so FLS-hidden managed-package fields fail with "No such column".
 * A *deployed* Apex class runs in system mode, where FLS is not enforced, so
 * those fields become queryable. We deploy a tiny helper on demand and route
 * SOQL through it. Disable with --no-system-mode. ---------------------- */
const HELPER_CLASS = 'CCDebugQuery';
const HELPER_API = '62.0';
const HELPER_SOURCE =
`public class ${HELPER_CLASS} {
    // Deployed class => system mode => FLS not enforced on SOQL, so the
    // debugger can read protected/hidden managed-package fields.
    public static String runSystem(String soql) {
        return JSON.serialize(Database.query(soql, AccessLevel.SYSTEM_MODE));
    }
}`;
let _systemMode = false;
async function ensureHelperClass() {
  if (!liveOrg() || ARGS.noSystemMode) return false;
  const check = await runAnonApex(`System.debug(LoggingLevel.ERROR,'__CC_HELPER__'+(Type.forName('${HELPER_CLASS}')!=null));`);
  if (check.markers && check.markers.__CC_HELPER__ === 'true') {
    _systemMode = true; tag('org', `system-mode SOQL: reusing deployed ${HELPER_CLASS} (FLS bypass on)`); return true;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc_helper_'));
  const cls = path.join(dir, 'classes'); fs.mkdirSync(cls);
  fs.writeFileSync(path.join(cls, `${HELPER_CLASS}.cls`), HELPER_SOURCE);
  fs.writeFileSync(path.join(cls, `${HELPER_CLASS}.cls-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${HELPER_API}</apiVersion><status>Active</status></ApexClass>`);
  fs.writeFileSync(path.join(dir, 'package.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>${HELPER_CLASS}</members><name>ApexClass</name></types><version>${HELPER_API}</version></Package>`);
  const { stdout } = await sf(['project', 'deploy', 'start', '--metadata-dir', dir, '--json', ...orgFlag()], { timeout: 300000 });
  const j = parseSfJson(stdout);
  if (j && j.status === 0 && j.result && j.result.success) {
    _systemMode = true; tag('org', `system-mode SOQL: deployed ${HELPER_CLASS} (FLS bypass on)`); return true;
  }
  tag('org', `system-mode SOQL: unavailable (deploy failed) — SOQL runs in user mode; hidden fields may error`);
  return false;
}

/* namespace: --namespace flag, else project sfdx-project.json, else org namespacePrefix */
let _ns; let _nsResolved = false;
async function getPackageNamespace() {
  if (_nsResolved) return _ns;
  _nsResolved = true; _ns = ARGS.namespace || null;
  if (!_ns && PROJECT_DIR) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'sfdx-project.json'), 'utf8'));
      if (j && j.namespace) _ns = j.namespace;
    } catch (_) { /* not an sfdx project */ }
  }
  if (!_ns && liveOrg()) {
    const { stdout } = await sf(['org', 'list', '--json']);
    const j = parseSfJson(stdout);
    if (j && j.result) {
      const all = [].concat(j.result.scratchOrgs || [], j.result.nonScratchOrgs || [], j.result.other || [], j.result.sandboxes || [], j.result.devHubs || []);
      const hit = all.find(o => o.alias === TARGET_ORG || o.username === TARGET_ORG);
      if (hit && hit.namespacePrefix) _ns = hit.namespacePrefix;
    }
  }
  if (_ns) tag('org', `namespace: ${_ns}`);
  return _ns;
}

/* ------------------------- SOQL (system + REST) --------------------- */
// Preserve the SObject type token (`attributes.type`) so the engine can resolve
// overloads / getSObjectType(); the engine skips `attributes` during field
// iteration, so keeping just the type adds no noise.
function cleanSObject(rec) {
  if (Array.isArray(rec)) return rec.map(cleanSObject);
  if (rec && typeof rec === 'object') {
    const o = {};
    if (rec.attributes && rec.attributes.type) o.attributes = { type: rec.attributes.type };
    for (const k of Object.keys(rec)) {
      if (k === 'attributes') continue;
      const v = rec[k];
      o[k] = (v && typeof v === 'object') ? cleanSObject(v) : v;
    }
    return o;
  }
  return rec;
}
function applyNamespaceToSoql(soql, ns) {
  if (!ns) return soql;
  const nsPrefix = ns.toLowerCase() + '__';
  return soql.replace(/\b(\w+?)__(c|r|mdt|e|b|x|share|history|kav)\b/gi, (full) => {
    if (full.toLowerCase().startsWith(nsPrefix)) return full;
    return ns + '__' + full;
  });
}
function stripColumnFromSoql(soql, col) {
  if (!col || !soql) return null;
  const upper = soql.toUpperCase();
  const idx = upper.indexOf('SELECT');
  const fromIdx = upper.indexOf(' FROM ');
  if (idx < 0 || fromIdx < 0) return null;
  const head = soql.slice(idx + 6, fromIdx);
  const cols = head.split(',').map(c => c.trim()).filter(Boolean);
  const kept = cols.filter(c => c.toLowerCase() !== col.toLowerCase());
  if (kept.length === cols.length || kept.length === 0) return null;
  return soql.slice(0, idx + 6) + ' ' + kept.join(', ') + ' ' + soql.slice(fromIdx + 1);
}

async function runSoqlViaApex(soql) {
  if (!liveOrg()) return { _apexUnavailable: true };
  // Collapse source-formatting newlines/tabs (between SOQL tokens) to spaces so the
  // query is a single-line Apex string literal — Apex forbids line breaks inside
  // string literals. Bind values are emitted single-line, so this never touches literals.
  const oneLine = soql.replace(/[\r\n\t]+/g, ' ');
  const escaped = oneLine.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const queryExpr = _systemMode
    ? `${HELPER_CLASS}.runSystem('${escaped}')`            // deployed class => system mode => FLS bypass
    : `JSON.serialize(Database.query('${escaped}'))`;      // anonymous => user-mode field visibility
  const apex = [
    `String ccOut = '[]';`,
    `String ccErr = '';`,
    `try { ccOut = ${queryExpr}; }`,
    `catch (Exception ccE) { ccErr = ccE.getTypeName() + ': ' + ccE.getMessage(); }`,
    `System.debug(LoggingLevel.ERROR, '__CC_SOQL__' + ccOut);`,
    `System.debug(LoggingLevel.ERROR, '__CC_SOQLERR__' + ccErr);`,
  ].join('\n');
  const res = await runAnonApex(apex);
  if (process.env.CC_DEBUG) process.stderr.write(`[dbg viaApex] sys=${_systemMode} unavail=${res._unavailable} rawLen=${res.markers && res.markers.__CC_SOQL__ != null ? res.markers.__CC_SOQL__.length : 'null'} qErr=${JSON.stringify(res.markers && res.markers.__CC_SOQLERR__)} soql=${soql.slice(0,60)}\n${process.env.CC_DEBUG === '2' ? 'CLI='+JSON.stringify(res.cli).slice(0,300)+'\n' : ''}`);
  if (res._unavailable) return { _apexUnavailable: true };
  const raw = res.markers.__CC_SOQL__;
  const qErr = res.markers.__CC_SOQLERR__;
  if (raw == null && !qErr) return { _apexUnavailable: true };
  if (qErr) return { records: [], error: qErr, soql };
  let recs = [];
  try { recs = JSON.parse(raw) || []; } catch { recs = []; }
  if (!Array.isArray(recs)) recs = recs ? [recs] : [];
  return { records: recs.map(cleanSObject), error: null, soql, mode: 'system' };
}
async function runSoqlViaRest(soql) {
  const { stdout, stderr } = await sf(['data', 'query', '--query', soql, '--json', ...orgFlag()]);
  const parsed = parseSfJson(stdout);
  const result = { records: [], error: null, soql, mode: 'user' };
  if (parsed && parsed.status === 0 && parsed.result) {
    result.records = (parsed.result.records || []).map(cleanSObject);
  } else {
    result.error = sfErrorText(parsed, stderr, stdout, 'Query failed');
  }
  return result;
}
async function runSoqlOnce(soql) {
  if (liveOrg()) {
    const viaApex = await runSoqlViaApex(soql);
    if (viaApex && !viaApex._apexUnavailable) return viaApex;
  }
  if (!liveOrg()) return { records: [], error: null, soql, mode: 'none' };
  return runSoqlViaRest(soql);
}
const _soqlCache = new Map();
async function execSoql(soql) {
  if (_soqlCache.has(soql)) return _soqlCache.get(soql);
  let result = await runSoqlOnce(soql);
  const compileErr = result.error && /not supported|INVALID_TYPE|INVALID_FIELD|No such column|did.?n.?t understand/i.test(result.error);
  const emptyResult = !result.error && (result.records || []).length === 0;
  if (compileErr || emptyResult) {
    const ns = await getPackageNamespace();
    const nsSoql = applyNamespaceToSoql(soql, ns);
    if (ns && nsSoql !== soql) {
      const r2 = await runSoqlOnce(nsSoql);
      const objErrRe = /sObject type '[^']*' is not supported|Invalid type\s*:/i;
      if (!r2.error && (r2.records || []).length > 0) result = { ...r2, soql: nsSoql };
      else if (compileErr && !r2.error) result = { ...r2, soql: nsSoql };
      else if (compileErr && r2.error) {
        // If the original failure was an unknown-object error but the namespaced object
        // now resolves (its error only concerns columns/fields), carry the namespaced
        // query forward so the drop-invisible-column retry strips the namespaced field
        // names that actually appear in the query.
        if (objErrRe.test(result.error) && !objErrRe.test(r2.error)) {
          result = { ...r2, soql: nsSoql };
        } else {
          result = { ...result, error: `${result.error} (also tried ${ns} namespace: ${r2.error})` };
        }
      }
    }
  }
  const dropped = [];
  let colQ = result.soql || soql;
  for (let n = 0; n < 6 && result.error; n++) {
    const m = result.error.match(/No such column '([\w.]+)' on entity '[\w.]+'/i)
      || result.error.match(/Didn.?t understand relationship '([\w.]+)'/i)
      || result.error.match(/INVALID_FIELD[^']*'([\w.]+)'/i);
    if (!m) break;
    const stripped = stripColumnFromSoql(colQ, m[1]);
    if (!stripped) break;
    colQ = stripped; dropped.push(m[1]);
    result = { ...(await runSoqlOnce(colQ)), soql: colQ };
  }
  if (!result.error && dropped.length) result.droppedColumns = dropped;
  _soqlCache.set(soql, result);
  return result;
}

/* --------------------- anonymous Apex marker runner ----------------- */
async function runAnonApex(apexSource) {
  if (!liveOrg()) return { _unavailable: true, markers: {} };
  const tmp = path.join(os.tmpdir(), `.cc_harness_${Date.now()}_${Math.random().toString(36).slice(2)}.apex`);
  try {
    fs.writeFileSync(tmp, apexSource);
    const { stdout, stderr } = await sf(['apex', 'run', '--file', tmp, '--json', ...orgFlag()]);
    const cli = parseSfJson(stdout);
    if (!cli) return { _unavailable: true, markers: {}, cli, stderr, stdout };
    const res = (cli.result || cli.data) || {};
    const log = res.logs || '';
    if (cli.status && cli.status !== 0 && !log) return { _unavailable: true, markers: {}, cli, stderr, stdout };
    const markers = {};
    for (const line of log.split('\n')) {
      const pipe = line.split('|');
      const msg = pipe.length >= 5 ? pipe.slice(4).join('|') : '';
      const mm = msg.match(/^(__CC_[A-Z]+__)/);
      if (mm) markers[mm[1]] = (markers[mm[1]] || '') + msg.slice(mm[1].length);
    }
    return { _unavailable: false, markers, cli, res, log, stderr, stdout };
  } catch (e) {
    return { _unavailable: true, markers: {}, error: e };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

/* ----------------------------- evalOrg ------------------------------ */
function buildEvalApex(expr) {
  return [
    `Savepoint ccEvSp = Database.setSavepoint();`,
    `Object ccEvVal;`,
    `String ccEvErr = '';`,
    `try { ccEvVal = (Object)( ${expr} ); }`,
    `catch (Exception ccEvE) { ccEvErr = ccEvE.getTypeName() + ': ' + ccEvE.getMessage(); }`,
    `finally { try { Database.rollback(ccEvSp); } catch (Exception ccEvRe) {} }`,
    `String ccEvOut;`,
    `if (ccEvVal == null) { ccEvOut = 'null'; }`,
    `else { try { ccEvOut = JSON.serialize(ccEvVal); } catch (Exception ccEvSe) {`,
    `  try { ccEvOut = JSON.serialize(String.valueOf(ccEvVal)); } catch (Exception ccEvSe2) { ccEvOut = '"<unserializable>"'; } } }`,
    `System.debug(LoggingLevel.ERROR, '__CC_EVAL__' + ccEvOut);`,
    `System.debug(LoggingLevel.ERROR, '__CC_EVALERR__' + ccEvErr);`,
  ].join('\n');
}
function applyNamespaceToApex(expr, ns) {
  if (!ns) return expr;
  const m = expr.match(/^([A-Za-z_]\w*)\b/);
  if (!m) return expr;
  if (m[1].toLowerCase() === ns.toLowerCase()) return expr;
  return ns + '.' + expr;
}
async function runEvalApexOnce(expr) {
  const res = await runAnonApex(buildEvalApex(expr));
  if (res._unavailable) return { error: sfErrorText(res.cli, res.stderr, res.stdout, 'Org command failed') };
  const r = res.res || {};
  let compileProblem = r.compileProblem;
  if (!compileProblem && r.compiled === false) {
    const rawMsg = (res.cli && res.cli.message) || '';
    const afterErr = rawMsg.match(/with the error:\s*([\s\S]+)/i);
    compileProblem = afterErr ? afterErr[1].trim() : (rawMsg || null);
  }
  if (r.compiled === false || compileProblem) {
    return { error: `Compile failed: ${compileProblem || 'unknown'}`, compileFailed: true };
  }
  const evalErr = res.markers.__CC_EVALERR__;
  const raw = res.markers.__CC_EVAL__;
  if (evalErr) return { error: evalErr };
  if (raw != null) { let value; try { value = JSON.parse(raw); } catch { value = raw; } return { value }; }
  return { error: 'Org returned no debug output (is FINEST logging enabled for the running user?)' };
}
const _evalCache = new Map();
async function evalOrg(expr) {
  if (!liveOrg()) return { ok: false, error: 'no org' };
  if (_evalCache.has(expr)) return _evalCache.get(expr);
  let r = await runEvalApexOnce(expr);
  if (r.compileFailed) {
    const ns = await getPackageNamespace();
    const nsExpr = applyNamespaceToApex(expr, ns);
    if (ns && nsExpr !== expr) { const r2 = await runEvalApexOnce(nsExpr); if (!r2.error) r = r2; }
  }
  const out = r.error ? { ok: false, error: r.error } : { ok: true, value: r.value };
  _evalCache.set(expr, out);
  return out;
}

/* --------------------------- describeSObject ------------------------ */
async function runDescribeOnce(name) {
  const esc = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Collect REAL per-field metadata (name/label/type/precision/scale/…) from the
  // org's describe. Output is chunked across repeated markers because a single
  // large object's field JSON exceeds the per-line debug-log limit.
  const apex = [
    `List<Map<String,Object>> ccFields = new List<Map<String,Object>>();`,
    `String ccErr = '', ccLabel = '', ccPrefix = '', ccPlural = '';`,
    `Map<String,Object> ccObj = new Map<String,Object>();`,
    `try {`,
    `  Schema.DescribeSObjectResult ccD = Schema.describeSObjects(new String[]{'${esc}'})[0];`,
    `  for (Schema.SObjectField ccF : ccD.fields.getMap().values()) {`,
    `    Schema.DescribeFieldResult d = ccF.getDescribe();`,
    `    List<String> ccRef = new List<String>();`,
    `    if (d.getType() == Schema.DisplayType.REFERENCE) { for (Schema.SObjectType rt : d.getReferenceTo()) ccRef.add(String.valueOf(rt)); }`,
    `    List<Map<String,Object>> ccPick = new List<Map<String,Object>>();`,
    `    if (d.getType() == Schema.DisplayType.PICKLIST || d.getType() == Schema.DisplayType.MULTIPICKLIST) {`,
    `      for (Schema.PicklistEntry pe : d.getPicklistValues()) ccPick.add(new Map<String,Object>{'label'=>pe.getLabel(),'value'=>pe.getValue(),'active'=>pe.isActive(),'default'=>pe.isDefaultValue()}); }`,
    `    ccFields.add(new Map<String,Object>{`,
    `      'name'=>d.getName(),'label'=>d.getLabel(),'type'=>String.valueOf(d.getType()),`,
    `      'custom'=>d.isCustom(),'html'=>d.isHtmlFormatted(),'calc'=>d.isCalculated(),`,
    `      'precision'=>d.getPrecision(),'scale'=>d.getScale(),'length'=>d.getLength(),`,
    `      'nillable'=>d.isNillable(),'defaultValue'=>d.getDefaultValue(),'referenceTo'=>ccRef,`,
    `      'nameField'=>d.isNameField(),'unique'=>d.isUnique(),'externalId'=>d.isExternalID(),`,
    `      'updateable'=>d.isUpdateable(),'createable'=>d.isCreateable(),'sortable'=>d.isSortable(),`,
    `      'filterable'=>d.isFilterable(),'relationshipName'=>d.getRelationshipName(),'picklist'=>ccPick });`,
    `  }`,
    `  ccLabel = ccD.getLabel(); ccPlural = ccD.getLabelPlural();`,
    `  if (ccD.getKeyPrefix() != null) ccPrefix = ccD.getKeyPrefix();`,
    `  ccObj = new Map<String,Object>{'accessible'=>ccD.isAccessible(),'createable'=>ccD.isCreateable(),`,
    `    'updateable'=>ccD.isUpdateable(),'deletable'=>ccD.isDeletable(),'queryable'=>ccD.isQueryable(),`,
    `    'searchable'=>ccD.isSearchable(),'mergeable'=>ccD.isMergeable(),'custom'=>ccD.isCustom(),`,
    `    'customSetting'=>ccD.isCustomSetting(),'feedEnabled'=>ccD.isFeedEnabled(),'undeletable'=>ccD.isUndeletable()};`,
    `} catch (Exception ccE) { ccErr = ccE.getTypeName() + ': ' + ccE.getMessage(); }`,
    `String ccOut;`,
    `try { ccOut = JSON.serialize(new Map<String,Object>{'fields'=>ccFields,'label'=>ccLabel,'prefix'=>ccPrefix,'plural'=>ccPlural,'obj'=>ccObj}); } catch (Exception e) { ccOut = '{}'; }`,
    `Integer ccChunk = 3000;`,
    `for (Integer i = 0; i < ccOut.length(); i += ccChunk) { System.debug(LoggingLevel.ERROR, '__CC_DESC__' + ccOut.substring(i, Math.min(i + ccChunk, ccOut.length()))); }`,
    `System.debug(LoggingLevel.ERROR, '__CC_DESCERR__' + ccErr);`,
  ].join('\n');
  const res = await runAnonApex(apex);
  if (res._unavailable) return { error: 'CLI unavailable' };
  const dErr = res.markers.__CC_DESCERR__;
  const raw = res.markers.__CC_DESC__;
  if (dErr) return { error: dErr };
  if (raw == null) return { error: 'no describe marker (FINEST logs off?)' };
  let obj = {}; try { obj = JSON.parse(raw) || {}; } catch { obj = {}; }
  const fields = Array.isArray(obj.fields) ? obj.fields : [];
  const names = fields.map(f => f && f.name).filter(Boolean);
  return { fields, names, label: obj.label || name, prefix: obj.prefix || '', plural: obj.plural || name, obj: obj.obj || null, error: names.length ? null : 'no fields' };
}
const _descCache = new Map();
async function describeSObject(name) {
  if (!liveOrg()) return { error: 'no org' };
  const key = String(name).toLowerCase();
  if (_descCache.has(key)) return _descCache.get(key);
  let r = await runDescribeOnce(name);
  if ((!r || !r.names || !r.names.length) && String(name).split('__').length < 3) {
    const ns = await getPackageNamespace();
    if (ns) { const r2 = await runDescribeOnce(`${ns}__${name}`); if (r2 && r2.names && r2.names.length) r = r2; }
  }
  const out = (r && r.names) ? r : { names: [], fields: [], error: (r && r.error) || 'describe failed' };
  _descCache.set(key, out);
  return out;
}

/* --------------------------- userInfo ------------------------------- */
async function getOrgUserInfo() {
  if (!liveOrg()) return null;
  const { stdout } = await sf(['org', 'display', 'user', '--json', ...orgFlag()]);
  const parsed = parseSfJson(stdout);
  if (!parsed || parsed.status !== 0 || !parsed.result) return null;
  const r = parsed.result;
  return { id: r.id, name: r.username, username: r.username, orgId: r.orgId, profileId: r.profileId, alias: r.alias };
}

/* ----------------------- cross-class loading ------------------------ */
let _classIndex = null;
function buildClassIndex() {
  const index = new Map();
  const roots = [PROJECT_DIR, process.cwd()].filter(Boolean);
  const seenRoot = new Set();
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && /\.(cls|trigger)$/i.test(e.name)) {
        const key = e.name.replace(/\.(cls|trigger)$/i, '').toLowerCase();
        if (!index.has(key)) index.set(key, full);
      } else if (e.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  };
  for (const r of roots) { const rp = path.resolve(r); if (!seenRoot.has(rp)) { seenRoot.add(rp); walk(rp, 0); } }
  return index;
}
function findClassFile(className) {
  if (!_classIndex) { _classIndex = buildClassIndex(); tag('info', `indexed ${_classIndex.size} Apex classes from project`); }
  return _classIndex.get(className.split('.')[0].toLowerCase()) || null;
}
async function loadClassSource(className) {
  const file = findClassFile(className);
  if (!file) return null;
  try {
    const src = fs.readFileSync(file, 'utf8');
    if (src) tag('org', `loaded ${className} from ${path.basename(file)} (step-into available)`);
    return src ? { source: src, path: file } : null;
  } catch { return null; }
}

/* --------------------------- bind → SOQL ---------------------------- */
function toSoqlLiteral(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  // Engine collection (ApexSet/ApexMap) that slipped through un-normalized.
  if (val && typeof val.items === 'function') val = val.items();
  else if (val && typeof val.vals === 'function') val = val.vals();
  if (Array.isArray(val)) {
    // An empty IN-bind matches nothing in Apex; `IN ()` is invalid SOQL, so emit
    // `(null)` which is valid and returns 0 rows for id/reference filters.
    if (val.length === 0) return '(null)';
    return '(' + val.map(toSoqlLiteral).join(', ') + ')';
  }
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') {
    // Engine date tokens render as unquoted SOQL date/datetime literals.
    if (typeof val.iso === 'function') return val.iso();
    if (val.__sobjectType) return `'${String(val.__sobjectType).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (val.Id) return `'${String(val.Id).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function isCollectionBind(v) {
  return Array.isArray(v) || (v && (typeof v.items === 'function' || typeof v.vals === 'function'));
}
function buildSoql(raw, binds) {
  let q = String(raw || '').trim().replace(/^\[/, '').replace(/\]\s*;?$/, '').trim();
  const entries = Object.entries(binds || {}).sort((a, b) => b[0].length - a[0].length);
  for (const [expr, val] of entries) {
    const lit = toSoqlLiteral(val);
    if (lit == null) continue;
    const ex = escapeRegex(expr);
    // Apex binds a collection to `=` as IN and to `!=`/`<>` as NOT IN. Rewrite the
    // operator so the rendered literal SOQL matches Apex semantics (e.g. queryAssets'
    // `WHERE Id = :assetIdSet` where assetIdSet is a Set<Id>).
    if (isCollectionBind(val)) {
      q = q.replace(new RegExp('([=!<>]{1,2})\\s*:\\s*' + ex + '(?![\\w.])', 'g'), (m, op) => {
        if (op === '=') return 'IN ' + lit;
        if (op === '!=' || op === '<>') return 'NOT IN ' + lit;
        return op + ' ' + lit;
      });
    }
    q = q.replace(new RegExp(':\\s*' + ex + '(?![\\w.])', 'g'), lit);
  }
  return q;
}

/* ------------------------------ the host ---------------------------- */
let soqlCount = 0, evalCount = 0;
const host = {
  log: (msg, level) => tag(level || 'debug', level === 'debug' ? `USER_DEBUG: ${msg}` : msg),
  query: async (raw, binds) => {
    const soql = buildSoql(raw, binds);
    soqlCount++;
    tag('soql', `⏳ ${soql.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (!liveOrg()) { tag('soql', '(no org — returning 0 rows)'); return []; }
    const res = await execSoql(soql);
    if (res.error) { tag('soql', `error: ${res.error}`); throw new ApexError('System.QueryException', res.error, 0); }
    tag('soql', `✓ ${res.records.length} row(s)${res.mode === 'system' ? ' (system mode)' : res.mode === 'user' ? ' (user mode)' : ''}${res.droppedColumns ? ` [dropped: ${res.droppedColumns.join(', ')}]` : ''}`);
    return res.records;
  },
  dml: async (op, value) => {
    const n = Array.isArray(value) ? value.length : 1;
    tag('dml', `${String(op).toUpperCase()} simulated locally (${n} record(s)) — org is never modified`);
  },
  evalOrg: async (expr) => {
    evalCount++;
    tag('org', `⚙ resolving: ${expr}`);
    const r = await evalOrg(expr);
    if (r.ok) tag('org', `↳ ${expr} → ${typeof r.value === 'object' && r.value !== null ? JSON.stringify(r.value) : r.value} (real org value)`);
    else tag('org', `resolve failed: ${r.error}`);
    return r;
  },
  describeSObject: async (name) => {
    tag('org', `⚙ describing ${name}…`);
    const r = await describeSObject(name);
    if (r.names && r.names.length) tag('org', `↳ ${name}: ${r.names.length} fields from org`);
    else tag('org', `describe ${name}: ${r.error || 'no fields'}`);
    return r;
  },
  loadClassSource,
  getBreakpoint: () => null,
  onExecLine: () => {},
  onPause: () => {},
  onDone: () => {},
  onError: () => {},
  userInfo: null,
};

/* ------------------------------- run -------------------------------- */
const PROJECT_DIR = ARGS.project || (ARGS.file ? path.dirname(path.resolve(ARGS.file)) : process.cwd());

function readSource() {
  if (ARGS.stdin) return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(ARGS.file, 'utf8');
}
function deriveClassName(source) {
  if (ARGS.className) return ARGS.className;
  if (ARGS.file) return path.basename(ARGS.file).replace(/\.(cls|trigger)$/i, '');
  const m = source.match(/\b(?:public|global|private)?\s*(?:with|without|inherited)?\s*sharing?\s*class\s+(\w+)/i)
    || source.match(/\bclass\s+(\w+)/i);
  return m ? m[1] : 'Anonymous';
}

async function main() {
  await resolveDefaultOrg();
  out('='.repeat(70));
  out(`Apex Debug Studio Apex harness — ${new Date().toISOString()}`);
  out(`org:      ${liveOrg() ? TARGET_ORG : '(none / --no-org)'}`);
  out(`log:      ${LOG_FILE}`);

  const source = readSource();
  const fileName = ARGS.file ? path.resolve(ARGS.file) : `${deriveClassName(source)}.cls`;
  const className = deriveClassName(source);

  if (liveOrg()) { try { await ensureHelperClass(); } catch (e) { tag('org', `system-mode SOQL: setup error (${e && e.message || e})`); } }

  let engine;
  try {
    engine = new Engine.ApexEngine(host);
    engine.pauseOnCaught = false;
    engine.loadSource(fileName, source);
  } catch (e) {
    out(`=== PARSE ERROR === ${e && e.message || e}`);
    process.exit(2);
  }

  const cls = engine.registry.get(className);
  if (!cls) { out(`=== HARNESS ERROR === class '${className}' not found after parse (use --class)`); process.exit(2); }

  let method = ARGS.method;
  if (!method) {
    const names = (cls.methods || []).map(m => m.name).filter(Boolean);
    method = names[0];
    if (!method) { out(`=== HARNESS ERROR === no methods found in ${className}`); process.exit(2); }
    tag('info', `no --method given; using first method: ${method}`);
  }
  const methods = cls.findMethods(method);
  if (!methods || !methods.length) { out(`=== HARNESS ERROR === method '${method}' not found in ${className}`); process.exit(2); }

  let args = [];
  if (ARGS.argsFile) { try { args = JSON.parse(fs.readFileSync(ARGS.argsFile, 'utf8')); } catch (e) { out(`=== HARNESS ERROR === --args-file is not valid JSON: ${e.message}`); process.exit(2); } }
  else if (ARGS.args) { try { args = JSON.parse(ARGS.args); } catch (e) { out(`=== HARNESS ERROR === --args is not valid JSON: ${e.message}`); process.exit(2); } }
  else args = (methods[0].params || []).map(() => null);

  out(`entry:    ${className}.${method}(${args.map(a => JSON.stringify(a)).join(', ')})`);
  out('='.repeat(70));

  if (liveOrg()) { try { host.userInfo = await getOrgUserInfo(); if (host.userInfo) tag('org', `running user: ${host.userInfo.username} (${host.userInfo.id})`); } catch (_) {} }

  engine.mode = 'continue';
  const started = Date.now();
  try {
    const result = await engine.run(className, method, args);
    const ms = Date.now() - started;
    out('='.repeat(70));
    if (host.__error) { reportError(host.__error, ms); process.exit(1); }
    let shown;
    try { shown = Engine.toApexString(result); } catch { shown = String(result); }
    out(`=== DONE === (${ms} ms, ${soqlCount} SOQL, ${evalCount} org-eval)`);
    out(`returned: ${result === undefined ? '(void)' : shown}`);
    process.exit(0);
  } catch (e) {
    const ms = Date.now() - started;
    out('='.repeat(70));
    reportError(e, ms);
    process.exit(1);
  }
}

function reportError(err, ms) {
  const type = err && err.apexType ? err.apexType : (err && err.name) || 'Error';
  const msg = err && (err.apexMessage != null ? err.apexMessage : err.message) || String(err);
  out(`=== ERROR === (${ms} ms, ${soqlCount} SOQL, ${evalCount} org-eval)`);
  out(`${type}: ${msg}`);
  if (err && err.apexLine) out(`  at line ${err.apexLine}`);
  if (err && Array.isArray(err.apexStack) && err.apexStack.length) {
    for (const f of err.apexStack) out(`    at ${f.className}.${f.methodName} (line ${f.line})`);
  } else if (err && err.stack && !err.apexType) {
    out(err.stack.split('\n').slice(0, 6).map(l => '  ' + l).join('\n'));
  }
}

// The engine reports uncaught Apex via host.onError; capture it so run() resolution
// still surfaces a non-zero exit.
host.onError = (err) => { host.__error = err; };
host.onDone = () => {};

main().catch(e => { out(`=== HARNESS ERROR === ${e && e.stack || e}`); process.exit(2); });

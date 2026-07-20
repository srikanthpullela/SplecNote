/*
 * apexengine.js — V8-style async tree-walking interpreter for Apex.
 *
 * Executes the AST produced by apexlang.js with a real call stack, scope
 * chain, and a stepping "gate" before every statement (like V8's debugger
 * pause points). Backend work (SOQL / DML / org eval) is delegated to an
 * async host bridge, so execution naturally pauses while real org data is
 * fetched on demand.
 *
 * Host bridge (all optional, all may be async):
 *   host.query(soqlText, binds)      -> Array<record>   (real SOQL against org)
 *   host.dml(op, value, extra)       -> result           (insert/update/...)
 *   host.log(msg, level)             -> void             (System.debug sink)
 *   host.loadClassSource(className)  -> source | null    (lazy cross-class load)
 *   host.getBreakpoint(file, line)   -> null | { condition: string|null }
 *   host.onPause(info)               -> void             (debugger paused; info = {line, file, reason, stack})
 *   host.onDone(result)              -> void
 *   host.onError(err)                -> void
 *   host.userInfo                    -> { id, name, username } (optional)
 *
 * Works in the Electron renderer (window.ApexEngine) and in Node for tests.
 */
(function () {
  'use strict';

  const Lang = (typeof globalThis !== 'undefined' && globalThis.ApexLang)
    ? globalThis.ApexLang
    : require('./apexlang.js');

  /* ================= control-flow signals ================= */
  class StopSignal { constructor() { this.__stop = true; } }
  class BreakSignal { }
  class ContinueSignal { }
  class ReturnSignal { constructor(value) { this.value = value; } }

  /* ================= Apex exception value ================= */
  class ApexError extends Error {
    constructor(typeName, message, line) {
      super(message || '');
      this.apexType = typeName || 'Exception';
      this.apexMessage = message == null ? '' : String(message);
      this.apexLine = line || null;
      this.apexStack = [];
      this.cause = null;
    }
    getTypeName() { return this.apexType; }
    getMessage() { return this.apexMessage; }
    getLineNumber() { return this.apexLine; }
    getStackTraceString() {
      return this.apexStack.map(f => `Class.${f.className}.${f.methodName}: line ${f.line}`).join('\n');
    }
    toString() { return `${this.apexType}: ${this.apexMessage}`; }
  }
  function npe(line, msg) { return new ApexError('System.NullPointerException', msg || 'Attempt to de-reference a null object', line); }

  /* ================= user-defined enum constants =================
   * Apex enum constants are first-class values exposing name()/ordinal(); a bare
   * string cannot carry the ordinal or the owning enum identity, so we box them.
   * Every value choke point below (keyOf, apexEquals, toApexString, jsonify,
   * instance dispatch) unwraps to the canonical constant name, so a boxed enum
   * still compares, hashes, serialises and concatenates exactly like its name —
   * preserving switch/==/Map-key/SOQL-bind behaviour — while name()/ordinal()
   * now return real values. Builtin enums (JSONToken, DisplayType…) stay strings. */
  class ApexEnumValue {
    constructor(enumClass, enumName, enumOrdinal) {
      this.enumClass = enumClass;     // owning enum's class name
      this.enumName = enumName;       // canonical constant name (declared case)
      this.enumOrdinal = enumOrdinal; // 0-based declaration position
    }
    toString() { return this.enumName; }
  }
  // Box a user enum constant by name. Returns null when the name isn't a member
  // so casts/valueOf degrade honestly instead of inventing a constant.
  function makeEnumValue(ci, rawName) {
    const vals = (ci && ci.ast && ci.ast.enumValues) || [];
    const idx = vals.findIndex(v => v.toLowerCase() === String(rawName).toLowerCase());
    if (idx < 0) return null;
    return new ApexEnumValue(ci.name, vals[idx], idx);
  }
  function enumValuesOf(ci) {
    const vals = (ci && ci.ast && ci.ast.enumValues) || [];
    return vals.map((v, i) => new ApexEnumValue(ci.name, v, i));
  }

  /* ================= identity for hashing keys ================= */
  let __idCounter = 1;
  const __idMap = new WeakMap();
  function identityId(o) {
    if (!__idMap.has(o)) __idMap.set(o, __idCounter++);
    return __idMap.get(o);
  }
  function keyOf(v) {
    if (v === null || v === undefined) return '\u0000null';
    const t = typeof v;
    if (t === 'string') return 's:' + v;
    if (t === 'number') return 'n:' + v;
    if (t === 'boolean') return 'b:' + v;
    if (v instanceof ApexEnumValue) return 'en:' + v.enumClass + ':' + v.enumName;
    if (v instanceof ApexDate) return 'd:' + v.iso();
    if (v instanceof ApexDatetime) return 'dt:' + v.d.getTime();
    return 'o:' + identityId(v);
  }

  /* ================= collections ================= */
  class ApexMap {
    constructor() { this.m = new Map(); }
    static from(entries) { const mm = new ApexMap(); for (const [k, v] of entries) mm.put(k, v); return mm; }
    put(k, v) { this.m.set(keyOf(k), { k, v }); return null; }
    get(k) { const e = this.m.get(keyOf(k)); return e ? e.v : null; }
    containsKey(k) { return this.m.has(keyOf(k)); }
    remove(k) { const e = this.m.get(keyOf(k)); this.m.delete(keyOf(k)); return e ? e.v : null; }
    keys() { return Array.from(this.m.values()).map(e => e.k); }
    vals() { return Array.from(this.m.values()).map(e => e.v); }
    size() { return this.m.size; }
    clone() { const c = new ApexMap(); for (const e of this.m.values()) c.put(e.k, e.v); return c; }
    clear() { this.m.clear(); }
  }
  class ApexSet {
    constructor() { this.m = new Map(); }
    static from(items) { const s = new ApexSet(); for (const it of items || []) s.add(it); return s; }
    add(v) { const had = this.m.has(keyOf(v)); this.m.set(keyOf(v), v); return !had; }
    has(v) { return this.m.has(keyOf(v)); }
    remove(v) { const had = this.m.has(keyOf(v)); this.m.delete(keyOf(v)); return had; }
    items() { return Array.from(this.m.values()); }
    size() { return this.m.size; }
    clone() { return ApexSet.from(this.items()); }
    clear() { this.m.clear(); }
  }

  /* ================= JSON streaming (System.JSONGenerator / System.JSONParser) =================
   * Faithful models of Apex's pull-generator and pull-parser. The generator builds an
   * ordered value tree and serialises it exactly like JSON.serialize (so getAsString()
   * equals JSON.serialize of the same shape). The parser tokenises the raw string into a
   * flat stream, preserving key order and the int-vs-float distinction Apex exposes via
   * VALUE_NUMBER_INT / VALUE_NUMBER_FLOAT. Neither fabricates data — they only reshape
   * values the caller already holds. */
  class ApexJsonGenerator {
    constructor(pretty) {
      this.pretty = !!pretty;
      this.root = undefined;      // top-level value once written
      this.stack = [];            // open containers ({} or []) innermost last
      this.pendingField = null;   // field name awaiting its value in object context
    }
    _place(value) {
      if (this.stack.length === 0) { this.root = value; return; }
      const top = this.stack[this.stack.length - 1];
      if (Array.isArray(top)) { top.push(value); return; }
      if (this.pendingField !== null) { top[this.pendingField] = value; this.pendingField = null; }
      // A value in object context without a field name is invalid Apex (JSONException);
      // a debugger stays lenient and drops it rather than aborting the step.
    }
    _open(container) { this._place(container); this.stack.push(container); }
    getAsString() {
      const v = this.root === undefined ? null : this.root;
      return JSON.stringify(v, null, this.pretty ? 2 : 0);
    }
  }

  // Tokenise a JSON string into a flat stream. Field names are distinguished from string
  // values by structural context; integers and floats are tagged separately to mirror
  // Apex's JSONToken.VALUE_NUMBER_INT vs VALUE_NUMBER_FLOAT.
  function tokenizeJson(src) {
    const s = String(src == null ? '' : src);
    const n = s.length;
    const out = [];
    const ctx = [];               // 'obj' | 'arr'
    let expectField = false;
    let i = 0;
    const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    function readString() {
      let j = i + 1, str = '';
      while (j < n) {
        const c = s[j];
        if (c === '\\') {
          const e = s[j + 1];
          if (e === 'n') str += '\n';
          else if (e === 't') str += '\t';
          else if (e === 'r') str += '\r';
          else if (e === 'b') str += '\b';
          else if (e === 'f') str += '\f';
          else if (e === 'u') { str += String.fromCharCode(parseInt(s.substr(j + 2, 4), 16)); j += 4; }
          else str += e;               // \" \\ \/ and any other escaped char
          j += 2;
        } else if (c === '"') { j++; break; }
        else { str += c; j++; }
      }
      i = j;
      return str;
    }
    while (i < n) {
      const c = s[i];
      if (isWs(c)) { i++; continue; }
      if (c === '{') { out.push({ token: 'START_OBJECT', text: '{' }); ctx.push('obj'); expectField = true; i++; continue; }
      if (c === '}') { out.push({ token: 'END_OBJECT', text: '}' }); ctx.pop(); expectField = false; i++; continue; }
      if (c === '[') { out.push({ token: 'START_ARRAY', text: '[' }); ctx.push('arr'); expectField = false; i++; continue; }
      if (c === ']') { out.push({ token: 'END_ARRAY', text: ']' }); ctx.pop(); expectField = false; i++; continue; }
      if (c === ',') { expectField = ctx[ctx.length - 1] === 'obj'; i++; continue; }
      if (c === ':') { expectField = false; i++; continue; }
      if (c === '"') {
        const str = readString();
        if (expectField && ctx[ctx.length - 1] === 'obj') { out.push({ token: 'FIELD_NAME', text: str }); expectField = false; }
        else out.push({ token: 'VALUE_STRING', text: str, value: str });
        continue;
      }
      if (s.startsWith('true', i)) { out.push({ token: 'VALUE_TRUE', text: 'true', value: true }); i += 4; continue; }
      if (s.startsWith('false', i)) { out.push({ token: 'VALUE_FALSE', text: 'false', value: false }); i += 5; continue; }
      if (s.startsWith('null', i)) { out.push({ token: 'VALUE_NULL', text: 'null', value: null }); i += 4; continue; }
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
      if (m) {
        const raw = m[0];
        const isFloat = /[.eE]/.test(raw);
        out.push({ token: isFloat ? 'VALUE_NUMBER_FLOAT' : 'VALUE_NUMBER_INT', text: raw, value: Number(raw) });
        i += raw.length;
        continue;
      }
      i++;                          // skip anything unexpected
    }
    return out;
  }

  // Index of the END token that closes the container the parser is currently positioned on
  // (or the same index when the current token is a scalar / has no children).
  function jsonSkipChildren(tokens, idx) {
    const t = tokens[idx];
    if (!t || (t.token !== 'START_OBJECT' && t.token !== 'START_ARRAY')) return idx;
    let depth = 0;
    for (let k = idx; k < tokens.length; k++) {
      const tk = tokens[k].token;
      if (tk === 'START_OBJECT' || tk === 'START_ARRAY') depth++;
      else if (tk === 'END_OBJECT' || tk === 'END_ARRAY') { depth--; if (depth === 0) return k; }
    }
    return tokens.length - 1;
  }

  class ApexJsonParser {
    constructor(jsonString) {
      this.tokens = tokenizeJson(jsonString);
      this.idx = -1;                // positioned before the first token, like a fresh Apex parser
      this.lastCleared = null;
    }
    cur() { return (this.idx >= 0 && this.idx < this.tokens.length) ? this.tokens[this.idx] : null; }
  }

  /* ================= dates ================= */
  class ApexDate {
    constructor(y, m, d) { this.y = y; this.mo = m; this.day = d; }
    static today() { const n = new Date(); return new ApexDate(n.getFullYear(), n.getMonth() + 1, n.getDate()); }
    static fromJs(d) { return new ApexDate(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
    js() { return new Date(this.y, this.mo - 1, this.day); }
    iso() { const p = n => String(n).padStart(2, '0'); return `${this.y}-${p(this.mo)}-${p(this.day)}`; }
    addDays(n) { const d = this.js(); d.setDate(d.getDate() + n); return ApexDate.fromJs(d); }
    addMonths(n) { const d = this.js(); d.setMonth(d.getMonth() + n); return ApexDate.fromJs(d); }
    addYears(n) { const d = this.js(); d.setFullYear(d.getFullYear() + n); return ApexDate.fromJs(d); }
    daysBetween(o) { return Math.round((o.js() - this.js()) / 86400000); }
    toString() { return this.iso(); }
  }
  class ApexDatetime {
    constructor(d) { this.d = d instanceof Date ? d : new Date(d); }
    static now() { return new ApexDatetime(new Date()); }
    addDays(n) { return new ApexDatetime(new Date(this.d.getTime() + n * 86400000)); }
    addHours(n) { return new ApexDatetime(new Date(this.d.getTime() + n * 3600000)); }
    addMinutes(n) { return new ApexDatetime(new Date(this.d.getTime() + n * 60000)); }
    addSeconds(n) { return new ApexDatetime(new Date(this.d.getTime() + n * 1000)); }
    dateOnly() { return ApexDate.fromJs(this.d); }
    getTime() { return this.d.getTime(); }
    format(fmt) { return fmt ? this.d.toLocaleString() : this.d.toLocaleString(); }
    toString() {
      const p = n => String(n).padStart(2, '0');
      const d = this.d;
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  }
  // Apex `Time` — a wall-clock time of day with no date/timezone. Modelled as h/m/s/ms
  // so Datetime.newInstance(Date, Time) / newInstanceGmt(Date, Time) can combine them.
  class ApexTime {
    constructor(h, m, s, ms) { this.h = h | 0; this.mi = m | 0; this.s = s | 0; this.ms = ms | 0; }
    _ms() { return ((this.h * 60 + this.mi) * 60 + this.s) * 1000 + this.ms; }
    static _fromMs(t) { t = ((t % 86400000) + 86400000) % 86400000; const ms = t % 1000; t = (t - ms) / 1000; const s = t % 60; t = (t - s) / 60; const mi = t % 60; const h = (t - mi) / 60; return new ApexTime(h, mi, s, ms); }
    addHours(n) { return ApexTime._fromMs(this._ms() + n * 3600000); }
    addMinutes(n) { return ApexTime._fromMs(this._ms() + n * 60000); }
    addSeconds(n) { return ApexTime._fromMs(this._ms() + n * 1000); }
    addMilliseconds(n) { return ApexTime._fromMs(this._ms() + n); }
    toString() { const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(this.h)}:${p(this.mi)}:${p(this.s)}.${p(this.ms, 3)}Z`; }
  }
  // Apex `Blob` — opaque binary. CPQ builds them from strings for REST response bodies
  // (Blob.valueOf(jsonStr)) and reads size()/toString(). Modelled over the UTF-8 string.
  class ApexBlob {
    constructor(s) { this.s = s == null ? '' : String(s); }
    size() { return (typeof Buffer !== 'undefined') ? Buffer.byteLength(this.s, 'utf8') : new TextEncoder().encode(this.s).length; }
    toString() { return this.s; }
  }
  // base64 / hex that work in both Node (tests) and the Electron renderer (Buffer present
  // via node integration; btoa/atob fallback otherwise). UTF-8 safe.
  function b64encode(str) { return (typeof Buffer !== 'undefined') ? Buffer.from(String(str), 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(String(str)))); }
  function b64decode(b64) { return (typeof Buffer !== 'undefined') ? Buffer.from(String(b64), 'base64').toString('utf8') : decodeURIComponent(escape(atob(String(b64)))); }
  function hexencode(str) { if (typeof Buffer !== 'undefined') return Buffer.from(String(str), 'utf8').toString('hex'); return Array.from(new TextEncoder().encode(String(str))).map(b => b.toString(16).padStart(2, '0')).join(''); }
  function hexdecode(hex) { if (typeof Buffer !== 'undefined') return Buffer.from(String(hex), 'hex').toString('utf8'); const bytes = String(hex).match(/.{1,2}/g) || []; return new TextDecoder().decode(new Uint8Array(bytes.map(h => parseInt(h, 16)))); }

  /* ================= watch / data-flow field observer =================
     A single module-level hook so the ONE active engine can observe field
     reads/writes on objects the UI has explicitly marked for tracking
     (obj.__tracked === true, obj.__watchId a stable id). Untracked objects pay
     only a cheap boolean property read on each access, so normal execution is
     unaffected. Installed at run() start, cleared on stop(). The observer body
     lives on the engine (_onFieldAccess) so it has full step/method context and
     can ignore inspection reads (see there). */
  let _fieldObserver = null;

  /* ================= user-class instance ================= */
  class ApexObject {
    constructor(classInfo) {
      this.classInfo = classInfo;           // ClassInfo
      this.fields = new Map();              // lower-name -> { name, value }
    }
    getField(name) {
      const e = this.fields.get(name.toLowerCase());
      const v = e ? e.value : undefined;
      if (this.__tracked && _fieldObserver) { try { _fieldObserver('read', this, name, v, v); } catch (_) {} }
      return v;
    }
    hasField(name) { return this.fields.has(name.toLowerCase()); }
    setField(name, value) {
      const lk = name.toLowerCase();
      const e = this.fields.get(lk);
      const old = e ? e.value : undefined;
      if (e) e.value = value; else this.fields.set(lk, { name, value });
      if (this.__tracked && _fieldObserver) { try { _fieldObserver('write', this, name, old, value); } catch (_) {} }
    }
  }

  /* ================= DOM (XML) support ================= */
  function decodeXmlEntities(str) {
    return String(str)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, '&');
  }
  function encodeXmlEntities(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Lightweight, dependency-free recursive-descent XML parser. Returns the root
  // ApexXmlnode (ELEMENT) or null. Handles elements, attributes, text, CDATA,
  // comments, processing instructions, self-closing tags and simple namespaces.
  function parseXml(input) {
    if (input == null) return null;
    const s = String(input);
    const n = s.length;
    let i = 0;
    const skipSpace = () => { while (i < n && /\s/.test(s[i])) i++; };
    const parseName = () => { const start = i; while (i < n && !/[\s\/>=?]/.test(s[i])) i++; return s.slice(start, i); };
    function parseAttributes() {
      const attrs = [];
      for (;;) {
        skipSpace();
        if (i >= n) break;
        const c = s[i];
        if (c === '>' || c === '/' || c === '?') break;
        const name = parseName();
        if (!name) { i++; continue; }
        skipSpace();
        let value = '';
        if (s[i] === '=') {
          i++; skipSpace();
          const q = s[i];
          if (q === '"' || q === "'") {
            i++; const vs = i;
            while (i < n && s[i] !== q) i++;
            value = s.slice(vs, i); i++;
          }
        }
        attrs.push({ name, value: decodeXmlEntities(value) });
      }
      return attrs;
    }
    function makeNode(rawName, attrs) {
      const idx = rawName.indexOf(':');
      const prefix = idx >= 0 ? rawName.slice(0, idx) : null;
      const local = idx >= 0 ? rawName.slice(idx + 1) : rawName;
      let namespace = null;
      for (const a of attrs) {
        if (a.name === 'xmlns' && !prefix) namespace = a.value;
        else if (prefix && a.name === 'xmlns:' + prefix) namespace = a.value;
      }
      return new ApexXmlnode({
        nodeType: 'ELEMENT', name: local, prefix, namespace,
        attributes: attrs.filter(a => a.name !== 'xmlns' && a.name.indexOf('xmlns:') !== 0),
        children: [], text: '',
      });
    }
    function parseElement() {
      i++; // consume '<'
      const rawName = parseName();
      const attrs = parseAttributes();
      skipSpace();
      const node = makeNode(rawName, attrs);
      if (s[i] === '/') { i++; if (s[i] === '>') i++; return node; }
      if (s[i] === '>') i++;
      for (;;) {
        if (i >= n) break;
        if (s[i] === '<') {
          if (s[i + 1] === '/') { i += 2; parseName(); skipSpace(); if (s[i] === '>') i++; break; }
          if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i); i = e < 0 ? n : e + 3; continue; }
          if (s.startsWith('<![CDATA[', i)) {
            const e = s.indexOf(']]>', i + 9); const txt = s.slice(i + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3;
            node.text += txt; node.children.push(new ApexXmlnode({ nodeType: 'CDATA', text: txt })); continue;
          }
          if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i); i = e < 0 ? n : e + 2; continue; }
          const child = parseElement();
          if (child) { child.parent = node; node.children.push(child); }
          continue;
        }
        const ts = i; while (i < n && s[i] !== '<') i++;
        const decoded = decodeXmlEntities(s.slice(ts, i));
        if (decoded.trim().length) { node.text += decoded; node.children.push(new ApexXmlnode({ nodeType: 'TEXT', text: decoded })); }
      }
      return node;
    }
    for (;;) {
      skipSpace();
      if (i >= n) return null;
      if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i); i = e < 0 ? n : e + 2; continue; }
      if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i); i = e < 0 ? n : e + 3; continue; }
      if (s.startsWith('<!', i)) { const e = s.indexOf('>', i); i = e < 0 ? n : e + 1; continue; }
      if (s[i] === '<') return parseElement();
      i++;
    }
  }
  function serializeXml(node) {
    if (!node) return '';
    if (node.nodeType === 'TEXT') return encodeXmlEntities(node.text);
    if (node.nodeType === 'CDATA') return '<![CDATA[' + node.text + ']]>';
    const tag = node.prefix ? node.prefix + ':' + node.name : node.name;
    let attrs = '';
    if (node.namespace) attrs += node.prefix ? ` xmlns:${node.prefix}="${encodeXmlEntities(node.namespace)}"` : ` xmlns="${encodeXmlEntities(node.namespace)}"`;
    for (const a of node.attributes || []) attrs += ` ${a.name}="${encodeXmlEntities(a.value)}"`;
    const kids = (node.children || []);
    if (!kids.length && !node.text) return `<${tag}${attrs}/>`;
    const inner = kids.length ? kids.map(serializeXml).join('') : encodeXmlEntities(node.text || '');
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
  class ApexXmlnode {
    constructor(o) {
      this.nodeType = 'ELEMENT'; this.name = ''; this.prefix = null; this.namespace = null;
      this.attributes = []; this.children = []; this.text = ''; this.parent = null;
      Object.assign(this, o);
    }
    elementChildren() { return this.children.filter(c => c.nodeType === 'ELEMENT'); }
    findAttr(name, ns) {
      const lk = String(name).toLowerCase();
      return this.attributes.find(a => a.name.toLowerCase() === lk) || null;
    }
  }
  class ApexDomDocument {
    constructor() { this.root = null; }
  }

  /* ================= SObject helpers ================= */
  function isSObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      && !(v instanceof ApexMap) && !(v instanceof ApexSet) && !(v instanceof ApexObject)
      && !(v instanceof ApexDate) && !(v instanceof ApexDatetime) && !(v instanceof ApexError)
      && !(v instanceof ApexXmlnode) && !(v instanceof ApexDomDocument);
  }
  function sobjGet(rec, field) {
    if (rec == null) return undefined;
    if (field in rec) return rec[field];
    const lk = field.toLowerCase();
    for (const k of Object.keys(rec)) if (k.toLowerCase() === lk) return rec[k];
    // Namespace-tolerant: source uses bare `Field__c` but the org returns
    // `Namespace__Field__c` (and vice versa). Match on the unqualified suffix.
    const bare = stripNs(lk);
    for (const k of Object.keys(rec)) {
      if (k === 'attributes') continue;
      if (stripNs(k.toLowerCase()) === bare) return rec[k];
    }
    return undefined;
  }
  function stripNs(name) {
    // Split on the managed-package separator "__". A namespaced custom field looks
    // like ns__Field__c (3+ segments); a bare custom field is Field__c (2 segments);
    // a standard field is Id/Name (1 segment). Only strip a leading namespace when
    // there are 3+ segments, keeping the true field name + suffix intact.
    const parts = name.split('__');
    if (parts.length >= 3) return parts.slice(1).join('__');
    return name;
  }
  function sobjSet(rec, field, value) {
    const lk = field.toLowerCase();
    for (const k of Object.keys(rec)) if (k.toLowerCase() === lk) { rec[k] = value; return; }
    const bare = stripNs(lk);
    for (const k of Object.keys(rec)) {
      if (k === 'attributes') continue;
      if (stripNs(k.toLowerCase()) === bare) { rec[k] = value; return; }
    }
    rec[field] = value;
  }
  function sobjType(rec) {
    return (rec && rec.attributes && rec.attributes.type) ? rec.attributes.type : 'SObject';
  }
  // Apex primitive/value parameter types. An SObject value can never legally bind
  // to one of these, so overload scoring must reject such pairings outright.
  const PRIMITIVE_PARAM_TYPES = new Set([
    'id', 'string', 'integer', 'long', 'double', 'decimal',
    'boolean', 'date', 'datetime', 'time', 'blob'
  ]);

  /* ================= environment (scope chain) ================= */
  class Environment {
    constructor(parent, label) {
      this.parent = parent || null;
      this.label = label || 'block';
      this.vars = new Map();                // lower-name -> { name, value, type }
    }
    define(name, value, type) { this.vars.set(name.toLowerCase(), { name, value, type: type || null }); }
    lookupEntry(name) {
      const lk = name.toLowerCase();
      let e = this;
      while (e) { if (e.vars.has(lk)) return e.vars.get(lk); e = e.parent; }
      return null;
    }
    has(name) { return this.lookupEntry(name) !== null; }
    get(name) { const en = this.lookupEntry(name); return en ? en.value : undefined; }
    set(name, value) {
      const en = this.lookupEntry(name);
      if (en) { en.value = value; return true; }
      return false;
    }
  }

  /* ================= value formatting / semantics helpers ================= */
  function typeNameOf(v) {
    if (v === null || v === undefined) return 'null';
    const t = typeof v;
    if (t === 'boolean') return 'Boolean';
    if (t === 'number') return Number.isInteger(v) ? 'Integer' : 'Decimal';
    if (t === 'string') return 'String';
    if (Array.isArray(v)) return 'List';
    if (v instanceof ApexMap) return 'Map';
    if (v instanceof ApexSet) return 'Set';
    if (v instanceof ApexDate) return 'Date';
    if (v instanceof ApexDatetime) return 'Datetime';
    if (v instanceof ApexError) return v.apexType;
    if (v instanceof ApexDomDocument) return 'DOM.Document';
    if (v instanceof ApexXmlnode) return 'DOM.XmlNode';
    if (v instanceof ApexObject) return v.classInfo.name;
    if (isSObject(v)) return sobjType(v);
    return 'Object';
  }
  function toApexString(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return '(' + v.map(toApexString).join(', ') + ')';
    if (v instanceof ApexMap) return '{' + Array.from(v.m.values()).map(e => toApexString(e.k) + '=' + toApexString(e.v)).join(', ') + '}';
    if (v instanceof ApexSet) return '{' + v.items().map(toApexString).join(', ') + '}';
    if (v instanceof ApexDate || v instanceof ApexDatetime) return v.toString();
    if (v instanceof ApexTime) return v.toString();
    if (v instanceof ApexBlob) return v.s;
    if (v instanceof ApexEnumValue) return v.enumName;
    if (v instanceof ApexError) return v.toString();
    if (v instanceof ApexObject) {
      const parts = [];
      for (const e of v.fields.values()) parts.push(`${e.name}=${toApexString(e.value)}`);
      return `${v.classInfo.name}:[${parts.join(', ')}]`;
    }
    if (isSObject(v)) {
      // A System.URL wrapper stringifies to its external form when known locally
      // (a literal URL); an org-context factory can't be resolved synchronously,
      // so it degrades to an empty string rather than a fabricated domain.
      if (v.__url) return v.__url.spec != null ? String(v.__url.spec) : '';
      // Schema describe-chain handles stringify to their API name (matches Apex,
      // e.g. `'' + ProductConfiguration__c.getSObjectType()` → 'ProductConfiguration__c').
      if (v.__sobjectType) return v.__sobjectType;
      if (v.__describeResult) return v.__describeResult;
      if (v.__fieldsHandle) return v.__fieldsHandle;
      if (v.__sobjectField) return v.__sobjectField.field;
      if (v.__describeFieldResult) return v.__describeFieldResult.field;
      if (v.__displayType) return v.__displayType;
      if (v.__typeToken) return v.__typeToken;
      if (v.__pattern) return v.__pattern.original;
      if (v.__matcher) return 'java.util.regex.Matcher';
      const parts = [];
      for (const k of Object.keys(v)) { if (k === 'attributes') continue; parts.push(`${k}=${toApexString(v[k])}`); }
      return `${sobjType(v)}:{${parts.join(', ')}}`;
    }
    return String(v);
  }
  function apexEquals(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    // Boxed user enum constant compares by canonical name (case-insensitive, like
    // Apex ==), also accepting the bare name string used in `switch when` labels.
    if (a instanceof ApexEnumValue || b instanceof ApexEnumValue) {
      const an = a instanceof ApexEnumValue ? a.enumName : (typeof a === 'string' ? a : null);
      const bn = b instanceof ApexEnumValue ? b.enumName : (typeof b === 'string' ? b : null);
      return an != null && bn != null && an.toLowerCase() === bn.toLowerCase();
    }
    // Apex '==' on Strings is case-insensitive
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
    if (a instanceof ApexDate && b instanceof ApexDate) return a.iso() === b.iso();
    if (a instanceof ApexDatetime && b instanceof ApexDatetime) return a.d.getTime() === b.d.getTime();
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!apexEquals(a[i], b[i])) return false;
      return true;
    }
    return a === b;
  }
  function compareVals(a, b, op, line) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    let av = a, bv = b;
    if (a instanceof ApexDate) av = a.js().getTime();
    if (b instanceof ApexDate) bv = b.js().getTime();
    if (a instanceof ApexDatetime) av = a.d.getTime();
    if (b instanceof ApexDatetime) bv = b.d.getTime();
    if (a instanceof ApexTime) av = a._ms();
    if (b instanceof ApexTime) bv = b._ms();
    switch (op) {
      case '<': return av < bv;
      case '<=': return av <= bv;
      case '>': return av > bv;
      case '>=': return av >= bv;
    }
    return false;
  }
  function jsonify(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(jsonify);
    if (v instanceof ApexMap) { const o = {}; for (const e of v.m.values()) o[toApexString(e.k)] = jsonify(e.v); return o; }
    if (v instanceof ApexSet) return v.items().map(jsonify);
    if (v instanceof ApexDate) return v.iso();
    if (v instanceof ApexDatetime) return v.d.toISOString();
    if (v instanceof ApexTime) return v.toString();
    if (v instanceof ApexBlob) return b64encode(v.s);
    if (v instanceof ApexEnumValue) return v.enumName;
    if (v instanceof ApexObject) { const o = {}; for (const e of v.fields.values()) o[e.name] = jsonify(e.value); return o; }
    if (isSObject(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = jsonify(v[k]); return o; }
    return String(v);
  }
  function unjsonify(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(unjsonify);
    const m = new ApexMap();
    for (const k of Object.keys(v)) m.put(k, unjsonify(v[k]));
    return m;
  }
  function fakeId(prefix) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = (prefix || '001') + '000000';
    while (s.length < 18) s += chars[Math.floor(Math.random() * chars.length)];
    return s.substring(0, 18);
  }

  /* ---------- java.util.regex ↔ JS RegExp (native, deterministic) ----------
   * Apex's Pattern/Matcher are backed by java.util.regex. For the constructs CPQ
   * uses (character classes, quantifiers, groups, anchors, case-insensitivity)
   * Java and JS regex are semantically equivalent, so we run them locally instead
   * of org-evaling (which would return a useless stringified Pattern object). */
  function javaRegexToJs(src) {
    let flags = '';
    let s = String(src == null ? '' : src);
    const original = s;
    // Leading inline flag group, e.g. (?i) / (?is) / (?im), maps to JS flags.
    const lead = s.match(/^\(\?([a-zA-Z]+)\)/);
    if (lead && /^[imsuxU]+$/.test(lead[1])) {
      for (const f of lead[1]) {
        if (f === 'i' && !flags.includes('i')) flags += 'i';
        else if (f === 's' && !flags.includes('s')) flags += 's';
        else if (f === 'm' && !flags.includes('m')) flags += 'm';
        else if (f === 'u' && !flags.includes('u')) flags += 'u';
        // x (comments) / U / d have no direct JS equivalent — ignored.
      }
      s = s.slice(lead[0].length);
    }
    return { original, source: s, flags };
  }
  function reGroupCount(source) {
    // Count capturing groups by forcing an empty-alternative match.
    try { return new RegExp(source + '|').exec('').length - 1; } catch (_) { return 0; }
  }
  function javaReplToJs(repl) {
    // Convert a java.util.regex replacement string to JS String.replace syntax.
    // Java: $0/$1.. group refs, ${name} named refs, \ escapes $ and \.
    // JS:   $&=whole match, $1.. groups, $<name> named, $$=literal $.
    const s = String(repl == null ? '' : repl);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        const nx = s[i + 1];
        if (nx === '$') { out += '$$'; i++; }
        else if (nx === '\\') { out += '\\'; i++; }
        else if (nx != null) { out += nx; i++; }
      } else if (c === '$') {
        const nx = s[i + 1];
        if (nx === '0') { out += '$&'; i++; }
        else if (nx === '{') {
          const close = s.indexOf('}', i + 2);
          if (close > 0) { out += '$<' + s.substring(i + 2, close) + '>'; i = close; }
          else { out += '$$'; }
        } else if (nx >= '1' && nx <= '9') { out += '$' + nx; i++; }
        else { out += '$$'; }
      } else {
        out += c;
      }
    }
    return out;
  }

  /* ================= class registry ================= */
  class ClassInfo {
    constructor(ast, fileName, outer) {
      this.ast = ast;
      this.name = ast.name;
      this.fileName = fileName || null;
      this.outer = outer || null;
      this.qualifiedName = outer ? outer.name + '.' + ast.name : ast.name;
      this.staticEnv = null;               // Environment for statics (lazy init)
      this.staticsReady = false;
    }
    findMethods(name) {
      const lk = name.toLowerCase();
      return (this.ast.methods || []).filter(m => !m.isConstructor && !m.isInitBlock && m.name.toLowerCase() === lk);
    }
    findProp(name) {
      const lk = name.toLowerCase();
      return (this.ast.props || []).find(p => p.name.toLowerCase() === lk) || null;
    }
    findField(name) {
      const lk = name.toLowerCase();
      return (this.ast.fields || []).find(f => f.name.toLowerCase() === lk) || null;
    }
    constructors() { return (this.ast.methods || []).filter(m => m.isConstructor); }
  }

  class ClassRegistry {
    constructor() { this.classes = new Map(); }   // lower qualified name -> ClassInfo
    register(unitAst, fileName) {
      const registered = [];
      const addClass = (clsAst, outer) => {
        const info = new ClassInfo(clsAst, fileName, outer);
        this.classes.set(info.qualifiedName.toLowerCase(), info);
        if (!outer) this.classes.set(info.name.toLowerCase(), info);
        else this.classes.set(info.name.toLowerCase() + '@' + outer.name.toLowerCase(), info);
        registered.push(info);
        for (const inner of clsAst.innerClasses || []) addClass(inner, info);
      };
      for (const cls of unitAst.classes || []) addClass(cls, null);
      return registered;
    }
    get(name) {
      if (!name) return null;
      return this.classes.get(String(name).toLowerCase()) || null;
    }
    getInner(outerInfo, name) {
      return this.classes.get(name.toLowerCase() + '@' + outerInfo.name.toLowerCase())
        || this.classes.get((outerInfo.name + '.' + name).toLowerCase()) || null;
    }
  }

  /* ================= interpreter ================= */
  const BUILTIN_TYPES = new Set(['string', 'integer', 'long', 'double', 'decimal', 'boolean', 'id', 'object', 'date', 'datetime', 'time', 'blob', 'list', 'map', 'set', 'math', 'json', 'system', 'database', 'limits', 'userinfo', 'test', 'schema', 'sobject', 'exception', 'type', 'url', 'void', 'string.format', 'logginglevel', 'apexpages', 'dom', 'pattern', 'matcher', 'encodingutil', 'crypto']);
  const BUILTIN_ENUMS = {
    'logginglevel': ['NONE', 'INTERNAL', 'FINEST', 'FINER', 'FINE', 'DEBUG', 'INFO', 'WARN', 'ERROR'],
    'apexpages.severity': ['CONFIRM', 'ERROR', 'FATAL', 'INFO', 'WARNING'],
    'triggeroperation': ['BEFORE_INSERT', 'BEFORE_UPDATE', 'BEFORE_DELETE', 'AFTER_INSERT', 'AFTER_UPDATE', 'AFTER_DELETE', 'AFTER_UNDELETE'],
    'quiddity': ['ANONYMOUS', 'AURA', 'BATCH_APEX', 'FUTURE', 'INVOCABLE_ACTION', 'QUEUEABLE', 'REST', 'RUNTEST_SYNC', 'SCHEDULED', 'SOAP', 'SYNCHRONOUS', 'VF'],
    'dom.xmlnodetype': ['ELEMENT', 'COMMENT', 'TEXT', 'CDATA', 'PROCESSING_INSTRUCTION'],
    'jsontoken': ['NOT_AVAILABLE', 'START_OBJECT', 'END_OBJECT', 'START_ARRAY', 'END_ARRAY', 'FIELD_NAME', 'VALUE_STRING', 'VALUE_NUMBER_INT', 'VALUE_NUMBER_FLOAT', 'VALUE_TRUE', 'VALUE_FALSE', 'VALUE_NULL', 'VALUE_EMBEDDED_OBJECT'],
  };
  // Sentinel returned by org-eval helpers when a value could not be resolved from the org.
  const ENGINE_UNRESOLVED = Symbol('engine-unresolved');
  // Sentinel returned when a queried field genuinely does NOT exist on the object in
  // the connected org (the installed managed-package version differs from the source
  // being debugged). Distinct from ENGINE_UNRESOLVED (a transient org/CLI miss):
  // retrying will never help, so the field is honestly recorded as absent and read as
  // null — and any later NullPointerException from that null is attributed to missing
  // org DATA rather than to the Apex code or an engine limitation.
  const ENGINE_FIELD_ABSENT = Symbol('engine-field-absent');

  class ApexEngine {
    constructor(host) {
      this.host = host || {};
      this.registry = new ClassRegistry();
      this.callStack = [];                 // frames, bottom-first
      this.mode = 'into';                  // 'continue' | 'into' | 'over' | 'out'
      this.stepDepth = 0;
      this.paused = false;
      this.stopped = false;
      // Never halt execution on a CAUGHT exception. Managed-package code routinely
      // throws-and-catches (e.g. UserInfo.isCurrentUserLicensed for an unlicensed
      // namespace), so pausing there would stop the debugger on lines the user never
      // set a breakpoint on. Caught exceptions are still surfaced via reportCaught()
      // (console) + inline markers — we just don't STOP. Only breakpoints, explicit
      // steps, and truly UNCAUGHT/fatal exceptions pause execution.
      this.pauseOnCaught = false;
      this.pauseRequested = false;
      this._resume = null;
      this.pendingBackend = null;          // label while awaiting org data
      this.maxSteps = 200000;
      this._steps = 0;
      this.dmlLog = [];
      this.pageMessages = [];
      this._unresolvedVarWarned = new Set();
      // Resilience: every engine limitation / internal crash we degrade past
      // (instead of killing the debug session) is recorded here so the UI can
      // show a "what actually happened" summary. Deduped via _gapKeys.
      this.diagnostics = [];
      this._gapKeys = new Set();
    }

    loadSource(fileName, source) {
      const unit = Lang.parse(source);
      const registered = this.registry.register(unit, fileName);
      // A newly loaded class may satisfy a type name we previously judged non-user,
      // so invalidate the negative cache used by the DO/wrapper dispatch.
      if (this._nonUserTypeCache) this._nonUserTypeCache.clear();
      return registered;
    }

    /* ---------- stepping controls (called by the UI) ---------- */
    resume(mode) {
      const r = this._resume;
      this._resume = null;
      if (r) r(mode || 'continue');
    }
    stepContinue() { this.resume('continue'); }
    stepInto() { this.resume('into'); }
    stepOver() { this.resume('over'); }
    stepOut() { this.resume('out'); }
    requestPause() { this.pauseRequested = true; }
    stop() {
      this.stopped = true;
      _fieldObserver = null;                 // stop observing tracked-field access
      const r = this._resume; this._resume = null;
      if (r) r('stop');
    }

    /* ---------- watch / data-flow field observer body ----------
       Called by ApexObject.get/setField ONLY for objects the UI marked
       obj.__tracked. Forwards to host.onFieldRead / host.onFieldWrite with the
       current execution context. Ignores:
         - sandbox evals (hover tooltips / console) — inspections, not real runs;
         - accesses while PAUSED — during a pause the engine is suspended, so any
           field access is UI-initiated (watch/hover render), never real execution.
       Together these guarantee we only ever record genuine runtime data flow. */
    _onFieldAccess(kind, obj, name, oldV, newV) {
      if (this._sandboxEval || this.paused) return;
      const host = this.host;
      if (kind === 'read' ? !host.onFieldRead : !host.onFieldWrite) return;
      const top = this.callStack.length ? this.callStack[this.callStack.length - 1] : null;
      const ctx = {
        obj, watchId: obj.__watchId, field: name,
        line: this.currentLine, file: this.currentFile, step: this._steps,
        className: top ? top.className : null, methodName: top ? top.methodName : null,
      };
      try {
        if (kind === 'read') host.onFieldRead(ctx);
        else { ctx.oldValue = oldV; ctx.newValue = newV; host.onFieldWrite(ctx); }
      } catch (_) { /* UI errors never affect execution */ }
    }

    /* ---------- the V8-style pause gate ---------- */
    async gate(node, frame, reason) {
      if (this.stopped) throw new StopSignal();
      if (!node || !node.line) return;
      frame.line = node.line;
      // Sandbox evals (hover tooltips, console) must never hit pause gates —
      // they run synchronously to completion and never interact with the step UI.
      if (this._sandboxEval) return;
      // Track the line currently executing and surface it to the UI so a running
      // (Continue) session shows WHERE it is — most valuable on a slow line that
      // then awaits the org (SOQL/describe/eval), which yields to let the UI paint
      // the highlight before the fetch returns.
      this.currentLine = node.line; this.currentFile = frame.file;
      if (this.host.onExecLine && (this._lastExecLine !== node.line || this._lastExecFile !== frame.file)) {
        this._lastExecLine = node.line; this._lastExecFile = frame.file;
        // Cheap stack snapshot (file+line per frame, bottom-first) so the UI can
        // keep the PARENT call-site line highlighted when execution descends into
        // another file — instead of leaving a stale highlight on screen.
        const stack = this.callStack.map(f => ({ file: f.file, line: f.line }));
        try { this.host.onExecLine({ line: node.line, file: frame.file, stack }); } catch (_) { /* UI errors never kill execution */ }
      }
      if (++this._steps > this.maxSteps) throw new ApexError('System.LimitException', 'Maximum interpreter steps exceeded (possible infinite loop)', node.line);
      const depth = this.callStack.length;
      let pauseReason = null;
      if (this.pauseRequested) pauseReason = 'pause';
      else if (this.mode === 'into') pauseReason = 'step';
      else if (this.mode === 'over' && depth <= this.stepDepth) pauseReason = 'step';
      else if (this.mode === 'out' && depth < this.stepDepth) pauseReason = 'step';
      const gateKey = frame.file + ':' + node.line + ':' + depth;
      if (!pauseReason && this.host.getBreakpoint) {
        const bp = this.host.getBreakpoint(frame.file, node.line);
        if (bp) {
          // A condition (if present) gates BOTH logpoints and plain breakpoints.
          let condOk = true;
          if (bp.condition) {
            condOk = false;
            try {
              condOk = (await this.evalExpressionInFrame(bp.condition, frame)) === true;
            } catch (err) { condOk = false; /* errored conditions never fire (Chrome behavior) */ }
          }
          const firstHitOnLine = this._lastBpKey !== gateKey;
          if (bp.logMessage != null && bp.logMessage !== '') {
            // Logpoint: evaluate the template + print, but NEVER pause. Fire once
            // per arrival at the line (nested gates share a line).
            if (condOk && firstHitOnLine) {
              try { await this._emitLogpoint(bp.logMessage, frame, node.line); } catch (_) {}
            }
            if (firstHitOnLine) this._lastBpKey = gateKey;
          } else if (condOk) {
            pauseReason = 'breakpoint';
            // A breakpoint pauses once per arrival at the line, not for every
            // nested gate on the same line (for-init / body-block share lines).
            if (this._lastBpKey === gateKey) pauseReason = null;
          }
        }
      }
      if (this._lastBpKey && this._lastBpKey !== gateKey && !pauseReason) this._lastBpKey = null;
      if (!pauseReason) return;
      if (pauseReason === 'breakpoint') this._lastBpKey = gateKey;
      this.pauseRequested = false;
      this.paused = true;
      this._hasSteppedOnce = true;
      try {
        if (this.host.onPause) this.host.onPause({ line: node.line, file: frame.file, reason: pauseReason, stack: this.getCallStack() });
      } catch (e) { /* UI errors must not kill execution */ }
      const action = await new Promise(res => { this._resume = res; });
      this.paused = false;
      if (action === 'stop') { this.stopped = true; throw new StopSignal(); }
      this.mode = action;
      this.stepDepth = this.callStack.length;
    }

    /* ---------- pause when an exception is caught (Chrome "pause on caught exceptions") ---------- */
    async pauseForException(err, frame, caught) {
      if (this._sandboxEval) return; // sandbox evals never pause on exception
      if (this.pauseOnCaught === false) return;
      // Only pause when this is an interactive stepping session (breakpoints set or
      // currently stepping) — never gate a plain "Continue" run into an interruption.
      if (this.mode === 'continue' && !this._hasSteppedOnce) return;
      const line = (err.apexStack && err.apexStack.length && err.apexStack[0].line) || err.apexLine || frame.line;
      this.paused = true;
      try {
        if (this.host.onPause) this.host.onPause({
          line, file: frame.file, reason: caught ? 'caught-exception' : 'exception',
          error: { type: err.apexType, message: err.apexMessage || err.message || '', stack: err.apexStack || [] },
          stack: this.getCallStack(),
        });
      } catch (e) { /* UI errors must not kill execution */ }
      const action = await new Promise(res => { this._resume = res; });
      this.paused = false;
      if (action === 'stop') { this.stopped = true; throw new StopSignal(); }
      this.mode = action;
      this.stepDepth = this.callStack.length;
    }

    /* ---------- inspection ---------- */
    getCallStack() {
      // top-first, Chrome style
      const out = [];
      for (let i = this.callStack.length - 1; i >= 0; i--) {
        const f = this.callStack[i];
        out.push({
          className: f.className, methodName: f.methodName, line: f.line, file: f.file,
          variables: this.snapshotVars(f), thisRef: f.thisRef || null,
        });
      }
      return out;
    }
    snapshotVars(frame) {
      const seen = new Set();
      const vars = [];
      let env = frame.env;
      while (env) {
        for (const e of env.vars.values()) {
          const lk = e.name.toLowerCase();
          if (seen.has(lk)) continue;
          seen.add(lk);
          vars.push({ name: e.name, value: e.value, type: e.type || typeNameOf(e.value), scope: env.label });
        }
        env = env.parent;
      }
      if (frame.thisRef) vars.push({ name: 'this', value: frame.thisRef, type: typeNameOf(frame.thisRef), scope: 'instance' });
      return vars;
    }
    async evalExpressionInFrame(src, frame) {
      const ast = Lang.parseExpression(src);
      return await this.evalExpr(ast, frame || this.topFrame());
    }
    topFrame() { return this.callStack[this.callStack.length - 1] || null; }

    /**
     * Sandboxed eval: runs an expression in a contained sub-execution that can
     * never corrupt the main debug session. Three guarantees:
     *  1. Call stack is always restored to its pre-eval depth (even on throw).
     *  2. Depth cap: aborts after 40 frames above the baseline → no 500-frame grind.
     *  3. When quiet=true (default): engine log calls are silenced.
     * Pass quiet=false for the debug console path where log output is desired.
     */
    async evalExpressionSandboxed(expr, frame, quiet) {
      const baseline = this.callStack.length;
      const prevSandbox = this._sandboxEval;
      const prevQuiet = this._quiet;
      const prevBaseline = this._sandboxBaseline;
      this._sandboxEval = true;
      this._quiet = quiet !== false; // default true; false = keep logs (console eval)
      this._sandboxBaseline = baseline;
      try {
        return await this.evalExpressionInFrame(expr, frame);
      } finally {
        this._sandboxEval = prevSandbox;
        this._quiet = prevQuiet;
        this._sandboxBaseline = prevBaseline;
        if (this.callStack.length > baseline) this.callStack.length = baseline;
      }
    }

    /** Route informational log messages through here so they can be suppressed
     *  during sandbox evals (hover tooltips etc.) by setting this._quiet = true. */
    log(msg, level) { if (!this._quiet && this.host.log) this.host.log(msg, level); }

    /* ======================================================================
     * Resilience layer — "the debug session must never die silently."
     *
     * We separate three kinds of failure so live debugging behaves like V8:
     *   1. Control-flow signals (Stop/Return/Break/Continue) → always propagate.
     *   2. Faithful Apex exceptions (NPE, QueryException, DmlException, user
     *      exceptions, …) → propagate so the DEBUGGED CODE's own try/catch runs,
     *      exactly as it would in a real org.
     *   3. Engine limitations / internal crashes (a builtin method we haven't
     *      simulated, an unsupported syntax node, or a raw JS error inside the
     *      interpreter) → these are NOT real Apex behavior, so instead of killing
     *      the session we log precisely what/where, substitute null, and keep
     *      stepping.
     * ==================================================================== */

    _isControlSignal(e) {
      return e instanceof StopSignal || e instanceof ReturnSignal ||
             e instanceof BreakSignal || e instanceof ContinueSignal;
    }

    // True when an error is an ENGINE gap rather than a faithful Apex exception.
    // Key insight: real Apex never throws NoSuchMethodException at RUNTIME (a
    // missing method is a compile error), so whenever OUR interpreter emits one it
    // is definitively an engine limitation and safe to degrade.
    _isEngineGap(e) {
      if (!(e instanceof ApexError)) return false;
      const t = String(e.apexType || '');
      if (t === 'System.NoSuchMethodException') return true;
      if (t === 'System.UnexpectedException') {
        const m = String(e.apexMessage || '');
        return /^Unsupported (statement|expression) kind|^Unknown (unary|operator)|^Invalid assignment target/.test(m);
      }
      return false;
    }

    // Should this thrown value be degraded-and-continued (true) or propagated as a
    // faithful Apex exception / control signal (false)?
    _shouldDegrade(e) {
      if (this._isControlSignal(e)) return false;
      if (e instanceof ApexError) return this._isEngineGap(e); // only engine gaps
      return true; // raw JS error = internal interpreter crash → degrade
    }

    // Infrastructure/connection failure signatures: an org round-trip that failed
    // for reasons UNRELATED to the code's logic (CLI bug, auth, network, timeout).
    // Distinctive tokens only, so a user exception whose message merely mentions a
    // word like "timeout" is not misclassified.
    _isOrgInfraError(e) {
      const s = String((e && (e.apexMessage || e.message)) || '');
      return /maximum call stack size exceeded|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|getaddrinfo|command not found|INVALID_LOGIN|invalid_grant|expired access token|refresh token is invalid|not authenticated|No authorization information|Unable to (reach|connect|locate|find)|Salesforce CLI|sfdx-cli|could not be resolved in org.*ENOENT/i.test(s);
    }

    // A failure that is characteristically the result of dereferencing a value the
    // debugger read as null because the connected org lacked a field the code queried.
    // Only null-dereference / not-queried-field exceptions qualify. Combined with the
    // presence of recorded org-absent reads (this._orgAbsentReads), this lets us
    // attribute such a failure to MISSING ORG DATA rather than to the Apex code or the
    // engine — the same code against a properly-provisioned org would not fail here.
    _isOrgDataDeref(e) {
      if (!(e instanceof ApexError)) return false;
      const t = String(e.apexType || '');
      return t === 'System.NullPointerException' || t === 'System.SObjectException';
    }

    /**
     * Honest three-way attribution of ANY failure the user can see, so an engine
     * gap is never mistaken for a code bug, and an org/CLI problem is never blamed
     * on the engine or the code logic. Returns {category, icon, label, advice}.
     *   ENGINE — the debugger itself couldn't handle a construct or crashed. My bug.
     *   ORG    — the Salesforce CLI / org round-trip failed (infra). Not logic.
     *   APEX   — a faithful Apex exception the code/data produced (incl. org-rejected
     *            SOQL/DML) — would happen the same way running directly in the org.
     */
    classifyFailure(e) {
      if (!(e instanceof ApexError)) {
        return { category: 'ENGINE', icon: '🧩', label: 'Debugger engine error',
          advice: 'an internal limitation of the debugger — NOT your Apex code; nothing in your org was affected' };
      }
      if (this._isEngineGap(e)) {
        return { category: 'ENGINE', icon: '⚠', label: 'Debugger limitation',
          advice: 'a construct the debugger has not implemented yet — NOT a problem with your code' };
      }
      if (this._isOrgInfraError(e)) {
        return { category: 'ORG', icon: '🌐', label: 'Org / Salesforce CLI issue',
          advice: 'the org connection or Salesforce CLI failed (auth, network, timeout, or a CLI bug) — NOT the engine or your code logic; retry, re-authorize, or update the CLI' };
      }
      // A null-dereference (or "field not queried" SObjectException) in a run where the
      // connected org was missing one or more of the fields the code read is, in
      // practice, a consequence of that MISSING ORG DATA — not an engine limitation and
      // not a bug in the Apex logic. The debugger honestly read each absent field as
      // null (every such degrade is noted above via _noteOrgFieldAbsent), and the code
      // then dereferenced that null. The identical code against a correctly-provisioned
      // org would not fail here, so attribute it to the org's data/schema, never blame
      // the user's code. Session-level correlation, phrased as the likely cause.
      if (this._orgAbsentReads && this._orgAbsentReads.length && this._isOrgDataDeref(e)) {
        const uniq = [...new Set(this._orgAbsentReads.map(r => `${r.type}.${r.field}`))];
        const shown = uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? `, +${uniq.length - 3} more` : '');
        const plural = uniq.length > 1;
        return { category: 'ORGDATA', icon: '🌐',
          label: 'Missing org data (not your code, not the engine)',
          advice: `this most likely dereferences a value that was read as null because the connected org is missing ${shown} — its installed managed-package version doesn't expose ${plural ? 'those fields' : 'that field'}, so ${plural ? 'they were' : 'it was'} substituted with null (noted above). The Apex logic and the debugger are both correct; connect an org that has ${plural ? 'these fields' : 'this field'} (or provision the data) and this will not occur — it is NOT a code bug and would NOT happen in a properly-provisioned org` };
      }
      const orgSeen = !!(e && e.__origin === 'org');
      return { category: 'APEX', icon: '❗',
        label: 'Real Apex error' + (orgSeen ? ' (reported by the org)' : ''),
        advice: (orgSeen
          ? 'the org rejected this — it reflects your Apex code or data and would happen the same way running directly in your org'
          : 'a genuine error in the Apex code or data — it would also occur when this runs in your org') + ', NOT an engine limitation' };
    }

    // Track a surfaced (non-degraded) failure for the end-of-run verdict.
    _trackFailure(e, caught) {
      if (!this._failures) this._failures = [];
      const c = this.classifyFailure(e);
      this._failures.push({ category: c.category, caught: !!caught });
      return c;
    }

    // Record a degraded failure and tell the user precisely what happened. Deduped
    // so the same gap inside a loop doesn't flood the console. Returns the record.
    _recordGap(e, ctx) {
      const isCrash = !(e instanceof ApexError);
      const detail = isCrash
        ? (e && e.message ? String(e.message) : String(e))
        : `${e.apexType}: ${e.apexMessage}`;
      return this._noteGap(detail, isCrash ? 'engine-crash' : 'engine-gap', ctx);
    }

    // Core degradation recorder, usable both from the resilience wrappers (which
    // pass an Error via _recordGap) and from inline "not simulated → return null"
    // sites that already know they're degrading. Pushes to diagnostics, dedupes,
    // and logs one precise, human line.
    _noteGap(detail, kind, ctx) {
      const isCrash = kind === 'engine-crash';
      const line = ctx && ctx.line;
      const file = ctx && ctx.file ? String(ctx.file).split(/[/\\]/).pop() : null;
      const rec = { kind: kind || 'engine-gap', detail: String(detail), line, file, at: ctx && ctx.what };
      this.diagnostics.push(rec);
      // Hover/console sandbox evals must stay silent — they probe expressions and
      // are expected to hit gaps; we degrade them without spamming the console.
      if (this._sandboxEval) return rec;
      const key = `${rec.kind}|${rec.detail}|${line}`;
      if (this._gapKeys.has(key)) return rec;
      this._gapKeys.add(key);
      const where = line ? ` (line ${line}${file ? ' in ' + file : ''})` : '';
      const icon = isCrash ? '🧩' : '⚠';
      const why = isCrash
        ? 'the interpreter hit an internal error on this step (a debugger-engine limitation, NOT your Apex code)'
        : 'this construct is not simulated yet (a debugger-engine limitation, NOT your Apex code)';
      this.log(`${icon} ${rec.detail}${where} — ${why}. Substituted null and kept stepping (the debug session did NOT stop; nothing was skipped silently).`, 'system');
      return rec;
    }

    // Record an "org value could not be fetched" degradation — DISTINCT from an
    // engine gap. Here the construct IS fully supported; the real org round-trip just
    // came back unresolved (CLI crash, transient auth/network), so a truthful,
    // Apex-semantics-correct substitute was used (null / empty map / empty record).
    // Deduped + logged honestly, and fed into the end-of-run verdict, so the user
    // knows a value is a placeholder rather than real org data — and never blames the
    // engine or their code for a transient infrastructure hiccup.
    _noteOrgUnresolved(what, substitute, line) {
      if (!this.diagnostics) this.diagnostics = [];
      if (!this._gapKeys) this._gapKeys = new Set();
      const rec = { kind: 'org-unresolved', detail: String(what), substitute: String(substitute), line: line || null };
      this.diagnostics.push(rec);
      if (this._sandboxEval) return rec;
      const key = `org-unresolved|${rec.detail}|${line}`;
      if (this._gapKeys.has(key)) return rec;
      this._gapKeys.add(key);
      const where = line ? ` (line ${line})` : '';
      this.log(`🌐 ${what}${where}: the real value couldn't be fetched from the org right now — substituted ${substitute} so stepping continues. This is an org/CLI availability issue, NOT your Apex code and NOT an engine limitation; if a later result looks off, an unfetched org value may be why.`, 'system');
      return rec;
    }

    // Record that a field the code READ genuinely does not exist on this SObject in the
    // CONNECTED org (the installed managed-package version differs from the source being
    // debugged). Distinct from _noteOrgUnresolved (a transient fetch miss): retrying
    // will NOT help. We degrade the read to null (Apex-correct), tell the user honestly,
    // feed the end-of-run verdict, and remember the field in this._orgAbsentReads so a
    // later NullPointerException caused by that null is attributed to missing org DATA
    // — never to the code or the engine. Deduped so a read in a loop doesn't flood.
    _noteOrgFieldAbsent(type, field, line) {
      if (!this.diagnostics) this.diagnostics = [];
      if (!this._gapKeys) this._gapKeys = new Set();
      if (!this._orgAbsentReads) this._orgAbsentReads = [];
      const objType = type || 'SObject';
      if (!this._orgAbsentReads.some(r => r.type === objType && r.field === field)) {
        this._orgAbsentReads.push({ type: objType, field, line: line || null });
      }
      const rec = { kind: 'org-field-absent', detail: `${objType}.${field}`, substitute: 'null', line: line || null };
      this.diagnostics.push(rec);
      if (this._sandboxEval) return rec;
      const key = `org-field-absent|${rec.detail}`;
      if (this._gapKeys.has(key)) return rec;
      this._gapKeys.add(key);
      const where = line ? ` (line ${line})` : '';
      this.log(`🌐 ${objType}.${field} doesn't exist on this object in the connected org${where} — the installed managed-package version differs from the source, so it was read as null (Apex-correct) and stepping continues. This is org DATA/schema, NOT your Apex code and NOT an engine limitation; retrying won't help — connect an org that has this field or provision the data. If a later NullPointerException follows, this missing value is the likely cause.`, 'system');
      return rec;
    }

    // went wrong AND whose responsibility each item is" — engine vs code vs org —
    // instead of a mysterious early stop or an error they might blame on the engine.
    _reportDiagnosticsSummary() {
      const gaps = (this.diagnostics || []).filter(d => d.kind === 'engine-gap').length;
      const crashes = (this.diagnostics || []).filter(d => d.kind === 'engine-crash').length;
      const orgUnresolved = (this.diagnostics || []).filter(d => d.kind === 'org-unresolved').length;
      const orgFieldAbsent = (this.diagnostics || []).filter(d => d.kind === 'org-field-absent').length;
      const fails = this._failures || [];
      const apex = fails.filter(f => f.category === 'APEX').length;
      const org = fails.filter(f => f.category === 'ORG').length;
      const orgData = fails.filter(f => f.category === 'ORGDATA').length;
      const engineFails = fails.filter(f => f.category === 'ENGINE').length;
      const engineTotal = gaps + crashes + engineFails;
      if (!engineTotal && !apex && !org && !orgData && !orgUnresolved && !orgFieldAbsent) return;
      const lines = ['ℹ Debug session verdict — what happened and whose responsibility each item is:'];
      if (engineTotal) lines.push(`   🧩 Debugger engine: ${engineTotal} limitation${engineTotal > 1 ? 's' : ''} (unsimulated construct or internal error) — the DEBUGGER's responsibility to fix, NOT your code. Each was reported above with its line; all degraded to null so stepping could continue.`);
      if (apex) lines.push(`   ❗ Apex code/data: ${apex} real error${apex > 1 ? 's' : ''} that would ALSO occur running this in your org — these live in the code or data, not the engine.`);
      if (orgData) lines.push(`   🌐 Missing org data: ${orgData} failure${orgData > 1 ? 's' : ''} caused by field(s) absent from the connected org — the debugger read the missing field(s) as null (noted above) and the code then dereferenced that null. NOT an engine limitation and NOT an Apex code bug; the same code would run against an org that has these fields.`);
      if (org) lines.push(`   🌐 Org / CLI: ${org} connection or Salesforce CLI issue${org > 1 ? 's' : ''} — infrastructure, not the engine or your code logic.`);
      if (orgUnresolved) lines.push(`   🌐 Org values unavailable: ${orgUnresolved} value${orgUnresolved > 1 ? 's' : ''} couldn't be fetched from the org and ${orgUnresolved > 1 ? 'were' : 'was'} substituted with an Apex-correct default (null / empty). NOT an engine or code bug — a transient org/CLI availability issue. If a result looks off, an unfetched value may be why; retrying or updating the Salesforce CLI usually resolves it.`);
      if (orgFieldAbsent && !orgData) lines.push(`   🌐 Org fields absent: ${orgFieldAbsent} field${orgFieldAbsent > 1 ? 's' : ''} the code read ${orgFieldAbsent > 1 ? "don't" : "doesn't"} exist on the object in the connected org (installed package version differs from the source) — read as null. Provision the field(s) or connect an org that has them; retrying won't help. NOT an engine or code bug.`);
      this.log(lines.join('\n'), 'system');
    }

    // Read-only snapshot of degraded failures (for the UI / diagnostics panel).
    getDiagnostics() { return (this.diagnostics || []).slice(); }

    /* ---------- entry points ---------- */
    async run(className, methodName, argValues) {
      this.stopped = false; this._steps = 0;
      const self = this;
      _fieldObserver = (kind, obj, name, oldV, newV) => self._onFieldAccess(kind, obj, name, oldV, newV);
      // Reset per-session pause state so a RESTART re-honors breakpoints. Without
      // this, _lastBpKey retains the previous run's gate key and the breakpoint at
      // the same line+depth (e.g. the method's first line) is suppressed on re-run.
      this._lastBpKey = null;
      this._hasSteppedOnce = false;
      this.pauseRequested = false;
      this.callStack = [];
      this._recursionReported = false;
      this._unresolvedVarWarned = new Set();
      this.pageMessages = [];
      this.dmlLog = [];
      this.diagnostics = [];
      this._gapKeys = new Set();
      this._failures = [];
      this._orgAbsentReads = [];
      const cls = this.registry.get(className) || await this.lazyLoadClass(className);
      if (!cls) throw new ApexError('System.TypeException', `Class not found: ${className}`, 0);
      const methods = cls.findMethods(methodName);
      if (!methods.length) throw new ApexError('System.NoSuchMethodException', `Method ${className}.${methodName} not found`, 0);
      const method = this.pickOverload(methods, argValues || []);
      try {
        let thisRef = null;
        if (!method.static) thisRef = await this.instantiate(cls, [], null, 0);
        const result = await this.invokeMethod(cls, method, thisRef, argValues || [], null);
        this._reportDiagnosticsSummary();
        if (this.host.onDone) this.host.onDone(result);
        return result;
      } catch (e) {
        if (e instanceof StopSignal) { if (this.host.onDone) this.host.onDone(undefined); return undefined; }
        // Uncaught faithful exception reached the top: attribute it honestly so the
        // user knows whether the method failed because of their code/data, an org/CLI
        // problem, or an engine limitation — before it surfaces as a bare error.
        if ((e instanceof ApexError) || (e instanceof Error && !this._isControlSignal(e))) {
          const c = this._trackFailure(e, false);
          const msg = (e instanceof ApexError) ? `${e.apexType}: ${e.apexMessage || ''}` : (e.message || String(e));
          this.log(`${c.icon} Uncaught ${msg} — ${c.label}: ${c.advice}.`, 'error');
        }
        this._reportDiagnosticsSummary();
        if (this.host.onError) this.host.onError(e);
        throw e;
      } finally {
        // Stop observing once the run is fully over (it stays active across pauses,
        // since run() only settles when the method completes). Prevents any later
        // UI-side field access on a still-__tracked object from being mis-recorded
        // as real execution data-flow.
        _fieldObserver = null;
      }
    }

    async runAnonymous(source, fileName) {
      this.stopped = false; this._steps = 0;
      const self = this;
      _fieldObserver = (kind, obj, name, oldV, newV) => self._onFieldAccess(kind, obj, name, oldV, newV);
      const stmts = Lang.parseStatements(source);
      const env = new Environment(null, 'anonymous');
      const frame = { className: '<anonymous>', methodName: 'execute', file: fileName || '<anonymous>', line: 1, env, thisRef: null, classInfo: null };
      this.callStack.push(frame);
      try {
        for (const s of stmts) await this.execStmt(s, frame);
        if (this.host.onDone) this.host.onDone(undefined);
      } catch (e) {
        if (e instanceof StopSignal) { if (this.host.onDone) this.host.onDone(undefined); return; }
        if (e instanceof ReturnSignal) { if (this.host.onDone) this.host.onDone(e.value); return; }
        if (this.host.onError) this.host.onError(e);
        throw e;
      } finally {
        this.callStack.pop();
        _fieldObserver = null;   // stop observing once the anonymous run is over
      }
    }

    async lazyLoadClass(className) {
      if (!className) return null;
      // Already registered (e.g. an inner class loaded with its outer file)?
      const already = this.registry.get(className);
      if (already) return already;
      if (!this.host.loadClassSource) return null;
      // For a qualified inner-class name (Outer.Inner[.Inner2]) the source lives in
      // the OUTER class file, so ask the host for the outer name too.
      const head = String(className).split('.')[0];
      const tries = head !== className ? [className, head] : [className];
      for (const nm of tries) {
        try {
          const res = await this.host.loadClassSource(nm);
          if (!res) continue;
          const src = typeof res === 'string' ? res : res.source;
          const file = typeof res === 'string' ? nm + '.cls' : (res.path || nm + '.cls');
          if (!src) continue;
          this.loadSource(file, src);
          const found = this.registry.get(className);
          if (found) return found;
        } catch (e) { /* try next candidate */ }
      }
      return this.registry.get(className) || null;
    }

    pickOverload(methods, args, argHints) {
      if (!methods || !methods.length) return null;
      args = args || [];
      // Candidates whose arity matches the supplied argument count.
      const arityMatch = methods.filter(m => (m.params || []).length === args.length);
      const pool = arityMatch.length ? arityMatch : methods;
      if (pool.length === 1) return pool[0];
      // Type-aware disambiguation: Apex resolves overloads by parameter types,
      // not merely by argument count. Score each candidate and keep the best.
      let best = pool[0], bestScore = -Infinity;
      for (const m of pool) {
        const params = m.params || [];
        let score = 0;
        for (let i = 0; i < args.length; i++) {
          const pt = params[i] && params[i].type ? params[i].type.name : null;
          const hint = argHints && argHints[i];
          if ((args[i] === null || args[i] === undefined) && hint) {
            // Use static type hint to break null-ambiguity between overloads.
            const hintL = String(hint).replace(/<[\s\S]*>/, '').replace(/\[\]$/, '').trim().toLowerCase();
            const baseL = pt ? String(pt).replace(/<[\s\S]*>/, '').replace(/\[\]$/, '').trim().toLowerCase() : null;
            if (!baseL) { score += 0; }
            else if (hintL === baseL || stripNs(hintL) === stripNs(baseL)) { score += 3; }
            else { score += -2; }
          } else {
            score += this.scoreArgToParam(args[i], pt);
          }
        }
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return best;
    }

    // Compute static type hints from arg AST nodes (synchronous, before evalArgs).
    // Returns an array parallel to argNodes; each element is a type-name string or null.
    _argHints(argNodes, frame) {
      if (!argNodes || !argNodes.length) return [];
      return argNodes.map(node => {
        if (!node) return null;
        if (node.kind === 'lit') {
          return node.litType === 'null' ? null : (node.litType || null);
        }
        if (node.kind === 'ident' && frame && frame.env) {
          const entry = frame.env.lookupEntry(node.name);
          return entry ? entry.type : null;
        }
        if (node.kind === 'call' && !node.target && frame && frame.classInfo) {
          // Unqualified call: look up declared return type from classInfo hierarchy.
          let c = frame.classInfo;
          while (c) {
            const ms = c.findMethods ? c.findMethods(node.name) : [];
            if (ms.length) { const rt = ms[0].returnType; return rt ? rt.name : null; }
            c = c.superClass ? this.registry.get(c.superClass) : null;
          }
          return null;
        }
        if (node.kind === 'new') {
          return node.type ? (node.type.name || null) : null;
        }
        return null;
      });
    }

    // How well a runtime argument value fits a declared parameter type.
    // 3 = exact match, 2 = compatible, 1 = weak/unknown, 0 = neutral, negative = mismatch.
    scoreArgToParam(arg, paramType) {
      if (!paramType) return 0;                       // unknown param type -> neutral
      const base = String(paramType).replace(/<[\s\S]*>/, '').replace(/\[\]$/, '').trim();
      const bl = base.toLowerCase();
      const isCollectionType = /<.*>/.test(String(paramType)) || /\[\]$/.test(String(paramType));
      if (bl === 'object' || bl === 'sobject' && isSObject(arg)) return bl === 'object' ? 1 : 2;
      if (arg === null || arg === undefined) return 1; // null binds to any reference type
      if (typeof arg === 'boolean') return bl === 'boolean' ? 3 : -3;
      if (typeof arg === 'number') {
        return ['integer', 'long', 'double', 'decimal'].includes(bl) ? 3 : -3;
      }
      if (typeof arg === 'string') {
        // Apex freely assigns between String and Id; also date-ish parse targets.
        if (['string', 'id'].includes(bl)) return 3;
        if (['date', 'datetime', 'time', 'blob'].includes(bl)) return 1;
        return -3;
      }
      if (Array.isArray(arg)) return (bl === 'list' || bl === 'set' || isCollectionType) ? 3 : -3;
      if (arg instanceof ApexMap) return bl === 'map' ? 3 : -3;
      if (arg instanceof ApexSet) return bl === 'set' ? 3 : -3;
      if (arg instanceof ApexDate) return bl === 'date' ? 3 : (bl === 'datetime' ? 1 : -2);
      if (arg instanceof ApexDatetime) return bl === 'datetime' ? 3 : (bl === 'date' ? 1 : -2);
      if (arg instanceof ApexTime) return bl === 'time' ? 3 : -2;
      if (arg instanceof ApexBlob) return bl === 'blob' ? 3 : -2;
      if (arg instanceof ApexEnumValue) {
        const ec = String(arg.enumClass).toLowerCase();
        return (bl === ec || stripNs(bl) === stripNs(ec)) ? 3 : 0;
      }
      if (arg instanceof ApexObject) {
        if (this.apexObjIsA(arg.classInfo, bl)) return 3;
        return -2;
      }
      if (isSObject(arg)) {
        if (bl === 'sobject') return 2;
        const t = String(sobjType(arg)).toLowerCase();
        if (t === bl || stripNs(t) === stripNs(bl)) return 3;
        // An SObject can never bind to a primitive parameter (Id, String, …).
        // Without this, a type-less query row (attributes stripped) would tie an
        // `Id` overload against an SObject overload and mis-dispatch (e.g. the
        // createManagedObject(Id)/(SObject) infinite-recursion bug).
        if (PRIMITIVE_PARAM_TYPES.has(bl)) return -3;
        // Custom/standard object param, or an unknown-typed SObject vs some class
        // type -> weakly compatible (covers records whose type token is absent).
        if (/__(c|mdt|e|x|share|history)$/.test(bl) || t === 'sobject') return 1;
        return -1;
      }
      return 0;
    }

    // Does an ApexObject's class satisfy a type name (self / super chain / interfaces)?
    apexObjIsA(ci, typeNameLower) {
      let c = ci;
      const seen = new Set();
      while (c && !seen.has(c)) {
        seen.add(c);
        if (c.name && c.name.toLowerCase() === typeNameLower) return true;
        if (c.qualifiedName && c.qualifiedName.toLowerCase() === typeNameLower) return true;
        for (const it of (c.ast.interfaces || [])) {
          if (it && it.name && it.name.toLowerCase() === typeNameLower) return true;
        }
        c = this.superOf(c);
      }
      return false;
    }

    superOf(ci) {
      if (!ci || !ci.ast.superClass) return null;
      const n = ci.ast.superClass.name;
      return this.registry.get(n)
        || (ci.outer ? this.registry.getInner(ci.outer, n) : null)
        || this.registry.getInner(ci, n)
        || null;
    }

    // Static type hint: does this expression look Decimal/Double?
    isDecimalHint(e, frame) {
      if (!e) return false;
      if (e.kind === 'lit') return e.litType === 'Decimal' || e.litType === 'Double';
      if (e.kind === 'ident' && frame && frame.env) {
        const en = frame.env.lookupEntry(e.name);
        if (en && en.type) { const t = String(en.type).toLowerCase(); return t === 'decimal' || t === 'double'; }
      }
      if (e.kind === 'binary') return this.isDecimalHint(e.left, frame) || this.isDecimalHint(e.right, frame);
      if (e.kind === 'cast') { const t = e.type.name.toLowerCase(); return t === 'decimal' || t === 'double'; }
      return false;
    }

    /* ---------- statics init ---------- */
    async ensureStatics(cls) {
      if (cls.staticsReady) return;
      cls.staticsReady = true;
      cls.staticEnv = new Environment(null, 'static:' + cls.name);
      // An inner class can reference its enclosing class's static members by simple
      // name (e.g. `LINE_ACTION_NONE` inside RemoteCPQ.LineItemDO resolves to the
      // outer RemoteCPQ.LINE_ACTION_NONE). Initialize the enclosing chain first so
      // those statics are actually present when the inner class runs — otherwise the
      // engine wrongly throws VariableDoesNotExistException for a real constant.
      if (cls.outer) await this.ensureStatics(cls.outer);
      const frame = { className: cls.name, methodName: '<static-init>', file: cls.fileName, line: cls.ast.line, env: cls.staticEnv, thisRef: null, classInfo: cls };
      for (const f of cls.ast.fields || []) {
        if (!f.static) continue;
        let v = null;
        if (f.init) v = await this.evalExpr(f.init, frame);
        cls.staticEnv.define(f.name, v, f.type ? f.type.name : null);
      }
      for (const p of cls.ast.props || []) {
        if (p.static) cls.staticEnv.define(p.name, null, p.type ? p.type.name : null);
      }
      for (const m of cls.ast.methods || []) {
        if (m.isInitBlock && m.static) {
          this.callStack.push(frame);
          try { await this.execBlock(m.body, frame, cls.staticEnv); } finally { this.callStack.pop(); }
        }
      }
    }

    /* ---------- instantiation ---------- */
    async instantiate(cls, args, namedArgs, line) {
      await this.ensureStatics(cls);
      const obj = new ApexObject(cls);
      // walk hierarchy for instance fields (super first)
      const chain = [];
      let c = cls;
      while (c) { chain.unshift(c); c = this.superOf(c); }
      const initFrame = { className: cls.name, methodName: '<init>', file: cls.fileName, line: line || cls.ast.line, env: new Environment(null, 'init'), thisRef: obj, classInfo: cls };
      for (const ci of chain) {
        for (const f of ci.ast.fields || []) {
          if (f.static) continue;
          let v = null;
          if (f.init) {
            this.callStack.push(initFrame);
            try { v = await this.evalExpr(f.init, initFrame); } finally { this.callStack.pop(); }
          }
          obj.setField(f.name, v);
        }
        for (const p of ci.ast.props || []) {
          if (!p.static && !obj.hasField(p.name)) obj.setField(p.name, null);
        }
        for (const m of ci.ast.methods || []) {
          if (m.isInitBlock && !m.static) {
            this.callStack.push(initFrame);
            try { await this.execBlock(m.body, initFrame, new Environment(initFrame.env, 'init-block')); } finally { this.callStack.pop(); }
          }
        }
      }
      if (namedArgs) {
        for (const na of namedArgs) obj.setField(na.name, na.value);
        return obj;
      }
      const ctors = cls.constructors();
      if (ctors.length) {
        const ctor = this.pickOverload(ctors, args);
        await this.invokeMethod(cls, ctor, obj, args, null);
      } else if (args.length) {
        throw new ApexError('System.TypeException', `Constructor with ${args.length} argument(s) not found for ${cls.name}`, line);
      }
      return obj;
    }

    /* ---------- method invocation ---------- */
    async invokeMethod(cls, method, thisRef, args, callerFrame) {
      await this.ensureStatics(cls);
      const env = new Environment(cls.staticEnv, 'method:' + method.name);
      const params = method.params || [];
      for (let i = 0; i < params.length; i++) {
        env.define(params[i].name, i < args.length ? args[i] : null, params[i].type ? params[i].type.name : null);
      }
      const frame = {
        className: cls.name, methodName: method.name, file: cls.fileName,
        line: method.line, env, thisRef: method.static ? null : thisRef, classInfo: cls,
      };
      // Fix 3: fast early-exit for direct self-recursion (25 consecutive identical frames
      // at the top of the stack). This turns a 500-frame grind into an immediate abort
      // for e.g. `Integer go() { return go(); }` — checked O(25) instead of O(500).
      if (this.callStack.length > 25) {
        const thisSig = cls.name.toLowerCase() + '.' + method.name.toLowerCase();
        let selfRun = 0;
        for (let i = this.callStack.length - 1; i >= Math.max(0, this.callStack.length - 25); i--) {
          const f = this.callStack[i];
          if ((f.className + '.' + f.methodName).toLowerCase() === thisSig) selfRun++;
          else break;
        }
        if (selfRun >= 25) {
          const cycle = this._describeRecursionCycle();
          throw new ApexError('System.LimitException', `Maximum stack depth reached (recursion too deep). Repeating cycle: ${cycle.short}`, method.line);
        }
      }
      // Fix 1: sandbox eval depth cap — hover/console evals abort at 40 frames above
      // their baseline so a buggy expression never causes a 500-frame hang.
      if (this._sandboxEval && this._sandboxBaseline !== undefined && this.callStack.length - this._sandboxBaseline >= 40) {
        throw new ApexError('System.LimitException', 'Hover evaluation aborted (too deep)', method.line);
      }
      if (this.callStack.length > 500) {
        // Interpreter recursion guard. Surface the repeating cycle so the user
        // (and we) can see WHICH methods loop, instead of a bare limit error
        // that a CPQ `catch (Exception)` swallows far from the real cause.
        const cycle = this._describeRecursionCycle();
        if (!this._recursionReported) {
          this._recursionReported = true;
          const cycleDesc = cycle.reps > 0
            ? `kept re-entering the same call cycle ${cycle.reps}× and stopped at depth ${this.callStack.length}. Repeating cycle:\n${cycle.text}`
            : `stopped at depth ${this.callStack.length} (no clear repeating cycle). Last frames:\n${cycle.text}`;
          this.log(`♻ Runaway recursion detected — the interpreter ${cycleDesc}`, 'system');
        }
        throw new ApexError('System.LimitException', `Maximum stack depth reached (recursion too deep). Repeating cycle: ${cycle.short}`, method.line);
      }
      this.callStack.push(frame);
      try {
        await this.execBlock(method.body, frame, new Environment(env, 'body'));
        return null;
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        if (e instanceof ApexError && !e.apexStack.length) {
          // Capture the FULL throw-site stack here, while every frame is still
          // live on this.callStack (the finally below, and the callers' finallys,
          // will pop them as the exception unwinds). We snapshot each frame's real
          // variables/thisRef/file too, so a "pause on exception" can show the
          // complete chain WITH real values — the unwound live stack at catch-time
          // only contains the catching frame.
          for (let i = this.callStack.length - 1; i >= 0; i--) {
            const f = this.callStack[i];
            e.apexStack.push({
              className: f.className, methodName: f.methodName, line: f.line,
              file: f.file, variables: this.snapshotVars(f), thisRef: f.thisRef || null,
            });
          }
        }
        throw e;
      } finally {
        this.callStack.pop();
      }
    }

    /**
     * Analyze the current call stack to find the repeating cycle behind a
     * runaway recursion. Returns a human-readable description of the shortest
     * repeating unit of `Class.method` signatures at the top of the stack.
     */
    _describeRecursionCycle() {
      const sig = (f) => `${f.className}.${f.methodName}`;
      const top = this.callStack.slice(-60).map(sig);
      // Find the shortest period P such that the tail repeats with period P.
      let period = 0;
      for (let p = 1; p <= Math.floor(top.length / 2); p++) {
        let ok = true;
        for (let i = top.length - 1; i - p >= 0 && i >= top.length - p * 3; i--) {
          if (top[i] !== top[i - p]) { ok = false; break; }
        }
        if (ok) { period = p; break; }
      }
      if (!period) {
        const uniq = [...new Set(top.slice(-8))];
        return { text: uniq.map(s => '   ↻ ' + s).join('\n'), short: uniq.join(' → '), reps: 0 };
      }
      const unit = top.slice(top.length - period);
      // Count how many times the unit repeats down the stack.
      let reps = 0;
      for (let i = top.length - period; i >= 0; i -= period) {
        let match = true;
        for (let j = 0; j < period; j++) { if (top[i + j] !== unit[j]) { match = false; break; } }
        if (match) reps++; else break;
      }
      reps = Math.max(1, reps);
      return {
        text: unit.map(s => '   ↻ ' + s).join('\n'),
        short: unit.join(' → '),
        reps,
      };
    }

    /* ---------- statement execution ---------- */
    async execBlock(block, frame, env) {
      if (!block) return;
      const prevEnv = frame.env;
      frame.env = env;
      try {
        for (const s of block.stmts || []) await this.execStmt(s, frame);
      } finally {
        frame.env = prevEnv;
      }
    }

    async execStmt(stmt, frame) {
      if (!stmt) return;
      // Blocks/empties aren't pause points (Chrome doesn't pause on '{');
      // their inner statements gate themselves.
      if (stmt.kind !== 'block' && stmt.kind !== 'empty') await this.gate(stmt, frame);
      try {
        return await this.execStmtInner(stmt, frame);
      } catch (err) {
        // Last-resort safety net: an engine gap or internal interpreter crash on
        // this statement is logged and skipped so the session keeps stepping the
        // rest of the method. Control signals and faithful Apex exceptions (which
        // the debugged code's own try/catch is meant to handle) always propagate.
        if (!this._shouldDegrade(err)) throw err;
        this._recordGap(err, { line: stmt.line, file: frame && frame.file, what: `statement '${stmt.kind}'` });
        return;
      }
    }

    // Statement body without the pause gate — used when the gate for this
    // line has already fired (e.g. for-loop init on the same line).
    async execStmtInner(stmt, frame) {
      switch (stmt.kind) {
        case 'block': return this.execBlock(stmt, frame, new Environment(frame.env, 'block'));
        case 'empty': return;
        case 'expr': { await this.evalExpr(stmt.expr, frame); return; }
        case 'vardecl': {
          for (const d of stmt.decls) {
            let v = null;
            if (d.init) v = await this.evalExpr(d.init, frame);
            frame.env.define(d.name, v, stmt.type ? this.typeLabel(stmt.type) : null);
          }
          return;
        }
        case 'if': {
          const c = await this.evalExpr(stmt.cond, frame);
          if (c === true) await this.execStmt(stmt.then, frame);
          else if (stmt.else) await this.execStmt(stmt.else, frame);
          return;
        }
        case 'while': {
          let firstIter = true;
          while (true) {
            if (!firstIter) await this.gate(stmt, frame);
            firstIter = false;
            const c = await this.evalExpr(stmt.cond, frame);
            if (c !== true) break;
            try { await this.execStmt(stmt.body, frame); }
            catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
          }
          return;
        }
        case 'dowhile': {
          while (true) {
            try { await this.execStmt(stmt.body, frame); }
            catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) { /* fallthrough to cond */ } else throw e; }
            await this.gate(stmt, frame);
            const c = await this.evalExpr(stmt.cond, frame);
            if (c !== true) break;
          }
          return;
        }
        case 'for': {
          const loopEnv = new Environment(frame.env, 'for');
          const prevEnv = frame.env;
          frame.env = loopEnv;
          try {
            if (stmt.init) await this.execStmtInner(stmt.init, frame);
            let firstIter = true;
            while (true) {
              if (stmt.cond) {
                if (!firstIter) await this.gate(stmt, frame);
                const c = await this.evalExpr(stmt.cond, frame);
                if (c !== true) break;
              }
              firstIter = false;
              try { await this.execStmt(stmt.body, frame); }
              catch (e) {
                if (e instanceof BreakSignal) break;
                if (!(e instanceof ContinueSignal)) throw e;
              }
              for (const u of stmt.updates || []) await this.evalExpr(u, frame);
            }
          } finally { frame.env = prevEnv; }
          return;
        }
        case 'foreach': {
          const iterable = await this.evalExpr(stmt.iterable, frame);
          if (iterable === null || iterable === undefined) throw npe(stmt.line, 'Attempt to iterate over a null collection');
          let items;
          if (Array.isArray(iterable)) items = iterable;
          else if (iterable instanceof ApexSet) items = iterable.items();
          else if (iterable instanceof ApexMap) items = iterable.keys();
          else throw new ApexError('System.TypeException', `Cannot iterate over ${typeNameOf(iterable)}`, stmt.line);
          let firstItem = true;
          for (const item of items) {
            const loopEnv = new Environment(frame.env, 'foreach');
            loopEnv.define(stmt.varName, item, stmt.type ? this.typeLabel(stmt.type) : null);
            const prevEnv = frame.env;
            frame.env = loopEnv;
            try {
              if (!firstItem) await this.gate(stmt, frame);
              firstItem = false;
              await this.execStmt(stmt.body, frame);
            }
            catch (e) {
              if (e instanceof BreakSignal) { frame.env = prevEnv; return; }
              if (!(e instanceof ContinueSignal)) { frame.env = prevEnv; throw e; }
            }
            finally { frame.env = prevEnv; }
          }
          return;
        }
        case 'switch': {
          const disc = await this.evalExpr(stmt.disc, frame);
          for (const cs of stmt.cases) {
            if (cs.isElse) { await this.execBlock(cs.body, frame, new Environment(frame.env, 'when')); return; }
            if (cs.typeVar) {
              const tn = cs.typeVar.type.name;
              if (disc !== null && typeNameOf(disc).toLowerCase() === tn.toLowerCase()) {
                const env = new Environment(frame.env, 'when');
                env.define(cs.typeVar.name, disc, tn);
                await this.execBlock(cs.body, frame, env);
                return;
              }
              continue;
            }
            for (const vexpr of cs.values || []) {
              let v;
              if (vexpr.kind === 'ident') {
                // enum value or variable
                v = frame.env.has(vexpr.name) ? frame.env.get(vexpr.name) : vexpr.name;
              } else v = await this.evalExpr(vexpr, frame);
              if (apexEquals(disc, v)) {
                await this.execBlock(cs.body, frame, new Environment(frame.env, 'when'));
                return;
              }
            }
          }
          return;
        }
        case 'try': {
          try {
            await this.execBlock(stmt.block, frame, new Environment(frame.env, 'try'));
          } catch (e) {
            if (e instanceof StopSignal || e instanceof ReturnSignal || e instanceof BreakSignal || e instanceof ContinueSignal) {
              if (stmt.finallyBlock) await this.execBlock(stmt.finallyBlock, frame, new Environment(frame.env, 'finally'));
              throw e;
            }
            const err = (e instanceof ApexError) ? e : new ApexError('System.UnexpectedException', e.message || String(e), stmt.line);
            let handled = false;
            for (const c of stmt.catches) {
              if (this.catchMatches(c.type, err)) {
                // Surface the caught exception so the user can SEE why the try block
                // exited early into catch (otherwise it looks like the try was skipped).
                this.reportCaught(err, c);
                await this.pauseForException(err, frame, true);
                const env = new Environment(frame.env, 'catch');
                if (c.name) env.define(c.name, err, c.type.name);
                try { await this.execBlock(c.block, frame, env); handled = true; }
                catch (inner) {
                  if (stmt.finallyBlock) await this.execBlock(stmt.finallyBlock, frame, new Environment(frame.env, 'finally'));
                  throw inner;
                }
                break;
              }
            }
            if (!handled) {
              if (stmt.finallyBlock) await this.execBlock(stmt.finallyBlock, frame, new Environment(frame.env, 'finally'));
              throw err;
            }
          }
          if (stmt.finallyBlock) await this.execBlock(stmt.finallyBlock, frame, new Environment(frame.env, 'finally'));
          return;
        }
        case 'return': {
          const v = stmt.expr ? await this.evalExpr(stmt.expr, frame) : null;
          throw new ReturnSignal(v);
        }
        case 'throw': {
          const v = await this.evalExpr(stmt.expr, frame);
          if (v instanceof ApexError) { v.apexLine = v.apexLine || stmt.line; throw v; }
          throw new ApexError('Exception', toApexString(v), stmt.line);
        }
        case 'break': throw new BreakSignal();
        case 'continue': throw new ContinueSignal();
        case 'dml': {
          const value = await this.evalExpr(stmt.expr, frame);
          await this.performDml(stmt.op, value, stmt, frame);
          return;
        }
        case 'callblock': {
          // e.g. System.runAs(user) { ... } — execute body in new scope
          try { await this.evalExpr(stmt.call, frame); } catch (e) { /* runAs itself is a no-op locally */ }
          await this.execBlock(stmt.body, frame, new Environment(frame.env, 'callblock'));
          return;
        }
        default:
          throw new ApexError('System.UnexpectedException', `Unsupported statement kind: ${stmt.kind}`, stmt.line);
      }
    }

    catchMatches(typeNode, err) {
      const tn = typeNode.name.toLowerCase().replace(/^system\./, '');
      if (tn === 'exception') return true;
      const en = String(err.apexType || '').toLowerCase().replace(/^system\./, '');
      if (en === tn) return true;
      // user exception classes: walk hierarchy
      let ci = this.registry.get(err.apexType);
      while (ci) {
        if (ci.name.toLowerCase() === tn) return true;
        ci = this.superOf(ci);
      }
      return false;
    }

    /**
     * Surface a caught exception to the host console so the user can SEE why the
     * try block exited early into catch. Without this a thrown-and-caught error is
     * invisible and looks like "the try block was skipped".
     */
    reportCaught(err, catchClause) {
      if (!this.host.log) return;
      const where = (err.apexStack && err.apexStack.length)
        ? ` at ${err.apexStack[0].className}.${err.apexStack[0].methodName} (line ${err.apexStack[0].line})`
        : (err.apexLine ? ` (line ${err.apexLine})` : '');
      const caughtAs = catchClause && catchClause.type ? catchClause.type.name : 'Exception';
      const cls = this._trackFailure(err, true);
      this.log(`⚠ Caught ${err.apexType || 'Exception'}: ${err.apexMessage || err.message || ''}${where} → handled by catch (${caughtAs}${catchClause && catchClause.name ? ' ' + catchClause.name : ''}). Execution continues in the catch block.`, 'system');
      // Honest attribution so a caught error is never mistaken for an engine bug.
      this.log(`    ${cls.icon} Cause: ${cls.label} — ${cls.advice}.`, 'system');
      if (err.apexStack && err.apexStack.length > 1) {
        this.log(err.apexStack.map(f => `      at ${f.className}.${f.methodName} (line ${f.line})`).join('\n'), 'system');
      }
    }

    typeLabel(t) {
      if (!t) return null;
      let s = t.name;
      if (t.args && t.args.length) s += '<' + t.args.map(a => this.typeLabel(a)).join(', ') + '>';
      return s;
    }

    async performDml(op, value, stmt, frame) {
      const records = Array.isArray(value) ? value : [value];
      this.pendingBackend = `DML ${op} (${records.length} record${records.length === 1 ? '' : 's'})`;
      try {
        if (this.host.dml) {
          await this.host.dml(op, value, { extField: stmt.extField || null, line: stmt.line });
        }
        // Simulate org behavior locally: assign IDs on insert
        if (op === 'insert' || op === 'upsert') {
          for (const r of records) {
            if (r && typeof r === 'object' && !sobjGet(r, 'Id')) sobjSet(r, 'Id', fakeId());
          }
        }
        this.dmlLog.push({ op, count: records.length, line: stmt.line, type: records.length && records[0] ? sobjType(records[0]) : 'SObject' });
        this.log(`DML ${op.toUpperCase()}: ${records.length} ${records.length && records[0] ? sobjType(records[0]) : 'SObject'} record(s)`, 'dml');
      } finally {
        this.pendingBackend = null;
      }
    }

    /* ================= expression evaluation ================= */
    async evalExpr(e, frame) {
      if (this.stopped) throw new StopSignal();
      if (!e) return null;
      switch (e.kind) {
        case 'lit': return e.value;
        case 'classlit': return { __typeToken: e.typeName };
        case 'this': {
          if (!frame.thisRef) throw new ApexError('System.UnexpectedException', "'this' is not available in a static context", e.line);
          return frame.thisRef;
        }
        case 'ident': return this.resolveIdent(e, frame);
        case 'soql': return this.runSoql(e, frame);
        case 'ternary': {
          const c = await this.evalExpr(e.cond, frame);
          return c === true ? this.evalExpr(e.then, frame) : this.evalExpr(e.else, frame);
        }
        case 'binary': return this.evalBinary(e, frame);
        case 'unary': {
          const v = await this.evalExpr(e.expr, frame);
          if (e.op === '!') { if (v === null) throw npe(e.line); return v !== true; }
          if (e.op === '-') { if (v === null) throw npe(e.line, 'Argument cannot be null'); return -v; }
          if (e.op === '+') return v;
          if (e.op === '~') return ~v;
          throw new ApexError('System.UnexpectedException', `Unknown unary ${e.op}`, e.line);
        }
        case 'update': {
          const old = await this.evalExpr(e.expr, frame);
          if (old === null) throw npe(e.line, 'Argument cannot be null');
          const nv = e.op === '++' ? old + 1 : old - 1;
          await this.assignTo(e.expr, nv, frame);
          return e.prefix ? nv : old;
        }
        case 'assign': {
          let v = await this.evalExpr(e.value, frame);
          if (e.op !== '=') {
            const cur = await this.evalExpr(e.target, frame);
            const binOp = e.op.slice(0, -1);      // '+=' -> '+'
            v = this.applyBinary(binOp, cur, v, e.line);
          }
          await this.assignTo(e.target, v, frame);
          return v;
        }
        case 'cast': {
          const v = await this.evalExpr(e.expr, frame);
          const tn = e.type.name.toLowerCase();
          if (v === null) return null;
          if (tn === 'integer' || tn === 'long') return Math.trunc(Number(v));
          if (tn === 'decimal' || tn === 'double') return Number(v);
          if (tn === 'string' || tn === 'id') return typeof v === 'string' ? v : toApexString(v);
          return v;
        }
        case 'instanceof': {
          const v = await this.evalExpr(e.expr, frame);
          if (v === null) return false;
          const tn = e.type.name.toLowerCase();
          let cn = typeNameOf(v);
          if (cn.toLowerCase() === tn) return true;
          let ci = this.registry.get(cn);
          while (ci) {
            if (ci.name.toLowerCase() === tn) return true;
            ci = this.superOf(ci);
          }
          if (tn === 'object' || tn === 'sobject') return true;
          return false;
        }
        case 'index': {
          const target = await this.evalExpr(e.target, frame);
          if (target === null) throw npe(e.line);
          const idx = await this.evalExpr(e.index, frame);
          if (Array.isArray(target)) {
            if (idx < 0 || idx >= target.length) throw new ApexError('System.ListException', `List index out of bounds: ${idx}`, e.line);
            return target[idx];
          }
          if (target instanceof ApexMap) return target.get(idx);
          throw new ApexError('System.TypeException', `Cannot index into ${typeNameOf(target)}`, e.line);
        }
        case 'prop': return this.evalProp(e, frame);
        case 'call': return this.evalCall(e, frame);
        case 'new': return this.evalNew(e, frame);
        case 'thiscall': {
          const ctors = frame.classInfo ? frame.classInfo.constructors() : [];
          if (!ctors.length) throw new ApexError('System.UnexpectedException', 'No constructor for this()', e.line);
          const args = await this.evalArgs(e.args, frame);
          const ctor = this.pickOverload(ctors, args);
          return this.invokeMethod(frame.classInfo, ctor, frame.thisRef, args, frame);
        }
        case 'supercall': {
          const superCi = frame.classInfo ? this.superOf(frame.classInfo) : null;
          if (!superCi) return null;
          const args = await this.evalArgs(e.args, frame);
          const ctors = superCi.constructors();
          if (!ctors.length) return null;
          const ctor = this.pickOverload(ctors, args);
          return this.invokeMethod(superCi, ctor, frame.thisRef, args, frame);
        }
        case 'super': return frame.thisRef;
        default:
          throw new ApexError('System.UnexpectedException', `Unsupported expression kind: ${e.kind}`, e.line);
      }
    }

    async evalArgs(args, frame) {
      const out = [];
      for (const a of args || []) out.push(await this.evalExpr(a, frame));
      return out;
    }

    resolveIdent(e, frame) {
      const en = frame.env ? frame.env.lookupEntry(e.name) : null;
      if (en) return en.value;
      if (frame.thisRef && frame.thisRef.hasField && frame.thisRef.hasField(e.name)) return frame.thisRef.getField(e.name);
      if (frame.classInfo && frame.classInfo.staticEnv && frame.classInfo.staticEnv.has(e.name)) return frame.classInfo.staticEnv.get(e.name);
      // Inner class referencing an ENCLOSING class's static by simple name. Walk the
      // outer chain (statics were initialized up-front by ensureStatics). This is how
      // Apex scopes unqualified names — a real constant like RemoteCPQ.LINE_ACTION_NONE
      // used inside RemoteCPQ.LineItemDO must resolve, not throw.
      for (let oc = frame.classInfo && frame.classInfo.outer; oc; oc = oc.outer) {
        if (oc.staticEnv && oc.staticEnv.has(e.name)) return oc.staticEnv.get(e.name);
      }
      const ci = this.registry.get(e.name) || (frame.classInfo ? this.registry.getInner(frame.classInfo, e.name) : null);
      if (ci) return { __classRef: ci };
      const bn = e.name.toLowerCase();
      if (BUILTIN_TYPES.has(bn)) return { __builtinRef: e.name };
      if (bn === 'trigger') return { __builtinRef: 'Trigger' };
      throw new ApexError('System.VariableDoesNotExistException', `Variable does not exist: ${e.name}`, e.line);
    }

    async evalProp(e, frame) {
      // Static access via class name?
      const target = await this.evalTargetMaybeType(e.target, frame);
      if (target === null || target === undefined) {
        if (e.safe) return null;
        throw npe(e.line, `Attempt to de-reference a null object (reading '${e.name}')`);
      }
      if (target.__classRef) {
        const ci = target.__classRef;
        await this.ensureStatics(ci);
        // enum value?
        if (ci.ast.isEnum) {
          const boxed = makeEnumValue(ci, e.name);
          if (boxed) return boxed;
        }
        // Static PROPERTY with an explicit getter — invoke it (mirrors the instance
        // getter path in memberGet). Without this the engine returns the raw backing
        // field (often null), so a null-guarding getter like
        //   static Boolean turbo_pricing { get { return x != null ? x : false; } }
        // wrongly yields null and `!Class.prop` throws a bogus NPE.
        const sowner = this.findPropOwner(ci, e.name);
        if (sowner && sowner.prop.static && sowner.prop.getter && sowner.prop.getter !== 'auto') {
          return await this.invokeStaticGetter(sowner.owner, sowner.prop, e.name);
        }
        if (ci.staticEnv.has(e.name)) return ci.staticEnv.get(e.name);
        const inner = this.registry.getInner(ci, e.name);
        if (inner) return { __classRef: inner };
        // `<Class>.class` type literal reaching here (e.g. produced dynamically): a
        // class reference's `.class` is its System.Type token, never a static member.
        if (String(e.name).toLowerCase() === 'class') return { __typeToken: ci.qualifiedName || ci.name };
        throw new ApexError('System.VariableDoesNotExistException', `Static ${ci.name}.${e.name} does not exist`, e.line);
      }
      if (target.__builtinRef) return await this.staticProp(target.__builtinRef, e.name, e.line);
      return this.memberGet(target, e.name, e.line, frame);
    }

    async memberGet(target, name, line, frame) {
      // Schema describe chain: `.fields` is accessed as a property on a
      // DescribeSObjectResult; the other handles expose no plain fields.
      if (target && typeof target === 'object' && !(target instanceof ApexObject)) {
        if (target.__labelRef) return await this.resolveLabel(name, line);
        // Schema.sObjectType.<Name> → a DescribeSObjectResult for that object. The
        // token reuses __describeResult so isAccessible()/isCreateable()/etc. resolve
        // truthfully from the org's describe. Namespaced objects resolve via retry.
        if (target.__globalDescribe) { await this.ensureDescribe(name); return { __describeResult: name }; }
        if (target.__describeResult && name.toLowerCase() === 'fields') return { __fieldsHandle: target.__describeResult };
        if (target.__sobjectType || target.__fieldsHandle || target.__sobjectField || target.__describeFieldResult || target.__typeToken) {
          // `<Type>.class` on a type/sObjectType token → its System.Type token.
          if (String(name).toLowerCase() === 'class') {
            return { __typeToken: target.__sobjectType || target.__typeToken || typeNameOf(target) };
          }
          throw new ApexError('System.VariableDoesNotExistException', `Property ${name} does not exist on ${typeNameOf(target)}`, line);
        }
      }
      if (target instanceof ApexObject) {
        const prop = this.findPropInHierarchy(target.classInfo, name);
        if (prop && prop.getter && prop.getter !== 'auto') {
          const env = new Environment(target.classInfo.staticEnv, 'getter');
          const f2 = { className: target.classInfo.name, methodName: 'get ' + name, file: target.classInfo.fileName, line: prop.line, env, thisRef: target, classInfo: target.classInfo };
          this.callStack.push(f2);
          try { await this.execBlock(prop.getter, f2, new Environment(env, 'body')); return null; }
          catch (ret) { if (ret instanceof ReturnSignal) return ret.value; throw ret; }
          finally { this.callStack.pop(); }
        }
        if (target.hasField(name)) return target.getField(name);
        const lk = name.toLowerCase();
        if (lk === 'class') return { __typeToken: target.classInfo.name };
        throw new ApexError('System.VariableDoesNotExistException', `Field ${name} does not exist on ${target.classInfo.name}`, line);
      }
      if (Array.isArray(target)) {
        if (name.toLowerCase() === 'size') return target.length; // property-style
        throw new ApexError('System.VariableDoesNotExistException', `Property ${name} does not exist on List`, line);
      }
      if (isSObject(target)) {
        const v = sobjGet(target, name);
        if (v !== undefined) return v;
        // Field is ABSENT from this record (not merely null). In real Apex this
        // either returns the queried value or throws SObjectException. Rather than
        // silently return a misleading null, ask the org for the REAL value — but
        // only when Live data is on and the record carries a real Id. This is the
        // general "any step that needs backend data fetches it" rule; it is gated
        // (falls back to null when Live is off/unavailable) and never fabricates.
        const hydrated = await this.hydrateSObjectField(target, name);
        if (hydrated === ENGINE_FIELD_ABSENT) {
          // The field genuinely does not exist on this object in the connected org
          // (installed managed-package version differs from the source). Degrade to
          // null (Apex-correct for an absent/unqueried field), record the absence
          // honestly, and remember it so a later NullPointerException from this null is
          // attributed to missing org DATA rather than to the code or the engine.
          this._noteOrgFieldAbsent(sobjType(target), name, line);
          return null;
        }
        if (hydrated !== ENGINE_UNRESOLVED) return hydrated;
        return null;
      }
      if (target instanceof ApexError) {
        return this.callErrorMethod(target, 'get' + name, [], line);
      }
      throw new ApexError('System.VariableDoesNotExistException', `Property ${name} does not exist on ${typeNameOf(target)}`, line);
    }

    findPropInHierarchy(ci, name) {
      let c = ci;
      while (c) {
        const p = c.findProp(name);
        if (p) return p;
        c = this.superOf(c);
      }
      return null;
    }

    /** Like findPropInHierarchy but also returns the class that DECLARES the property
     *  (needed so a static getter/setter runs against the right static backing env). */
    findPropOwner(ci, name) {
      let c = ci;
      while (c) {
        const p = c.findProp(name);
        if (p) return { owner: c, prop: p };
        c = this.superOf(c);
      }
      return null;
    }

    /** Invoke an explicit STATIC property getter (thisRef=null, static context). The
     *  getter's backing field is read via the static env, so a self-referencing
     *  null-guard getter resolves the backing value without re-entering the getter. */
    async invokeStaticGetter(owner, prop, name) {
      await this.ensureStatics(owner);
      const env = new Environment(owner.staticEnv, 'getter');
      const f2 = { className: owner.name, methodName: 'get ' + name, file: owner.fileName, line: prop.line, env, thisRef: null, classInfo: owner };
      this.callStack.push(f2);
      try { await this.execBlock(prop.getter, f2, new Environment(env, 'body')); return null; }
      catch (ret) { if (ret instanceof ReturnSignal) return ret.value; throw ret; }
      finally { this.callStack.pop(); }
    }

    /** Invoke an explicit STATIC property setter (thisRef=null, `value` in scope). */
    async invokeStaticSetter(owner, prop, name, value) {
      await this.ensureStatics(owner);
      const env = new Environment(owner.staticEnv, 'setter');
      env.define('value', value, null);
      const f2 = { className: owner.name, methodName: 'set ' + name, file: owner.fileName, line: prop.line, env, thisRef: null, classInfo: owner };
      this.callStack.push(f2);
      try { await this.execBlock(prop.setter, f2, new Environment(env, 'body')); }
      catch (ret) { if (!(ret instanceof ReturnSignal)) throw ret; }
      finally { this.callStack.pop(); }
    }

    async evalTargetMaybeType(t, frame) {
      if (!t) return null;
      if (t.kind === 'ident') {
        try { return this.resolveIdent(t, frame); }
        catch (err) {
          // Unknown ident used as a member target. It may be a user class whose
          // source hasn't been loaded yet (e.g. RequestParams.PARAM_X static
          // constants). Try to lazy-load it before assuming a builtin namespace,
          // otherwise its static fields resolve to null and break the code.
          if (!BUILTIN_TYPES.has(t.name.toLowerCase())) {
            const ci = await this.lazyLoadClass(t.name);
            if (ci) return { __classRef: ci };
          }
          // Dotted type like Schema.Account — treat unknown ident as builtin/namespace marker
          return { __builtinRef: t.name };
        }
      }
      if (t.kind === 'prop' && t.target && t.target.kind === 'ident') {
        // Possibly Namespace.Class (e.g. System.Math, Schema.Account)
        const outer = t.target.name.toLowerCase();
        if (outer === 'system' || outer === 'schema' || outer === 'database') {
          const ci = this.registry.get(t.name);
          if (ci) return { __classRef: ci };
          if (BUILTIN_TYPES.has(t.name.toLowerCase())) return { __builtinRef: t.name };
        }
      }
      return this.evalExpr(t, frame);
    }

    async assignTo(target, value, frame) {
      if (target.kind === 'ident') {
        if (frame.env && frame.env.set(target.name, value)) return;
        if (frame.thisRef && frame.thisRef.hasField && frame.thisRef.hasField(target.name)) { frame.thisRef.setField(target.name, value); return; }
        if (frame.classInfo && frame.classInfo.staticEnv && frame.classInfo.staticEnv.has(target.name)) { frame.classInfo.staticEnv.set(target.name, value); return; }
        // Assignment to an ENCLOSING class's static from an inner class (simple name).
        for (let oc = frame.classInfo && frame.classInfo.outer; oc; oc = oc.outer) {
          if (oc.staticEnv && oc.staticEnv.has(target.name)) { oc.staticEnv.set(target.name, value); return; }
        }
        // implicit define (shouldn't happen in valid Apex, but be forgiving)
        frame.env.define(target.name, value, null);
        return;
      }
      if (target.kind === 'prop') {
        const obj = await this.evalTargetMaybeType(target.target, frame);
        if (obj === null || obj === undefined) throw npe(target.line);
        if (obj.__classRef) {
          const ci = obj.__classRef;
          await this.ensureStatics(ci);
          // Static PROPERTY with an explicit setter — invoke it (mirrors the instance
          // setter path below) so setters with side effects / validation actually run.
          const sowner = this.findPropOwner(ci, target.name);
          if (sowner && sowner.prop.static && sowner.prop.setter && sowner.prop.setter !== 'auto') {
            await this.invokeStaticSetter(sowner.owner, sowner.prop, target.name, value);
            return;
          }
          if (!ci.staticEnv.set(target.name, value)) ci.staticEnv.define(target.name, value, null);
          return;
        }
        if (obj instanceof ApexObject) {
          const prop = this.findPropInHierarchy(obj.classInfo, target.name);
          if (prop && prop.setter && prop.setter !== 'auto') {
            const env = new Environment(obj.classInfo.staticEnv, 'setter');
            env.define('value', value, null);
            const f2 = { className: obj.classInfo.name, methodName: 'set ' + target.name, file: obj.classInfo.fileName, line: prop.line, env, thisRef: obj, classInfo: obj.classInfo };
            this.callStack.push(f2);
            try { await this.execBlock(prop.setter, f2, new Environment(env, 'body')); }
            catch (ret) { if (!(ret instanceof ReturnSignal)) throw ret; }
            finally { this.callStack.pop(); }
            return;
          }
          obj.setField(target.name, value);
          return;
        }
        if (isSObject(obj)) { sobjSet(obj, target.name, value); return; }
        throw new ApexError('System.TypeException', `Cannot assign property on ${typeNameOf(obj)}`, target.line);
      }
      if (target.kind === 'index') {
        const obj = await this.evalExpr(target.target, frame);
        if (obj === null) throw npe(target.line);
        const idx = await this.evalExpr(target.index, frame);
        if (Array.isArray(obj)) {
          if (idx < 0 || idx >= obj.length) throw new ApexError('System.ListException', `List index out of bounds: ${idx}`, target.line);
          obj[idx] = value; return;
        }
        if (obj instanceof ApexMap) { obj.put(idx, value); return; }
        throw new ApexError('System.TypeException', `Cannot index-assign into ${typeNameOf(obj)}`, target.line);
      }
      throw new ApexError('System.UnexpectedException', 'Invalid assignment target', target.line);
    }

    async evalBinary(e, frame) {
      // short-circuit
      if (e.op === '&&') {
        const l = await this.evalExpr(e.left, frame);
        if (l !== true) return false;
        return (await this.evalExpr(e.right, frame)) === true;
      }
      if (e.op === '||') {
        const l = await this.evalExpr(e.left, frame);
        if (l === true) return true;
        return (await this.evalExpr(e.right, frame)) === true;
      }
      if (e.op === '??') {
        const l = await this.evalExpr(e.left, frame);
        if (l !== null && l !== undefined) return l;
        return this.evalExpr(e.right, frame);
      }
      const l = await this.evalExpr(e.left, frame);
      const r = await this.evalExpr(e.right, frame);
      const decHint = e.op === '/' && (this.isDecimalHint(e.left, frame) || this.isDecimalHint(e.right, frame));
      return this.applyBinary(e.op, l, r, e.line, decHint);
    }

    applyBinary(op, l, r, line, decHint) {
      switch (op) {
        case '==': return apexEquals(l, r);
        case '!=': return !apexEquals(l, r);
        case '===': return l === r;
        case '!==': return l !== r;
        case '<': case '<=': case '>': case '>=': {
          if (l === null || r === null) throw npe(line, 'Argument cannot be null');
          return compareVals(l, r, op, line);
        }
        case '+': {
          if (typeof l === 'string' || typeof r === 'string') return toApexString(l) + toApexString(r);
          if (l === null || r === null) throw npe(line, 'Argument cannot be null');
          if (l instanceof ApexDate && typeof r === 'number') return l.addDays(r);
          if (l instanceof ApexDatetime && typeof r === 'number') return l.addDays(r);
          return l + r;
        }
        case '-': {
          if (l === null || r === null) throw npe(line, 'Argument cannot be null');
          if (l instanceof ApexDate && typeof r === 'number') return l.addDays(-r);
          return l - r;
        }
        case '*': {
          if (l === null || r === null) throw npe(line, 'Argument cannot be null');
          return l * r;
        }
        case '/': {
          if (l === null || r === null) throw npe(line, 'Argument cannot be null');
          if (r === 0) throw new ApexError('System.MathException', 'Divide by 0', line);
          const res = l / r;
          // Apex Integer division truncates (unless a Decimal/Double is involved)
          if (!decHint && Number.isInteger(l) && Number.isInteger(r)) return Math.trunc(res);
          return res;
        }
        case '%': {
          // Apex modulo (Integer/Long). Real Apex only allows % on integral types and
          // throws on a null operand — mirror both so results are truthful.
          if (l === null || r === null) throw npe(line, 'Argument cannot be null');
          if (r === 0) throw new ApexError('System.MathException', 'Divide by 0', line);
          return l % r;
        }
        case '&': return l & r;
        case '|': return l | r;
        case '^': return l ^ r;
        case '<<': return l << r;
        case '>>': return l >> r;
        case '>>>': return l >>> r;
        default:
          throw new ApexError('System.UnexpectedException', `Unknown operator ${op}`, line);
      }
    }

    /* ---------- SOQL (real org fetch, pauses execution) ---------- */
    // Bind values reach the host as plain JS so it can render SOQL literals. The
    // engine's own collection types (ApexSet, ApexMap) are flattened to arrays
    // here; SObjects, primitives and dates pass through for the host to format.
    normalizeBindValue(v) {
      if (v instanceof ApexSet) return v.items().map(x => this.normalizeBindValue(x));
      if (v instanceof ApexMap) return v.vals().map(x => this.normalizeBindValue(x));
      if (Array.isArray(v)) return v.map(x => this.normalizeBindValue(x));
      return v;
    }
    async runSoql(e, frame) {
      const binds = {};
      for (const b of e.binds || []) {
        try {
          const ast = Lang.parseExpression(b.expr);
          binds[b.expr] = this.normalizeBindValue(await this.evalExpr(ast, frame));
        } catch (err) { binds[b.expr] = null; }
      }      this.pendingBackend = 'SOQL query against org…';
      this.log(`SOQL → org: ${e.raw.replace(/\s+/g, ' ').trim()}`, 'soql');
      try {
        if (this.host.query) {
          const rows = await this.host.query(e.raw, binds);
          return Array.isArray(rows) ? rows : [];
        }
        return [];
      } finally {
        this.pendingBackend = null;
      }
    }

    // Resolve `:name` / `:obj.field` bind tokens in a dynamic SOQL string against
    // the current frame's scope (mirrors inline [SELECT ...] bind resolution).
    async resolveScopeBinds(raw, frame) {
      const binds = {};
      const re = /:\s*([A-Za-z_]\w*(?:\.\w+)*)/g;
      let m;
      const seen = new Set();
      while ((m = re.exec(String(raw || '')))) {
        const expr = m[1];
        if (seen.has(expr)) continue;
        seen.add(expr);
        try {
          const ast = Lang.parseExpression(expr);
          binds[expr] = this.normalizeBindValue(await this.evalExpr(ast, frame));
        } catch (_) { binds[expr] = null; }
      }
      return binds;
    }

    /* ---------- calls ---------- */
    // Resilient wrapper: an engine gap or internal crash on a single call must not
    // kill the session — degrade to null so the surrounding statement keeps
    // computing, while faithful Apex exceptions still propagate to user try/catch.
    async evalCall(e, frame) {
      try {
        return await this._evalCallRaw(e, frame);
      } catch (err) {
        if (!this._shouldDegrade(err)) throw err;
        this._recordGap(err, { line: e.line, file: frame && frame.file, what: `call ${e.name}()` });
        return null;
      }
    }

    async _evalCallRaw(e, frame) {
      // Unqualified call: method on this / current class statics
      if (!e.target) {
        const argHints = this._argHints(e.args, frame);
        const args = await this.evalArgs(e.args, frame);
        if (frame.classInfo) {
          const { ci, m } = this.findMethodInHierarchy(frame.classInfo, e.name, args, false, argHints);
          if (m) return this.invokeMethod(ci, m, m.static ? null : frame.thisRef, args, frame);
          // An inner class can call its ENCLOSING class's STATIC methods by simple
          // name — a nested Apex class has no implicit outer instance, so only
          // statics are in scope. Walk the enclosing chain, mirroring the same
          // outer-static resolution already done for identifier reads (resolveIdent)
          // and assignments (assignTo). Without this, e.g. `createCartInfo(cfg)`
          // inside PriceSupport.PricingContext throws NoSuchMethodException, degrades
          // to null, and the caller then NPEs on `cartInfo.cartItems`.
          for (let oc = frame.classInfo.outer; oc; oc = oc.outer) {
            const { ci: oci, m: om } = this.findMethodInHierarchy(oc, e.name, args, true, argHints);
            if (om && om.static) { await this.ensureStatics(oci); return this.invokeMethod(oci, om, null, args, frame); }
          }
        }
        throw new ApexError('System.NoSuchMethodException', `Method ${e.name}(${args.length} args) not found`, e.line);
      }
      const target = await this.evalTargetMaybeType(e.target, frame);
      if (target === null || target === undefined) {
        if (e.safe) return null;
        throw npe(e.line, `Attempt to de-reference a null object (calling '${e.name}')`);
      }
      const argHints = this._argHints(e.args, frame);
      const args = await this.evalArgs(e.args, frame);
      if (target.__classRef) {
        const ci = target.__classRef;
        const { ci: foundCi, m } = this.findMethodInHierarchy(ci, e.name, args, true, argHints);
        if (m) {
          if (m.static) return this.invokeMethod(foundCi, m, null, args, frame);
          throw new ApexError('System.TypeException', `Non-static method ${e.name} called statically on ${ci.name}`, e.line);
        }
        // enum helpers
        if (ci.ast.isEnum && e.name.toLowerCase() === 'values') return enumValuesOf(ci);
        throw new ApexError('System.NoSuchMethodException', `Static method ${ci.name}.${e.name} not found`, e.line);
      }
      if (target.__builtinRef) return this.callStaticBuiltin(target.__builtinRef, e.name, args, e.line, frame);
      if (e.target.kind === 'super' && frame.classInfo) {
        const superCi = this.superOf(frame.classInfo);
        if (superCi) {
          const { ci: fci, m } = this.findMethodInHierarchy(superCi, e.name, args, false, argHints);
          if (m) return this.invokeMethod(fci, m, frame.thisRef, args, frame);
        }
      }
      // Truthful type-aware dispatch for values the engine carries as PLAIN objects
      // (DO/wrapper instances and collections deserialized from org/request data).
      // Runtime shape alone can't tell a Map from an SObject — both look like {} — so
      // we recover the receiver's DECLARED type from the source and dispatch correctly,
      // instead of treating everything as a bare SObject (which fabricates a null for
      // any unrecognized method and causes a MISLEADING downstream error, e.g.
      // `chargeLine.extensionAttributes.values()` → "iterate over null", or
      // `lineItemDO.primaryLineItemSO()` → NPE). We only run real Apex over the real
      // field data the object already holds; nothing is invented.
      if (isSObject(target) && !(target && target.__typeToken)) {
        const stype = (target && target.__apexClass) || this._staticTypeOfExpr(e.target, frame);
        // (a) A collection field held as a plain object/array → coerce to the REAL
        //     Apex collection so Map/Set/List methods (values/keySet/get/…) work.
        const coerced = this._coercePlainToApexCollection(target, stype);
        if (coerced instanceof ApexMap) return this.callMapMethod(coerced, e.name, args, e.line);
        if (coerced instanceof ApexSet) return this.callSetMethod(coerced, e.name, args, e.line);
        if (Array.isArray(coerced)) return this.callListMethod(coerced, e.name, args, e.line);
        // (b) A user-class DO/wrapper held as a plain object → run its REAL method.
        const uci = await this._userClassFromTypeName(stype, frame);
        if (uci) {
          const { ci: fci, m } = this.findMethodInHierarchy(uci, e.name, args, false, argHints);
          if (m && !m.static) {
            return this.invokeMethod(fci, m, this._boxPlainAsApexObject(target, uci), args, frame);
          }
        }
      }
      return this.callInstanceMethod(target, e.name, args, e.line, frame, argHints);
    }

    /**
     * Best-effort STATIC type label of an expression, read from declared types in the
     * source — never guessed from runtime shape. Powers truthful dispatch of values
     * the engine holds as plain objects. Handles identifiers (local/param/loop vars,
     * this-fields, static fields), member access (a.b → declared type of field b on
     * a's class), casts, `new`, `this`, and index (list element / map value). Returns
     * a label like "Map<String, SObject>" or "RemoteCPQ.LineItemDO", or null.
     */
    _staticTypeOfExpr(expr, frame) {
      if (!expr || !frame) return null;
      switch (expr.kind) {
        case 'ident': {
          const en = frame.env && frame.env.lookupEntry ? frame.env.lookupEntry(expr.name) : null;
          if (en && en.type) return en.type;
          if (frame.classInfo && frame.classInfo.findField) {
            const f = frame.classInfo.findField(expr.name);
            if (f && f.type) return this.typeLabel(f.type);
          }
          return null;
        }
        case 'this':
          return frame.classInfo ? frame.classInfo.qualifiedName : null;
        case 'cast':
          return expr.type ? this.typeLabel(expr.type) : null;
        case 'new':
          return expr.type ? this.typeLabel(expr.type) : null;
        case 'prop': {
          const ownerType = this._staticTypeOfExpr(expr.target, frame);
          if (!ownerType) return null;
          const ci = this.registry.get(ownerType)
            || (frame.classInfo ? this.registry.getInner(frame.classInfo, ownerType) : null);
          if (!ci) return null;
          const f = ci.findField && ci.findField(expr.name);
          if (f && f.type) return this.typeLabel(f.type);
          const p = ci.findProp && ci.findProp(expr.name);
          if (p && p.type) return this.typeLabel(p.type);
          return null;
        }
        case 'index': {
          const ct = this._staticTypeOfExpr(expr.target, frame);
          if (!ct) return null;
          let mm = /^List\s*<\s*(.+)\s*>$/i.exec(ct) || /^(.+)\[\]$/.exec(ct);
          if (mm) return mm[1].trim();
          mm = /^Map\s*<\s*[^,]+,\s*(.+)\s*>$/i.exec(ct);
          if (mm) return mm[1].trim();
          return null;
        }
        default:
          return null;
      }
    }

    /**
     * Coerce a plain object/array that is really an Apex collection (per its declared
     * type) into the proper ApexMap/ApexSet/array, so real collection methods run. The
     * coerced collection is cached on the value for stable identity + mutation across
     * calls. Returns null when the type isn't a collection or the shape doesn't match.
     * Only the data the value already carries is exposed — nothing is fabricated.
     */
    _coercePlainToApexCollection(value, typeStr) {
      if (!typeStr || value == null || typeof value !== 'object') return null;
      // Engine marker objects (describe chain, URL, global describe, type tokens…)
      // are NOT collections even when their declared type is Map/List/Set — coercing
      // them would turn the marker into a junk collection keyed by its internal
      // fields. Leave them for the marker-aware dispatch in callInstanceMethod.
      if (value.__globalDescribeMap || value.__url || value.__sobjectType || value.__describeResult
        || value.__fieldsHandle || value.__sobjectField || value.__describeFieldResult
        || value.__picklistEntry || value.__displayType || value.__pattern || value.__matcher
        || value.__typeToken || value.__labelRef || value.__globalDescribe) return null;
      const t = String(typeStr).trim();
      if (/^Map\s*</i.test(t)) {
        if (value instanceof ApexMap) return value;
        if (Array.isArray(value)) return null;
        if (value.__apexColl instanceof ApexMap) return value.__apexColl;
        const m = new ApexMap();
        for (const k of Object.keys(value)) {
          if (k === 'attributes' || k === '__apexBox' || k === '__apexClass' || k === '__apexColl') continue;
          m.put(k, value[k]);
        }
        this._cacheColl(value, m);
        return m;
      }
      if (/^Set\s*</i.test(t)) {
        if (value instanceof ApexSet) return value;
        if (!Array.isArray(value)) return null;
        if (value.__apexColl instanceof ApexSet) return value.__apexColl;
        const s = ApexSet.from(value);
        this._cacheColl(value, s);
        return s;
      }
      if (/^List\s*</i.test(t) || /\[\]$/.test(t)) {
        return Array.isArray(value) ? value : null;
      }
      return null;
    }

    _cacheColl(value, coll) {
      try { Object.defineProperty(value, '__apexColl', { value: coll, enumerable: false, configurable: true, writable: true }); }
      catch (_) { /* frozen — coercion still works, just recomputed next time */ }
    }

    /**
     * Resolve a type-name string to a loaded user-class ClassInfo, or null. Negative-
     * cached (cleared on loadSource) so ordinary SObject/primitive receivers don't pay
     * a repeated async lazy-load. Lets the engine run a DO/wrapper's REAL method body
     * instead of the fabricated-null SObject fallback.
     */
    async _userClassFromTypeName(typeName, frame) {
      if (!typeName) return null;
      const t = String(typeName).trim();
      if (!this._nonUserTypeCache) this._nonUserTypeCache = new Set();
      const key = t.toLowerCase();
      if (this._nonUserTypeCache.has(key)) return null;
      let ci = this.registry.get(t)
        || (frame && frame.classInfo ? this.registry.getInner(frame.classInfo, t) : null);
      if (!ci) ci = await this.lazyLoadClass(t);
      if (!ci) { this._nonUserTypeCache.add(key); return null; }
      return ci;
    }

    /**
     * Box a plain object as an ApexObject of class `ci` so its REAL user-class
     * methods can run (they read/write fields via this.<field>). Field values are
     * shared by reference; the box is cached on the plain object so mutations
     * persist across calls within the session. No data is fabricated — only the
     * fields the object already carries are exposed.
     */
    _boxPlainAsApexObject(plain, ci) {
      if (plain.__apexBox && plain.__apexBox.classInfo === ci) return plain.__apexBox;
      const obj = new ApexObject(ci);
      for (const k of Object.keys(plain)) {
        if (k === 'attributes' || k === '__apexBox' || k === '__apexClass') continue;
        obj.setField(k, plain[k]);
      }
      obj.__backing = plain;
      try {
        Object.defineProperty(plain, '__apexBox', { value: obj, enumerable: false, configurable: true, writable: true });
      } catch (_) { /* frozen object — box still works, just not cached */ }
      return obj;
    }

    /**
     * Type-directed JSON deserialization — the truthful equivalent of Apex
     * `JSON.deserialize(jsonString, ApexType.class)` (and `deserializeStrict`).
     * Reconstructs a fully TYPED value from already-parsed JSON, driven entirely by
     * the declared type metadata the engine already holds (class fields/props + their
     * AST types). It is fully general — nothing is hardcoded to any class:
     *   - user classes (including inner / namespaced) → a real ApexObject with each
     *     member recursively deserialized to its DECLARED field/property type;
     *   - List<E> / E[] → array of E; Set<E> → ApexSet; Map<K,V> → ApexMap (keys
     *     coerced to K, values to V);
     *   - enums → the matching enum constant;
     *   - primitives (String/Id/Integer/Long/Decimal/Double/Boolean/Date/Datetime/Blob);
     *   - SObjects / unknown object types → an SObject-shaped record.
     * Absent members default to null (exactly as Apex does). No data is fabricated —
     * only what the JSON actually carries is materialised.
     */
    async deserializeTyped(plain, typeStr, frame) {
      if (!typeStr) return unjsonify(plain);
      const t = String(typeStr).trim();
      const low = t.toLowerCase();

      // `Object` / untyped → leave as an untyped map/list (Apex behaviour).
      if (low === 'object' || low === 'sobject') {
        if (plain === null || plain === undefined) return null;
        return low === 'sobject' && plain && typeof plain === 'object' && !Array.isArray(plain)
          ? this._jsonToRecord(plain, t) : unjsonify(plain);
      }
      if (plain === null || plain === undefined) return null;

      // ---- primitives / scalars ----
      switch (low) {
        case 'string': case 'id':
          return typeof plain === 'string' ? plain : toApexString(plain);
        case 'integer': case 'long':
          return typeof plain === 'number' ? Math.trunc(plain) : (plain === '' ? null : Math.trunc(Number(plain)));
        case 'decimal': case 'double':
          return typeof plain === 'number' ? plain : (plain === '' ? null : Number(plain));
        case 'boolean':
          return typeof plain === 'boolean' ? plain : (plain === 'true' ? true : plain === 'false' ? false : !!plain);
        case 'blob':
          return plain;
        case 'date': {
          if (typeof plain === 'string') { const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(plain); if (mm) return new ApexDate(+mm[1], +mm[2], +mm[3]); }
          return plain;
        }
        case 'datetime': case 'time': {
          if (typeof plain === 'string') { const d = new Date(plain); if (!isNaN(d.getTime())) return new ApexDatetime(d); }
          return plain;
        }
      }

      // ---- generic collections ----
      let m = /^list\s*<\s*([\s\S]+)\s*>$/i.exec(t) || /^([\s\S]+)\[\]$/.exec(t);
      if (m) {
        const elemType = m[1].trim();
        const arr = Array.isArray(plain) ? plain
          : (plain && typeof plain === 'object' && Array.isArray(plain.records) ? plain.records : null);
        if (!arr) return unjsonify(plain);
        const out = [];
        for (const el of arr) out.push(await this.deserializeTyped(el, elemType, frame));
        return out;
      }
      m = /^set\s*<\s*([\s\S]+)\s*>$/i.exec(t);
      if (m) {
        const elemType = m[1].trim();
        const arr = Array.isArray(plain) ? plain : [];
        const s = new ApexSet();
        for (const el of arr) s.add(await this.deserializeTyped(el, elemType, frame));
        return s;
      }
      m = /^map\s*<\s*([^,]+),\s*([\s\S]+)\s*>$/i.exec(t);
      if (m) {
        const keyType = m[1].trim(), valType = m[2].trim();
        const map = new ApexMap();
        if (plain && typeof plain === 'object' && !Array.isArray(plain)) {
          for (const k of Object.keys(plain)) {
            map.put(this._coerceMapKey(k, keyType), await this.deserializeTyped(plain[k], valType, frame));
          }
        }
        return map;
      }

      // ---- user class / enum ----
      const ci = await this._userClassFromTypeName(t, frame);
      if (ci) {
        if (ci.ast && ci.ast.isEnum) {
          const sv = plain instanceof ApexEnumValue ? plain.enumName
                   : (typeof plain === 'string' ? plain : String(plain));
          return makeEnumValue(ci, sv) || sv;
        }
        const obj = new ApexObject(ci);
        // Apex reflectively instantiates without a constructor; absent members = null.
        for (const [nm] of this._instanceMembersOf(ci)) obj.setField(nm, null);
        if (plain && typeof plain === 'object' && !Array.isArray(plain)) {
          for (const k of Object.keys(plain)) {
            if (k === 'attributes') continue;
            const decl = this._declaredMember(ci, k);
            const ft = decl && decl.type ? this.typeLabel(decl.type) : null;
            const nm = decl ? decl.name : k;
            obj.setField(nm, await this.deserializeTyped(plain[k], ft, frame));
          }
        }
        return obj;
      }

      // ---- SObject / unknown object type → SObject-shaped record ----
      if (plain && typeof plain === 'object' && !Array.isArray(plain)) return this._jsonToRecord(plain, t);
      if (Array.isArray(plain)) return plain.map(x => unjsonify(x));
      return plain;
    }

    /** Recursively materialise plain JSON as an SObject-shaped record (plain objects
     *  stay plain objects — never ApexMap — so isSObject()/field access work). */
    _jsonToRecord(v, typeName) {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(x => this._jsonToRecord(x, null));
      const o = {};
      for (const k of Object.keys(v)) o[k] = this._jsonToRecord(v[k], null);
      if (typeName && !o.attributes) o.attributes = { type: typeName };
      return o;
    }

    /** Coerce a JSON string key to the declared Map key type. */
    _coerceMapKey(k, keyType) {
      const kt = String(keyType || '').trim().toLowerCase();
      if (kt === 'integer' || kt === 'long') { const n = Number(k); return Number.isNaN(n) ? k : Math.trunc(n); }
      if (kt === 'decimal' || kt === 'double') { const n = Number(k); return Number.isNaN(n) ? k : n; }
      if (kt === 'boolean') return k === 'true' ? true : (k === 'false' ? false : k);
      return k; // String / Id / enum / SObjectType key etc.
    }

    /** Find a declared instance field or property (walking the superclass chain). */
    _declaredMember(ci, name) {
      const lk = String(name).toLowerCase();
      let c = ci;
      while (c && c.ast) {
        const f = (c.ast.fields || []).find(x => !x.static && x.name.toLowerCase() === lk);
        if (f) return f;
        const p = (c.ast.props || []).find(x => !x.static && x.name.toLowerCase() === lk);
        if (p) return p;
        c = this.superOf(c);
      }
      return null;
    }

    /** All declared instance members (fields + props) across the hierarchy. */
    _instanceMembersOf(ci) {
      const out = [];
      let c = ci;
      while (c && c.ast) {
        for (const f of c.ast.fields || []) if (!f.static) out.push([f.name, f.type]);
        for (const p of c.ast.props || []) if (!p.static) out.push([p.name, p.type]);
        c = this.superOf(c);
      }
      return out;
    }

    findMethodInHierarchy(ci, name, args, staticsOnly, argHints) {
      let c = ci;
      while (c) {
        const ms = c.findMethods(name);
        if (ms.length) {
          const m = this.pickOverload(ms, args, argHints);
          return { ci: c, m };
        }
        c = this.superOf(c);
      }
      return { ci: null, m: null };
    }

    async callInstanceMethod(target, name, args, line, frame, argHints) {
      // System.Type handle (from Type.forName(...) / SomeType.class): support the
      // reflection primitives natively so patterns like
      //   Type t = Type.forName(name); SObject so = (SObject) t.newInstance();
      // execute in the engine instead of falling through to org eval (which can't
      // rebuild a runtime object). Handled BEFORE isSObject, since {__typeToken}
      // is a plain object that would otherwise be mistaken for an SObject.
      if (target && target.__typeToken) {
        return await this.callTypeTokenMethod(target, name, args, line, frame);
      }
      // Schema describe chain handles (Schema.SObjectType / DescribeSObjectResult /
      // SObjectField / DescribeFieldResult). These are plain objects, so they must
      // be intercepted BEFORE the isSObject branch below. Field metadata is resolved
      // from the connected org (real names/labels) — never fabricated.
      if (target && typeof target === 'object') {
        if (target.__sobjectType) return await this.callSObjectTypeMethod(target, name, args, line, frame);
        if (target.__describeResult) return await this.callDescribeResultMethod(target, name, args, line, frame);
        if (target.__fieldsHandle) return await this.callFieldsHandleMethod(target, name, args, line, frame);
        if (target.__sobjectField) return this.callSObjectFieldMethod(target, name, args, line, frame);
        if (target.__describeFieldResult) return this.callDescribeFieldResultMethod(target, name, args, line, frame);
        if (target.__picklistEntry) return this.callPicklistEntryMethod(target, name, args, line);
        if (target.__displayType) return this.callDisplayTypeMethod(target, name, args, line);
        if (target.__pattern) return this.callPatternMethod(target, name, args, line);
        if (target.__matcher) return this.callMatcherMethod(target, name, args, line);
        if (target.__url) return await this.callUrlMethod(target, name, args, line, frame);
        if (target.__globalDescribeMap) return await this.callGlobalDescribeMethod(target, name, args, line);
      }
      if (target instanceof ApexObject) {
        const { ci, m } = this.findMethodInHierarchy(target.classInfo, name, args, false, argHints);
        if (m) return this.invokeMethod(ci, m, target, args, frame);
        // fallthrough: maybe common Object methods
        const lk = name.toLowerCase();
        if (lk === 'tostring') return toApexString(target);
        if (lk === 'equals') return apexEquals(target, args[0]);
        if (lk === 'hashcode') return identityId(target);
        if (lk === 'getclass') return { __typeToken: target.classInfo.name };
        throw new ApexError('System.NoSuchMethodException', `Method ${target.classInfo.name}.${name} not found`, line);
      }
      if (typeof target === 'string') return this.callStringMethod(target, name, args, line);
      if (typeof target === 'number') return this.callNumberMethod(target, name, args, line);
      if (typeof target === 'boolean') {
        if (name.toLowerCase() === 'tostring') return target ? 'true' : 'false';
        throw new ApexError('System.NoSuchMethodException', `Boolean.${name} not supported`, line);
      }
      if (Array.isArray(target)) return this.callListMethod(target, name, args, line);
      if (target instanceof ApexMap) return this.callMapMethod(target, name, args, line);
      if (target instanceof ApexSet) return this.callSetMethod(target, name, args, line);
      if (target instanceof ApexJsonGenerator) return this.callJsonGeneratorMethod(target, name, args, line);
      if (target instanceof ApexJsonParser) return await this.callJsonParserMethod(target, name, args, line, frame);
      if (target instanceof ApexDate) return this.callDateMethod(target, name, args, line);
      if (target instanceof ApexDatetime) return this.callDatetimeMethod(target, name, args, line);
      if (target instanceof ApexTime) return this.callTimeMethod(target, name, args, line);
      if (target instanceof ApexBlob) return this.callBlobMethod(target, name, args, line);
      if (target instanceof ApexEnumValue) {
        switch (name.toLowerCase()) {
          case 'name': return target.enumName;
          case 'ordinal': return target.enumOrdinal;
          case 'tostring': return target.enumName;
          case 'equals': return apexEquals(target, args[0]);
          case 'hashcode': return target.enumOrdinal;
        }
        this._noteGap(`Enum ${target.enumClass}.${name}() is not a standard enum method (only name/ordinal/equals/hashCode exist)`, 'engine-gap', { line, what: 'instance call' });
        return null;
      }
      if (target instanceof ApexError) return this.callErrorMethod(target, name, args, line);
      if (target instanceof ApexDomDocument) return this.callDomDocumentMethod(target, name, args, line);
      if (target instanceof ApexXmlnode) return this.callXmlnodeMethod(target, name, args, line);
      if (isSObject(target)) return this.callSObjectMethod(target, name, args, line);
      throw new ApexError('System.NoSuchMethodException', `Method ${name} not found on ${typeNameOf(target)}`, line);
    }

    /**
     * Methods on a System.Type handle (produced by Type.forName / X.class).
     * newInstance() builds a real instance: a user class is instantiated via its
     * no-arg constructor; any other name is treated as an SObject type and yields
     * an empty SObject (`{attributes:{type:name}}`) — matching how CPQ code uses
     * `(SObject) Type.forName(name).newInstance()`. No fabricated field data.
     */
    async callTypeTokenMethod(tok, name, args, line, frame) {
      const typeName = tok.__typeToken;
      const lk = name.toLowerCase();
      if (lk === 'newinstance') {
        let ci = this.registry.get(typeName)
          || (frame && frame.classInfo ? this.registry.getInner(frame.classInfo, typeName) : null)
          || await this.lazyLoadClass(typeName);
        if (ci && !ci.ast.isEnum) return this.instantiate(ci, [], null, line);
        // Not a user class → an SObject type. Return an empty SObject of that type.
        return { attributes: { type: typeName } };
      }
      if (lk === 'getname') return typeName;
      if (lk === 'tostring') return typeName;
      if (lk === 'equals') { const o = args[0]; return !!(o && o.__typeToken && String(o.__typeToken).toLowerCase() === String(typeName).toLowerCase()); }
      if (lk === 'hashcode') return String(typeName).length;
      throw new ApexError('System.NoSuchMethodException', `Method Type.${name} not supported`, line);
    }

    /* ---------- Schema describe chain (real org metadata) ---------- */
    /** Fetch + cache real field metadata for an SObject from the connected org. */
    async ensureDescribe(name) {
      if (!this._descCache) this._descCache = new Map();
      const key = String(name).toLowerCase();
      if (this._descCache.has(key)) return this._descCache.get(key);
      let info = { name, names: [], fieldMeta: new Map(), objMeta: null, label: name, prefix: '', plural: name, error: null, resolved: false };
      if (this.host.describeSObject) {
        this.pendingBackend = `describe ${name} from org…`;
        try {
          const r = await this.host.describeSObject(name);
          const fields = r && Array.isArray(r.fields) ? r.fields : null;
          const names = fields ? fields.map(f => f && f.name).filter(Boolean)
                               : (r && Array.isArray(r.names) ? r.names : []);
          if (names.length) {
            const fieldMeta = new Map();
            if (fields) for (const f of fields) { if (f && f.name) fieldMeta.set(String(f.name).toLowerCase(), f); }
            info = { name, names, fieldMeta, objMeta: (r && r.obj) || null, label: (r && r.label) || name, prefix: (r && r.prefix) || '', plural: (r && r.plural) || name, error: null, resolved: true };
          } else if (r && r.error) { info.error = r.error; }
        } catch (e) { info.error = e && e.message; }
        finally { this.pendingBackend = null; }
      }
      this._descCache.set(key, info);
      return info;
    }
    async callSObjectTypeMethod(tok, name, args, line, frame) {
      const nm = tok.__sobjectType; const lk = name.toLowerCase();
      if (lk === 'getdescribe') { await this.ensureDescribe(nm); return { __describeResult: nm }; }
      if (lk === 'newsobject') return { attributes: { type: nm } };
      if (lk === 'getname' || lk === 'tostring') return nm;
      if (lk === 'equals') { const o = args[0]; return !!(o && o.__sobjectType && String(o.__sobjectType).toLowerCase() === String(nm).toLowerCase()); }
      if (lk === 'hashcode') return String(nm).length;
      this.log(`⚠ Schema.SObjectType.${name}() not simulated — returning null`, 'system');
      return null;
    }
    async callDescribeResultMethod(tok, name, args, line, frame) {
      const nm = tok.__describeResult; const info = await this.ensureDescribe(nm); const lk = name.toLowerCase();
      if (lk === 'getname') return nm;
      if (lk === 'getlocalname') return stripNs(nm);
      if (lk === 'getlabel') return info.label;
      if (lk === 'getlabelplural') return info.plural;
      if (lk === 'getkeyprefix') return info.prefix || null;
      if (lk === 'getsobjecttype') return { __sobjectType: nm };
      if (lk === 'fields' || lk === 'getfields') return { __fieldsHandle: nm };
      if (lk === 'tostring') return nm;
      const om = info.objMeta || null;
      if (lk === 'iscustom') return om ? !!om.custom : /__c$/i.test(nm);
      if (lk === 'iscustomsetting') return om ? !!om.customSetting : false;
      if (lk === 'isfeedenabled') return om ? !!om.feedEnabled : false;
      if (lk === 'ismergeenabled' || lk === 'ismergeable') return om ? !!om.mergeable : false;
      if (lk === 'isdeprecatedandhidden') return false;
      // Object-level CRUD/accessibility. Truthful: reflects the connected user's
      // REAL permissions from the org describe, so genuine permission gates fire
      // (surfacing "you lack access to X" the way the user actually hits it). Only
      // when describe data is unavailable do we fall back to true (never wrongly
      // block a guarded path on missing data).
      if (lk === 'isaccessible') return om ? !!om.accessible : true;
      if (lk === 'iscreateable') return om ? !!om.createable : true;
      if (lk === 'isupdateable') return om ? !!om.updateable : true;
      if (lk === 'isdeletable') return om ? !!om.deletable : true;
      if (lk === 'isundeletable') return om ? !!om.undeletable : true;
      if (lk === 'isqueryable') return om ? !!om.queryable : true;
      if (lk === 'issearchable') return om ? !!om.searchable : true;
      this.log(`⚠ DescribeSObjectResult.${name}() not simulated — returning null`, 'system');
      return null;
    }
    async callFieldsHandleMethod(tok, name, args, line, frame) {
      const nm = tok.__fieldsHandle; const info = await this.ensureDescribe(nm); const lk = name.toLowerCase();
      if (lk === 'getmap') {
        // Apex Schema fields.getMap() keys are lowercased field names; the values
        // (SObjectField) carry the real API name via getDescribe().getName().
        const m = new ApexMap();
        for (const fn of info.names) m.put(String(fn).toLowerCase(), { __sobjectField: { sobject: nm, field: fn } });
        return m;
      }
      this.log(`⚠ Schema fields.${name}() not simulated — returning null`, 'system');
      return null;
    }
    callSObjectFieldMethod(tok, name, args, line) {
      const f = tok.__sobjectField; const lk = name.toLowerCase();
      if (lk === 'getdescribe') return { __describeFieldResult: f };
      if (lk === 'getsobjectfield') return tok;
      if (lk === 'getname' || lk === 'tostring') return f.field;
      this.log(`⚠ Schema.SObjectField.${name}() not simulated — returning null`, 'system');
      return null;
    }
    async callDescribeFieldResultMethod(tok, name, args, line) {
      const f = tok.__describeFieldResult; const lk = name.toLowerCase();
      // Real field metadata from the connected org (populated when fields.getMap()
      // ran). Never fabricated: unknown → fall through to the warning + null.
      const info = await this.ensureDescribe(f.sobject);
      const meta = (info.fieldMeta && info.fieldMeta.get(String(f.field).toLowerCase())) || null;
      const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
      if (lk === 'getname' || lk === 'tostring') return (meta && meta.name) || f.field;
      if (lk === 'getlocalname') return stripNs((meta && meta.name) || f.field);
      if (lk === 'getlabel') return (meta && meta.label != null) ? meta.label : f.field;
      if (lk === 'getsobjecttype') return f.sobject;
      // getType() → Schema.DisplayType enum token; `.name()` yields e.g. STRING/
      // CURRENCY/REFERENCE. meta.type is the real DisplayType name from the org.
      if (lk === 'gettype') return (meta && meta.type) ? { __displayType: String(meta.type).toUpperCase() } : null;
      if (lk === 'getprecision') return meta ? num(meta.precision) : 0;
      if (lk === 'getscale') return meta ? num(meta.scale) : 0;
      if (lk === 'getlength' || lk === 'getbytelength' || lk === 'getdigits') return meta ? num(meta.length) : 0;
      if (lk === 'ishtmlformatted') return !!(meta && meta.html);
      if (lk === 'iscalculated') return !!(meta && meta.calc);
      if (lk === 'getdefaultvalue') return (meta && meta.defaultValue !== undefined) ? meta.defaultValue : null;
      if (lk === 'getreferenceto') return (meta && Array.isArray(meta.referenceTo)) ? meta.referenceTo.map(t => ({ __sobjectType: t })) : [];
      if (lk === 'getrelationshipname') return (meta && meta.relationshipName != null) ? meta.relationshipName : null;
      if (lk === 'getpicklistvalues') return (meta && Array.isArray(meta.picklist)) ? meta.picklist.map(p => ({ __picklistEntry: p })) : [];
      if (lk === 'isnamefield') return !!(meta && meta.nameField);
      if (lk === 'isunique') return !!(meta && meta.unique);
      if (lk === 'isexternalid') return !!(meta && meta.externalId);
      if (lk === 'isnillable') return meta ? !!meta.nillable : true;
      if (lk === 'isupdateable') return meta ? !!meta.updateable : true;
      if (lk === 'iscreateable') return meta ? !!meta.createable : true;
      if (lk === 'issortable') return meta ? !!meta.sortable : true;
      if (lk === 'isfilterable') return meta ? !!meta.filterable : true;
      if (lk === 'isaccessible') return true;
      if (lk === 'iscustom') return meta ? !!meta.custom : /__c$/i.test(f.field);
      this.log(`⚠ DescribeFieldResult.${name}() not simulated — returning null`, 'system');
      return null;
    }
    // Schema.PicklistEntry (from DescribeFieldResult.getPicklistValues()). Backed by
    // the real picklist metadata reported by the org.
    callPicklistEntryMethod(tok, name, args, line) {
      const p = tok.__picklistEntry || {}; const lk = name.toLowerCase();
      if (lk === 'getlabel') return p.label != null ? p.label : null;
      if (lk === 'getvalue' || lk === 'tostring') return p.value != null ? p.value : null;
      if (lk === 'isactive') return !!p.active;
      if (lk === 'isdefaultvalue') return !!p.default;
      this.log(`⚠ Schema.PicklistEntry.${name}() not simulated — returning null`, 'system');
      return null;
    }
    // Schema.DisplayType enum value (from DescribeFieldResult.getType()). Backed by
    // the real type name reported by the org; `.name()` matches Apex semantics.
    callDisplayTypeMethod(tok, name, args, line) {
      const dt = String(tok.__displayType); const lk = name.toLowerCase();
      if (lk === 'name' || lk === 'tostring') return dt;
      if (lk === 'ordinal') return 0;
      if (lk === 'equals') { const o = args[0]; return !!(o && o.__displayType && String(o.__displayType).toUpperCase() === dt.toUpperCase()); }
      if (lk === 'hashcode') return dt.length;
      this.log(`⚠ Schema.DisplayType.${name}() not simulated — returning null`, 'system');
      return null;
    }

    /* ---------- java.util.regex Pattern / Matcher (native) ---------- */
    callPatternMethod(target, name, a, line) {
      const p = target.__pattern;
      const n = String(name).toLowerCase();
      switch (n) {
        case 'split': return this.patternSplit(p, a[0] == null ? '' : a[0], a.length > 1 ? a[1] : 0);
        case 'matcher': return { __matcher: { p, input: String(a[0] == null ? '' : a[0]), re: new RegExp(p.source, p.flags.replace('g', '') + 'gd'), last: null } };
        case 'pattern': case 'tostring': return p.original;
      }
      throw new ApexError('System.NoSuchMethodException', `Pattern.${name} not supported`, line);
    }

    /** Java Pattern.split — split by regex; with limit 0 (default) trailing empty
     *  strings are removed, exactly like java.util.regex.Pattern.split. */
    patternSplit(p, input, limit) {
      const s = String(input);
      const re = new RegExp(p.source, p.flags.replace('g', '') + 'g');
      const lim = (limit == null) ? 0 : (limit | 0);
      const out = [];
      let last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(s)) !== null) {
        if (lim > 0 && out.length === lim - 1) break;
        // A zero-width match at position 0 would yield a spurious leading empty.
        if (m.index === 0 && m[0].length === 0) { re.lastIndex++; continue; }
        out.push(s.substring(last, m.index));
        last = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++; // avoid stalling on zero-width matches
      }
      out.push(s.substring(last));
      if (lim === 0) { while (out.length && out[out.length - 1] === '') out.pop(); }
      return out;
    }

    callMatcherMethod(target, name, a, line) {
      const M = target.__matcher;
      const n = String(name).toLowerCase();
      const noMatch = () => { throw new ApexError('System.StringException', 'No match available. Call find(), matches(), or lookingAt() first.', line); };
      switch (n) {
        case 'find': {
          if (a.length && a[0] != null) M.re.lastIndex = a[0] | 0;
          const m = M.re.exec(M.input);
          if (m && m[0].length === 0) M.re.lastIndex++; // progress past zero-width match
          M.last = m || null;
          return m !== null;
        }
        case 'matches': {
          const re = new RegExp('^(?:' + M.p.source + ')$', M.p.flags.replace('g', '') + 'd');
          M.last = re.exec(M.input) || null;
          return M.last !== null;
        }
        case 'lookingat': {
          const re = new RegExp('^(?:' + M.p.source + ')', M.p.flags.replace('g', '') + 'd');
          M.last = re.exec(M.input) || null;
          return M.last !== null;
        }
        case 'group': {
          if (!M.last) noMatch();
          const idx = a.length ? (a[0] | 0) : 0;
          const v = M.last[idx];
          return v == null ? null : v;
        }
        case 'groupcount': return reGroupCount(M.p.source);
        case 'start': {
          if (!M.last) noMatch();
          const idx = a.length ? (a[0] | 0) : 0;
          if (idx === 0) return M.last.index;
          return (M.last.indices && M.last.indices[idx]) ? M.last.indices[idx][0] : -1;
        }
        case 'end': {
          if (!M.last) noMatch();
          const idx = a.length ? (a[0] | 0) : 0;
          if (idx === 0) return M.last.index + M.last[0].length;
          return (M.last.indices && M.last.indices[idx]) ? M.last.indices[idx][1] : -1;
        }
        case 'replaceall': return this.matcherReplace(M, a[0], true);
        case 'replacefirst': return this.matcherReplace(M, a[0], false);
        case 'reset': { M.re.lastIndex = 0; M.last = null; if (a.length && a[0] != null) M.input = String(a[0]); return target; }
        case 'region': case 'usepattern': return target;
        case 'hitend': return M.re.lastIndex >= M.input.length;
      }
      throw new ApexError('System.NoSuchMethodException', `Matcher.${name} not supported`, line);
    }

    matcherReplace(M, repl, all) {
      const jsRepl = javaReplToJs(repl);
      const re = new RegExp(M.p.source, M.p.flags.replace('g', '') + (all ? 'g' : ''));
      return String(M.input).replace(re, jsRepl);
    }

    /* ---------- new ---------- */
    async evalNew(e, frame) {
      const tn = e.type.name.toLowerCase();
      // Collections
      if (tn === 'list' || e.type.isArray) {
        const arr = [];
        if (e.listItems) for (const it of e.listItems) arr.push(await this.evalExpr(it, frame));
        if (e.arraySize) { const n = await this.evalExpr(e.arraySize, frame); for (let i = 0; i < n; i++) arr.push(null); }
        if (e.args && e.args.length === 1) {
          const src = await this.evalExpr(e.args[0], frame);
          if (Array.isArray(src)) arr.push(...src);
          else if (src instanceof ApexSet) arr.push(...src.items());
        }
        return arr;
      }
      if (tn === 'map') {
        const m = new ApexMap();
        if (e.mapEntries) for (const en of e.mapEntries) m.put(await this.evalExpr(en.key, frame), await this.evalExpr(en.value, frame));
        if (e.args && e.args.length === 1) {
          const src = await this.evalExpr(e.args[0], frame);
          if (src instanceof ApexMap) for (const en2 of src.m.values()) m.put(en2.k, en2.v);
          else if (Array.isArray(src)) for (const rec of src) { const id = sobjGet(rec, 'Id'); if (id !== undefined) m.put(id, rec); }
        }
        return m;
      }
      if (tn === 'set') {
        const s = new ApexSet();
        if (e.listItems) for (const it of e.listItems) s.add(await this.evalExpr(it, frame));
        if (e.args && e.args.length === 1) {
          const src = await this.evalExpr(e.args[0], frame);
          if (Array.isArray(src)) for (const x of src) s.add(x);
          else if (src instanceof ApexSet) for (const x of src.items()) s.add(x);
        }
        return s;
      }
      // User class?
      let ci = this.registry.get(e.type.name) || (frame.classInfo ? this.registry.getInner(frame.classInfo, e.type.name) : null);
      if (!ci) ci = await this.lazyLoadClass(e.type.name);
      if (ci) {
        const args = await this.evalArgs(e.args, frame);
        let namedArgs = null;
        if (e.namedArgs) {
          namedArgs = [];
          for (const na of e.namedArgs) namedArgs.push({ name: na.name, value: await this.evalExpr(na.value, frame) });
        }
        return this.instantiate(ci, args, namedArgs, e.line);
      }
      // Built-in exceptions: new NullPointerException('msg') etc.
      if (/exception$/i.test(e.type.name)) {
        const args = await this.evalArgs(e.args, frame);
        const err = new ApexError(e.type.name, args.length ? toApexString(args[0]) : '', e.line);
        if (args.length > 1 && args[1] instanceof ApexError) err.cause = args[1];
        return err;
      }
      if (tn === 'datetime') { const args = await this.evalArgs(e.args, frame); return args.length ? new ApexDatetime(new Date(args[0], (args[1] || 1) - 1, args[2] || 1, args[3] || 0, args[4] || 0, args[5] || 0)) : ApexDatetime.now(); }
      if (tn === 'date') { const args = await this.evalArgs(e.args, frame); return args.length >= 3 ? new ApexDate(args[0], args[1], args[2]) : ApexDate.today(); }
      if (tn === 'url' || tn === 'system.url') {
        const args = await this.evalArgs(e.args, frame);
        if (args.length >= 2) {
          const ctx = args[0], spec = toApexString(args[1]);
          if (ctx && ctx.__url && ctx.__url.spec != null) {
            let combined; try { combined = new URL(spec, String(ctx.__url.spec)).href; } catch (_) { combined = spec; }
            return { __url: { expr: null, spec: combined } };
          }
          if (ctx && ctx.__url && ctx.__url.expr) {
            return { __url: { expr: `new URL(${ctx.__url.expr}, '${spec.replace(/'/g, "\\'")}')`, spec: null } };
          }
          return { __url: { expr: null, spec } };
        }
        const a0 = args[0];
        if (a0 && a0.__url) return a0;
        return { __url: { expr: null, spec: a0 == null ? '' : toApexString(a0) } };
      }
      // DOM.Document — real XML document
      if (tn === 'dom.document') { await this.evalArgs(e.args, frame); return new ApexDomDocument(); }
      // ApexPages.Message — simulate locally
      if (tn === 'apexpages.message') {
        const args = await this.evalArgs(e.args, frame);
        return {
          attributes: { type: 'ApexPages.Message' },
          severity: args.length > 0 ? toApexString(args[0]) : null,
          summary: args.length > 1 ? toApexString(args[1]) : null,
          detail: args.length > 2 ? toApexString(args[2]) : null,
        };
      }
      // Otherwise: assume SObject — new Account(Name='x') or new Account()
      const rec = { attributes: { type: e.type.name } };
      if (e.namedArgs) for (const na of e.namedArgs) rec[na.name] = await this.evalExpr(na.value, frame);
      if (e.args) for (let i = 0; i < e.args.length; i++) { /* positional args on sobjects unsupported; ignore */ await this.evalExpr(e.args[i], frame); }
      return rec;
    }

    /* ---------- builtin instance methods ---------- */
    callStringMethod(s, name, a, line) {
      switch (name.toLowerCase()) {
        // A Schema.SObjectType stringifies to its API name, so getSObjectType()
        // returns a plain string. Support the describe chain from that string:
        // <apiName>.getDescribe() → DescribeSObjectResult handle. ensureDescribe
        // (org metadata fetch) is triggered lazily by the describe-result methods.
        case 'getdescribe': return { __describeResult: s };
        case 'length': return s.length;
        case 'substring': return a.length > 1 ? s.substring(a[0], a[1]) : s.substring(a[0]);
        case 'indexof': return a.length > 1 ? s.indexOf(a[0], a[1]) : s.indexOf(a[0]);
        case 'lastindexof': return s.lastIndexOf(a[0]);
        case 'contains': return s.includes(a[0]);
        case 'containsignorecase': return s.toLowerCase().includes(String(a[0]).toLowerCase());
        case 'startswith': return s.startsWith(a[0]);
        case 'startswithignorecase': return s.toLowerCase().startsWith(String(a[0]).toLowerCase());
        case 'endswith': return s.endsWith(a[0]);
        case 'endswithignorecase': return s.toLowerCase().endsWith(String(a[0]).toLowerCase());
        case 'touppercase': return s.toUpperCase();
        case 'tolowercase': return s.toLowerCase();
        case 'trim': return s.trim();
        case 'split': return s.split(new RegExp(a[0]));
        case 'replace': return s.split(a[0]).join(a[1]);
        case 'replaceall': return s.replace(new RegExp(a[0], 'g'), a[1]);
        case 'replacefirst': return s.replace(new RegExp(a[0]), a[1]);
        case 'equals': return s === a[0];
        case 'equalsignorecase': return a[0] != null && s.toLowerCase() === String(a[0]).toLowerCase();
        case 'capitalize': return s.charAt(0).toUpperCase() + s.slice(1);
        case 'uncapitalize': return s.charAt(0).toLowerCase() + s.slice(1);
        case 'left': return s.substring(0, a[0]);
        case 'right': return s.substring(Math.max(0, s.length - a[0]));
        case 'mid': return s.substr(a[0], a[1]);
        case 'abbreviate': return s.length <= a[0] ? s : s.substring(0, Math.max(0, a[0] - 3)) + '...';
        case 'deletewhitespace': return s.replace(/\s+/g, '');
        case 'normalizespace': return s.trim().replace(/\s+/g, ' ');
        case 'isnumeric': return /^[0-9]+$/.test(s);
        case 'isalpha': return /^[a-zA-Z]+$/.test(s);
        case 'isalphanumeric': return /^[a-zA-Z0-9]+$/.test(s);
        case 'iswhitespace': return /^\s*$/.test(s);
        case 'charat': return s.charCodeAt(a[0]);
        case 'getchars': return Array.from(s).map(c => c.charCodeAt(0));
        case 'reverse': return Array.from(s).reverse().join('');
        case 'repeat': return a.length > 1 ? Array(a[1]).fill(s + a[0]).join('').slice(0, -String(a[0]).length) : s.repeat(a[0]);
        case 'remove': return s.split(a[0]).join('');
        case 'removestart': return s.startsWith(a[0]) ? s.slice(String(a[0]).length) : s;
        case 'removeend': return s.endsWith(a[0]) ? s.slice(0, -String(a[0]).length) : s;
        case 'substringbefore': { const i = s.indexOf(a[0]); return i < 0 ? s : s.substring(0, i); }
        case 'substringafter': { const i = s.indexOf(a[0]); return i < 0 ? '' : s.substring(i + String(a[0]).length); }
        case 'substringbeforelast': { const i = s.lastIndexOf(a[0]); return i < 0 ? s : s.substring(0, i); }
        case 'substringafterlast': { const i = s.lastIndexOf(a[0]); return i < 0 ? '' : s.substring(i + String(a[0]).length); }
        case 'leftpad': return s.padStart(a[0], a.length > 1 ? a[1] : ' ');
        case 'rightpad': return s.padEnd(a[0], a.length > 1 ? a[1] : ' ');
        case 'hashcode': { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
        case 'tostring': return s;
        case 'intvalue': return parseInt(s, 10);
        case 'escapesinglequotes': return s.replace(/'/g, "\\'");
        case 'escapehtml4': return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        case 'compareto': return s < a[0] ? -1 : (s > a[0] ? 1 : 0);
        case 'countmatches': return (s.split(a[0]).length - 1);
        case 'format': return s;
        default: throw new ApexError('System.NoSuchMethodException', `String.${name} not supported`, line);
      }
    }
    callNumberMethod(n, name, a, line) {
      switch (name.toLowerCase()) {
        case 'intvalue': return Math.trunc(n);
        case 'longvalue': return Math.trunc(n);
        case 'doublevalue': return n;
        case 'format': return n.toLocaleString();
        case 'tostring': return String(n);
        case 'round': return Math.round(n);
        case 'setscale': { const p = Math.pow(10, a[0]); return Math.round(n * p) / p; }
        case 'divide': { const p = Math.pow(10, a[1] != null ? a[1] : 6); return Math.round((n / a[0]) * p) / p; }
        case 'pow': return Math.pow(n, a[0]);
        case 'abs': return Math.abs(n);
        case 'stripTrailingZeros'.toLowerCase(): return n;
        case 'precision': return String(Math.abs(n)).replace(/[.-]/g, '').replace(/^0+/, '').length || 1;
        case 'scale': { const s2 = String(n); const i = s2.indexOf('.'); return i < 0 ? 0 : s2.length - i - 1; }
        default: throw new ApexError('System.NoSuchMethodException', `Decimal.${name} not supported`, line);
      }
    }
    callListMethod(arr, name, a, line) {
      switch (name.toLowerCase()) {
        case 'add': if (a.length > 1) { arr.splice(a[0], 0, a[1]); } else arr.push(a[0]); return null;
        case 'addall': { const src = a[0]; const items = Array.isArray(src) ? src : (src instanceof ApexSet ? src.items() : []); arr.push(...items); return null; }
        case 'get': { if (a[0] < 0 || a[0] >= arr.length) throw new ApexError('System.ListException', `List index out of bounds: ${a[0]}`, line); return arr[a[0]]; }
        case 'set': { if (a[0] < 0 || a[0] >= arr.length) throw new ApexError('System.ListException', `List index out of bounds: ${a[0]}`, line); arr[a[0]] = a[1]; return null; }
        case 'size': return arr.length;
        case 'isempty': return arr.length === 0;
        case 'contains': return arr.some(x => apexEquals(x, a[0]));
        case 'indexof': { for (let i = 0; i < arr.length; i++) if (apexEquals(arr[i], a[0])) return i; return -1; }
        case 'remove': { if (a[0] < 0 || a[0] >= arr.length) throw new ApexError('System.ListException', `List index out of bounds: ${a[0]}`, line); return arr.splice(a[0], 1)[0]; }
        case 'clear': arr.length = 0; return null;
        case 'clone': case 'deepclone': return arr.slice();
        case 'sort': arr.sort((x, y) => { if (x === null) return -1; if (y === null) return 1; if (typeof x === 'string') return x.localeCompare(y); return x < y ? -1 : x > y ? 1 : 0; }); return null;
        case 'iterator': return arr.slice();
        case 'tostring': return toApexString(arr);
        case 'equals': return apexEquals(arr, a[0]);
        case 'hashcode': return identityId(arr);
        default: throw new ApexError('System.NoSuchMethodException', `List.${name} not supported`, line);
      }
    }
    callMapMethod(m, name, a, line) {
      switch (name.toLowerCase()) {
        case 'put': { const prev = m.get(a[0]); m.put(a[0], a[1]); return prev; }
        case 'get': return m.get(a[0]);
        case 'containskey': return m.containsKey(a[0]);
        case 'keyset': return ApexSet.from(m.keys());
        case 'values': return m.vals();
        case 'size': return m.size();
        case 'isempty': return m.size() === 0;
        case 'remove': return m.remove(a[0]);
        case 'clear': m.clear(); return null;
        case 'clone': case 'deepclone': return m.clone();
        case 'putall': {
          const src = a[0];
          if (src instanceof ApexMap) for (const e of src.m.values()) m.put(e.k, e.v);
          else if (Array.isArray(src)) for (const rec of src) { const id = sobjGet(rec, 'Id'); if (id !== undefined) m.put(id, rec); }
          return null;
        }
        case 'tostring': return toApexString(m);
        default: throw new ApexError('System.NoSuchMethodException', `Map.${name} not supported`, line);
      }
    }
    callSetMethod(s, name, a, line) {
      switch (name.toLowerCase()) {
        case 'add': return s.add(a[0]);
        case 'addall': { const src = a[0]; const items = Array.isArray(src) ? src : (src instanceof ApexSet ? src.items() : []); let changed = false; for (const x of items) if (s.add(x)) changed = true; return changed; }
        case 'contains': return s.has(a[0]);
        case 'remove': return s.remove(a[0]);
        case 'removeall': { const src = a[0]; const items = Array.isArray(src) ? src : src.items(); let ch = false; for (const x of items) if (s.remove(x)) ch = true; return ch; }
        case 'retainall': { const src = a[0]; const keep = src instanceof ApexSet ? src : ApexSet.from(src); let ch = false; for (const x of s.items()) if (!keep.has(x)) { s.remove(x); ch = true; } return ch; }
        case 'containsall': { const src = a[0]; const items = Array.isArray(src) ? src : src.items(); return items.every(x => s.has(x)); }
        case 'size': return s.size();
        case 'isempty': return s.size() === 0;
        case 'clear': s.clear(); return null;
        case 'clone': return s.clone();
        case 'tostring': return toApexString(s);
        default: throw new ApexError('System.NoSuchMethodException', `Set.${name} not supported`, line);
      }
    }
    /* ---------- System.JSONGenerator ---------- */
    callJsonGeneratorMethod(g, name, a, line) {
      const num = v => (v === null || v === undefined) ? null : (v instanceof ApexDate || v instanceof ApexDatetime ? jsonify(v) : Number(v));
      switch (name.toLowerCase()) {
        case 'writestartobject': g._open({}); return null;
        case 'writeendobject': if (g.stack.length) g.stack.pop(); return null;
        case 'writestartarray': g._open([]); return null;
        case 'writeendarray': if (g.stack.length) g.stack.pop(); return null;
        case 'writefieldname': g.pendingField = toApexString(a[0]); return null;
        // ---- scalar values (current array element / pending field) ----
        case 'writestring': g._place(a[0] == null ? null : toApexString(a[0])); return null;
        case 'writeid': g._place(a[0] == null ? null : toApexString(a[0])); return null;
        case 'writeblob': g._place(a[0] == null ? null : toApexString(a[0])); return null;
        case 'writenumber': g._place(num(a[0])); return null;
        case 'writeboolean': g._place(a[0] == null ? null : !!a[0]); return null;
        case 'writedate': case 'writedatetime': case 'writetime': g._place(a[0] == null ? null : jsonify(a[0])); return null;
        case 'writenull': g._place(null); return null;
        case 'writeobject': g._place(jsonify(a[0])); return null;
        // ---- fieldName + value convenience variants ----
        case 'writestringfield': g.pendingField = toApexString(a[0]); g._place(a[1] == null ? null : toApexString(a[1])); return null;
        case 'writeidfield': g.pendingField = toApexString(a[0]); g._place(a[1] == null ? null : toApexString(a[1])); return null;
        case 'writeblobfield': g.pendingField = toApexString(a[0]); g._place(a[1] == null ? null : toApexString(a[1])); return null;
        case 'writenumberfield': g.pendingField = toApexString(a[0]); g._place(num(a[1])); return null;
        case 'writebooleanfield': g.pendingField = toApexString(a[0]); g._place(a[1] == null ? null : !!a[1]); return null;
        case 'writedatefield': case 'writedatetimefield': case 'writetimefield': g.pendingField = toApexString(a[0]); g._place(a[1] == null ? null : jsonify(a[1])); return null;
        case 'writenullfield': g.pendingField = toApexString(a[0]); g._place(null); return null;
        case 'writeobjectfield': g.pendingField = toApexString(a[0]); g._place(jsonify(a[1])); return null;
        case 'getasstring': return g.getAsString();
        default: throw new ApexError('System.NoSuchMethodException', `JSONGenerator.${name} not supported`, line);
      }
    }
    /* ---------- System.JSONParser ---------- */
    // Reconstruct the plain JS value the parser is currently positioned on, leaving idx on
    // that value's final token (matching Apex readValueAs / skipChildren positioning).
    _jsonParserReadValue(p) {
      const t = p.cur();
      if (!t) return null;
      if (t.token === 'START_OBJECT') {
        const obj = {};
        p.idx++;
        while (p.cur() && p.cur().token !== 'END_OBJECT') {
          if (p.cur().token === 'FIELD_NAME') {
            const key = p.cur().text;
            p.idx++;                                   // advance onto the value
            obj[key] = this._jsonParserReadValue(p);
            p.idx++;                                   // step past the value's final token
          } else { p.idx++; }
        }
        return obj;                                    // idx now on END_OBJECT
      }
      if (t.token === 'START_ARRAY') {
        const arr = [];
        p.idx++;
        while (p.cur() && p.cur().token !== 'END_ARRAY') {
          arr.push(this._jsonParserReadValue(p));
          p.idx++;
        }
        return arr;                                    // idx now on END_ARRAY
      }
      return t.value !== undefined ? t.value : (t.text != null ? t.text : null);
    }
    async callJsonParserMethod(p, name, a, line, frame) {
      const t = () => p.cur();
      switch (name.toLowerCase()) {
        case 'nexttoken': { p.idx++; const c = t(); return c ? c.token : null; }
        case 'nextvalue': { do { p.idx++; } while (t() && t().token === 'FIELD_NAME'); const c = t(); return c ? c.token : null; }
        case 'getcurrenttoken': { const c = t(); return c ? c.token : null; }
        case 'hascurrenttoken': return t() != null;
        case 'clearcurrenttoken': { const c = t(); p.lastCleared = c ? c.token : null; return null; }
        case 'getlastclearedtoken': return p.lastCleared;
        case 'getcurrentname': {
          let depth = 0;
          for (let k = p.idx; k >= 0; k--) {
            const tk = p.tokens[k].token;
            if (tk === 'END_OBJECT' || tk === 'END_ARRAY') depth++;
            else if (tk === 'START_OBJECT') { if (depth === 0) return null; depth--; }
            else if (tk === 'START_ARRAY') { if (depth > 0) depth--; }
            else if (tk === 'FIELD_NAME' && depth === 0) return p.tokens[k].text;
          }
          return null;
        }
        case 'gettext': { const c = t(); return c ? (c.text != null ? c.text : null) : null; }
        case 'getstringvalue': { const c = t(); return c ? (c.value != null ? toApexString(c.value) : c.text) : null; }
        case 'getidvalue': { const c = t(); return c && c.value != null ? toApexString(c.value) : null; }
        case 'getblobvalue': { const c = t(); return c && c.value != null ? toApexString(c.value) : null; }
        case 'getintegervalue': case 'getlongvalue': { const c = t(); return c && c.value != null ? Math.trunc(Number(c.value)) : null; }
        case 'getdoublevalue': case 'getdecimalvalue': { const c = t(); return c && c.value != null ? Number(c.value) : null; }
        case 'getbooleanvalue': { const c = t(); return c && c.value != null ? !!c.value : null; }
        case 'getdatetimevalue': { const c = t(); return c && c.value != null ? new ApexDatetime(new Date(c.value)) : null; }
        case 'getdatevalue': { const c = t(); return c && c.value != null ? ApexDate.fromJs(new Date(c.value)) : null; }
        case 'skipchildren': { p.idx = jsonSkipChildren(p.tokens, p.idx); return null; }
        case 'readvalueas': case 'readvalueasstrict': {
          const plain = this._jsonParserReadValue(p);
          const typeTok = (a[0] && typeof a[0] === 'object' && a[0].__typeToken) ? a[0].__typeToken : (typeof a[0] === 'string' ? a[0] : null);
          return typeTok ? await this.deserializeTyped(plain, typeTok, frame) : unjsonify(plain);
        }
        default: throw new ApexError('System.NoSuchMethodException', `JSONParser.${name} not supported`, line);
      }
    }
    callDateMethod(d, name, a, line) {
      switch (name.toLowerCase()) {
        case 'adddays': return d.addDays(a[0]);
        case 'addmonths': return d.addMonths(a[0]);
        case 'addyears': return d.addYears(a[0]);
        case 'daysbetween': return d.daysBetween(a[0]);
        case 'year': return d.y;
        case 'month': return d.mo;
        case 'day': return d.day;
        case 'format': return d.iso();
        case 'tostring': return d.toString();
        case 'isleapyear': return (d.y % 4 === 0 && d.y % 100 !== 0) || d.y % 400 === 0;
        default: throw new ApexError('System.NoSuchMethodException', `Date.${name} not supported`, line);
      }
    }
    callDatetimeMethod(dt, name, a, line) {
      switch (name.toLowerCase()) {
        case 'adddays': return dt.addDays(a[0]);
        case 'addhours': return dt.addHours(a[0]);
        case 'addminutes': return dt.addMinutes(a[0]);
        case 'addseconds': return dt.addSeconds(a[0]);
        case 'date': return dt.dateOnly();
        case 'dategmt': return new ApexDate(dt.d.getUTCFullYear(), dt.d.getUTCMonth() + 1, dt.d.getUTCDate());
        case 'time': return new ApexTime(dt.d.getHours(), dt.d.getMinutes(), dt.d.getSeconds(), dt.d.getMilliseconds());
        case 'timegmt': return new ApexTime(dt.d.getUTCHours(), dt.d.getUTCMinutes(), dt.d.getUTCSeconds(), dt.d.getUTCMilliseconds());
        case 'gettime': return dt.getTime();
        case 'format': return dt.format(a[0]);
        case 'formatgmt': return dt.d.toISOString();
        case 'year': return dt.d.getFullYear();
        case 'month': return dt.d.getMonth() + 1;
        case 'day': return dt.d.getDate();
        case 'hour': return dt.d.getHours();
        case 'minute': return dt.d.getMinutes();
        case 'second': return dt.d.getSeconds();
        case 'millisecond': return dt.d.getMilliseconds();
        case 'tostring': return dt.toString();
        default: throw new ApexError('System.NoSuchMethodException', `Datetime.${name} not supported`, line);
      }
    }
    callTimeMethod(tm, name, a, line) {
      switch (name.toLowerCase()) {
        case 'hour': return tm.h;
        case 'minute': return tm.mi;
        case 'second': return tm.s;
        case 'millisecond': return tm.ms;
        case 'addhours': return tm.addHours(a[0]);
        case 'addminutes': return tm.addMinutes(a[0]);
        case 'addseconds': return tm.addSeconds(a[0]);
        case 'addmilliseconds': return tm.addMilliseconds(a[0]);
        case 'tostring': return tm.toString();
        default: throw new ApexError('System.NoSuchMethodException', `Time.${name} not supported`, line);
      }
    }
    callBlobMethod(b, name, a, line) {
      switch (name.toLowerCase()) {
        case 'size': return b.size();
        case 'tostring': return b.toString();
        default: throw new ApexError('System.NoSuchMethodException', `Blob.${name} not supported`, line);
      }
    }
    /* System.URL — org-context URLs. A literal `new URL('https://…')` is parsed
     * locally (deterministic); an org factory (getOrgDomainUrl/getSalesforceBaseUrl/
     * getCurrentRequestUrl) is resolved from the connected org so the REAL domain
     * comes back. When Live data is unavailable the string degrades to null with a
     * gap note — never a fabricated domain. */
    async callUrlMethod(u, name, args, line, frame) {
      const info = u.__url || {};
      const lk = name.toLowerCase();
      const APEX = { toexternalform: 'toExternalForm', gethost: 'getHost', getprotocol: 'getProtocol',
        getpath: 'getPath', getfile: 'getFile', getquery: 'getQuery', getauthority: 'getAuthority',
        getport: 'getPort', getdefaultport: 'getDefaultPort', getuserinfo: 'getUserInfo', getref: 'getRef' };
      // Locally-parseable literal URL.
      if (info.spec != null) {
        let parsed = null;
        try { parsed = new URL(String(info.spec)); } catch (_) { parsed = null; }
        if (parsed) {
          switch (lk) {
            case 'toexternalform': case 'tostring': return parsed.href;
            case 'gethost': return parsed.hostname;
            case 'getprotocol': return parsed.protocol.replace(/:$/, '');
            case 'getpath': return parsed.pathname;
            case 'getfile': return parsed.pathname + (parsed.search || '');
            case 'getquery': return parsed.search ? parsed.search.slice(1) : null;
            case 'getref': return parsed.hash ? parsed.hash.slice(1) : null;
            case 'getauthority': return parsed.host;
            case 'getport': return parsed.port ? Number(parsed.port) : -1;
            case 'getuserinfo': return parsed.username ? (parsed.username + (parsed.password ? ':' + parsed.password : '')) : null;
          }
        }
        if (lk === 'toexternalform' || lk === 'tostring') return String(info.spec);
      }
      // Org-context factory URL: resolve the whole terminal expression from the org.
      if (info.expr && (APEX[lk] || lk === 'tostring')) {
        const m = APEX[lk] || 'toExternalForm';
        const v = await this.resolveViaOrg(`${info.expr}.${m}()`, {});
        if (v !== ENGINE_UNRESOLVED) return v;
        this._noteGap(`URL.${m}() is org-context-dependent and Live data is unavailable`, 'engine-gap', { line, what: 'instance call' });
        return null;
      }
      this._noteGap(`URL.${name}() could not be resolved`, 'engine-gap', { line, what: 'instance call' });
      return null;
    }
    /* Schema.getGlobalDescribe() → lazy Map<String, Schema.SObjectType>. get()/
     * containsKey() consult the org's describe so existence is answered truthfully;
     * a Schema.SObjectType is represented as the API-name string, so the describe
     * chain (<name>.getDescribe()…) keeps working. Enumeration (keySet/values/size)
     * would require listing every org SObject, which the debugger can't fetch, so it
     * degrades honestly with a gap note rather than fabricating a set. */
    async callGlobalDescribeMethod(map, name, args, line) {
      const lk = name.toLowerCase();
      if (lk === 'get' || lk === 'containskey') {
        const key = args[0] == null ? '' : toApexString(args[0]);
        if (!key) return lk === 'containskey' ? false : null;
        const info = await this.ensureDescribe(key);
        if (this.host.describeSObject) {
          // Live describe available: answer from real org metadata.
          if (lk === 'containskey') return !!info.resolved;
          return info.resolved ? key : null;
        }
        // Live off: existence is unknowable. Return the token so the describe chain
        // degrades downstream instead of NPE-ing here; containsKey can't be trusted.
        return lk === 'containskey' ? false : key;
      }
      if (lk === 'keyset' || lk === 'values' || lk === 'size' || lk === 'isempty') {
        this._noteGap(`Schema.getGlobalDescribe().${name}() enumerates every org SObject, which the debugger can't retrieve`, 'engine-gap', { line, what: 'instance call' });
        if (lk === 'size') return 0;
        if (lk === 'isempty') return true;
        if (lk === 'values') return [];
        return ApexSet.from([]);
      }
      this._noteGap(`Schema.getGlobalDescribe().${name}() is not simulated`, 'engine-gap', { line, what: 'instance call' });
      return null;
    }
    callErrorMethod(err, name, a, line) {
      switch (name.toLowerCase()) {
        case 'getmessage': return err.getMessage();
        case 'gettypename': return err.getTypeName();
        case 'getlinenumber': return err.getLineNumber();
        case 'getstacktracestring': return err.getStackTraceString();
        case 'getcause': return err.cause;
        case 'setmessage': err.apexMessage = toApexString(a[0]); return null;
        case 'tostring': return err.toString();
        default: throw new ApexError('System.NoSuchMethodException', `Exception.${name} not supported`, line);
      }
    }
    callSObjectMethod(rec, name, a, line) {
      switch (name.toLowerCase()) {
        case 'get': { const v = sobjGet(rec, a[0]); return v === undefined ? null : v; }
        case 'put': { const prev = sobjGet(rec, a[0]); sobjSet(rec, a[0], a[1]); return prev === undefined ? null : prev; }
        case 'getsobjecttype': return sobjType(rec);
        case 'clone': { const c = Object.assign({}, rec); if (!a[0]) delete c.Id; return c; }
        case 'getpopulatedfieldsasmap': { const m = new ApexMap(); for (const k of Object.keys(rec)) if (k !== 'attributes') m.put(k, rec[k]); return m; }
        case 'tostring': return toApexString(rec);
        case 'getsummary': return rec.summary ?? null;
        case 'getdetail': return rec.detail ?? null;
        case 'getseverity': return rec.severity ?? null;
        default:
          // Reached only when the receiver is NOT a resolvable user-class instance
          // (the DO/wrapper dispatch in evalMethodCall already runs the REAL method
          // when the declared type is a loaded Apex class). Be honest that this is an
          // engine limitation: a substituted null here can surface downstream as a
          // NullPointerException that is NOT a real bug in the code being debugged.
          this._noteGap(`Method ${name}() could not be evaluated on a ${sobjType(rec) || 'record'}-shaped value — no loaded Apex class backs it, so the real method body is unavailable`, 'engine-gap', { line, what: 'instance call' });
          return null;
      }
    }

    /* ---------- DOM.Document / DOM.XmlNode ---------- */
    callDomDocumentMethod(doc, name, a, line) {
      switch (name.toLowerCase()) {
        case 'load': doc.root = parseXml(a[0]); return null;
        case 'getrootelement': return doc.root;
        case 'toxmlstring': return doc.root ? serializeXml(doc.root) : '';
        case 'createrootelement': {
          const node = new ApexXmlnode({ name: a[0], namespace: a[1] || null, prefix: a[2] || null });
          doc.root = node; return node;
        }
        default:
          this.log(`⚠ DOM.Document.${name}() is not simulated — returning null and continuing.`, 'system');
          return null;
      }
    }
    callXmlnodeMethod(node, name, a, line) {
      switch (name.toLowerCase()) {
        case 'getname': return node.name || null;
        case 'gettext': return node.text != null ? node.text : '';
        case 'getnodetype': return node.nodeType;
        case 'getnamespace': return node.namespace || null;
        case 'getprefixfornamespace': return node.prefix || null;
        case 'getparent': return node.parent || null;
        case 'getchildelements': return node.elementChildren();
        case 'getchildren': return node.children.slice();
        case 'haschildren': return node.children.length > 0;
        case 'getchildelement': {
          const nm = String(a[0] || '').toLowerCase();
          return node.elementChildren().find(c => c.name.toLowerCase() === nm) || null;
        }
        case 'getattributecount': return node.attributes.length;
        case 'getattributekeyat': return node.attributes[a[0]] ? node.attributes[a[0]].name : null;
        case 'getattributekeynsat': return null;
        case 'getattributevalueat': return node.attributes[a[0]] ? node.attributes[a[0]].value : null;
        case 'getattribute':
        case 'getattributevalue': { const at = node.findAttr(a[0], a[1]); return at ? at.value : null; }
        case 'tostring': return serializeXml(node);
        default:
          this.log(`⚠ DOM.XmlNode.${name}() is not simulated — returning null and continuing.`, 'system');
          return null;
      }
    }

    /* ---------- static builtins ---------- */
    async staticProp(typeName, propName, line) {
      const t = typeName.toLowerCase();
      const p = propName.toLowerCase();
      if (t === 'trigger') return null; // trigger context not simulated
      // Built-in enum lookup
      const enumVals = BUILTIN_ENUMS[t];
      if (enumVals) {
        const match = enumVals.find(v => v.toLowerCase() === p);
        if (match) return match;
      }
      // ApexPages.Severity sub-namespace
      if (t === 'apexpages' && p === 'severity') return { __builtinRef: 'ApexPages.Severity' };
      // DOM sub-namespace (DOM.Xmlnodetype.ELEMENT, etc.)
      if (t === 'dom' && p === 'xmlnodetype') return { __builtinRef: 'DOM.Xmlnodetype' };
      // System.JSONToken.* → the JSON pull-parser token enum (bare `JSONToken.X` is
      // handled directly via BUILTIN_ENUMS['jsontoken']).
      if (t === 'system' && p === 'jsontoken') return { __builtinRef: 'JSONToken' };
      // Schema.sObjectType → the global describe namespace. Accessing a member
      // (Schema.sObjectType.Account) yields that object's DescribeSObjectResult.
      if (t === 'schema' && p === 'sobjecttype') return { __globalDescribe: true };
      // <SObjectName>.SObjectType static access → a Schema.SObjectType token. Only
      // valid Apex when the base is an SObject type, so any non-builtin base that
      // reaches here is one. getDescribe() on the token resolves REAL metadata from
      // the org (ensureDescribe) — nothing is fabricated.
      if (p === 'sobjecttype' && !BUILTIN_TYPES.has(t)) return { __sobjectType: typeName };
      // System.Label.<name> → a custom-label namespace token; reading a name off it
      // resolves the REAL label text from the org. Labels are compile-checked in
      // Apex, so a referenced label always exists in the connected org.
      if (t === 'system' && p === 'label') return { __labelRef: true };
      // Bare `Label.<name>` arrives here as builtinRef 'Label'.
      if (t === 'label') return await this.resolveLabel(propName, line);
      // <SObjectType>.<FieldName> static access → a Schema.SObjectField token. When
      // the base describes as a real SObject in the connected org, any member other
      // than sObjectType is a field reference; resolve the REAL (namespaced) field
      // name so getDescribe().getPicklistValues()/getType()/getLabel()/... read true
      // org metadata instead of org-evaling the field handle (which can't rebuild it).
      if (!BUILTIN_TYPES.has(t) && !this.registry.get(typeName)) {
        const dinfo = await this.ensureDescribe(typeName);
        if (dinfo && dinfo.resolved && Array.isArray(dinfo.names) && dinfo.names.length) {
          const want = String(propName).toLowerCase();
          const real = dinfo.names.find(fn => String(fn).toLowerCase() === want)
                    || dinfo.names.find(fn => stripNs(String(fn).toLowerCase()) === stripNs(want))
                    || propName;
          return { __sobjectField: { sobject: typeName, field: real } };
        }
      }
      // Unknown static prop/constant. Before degrading to null, try to resolve the
      // real value from the org (a class constant we couldn't load locally, a
      // global static, etc.). Gated by Live data — a no-op when Live is off.
      if (!BUILTIN_TYPES.has(t)) {
        const orgVal = await this.resolveViaOrg(`${typeName}.${propName}`, {});
        if (orgVal !== ENGINE_UNRESOLVED) return orgVal;
      }
      // Degrade gracefully (never kill a session)
      this.log(`⚠ ${typeName}.${propName} is not simulated — returning null and continuing.`, 'system');
      return null;
    }

    /**
     * Structural, plain-JS form of a value for the Chrome-style console tree.
     * Objects/collections → nested plain JS (via jsonify); primitives → null so
     * the console renders them inline from the text. Never throws.
     */
    _debugTree(v) {
      try {
        if (v === null || v === undefined) return null;
        if (Array.isArray(v) || v instanceof ApexMap || v instanceof ApexSet ||
            v instanceof ApexObject || isSObject(v)) {
          return jsonify(v);
        }
        return null;
      } catch (_) { return null; }
    }

    /**
     * Fire a logpoint (Chrome DevTools semantics) — print, never pause.
     * The message is treated as an EXPRESSION, not a literal `{}`-template:
     *  - a bare message (`logger`) or a sole `{logger}` → evaluate it and print the
     *    VALUE (an object/collection/SObject becomes an expandable tree; a scalar
     *    prints as `expr = <value>`);
     *  - a simple variable/path that can't be resolved in this scope → an honest
     *    "unavailable" note (never the bare word, which looks like it wasn't run);
     *  - a mixed template (`count={count} of {total}`) → interpolate placeholders.
     */
    async _emitLogpoint(template, frame, line) {
      const raw = String(template == null ? '' : template);
      const emit = (text, tree) => {
        if (this.host && this.host.debug) this.host.debug({ text, tree: tree || null, category: 'logpoint', line });
        else this.log(text, 'debug');
      };
      const soleBrace = raw.match(/^\s*\{([^{}]+)\}\s*$/);
      const expr = soleBrace ? soleBrace[1].trim() : (raw.indexOf('{') === -1 ? raw.trim() : null);
      if (expr) {
        let val, ok = true;
        try { val = await this.evalExpressionSandboxed(expr, frame, true); }
        catch (_) { ok = false; }
        if (ok && val !== undefined) {
          const tree = this._debugTree(val);
          emit(tree ? `${expr} =` : `${expr} = ${toApexString(val)}`, tree);
          return;
        }
        // Couldn't evaluate: if it's clearly meant as a variable/path, be honest
        // rather than printing the bare word (which reads like it never ran).
        if (/^[A-Za-z_]\w*(\s*\.\s*[A-Za-z_]\w*|\s*\[[^\]]*\])*$/.test(expr)) {
          emit(`${expr} — ‹unavailable in this scope›`, null);
          return;
        }
        // Otherwise treat it as prose and fall through to template handling.
      }
      let text;
      try { text = await this._formatLogTemplate(raw, frame); }
      catch (_) { text = raw; }
      emit(text, null);
    }

    /**
     * Replace {expr} placeholders in a logpoint message with their evaluated
     * values in the current frame. Literal text is preserved; an expression that
     * fails to evaluate is left as-is so the user can see what broke.
     */
    async _formatLogTemplate(template, frame) {
      const re = /\{([^{}]+)\}/g;
      let out = '', last = 0, m;
      while ((m = re.exec(template)) !== null) {
        out += template.slice(last, m.index);
        try {
          const v = await this.evalExpressionInFrame(m[1].trim(), frame);
          out += toApexString(v);
        } catch (_) { out += m[0]; }
        last = re.lastIndex;
      }
      out += template.slice(last);
      return out;
    }

    async callStaticBuiltin(typeName, name, a, line, frame) {
      const t = typeName.toLowerCase();
      const n = name.toLowerCase();
      if (t === 'system') {
        switch (n) {
          case 'debug': {
            // System.debug(msg) or System.debug(LoggingLevel, msg). The value we
            // want to render as an expandable tree is the last argument.
            const twoArg = a.length > 1;
            const val = twoArg ? a[1] : a[0];
            const cat = twoArg ? toApexString(a[0]) : null;
            const text = twoArg ? `[${cat}] ${toApexString(val)}` : toApexString(val);
            if (this.host && this.host.debug) {
              this.host.debug({ text, tree: this._debugTree(val), category: cat, line });
            } else {
              this.log(text, 'debug');
            }
            return null;
          }
          case 'now': return ApexDatetime.now();
          case 'today': return ApexDate.today();
          case 'currenttimemillis': return Date.now();
          case 'assert': if (a[0] !== true) throw new ApexError('System.AssertException', 'Assertion Failed' + (a[1] != null ? ': ' + toApexString(a[1]) : ''), line); return null;
          case 'assertequals': if (!apexEquals(a[0], a[1])) throw new ApexError('System.AssertException', `Assertion Failed: Expected: ${toApexString(a[0])}, Actual: ${toApexString(a[1])}` + (a[2] != null ? ' — ' + toApexString(a[2]) : ''), line); return null;
          case 'assertnotequals': if (apexEquals(a[0], a[1])) throw new ApexError('System.AssertException', `Assertion Failed: Same value: ${toApexString(a[0])}` + (a[2] != null ? ' — ' + toApexString(a[2]) : ''), line); return null;
          case 'runas': return null;   // handled by callblock
          case 'isbatch': case 'isfuture': case 'isqueueable': case 'isscheduled': return false;
          case 'enqueuejob': { this.log('System.enqueueJob: queued (simulated, not executed)', 'system'); return fakeId('707'); }
          case 'schedule': { this.log('System.schedule: scheduled (simulated)', 'system'); return fakeId('708'); }
          case 'abortjob': return null;
        }
        throw new ApexError('System.NoSuchMethodException', `System.${name} not supported`, line);
      }
      if (t === 'math') {
        switch (n) {
          case 'abs': return Math.abs(a[0]);
          case 'max': return Math.max(a[0], a[1]);
          case 'min': return Math.min(a[0], a[1]);
          case 'round': return Math.round(a[0]);
          case 'floor': return Math.floor(a[0]);
          case 'ceil': return Math.ceil(a[0]);
          case 'sqrt': return Math.sqrt(a[0]);
          case 'pow': return Math.pow(a[0], a[1]);
          case 'random': return Math.random();
          case 'mod': return a[0] % a[1];
          case 'exp': return Math.exp(a[0]);
          case 'log': return Math.log(a[0]);
          case 'log10': return Math.log10(a[0]);
          case 'signum': return Math.sign(a[0]);
          case 'roundtolong': return Math.round(a[0]);
          case 'cbrt': return Math.cbrt(a[0]);
          case 'hypot': return Math.hypot(a[0], a[1]);
          case 'sin': return Math.sin(a[0]);
          case 'cos': return Math.cos(a[0]);
          case 'tan': return Math.tan(a[0]);
          case 'asin': return Math.asin(a[0]);
          case 'acos': return Math.acos(a[0]);
          case 'atan': return Math.atan(a[0]);
          case 'atan2': return Math.atan2(a[0], a[1]);
          case 'sinh': return Math.sinh(a[0]);
          case 'cosh': return Math.cosh(a[0]);
          case 'tanh': return Math.tanh(a[0]);
        }
        throw new ApexError('System.NoSuchMethodException', `Math.${name} not supported`, line);
      }
      if (t === 'json') {
        switch (n) {
          case 'serialize': return JSON.stringify(jsonify(a[0]));
          case 'serializepretty': return JSON.stringify(jsonify(a[0]), null, 2);
          case 'deserializeuntyped': return unjsonify(JSON.parse(a[0]));
          case 'deserialize': case 'deserializestrict': {
            const parsed = JSON.parse(a[0]);
            const typeTok = (a[1] && typeof a[1] === 'object' && a[1].__typeToken)
              ? a[1].__typeToken
              : (typeof a[1] === 'string' ? a[1] : null);
            return typeTok ? await this.deserializeTyped(parsed, typeTok, frame) : unjsonify(parsed);
          }
          case 'creategenerator': return new ApexJsonGenerator(a[0] === true);
          case 'createparser': return new ApexJsonParser(a[0] == null ? '' : toApexString(a[0]));
        }
        throw new ApexError('System.NoSuchMethodException', `JSON.${name} not supported`, line);
      }
      if (t === 'string') {
        switch (n) {
          case 'isblank': return a[0] === null || a[0] === undefined || String(a[0]).trim() === '';
          case 'isnotblank': return !(a[0] === null || a[0] === undefined || String(a[0]).trim() === '');
          case 'isempty': return a[0] === null || a[0] === undefined || a[0] === '';
          case 'isnotempty': return !(a[0] === null || a[0] === undefined || a[0] === '');
          case 'valueof': return a[0] === null || a[0] === undefined ? null : toApexString(a[0]);
          case 'valueofgmt': return toApexString(a[0]);
          case 'join': { const items = Array.isArray(a[0]) ? a[0] : (a[0] instanceof ApexSet ? a[0].items() : []); return items.map(toApexString).join(a[1]); }
          case 'format': { let s = String(a[0]); const args = Array.isArray(a[1]) ? a[1] : []; args.forEach((x, i) => { s = s.split('{' + i + '}').join(toApexString(x)); }); return s; }
          case 'escapesinglequotes': return String(a[0]).replace(/'/g, "\\'");
          case 'fromchararray': return (a[0] || []).map(c => String.fromCharCode(c)).join('');
          case 'getcommonprefix': return '';
        }
        throw new ApexError('System.NoSuchMethodException', `String.${name} not supported`, line);
      }
      if (t === 'integer' || t === 'long') {
        if (n === 'valueof') { const v = parseInt(a[0], 10); if (isNaN(v)) throw new ApexError('System.TypeException', `Invalid integer: ${a[0]}`, line); return v; }
        throw new ApexError('System.NoSuchMethodException', `Integer.${name} not supported`, line);
      }
      if (t === 'decimal' || t === 'double') {
        if (n === 'valueof') { const v = parseFloat(a[0]); if (isNaN(v)) throw new ApexError('System.TypeException', `Invalid decimal: ${a[0]}`, line); return v; }
        throw new ApexError('System.NoSuchMethodException', `Decimal.${name} not supported`, line);
      }
      if (t === 'boolean') {
        if (n === 'valueof') return String(a[0]).toLowerCase() === 'true';
        throw new ApexError('System.NoSuchMethodException', `Boolean.${name} not supported`, line);
      }
      if (t === 'id') {
        if (n === 'valueof') return String(a[0]);
        throw new ApexError('System.NoSuchMethodException', `Id.${name} not supported`, line);
      }
      if (t === 'date') {
        switch (n) {
          case 'today': return ApexDate.today();
          case 'newinstance': return new ApexDate(a[0], a[1], a[2]);
          case 'valueof': { const d = new Date(a[0]); return ApexDate.fromJs(d); }
          // Date.parse(String) parses a locale date ("M/d/yyyy"); JS Date handles that form.
          case 'parse': { const d = new Date(String(a[0])); if (isNaN(d.getTime())) throw new ApexError('System.TypeException', `Invalid date: ${a[0]}`, line); return ApexDate.fromJs(d); }
          case 'daysinmonth': return new Date(a[0], a[1], 0).getDate();
          case 'isleapyear': { const y = a[0]; return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
        }
        throw new ApexError('System.NoSuchMethodException', `Date.${name} not supported`, line);
      }
      if (t === 'blob') {
        switch (n) {
          case 'valueof': return new ApexBlob(a[0] == null ? '' : toApexString(a[0]));
        }
        throw new ApexError('System.NoSuchMethodException', `Blob.${name} not supported`, line);
      }
      if (t === 'encodingutil') {
        const asStr = x => x instanceof ApexBlob ? x.s : (x == null ? '' : toApexString(x));
        switch (n) {
          case 'base64encode': return b64encode(asStr(a[0]));
          case 'base64decode': return new ApexBlob(b64decode(String(a[0])));
          // Apex urlEncode uses application/x-www-form-urlencoded (space → '+').
          case 'urlencode': return encodeURIComponent(String(a[0])).replace(/%20/g, '+').replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
          case 'urldecode': return decodeURIComponent(String(a[0]).replace(/\+/g, ' '));
          case 'converttohex': return hexencode(asStr(a[0]));
          case 'convertfromhex': return new ApexBlob(hexdecode(String(a[0])));
        }
        throw new ApexError('System.NoSuchMethodException', `EncodingUtil.${name} not supported`, line);
      }
      if (t === 'crypto') {
        switch (n) {
          case 'getrandominteger': return (Math.floor(Math.random() * 4294967296)) | 0;
          case 'getrandomlong': return Math.floor((Math.random() - 0.5) * Number.MAX_SAFE_INTEGER);
        }
        // Digest/MAC/signing need real crypto keys and are org/config-dependent — degrade
        // honestly rather than fabricate a bogus hash.
        this._noteGap(`Crypto.${name}() needs real key/cert material and cannot be simulated truthfully`, 'engine-gap', { line, what: 'static call' });
        return null;
      }
      if (t === 'time') {
        switch (n) {
          case 'newinstance': return new ApexTime(a[0], a[1], a[2], a[3]);
        }
        throw new ApexError('System.NoSuchMethodException', `Time.${name} not supported`, line);
      }
      if (t === 'url') {
        // Org-context factory URLs. The wrapper stores the originating Apex
        // expression; the real domain is resolved from the connected org when a
        // terminal string method (toExternalForm/getHost/…) is called.
        switch (n) {
          case 'getorgdomainurl': return { __url: { expr: 'URL.getOrgDomainUrl()', spec: null } };
          case 'getsalesforcebaseurl': return { __url: { expr: 'URL.getSalesforceBaseUrl()', spec: null } };
          case 'getorgurl': return { __url: { expr: 'URL.getOrgURL()', spec: null } };
          case 'getcurrentrequesturl': return { __url: { expr: 'URL.getCurrentRequestUrl()', spec: null } };
        }
        throw new ApexError('System.NoSuchMethodException', `URL.${name} not supported`, line);
      }
      if (t === 'datetime') {
        switch (n) {
          case 'now': return ApexDatetime.now();
          // newInstance(Date[, Time]) | newInstance(Long millis) | newInstance(y,mo,d[,h,mi,s]) — local time.
          case 'newinstance': {
            if (a[0] instanceof ApexDate) {
              const dt = a[0], tm = a[1] instanceof ApexTime ? a[1] : new ApexTime(0, 0, 0, 0);
              return new ApexDatetime(new Date(dt.y, dt.mo - 1, dt.day, tm.h, tm.mi, tm.s, tm.ms));
            }
            if (a.length === 1) return new ApexDatetime(new Date(Number(a[0])));
            return new ApexDatetime(new Date(a[0], (a[1] || 1) - 1, a[2] || 1, a[3] || 0, a[4] || 0, a[5] || 0));
          }
          // newInstanceGmt(Date, Time) | newInstanceGmt(y,mo,d[,h,mi,s]) — the given
          // wall-clock components are interpreted as GMT (Date.UTC), matching Apex.
          case 'newinstancegmt': {
            if (a[0] instanceof ApexDate) {
              const dt = a[0], tm = a[1] instanceof ApexTime ? a[1] : new ApexTime(0, 0, 0, 0);
              return new ApexDatetime(new Date(Date.UTC(dt.y, dt.mo - 1, dt.day, tm.h, tm.mi, tm.s, tm.ms)));
            }
            return new ApexDatetime(new Date(Date.UTC(a[0], (a[1] || 1) - 1, a[2] || 1, a[3] || 0, a[4] || 0, a[5] || 0)));
          }
          case 'valueof': return new ApexDatetime(new Date(a[0]));
          case 'valueofgmt': return new ApexDatetime(new Date(String(a[0]).trim().replace(' ', 'T') + 'Z'));
        }
        throw new ApexError('System.NoSuchMethodException', `Datetime.${name} not supported`, line);
      }
      if (t === 'pattern') {
        switch (n) {
          case 'compile': return { __pattern: javaRegexToJs(a[0]) };
          case 'matches': {
            // Pattern.matches(regex, input): whole-input (anchored) match.
            const p = javaRegexToJs(a[0]);
            const re = new RegExp('^(?:' + p.source + ')$', p.flags.replace('g', ''));
            return re.test(String(a[1] == null ? '' : a[1]));
          }
          case 'quote': return String(a[0] == null ? '' : a[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        throw new ApexError('System.NoSuchMethodException', `Pattern.${name} not supported`, line);
      }
      if (t === 'database') {
        switch (n) {
          case 'query': case 'querywithbinds': {
            const raw = String(a[0]);
            // Resolve bind variables the same way inline [SELECT ...] does. For
            // Database.queryWithBinds the caller supplies an explicit Map; for a
            // plain Database.query(dynamicString) we resolve `:name` tokens from
            // the current scope so dynamic SOQL isn't sent with unbound vars.
            let binds;
            if (n === 'querywithbinds' && a[1] instanceof ApexMap) {
              binds = {};
              for (const en of a[1].m.values()) binds[toApexString(en.k)] = this.normalizeBindValue(en.v);
            } else {
              binds = await this.resolveScopeBinds(raw, frame);
            }
            this.pendingBackend = 'Database.query against org…';
            this.log(`Database.query → org: ${raw.replace(/\s+/g, ' ').trim()}`, 'soql');
            try {
              if (this.host.query) { const rows = await this.host.query(raw, binds); return Array.isArray(rows) ? rows : []; }
              return [];
            } finally { this.pendingBackend = null; }
          }
          case 'insert': case 'update': case 'delete': case 'upsert': case 'undelete': {
            await this.performDml(n, a[0], { line }, frame);
            const records = Array.isArray(a[0]) ? a[0] : [a[0]];
            return records.map(r => ({ attributes: { type: 'Database.SaveResult' }, success: true, id: sobjGet(r, 'Id') || null, errors: [] }));
          }
          case 'countquery': {
            const raw = String(a[0]);
            const binds = await this.resolveScopeBinds(raw, frame);
            if (this.host.query) { const rows = await this.host.query(raw, binds); return Array.isArray(rows) && rows.length && rows[0].expr0 !== undefined ? rows[0].expr0 : (rows || []).length; }
            return 0;
          }
          case 'setsavepoint': return { __savepoint: Date.now() };
          case 'rollback': { this.log('Database.rollback (simulated)', 'system'); return null; }
        }
        throw new ApexError('System.NoSuchMethodException', `Database.${name} not supported`, line);
      }
      if (t === 'limits') {
        if (n.startsWith('getlimit')) return 100;
        if (n.startsWith('get')) return 0;
        throw new ApexError('System.NoSuchMethodException', `Limits.${name} not supported`, line);
      }
      if (t === 'userinfo') {
        const ui = this.host.userInfo || {};
        switch (n) {
          case 'getuserid': return ui.id || fakeId('005');
          case 'getname': return ui.name || 'Debug User';
          case 'getusername': return ui.username || 'debug@example.com';
          case 'getorganizationid': return ui.orgId || fakeId('00D');
          case 'getprofileid': return ui.profileId || fakeId('00e');
          case 'getsessionid': return 'SESSION_ID_REMOVED';
        }
        // Everything else (isCurrentUserLicensed, getLocale, getLanguage,
        // isMultiCurrencyOrganization, getDefaultCurrency, getUserType, …) is a
        // real user/org-specific value. Resolve it truthfully from the connected
        // org and faithfully reproduce a thrown Apex exception so caller
        // try/catch behaves exactly as in production — e.g.
        // isCurrentUserLicensed('Apttus') THROWS System.TypeException when that
        // managed package isn't installed, which CPQ catches and turns into false.
        return await this.callUserInfoViaOrg(name, n, a, line);
      }
      if (t === 'test') {
        switch (n) {
          case 'isrunningtest': return false;
          case 'starttest': case 'stoptest': return null;
        }
        return null;
      }
      if (t === 'apexpages') {
        switch (n) {
          case 'addmessage': {
            const msg = a[0];
            this.pageMessages.push(msg);
            const sev = (msg && msg.severity) ? toApexString(msg.severity) : 'UNKNOWN';
            const sum = (msg && msg.summary != null) ? toApexString(msg.summary) : '';
            this.log(`ApexPages message [${sev}]: ${sum}`, 'system');
            return null;
          }
          case 'addmessages': {
            const arg = a[0];
            if (arg instanceof ApexError) {
              const synth = { attributes: { type: 'ApexPages.Message' }, severity: 'ERROR', summary: arg.apexMessage, detail: null };
              this.pageMessages.push(synth);
              this.log(`ApexPages message [ERROR]: ${arg.apexMessage}`, 'system');
            } else if (Array.isArray(arg)) {
              for (const m of arg) { this.pageMessages.push(m); }
            }
            return null;
          }
          case 'getmessages': return this.pageMessages.slice();
          case 'hasmessages': return this.pageMessages.length > 0;
          case 'currentpage':
            this.log('⚠ ApexPages.currentPage(): VF page context is not simulated — returning null.', 'system');
            return null;
          default:
            this.log(`⚠ ApexPages.${name}() is not simulated — returning null`, 'system');
            return null;
        }
      }
      if (t === 'schema') {
        // getGlobalDescribe() → a lazy Map<String, Schema.SObjectType>. We can't
        // enumerate every org SObject, but the dominant usage is .get(name) /
        // .containsKey(name), which we resolve truthfully via the org describe.
        if (n === 'getglobaldescribe') return { __globalDescribeMap: true };
        // describeSObjects(List<String>) → List<DescribeSObjectResult>. Each element
        // is a describe token backed by real org metadata (resolved lazily).
        if (n === 'describesobjects') {
          const names = Array.isArray(a[0]) ? a[0] : [];
          const out = [];
          for (const nm0 of names) { const nm = toApexString(nm0); await this.ensureDescribe(nm); out.push({ __describeResult: nm }); }
          return out;
        }
        this.log(`Schema.${name}: describe calls are not simulated locally`, 'system');
        return null;
      }
      if (t === 'type') {
        if (n === 'forname') {
          // forName(name) or forName(namespace, name). Return a type handle, or
          // null for an empty/unknown name so `if (oType != null)` guards behave
          // exactly as in real Apex.
          let nm;
          if (a.length >= 2) {
            const ns = a[0] != null ? toApexString(a[0]) : '';
            const base = a[1] != null ? toApexString(a[1]) : '';
            nm = ns ? `${ns}__${base}` : base;
          } else {
            nm = a.length && a[0] != null ? toApexString(a[0]) : '';
          }
          return (nm && nm !== 'null') ? { __typeToken: nm } : null;
        }
        return null;
      }
      // ---- Custom Settings (__c) / Custom Metadata (__mdt) built-in static methods ----
      // getInstance / getInstance(id|name) / getOrgDefaults / getValues(name) / getAll.
      // Resolve REAL values from the connected org; fall back to a typed empty stub so
      // execution keeps stepping instead of dying on a NoSuchMethodException.
      if (/__(c|mdt)$/i.test(typeName) &&
          (n === 'getinstance' || n === 'getorgdefaults' || n === 'getvalues' || n === 'getall')) {
        return await this.resolveCustomSettingCall(typeName, name, n, a, line);
      }
      // <SObjectTypeName>.getSObjectType() — a static Schema call on a type name
      // (e.g. ProductConfiguration__c.getSObjectType()). Return the API-name
      // STRING (Apex Schema.SObjectType stringifies to the API name and is used
      // as a Map/cache key throughout CPQ code). The describe chain is reachable
      // via <string>.getDescribe() (see callStringMethod), so field-name
      // resolution still works against real org metadata.
      if (n === 'getsobjecttype') return typeName;
      // Unknown namespace/class — try lazy class load once
      const ci = await this.lazyLoadClass(typeName);
      if (ci) {
        const { ci: fci, m } = this.findMethodInHierarchy(ci, name, a, true);
        if (m && m.static) return this.invokeMethod(fci, m, null, a, frame);
      }
      // Lowercase-first name that isn't a known class or builtin is almost certainly
      // an unresolved local variable whose declaration failed earlier.  Evaluating it
      // against the org as if it were a class reference produces nonsense results
      // (e.g. "configs.isEmpty()" being org-evaled as a class call).  Catch it here,
      // warn once, and return null so stepping continues.
      if (/^[a-z]/.test(typeName) && !BUILTIN_TYPES.has(t) && !BUILTIN_ENUMS[t] && !this.registry.get(typeName)) {
        if (!this._unresolvedVarWarned.has(typeName)) {
          this._unresolvedVarWarned.add(typeName);
          this.log(`⚠ '${typeName}' isn't in scope here (its declaration may have failed) — treating as null.`, 'system');
        }
        return null;
      }
      // Graceful degradation (V8-style "keep going"): a genuinely unsupported static
      // method must NOT halt the whole debug session. Try to resolve the entire call
      // in the org when every argument is a serializable scalar; otherwise log a
      // warning and return null so line-by-line stepping continues.
      const orgVal = await this.tryOrgStaticCall(typeName, name, a);
      if (orgVal !== ENGINE_UNRESOLVED) return orgVal;
      this._noteGap(`${typeName}.${name}() is not simulated and could not be resolved in the org`, 'engine-gap', { line, what: 'static call' });
      return null;
    }

    /* ---------- custom setting / metadata resolution via the org ---------- */
    apexLiteral(v) {
      if (v === null || v === undefined) return 'null';
      if (typeof v === 'number') return String(v);
      if (typeof v === 'boolean') return String(v);
      if (v instanceof ApexDate) return `Date.newInstance(${v.y}, ${v.mo}, ${v.day})`;
      return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }

    /** Convert plain JSON from an org eval into engine SObject/scalar values. */
    orgJsonToSObject(v, typeName) {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(x => this.orgJsonToSObject(x, typeName));
      const rec = {};
      for (const k of Object.keys(v)) {
        const child = v[k];
        rec[k] = (child && typeof child === 'object')
          ? this.orgJsonToSObject(child, (child && child.attributes && child.attributes.type) || 'SObject')
          : child;
      }
      if (!rec.attributes) rec.attributes = { type: typeName };
      return rec;
    }

    async resolveCustomSettingCall(typeName, methodName, n, a, line) {
      // ── Perf (issues 2 & 4): LIST custom settings ──────────────────────────
      // A LIST custom setting's getInstance(name) is exactly getAll().get(name)
      // (same real records). So instead of one org round-trip per name — the log
      // showed DataCache__c.getInstance('LineItemRemoteCPQFields_0'..'_31') firing
      // 32× — fetch getAll() ONCE per type (session-cached) and serve each name
      // from it. This is truthful: getAll() returns the identical real records.
      // HIERARCHY settings are NOT batched: getInstance()/getInstance(Id) merge
      // org/profile/user levels, which getAll() cannot reproduce — those stay
      // direct (guarded by the Salesforce-Id / no-arg checks below).
      if (n === 'getinstance' && a.length) {
        const key = toApexString(a[0]);
        if (key != null && key !== '' && !this._looksLikeSalesforceId(key)) {
          const all = await this._customSettingGetAll(typeName);
          if (all) return all.containsKey(key) ? all.get(key) : null;
          // getAll unavailable → fall through to the direct per-name path below.
        }
      } else if (n === 'getall') {
        const all = await this._customSettingGetAll(typeName);
        if (all) return all;
        // fall through to the direct path (which emits the empty-map stub).
      }

      const argLit = a.length ? this.apexLiteral(a[0]) : null;
      let expr;
      if (n === 'getall') expr = `${typeName}.getAll()`;
      else if (n === 'getorgdefaults') expr = `${typeName}.getOrgDefaults()`;
      else if (n === 'getvalues') expr = `${typeName}.getValues(${argLit != null ? argLit : "''"})`;
      else expr = argLit != null ? `${typeName}.getInstance(${argLit})` : `${typeName}.getInstance()`;

      let val = ENGINE_UNRESOLVED;
      if (this.host.evalOrg) {
        this.pendingBackend = `${typeName}.${methodName}() from org…`;
        try {
          const r = await this.host.evalOrg(expr, { sobjectType: typeName });
          if (r && r.ok) val = r.value;
        } catch (_) { /* fall through to stub */ }
        finally { this.pendingBackend = null; }
      }
      if (val === ENGINE_UNRESOLVED) {
        // The org round-trip came back unresolved (org/CLI flakiness — e.g. the old
        // CLI crashing on a huge log). Degrade to a value that MATCHES real Apex
        // semantics for THIS call, never a phantom record that would crash on the
        // first field dereference (that was a fabricated NullPointerException).
        if (n === 'getall') {
          // Apex getAll() never returns null → an empty map is safe to iterate.
          this._noteOrgUnresolved(`${typeName}.getAll()`, 'an empty map', line);
          return new ApexMap();
        }
        const key = a.length ? toApexString(a[0]) : null;
        if ((n === 'getinstance' || n === 'getvalues') && key != null && key !== '' && !this._looksLikeSalesforceId(key)) {
          // LIST custom setting getInstance(name)/getValues(name): Apex returns NULL
          // when no record has that name, and CPQ code universally relies on the
          //   ConfigX__c dc = ConfigX__c.getInstance(name + '_' + i);
          //   if (dc == null) return null;           // ← this guard
          // pattern. Returning null (instead of an empty {} stub) lets that guard run
          // and eliminates the whole class of fabricated NPEs like
          // "de-reference a null object (calling 'intValue')" on dc.IsLast__c.
          this._noteOrgUnresolved(`${typeName}.${methodName}('${key}')`, 'null (treated as no matching record, which is what Apex returns)', line);
          return null;
        }
        // Hierarchy getInstance()/getInstance(Id)/getOrgDefaults()/getValues(Id):
        // Apex never returns null here (it merges org/profile/user defaults), so we
        // return an empty record so stepping continues — TAGGED __ccUnresolved (a
        // non-enumerable marker) so any value read from it is understood to be an
        // unknown placeholder, not real org data, rather than being blamed on the code.
        this._noteOrgUnresolved(`${typeName}.${methodName}(${key != null ? "'" + key + "'" : ''})`, 'an empty record (values unknown, not real)', line);
        const stub = { attributes: { type: typeName } };
        try { Object.defineProperty(stub, '__ccUnresolved', { value: true, enumerable: false, configurable: true }); } catch (_) {}
        return stub;
      }
      if (n === 'getall') {
        const m = new ApexMap();
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (const k of Object.keys(val)) m.put(k, this.orgJsonToSObject(val[k], typeName));
        }
        return m;
      }
      const rec = this.orgJsonToSObject(val, typeName);
      // Honor a real "no such record" result. A LIST custom setting's
      // getInstance(name)/getValues(name) returns null in Apex when no record has
      // that name (CPQ relies on this: `if (dataCache == null) return null;`).
      // Hierarchy getInstance()/getOrgDefaults() never return null, so the org
      // yields a record there and we pass it through. Only ENGINE_UNRESOLVED (org
      // unreachable, handled above) degrades to a stub — never a resolved null.
      if (rec === null || rec === undefined) return null;
      return (typeof rec === 'object') ? rec : { attributes: { type: typeName } };
    }

    /** Fetch a LIST custom setting's getAll() ONCE per type (session-cached),
     *  returned as an ApexMap<Name, record>. In-flight de-dupes concurrent calls.
     *  Returns null when the org value is unavailable so the caller falls back to
     *  a direct per-name query (never fabricates). */
    async _customSettingGetAll(typeName) {
      if (!this._csAllCache) this._csAllCache = new Map();
      if (this._csAllCache.has(typeName)) return this._csAllCache.get(typeName);
      if (!this._csAllInflight) this._csAllInflight = new Map();
      if (this._csAllInflight.has(typeName)) return this._csAllInflight.get(typeName);

      const p = (async () => {
        let val = ENGINE_UNRESOLVED;
        if (this.host.evalOrg) {
          this.pendingBackend = `${typeName}.getAll() from org…`;
          try {
            const r = await this.host.evalOrg(`${typeName}.getAll()`, { sobjectType: typeName });
            if (r && r.ok) val = r.value;
          } catch (_) { /* leave unresolved → null */ }
          finally { this.pendingBackend = null; }
        }
        if (val === ENGINE_UNRESOLVED || !val || typeof val !== 'object' || Array.isArray(val)) return null;
        const m = new ApexMap();
        for (const k of Object.keys(val)) m.put(k, this.orgJsonToSObject(val[k], typeName));
        this._csAllCache.set(typeName, m);
        return m;
      })();
      this._csAllInflight.set(typeName, p);
      try { return await p; }
      finally { this._csAllInflight.delete(typeName); }
    }

    /** True when s looks like a 15- or 18-char Salesforce Id. Hierarchy custom
     *  setting getInstance(Id) must NOT be batched via getAll() (it merges
     *  org/profile/user levels), so such args stay on the direct path. Requiring
     *  a digit avoids misreading all-alpha list-setting Names as Ids. */
    _looksLikeSalesforceId(s) {
      return typeof s === 'string' && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(s) && /[0-9]/.test(s);
    }

    /** Try to resolve an arbitrary static call in the org (scalar args only). */
    async tryOrgStaticCall(typeName, methodName, a) {
      // VF-only namespaces are illegal in anon Apex — never send them to the org.
      const blocked = new Set(['apexpages', 'pagereference']);
      if (blocked.has(typeName.toLowerCase())) return ENGINE_UNRESOLVED;
      if (!this.host.evalOrg) return ENGINE_UNRESOLVED;
      for (const x of a) { if (x !== null && x !== undefined && typeof x === 'object') return ENGINE_UNRESOLVED; }
      const expr = `${typeName}.${methodName}(${a.map(x => this.apexLiteral(x)).join(', ')})`;
      this.pendingBackend = `${typeName}.${methodName}() from org…`;
      try {
        const r = await this.host.evalOrg(expr, {});
        if (r && r.ok) {
          const v = r.value;
          return (v !== null && typeof v === 'object') ? this.orgJsonToSObject(v, 'SObject') : v;
        }
      } catch (_) { /* ignore */ }
      finally { this.pendingBackend = null; }
      return ENGINE_UNRESOLVED;
    }

    /** Resolve a UserInfo.* call truthfully from the org, reproducing thrown
     *  exceptions so caller try/catch fires exactly as in production. Results are
     *  cached per (method, args) because identity/license data is session-stable. */
    async callUserInfoViaOrg(methodName, n, a, line) {
      const key = `${n}(${a.map(x => this.apexLiteral(x)).join(',')})`;
      if (!this._userInfoCache) this._userInfoCache = new Map();
      if (this._userInfoCache.has(key)) {
        const c = this._userInfoCache.get(key);
        if (c && c.__throw) throw new ApexError(c.type, c.message, line);
        return c;
      }
      // isCurrentUserLicensed must yield a real Boolean so callers like
      // `if (!isComplyEnabled())` never de-reference null. Fall back to false when
      // the org is unreachable — that matches CPQ's own catch-block default.
      const licenseCheck = (n === 'iscurrentuserlicensed');
      const fallback = licenseCheck ? false : null;
      if (!this.host.evalOrg) return fallback;
      // UserInfo methods take only scalars (namespace string / id) or no args.
      for (const x of a) { if (x !== null && x !== undefined && typeof x === 'object') return fallback; }
      const expr = `UserInfo.${methodName}(${a.map(x => this.apexLiteral(x)).join(', ')})`;
      this.pendingBackend = `UserInfo.${methodName}() from org…`;
      let r = null;
      try { r = await this.host.evalOrg(expr, {}); }
      catch (_) { r = null; }
      finally { this.pendingBackend = null; }
      if (r && r.ok) {
        const v = (r.value !== null && typeof r.value === 'object')
          ? this.orgJsonToSObject(r.value, 'SObject') : r.value;
        this._userInfoCache.set(key, v);
        return v;
      }
      // Org reported a thrown Apex exception → reproduce it so caller try/catch
      // handles it (e.g. TypeException for an uninstalled managed-package namespace).
      const errStr = (r && r.error) ? String(r.error) : '';
      const m = errStr.match(/^([A-Za-z_][\w.]*Exception)\s*:\s*([\s\S]*)$/);
      if (m) {
        this._userInfoCache.set(key, { __throw: true, type: m[1], message: m[2] });
        throw new ApexError(m[1], m[2], line);
      }
      // Genuinely unresolved (no org / transient failure): degrade to a safe value.
      return fallback;
    }

    /* ---------- general Live-data seam ----------
     * Single entry point every "I don't have this value locally" branch routes
     * through. host.evalOrg is gated by the debugger's Live Org toggle, so when
     * Live is OFF (or no org) this is a cheap no-op returning ENGINE_UNRESOLVED
     * and the caller falls back to normal local behavior. When Live is ON we get
     * the REAL value from the connected org. We NEVER fabricate — an unresolved
     * value stays unresolved so faithful behavior (null / NPE) still surfaces. */
    async resolveViaOrg(expr, ctx) {
      if (!this.host.evalOrg) return ENGINE_UNRESOLVED;
      this.pendingBackend = `resolving ${expr} from org…`;
      try {
        const r = await this.host.evalOrg(expr, ctx || {});
        if (r && r.ok) {
          const v = r.value;
          return (v !== null && typeof v === 'object')
            ? this.orgJsonToSObject(v, (ctx && ctx.sobjectType) || 'SObject')
            : v;
        }
      } catch (_) { /* fall through to unresolved */ }
      finally { this.pendingBackend = null; }
      return ENGINE_UNRESOLVED;
    }

    /* Resolve a custom label's REAL text from the connected org. Apex compiles
     * label references, so any label the source names exists in the org; if the
     * org is unreachable we return null (never a fabricated string). */
    async resolveLabel(name, line) {
      if (!this._labelCache) this._labelCache = new Map();
      const key = String(name);
      if (this._labelCache.has(key)) return this._labelCache.get(key);
      const v = await this.resolveViaOrg('System.Label.' + name, {});
      const out = (v !== ENGINE_UNRESOLVED) ? v : null;
      if (v === ENGINE_UNRESOLVED) this.log(`⚠ System.Label.${name} could not be resolved from org — returning null.`, 'system');
      this._labelCache.set(key, out);
      return out;
    }

    /* Lazily fetch a single field that wasn't part of the record's original query.
     * Only fires when Live data is on, the record has a real 15/18-char Id and a
     * concrete SObject type. The fetched value is cached back onto the record so
     * subsequent reads (and re-reads of a genuinely-null field) don't re-query. */
    async hydrateSObjectField(rec, field) {
      if (!this.host.query) return ENGINE_UNRESOLVED;
      const id = sobjGet(rec, 'Id');
      const type = sobjType(rec);
      if (id === undefined || id === null || !/^[a-zA-Z0-9]{15,18}$/.test(String(id))) return ENGINE_UNRESOLVED;
      if (!type || type === 'SObject') return ENGINE_UNRESOLVED;
      const soql = `SELECT ${field} FROM ${type} WHERE Id = '${String(id).replace(/'/g, "\\'")}' LIMIT 1`;
      this.pendingBackend = `hydrating ${type}.${field} from org…`;
      try {
        const rows = await this.host.query(soql, {}, { probe: true });
        if (Array.isArray(rows) && rows.length) {
          const val = sobjGet(rows[0], field);
          if (val === undefined) {
            // The row came back but WITHOUT the requested field — the org dropped it as
            // a non-existent column. Cache null so repeat reads stay quiet, and signal
            // the field is genuinely absent (not merely a transient miss).
            sobjSet(rec, field, null);
            return ENGINE_FIELD_ABSENT;
          }
          const resolved = val === undefined ? null : val;
          sobjSet(rec, field, resolved); // cache onto the live record
          return resolved;
        }
      } catch (e) {
        // Distinguish a permanent schema gap ("No such column" / INVALID_FIELD / "not
        // supported") from a transient org/CLI failure: the former means the connected
        // org simply does not have this field, so retrying is pointless and the honest
        // outcome is a recorded absence; the latter degrades quietly to unresolved.
        const msg = String((e && (e.apexMessage || e.message)) || '');
        if (/No such column|INVALID_FIELD|not supported|Didn.?t understand relationship|does\s?n.?t exist/i.test(msg)) {
          sobjSet(rec, field, null);
          return ENGINE_FIELD_ABSENT;
        }
      }
      finally { this.pendingBackend = null; }
      return ENGINE_UNRESOLVED;
    }
  }

  /* ================= exports ================= */
  // Mark / unmark a live engine object for watch + data-flow observation. The UI
  // obtains the real reference (from hover / variables) and calls these so it never
  // has to poke engine-internal flags directly. Only ApexObject participates in the
  // get/setField observer; other containers can still be pinned for live-value
  // display but won't emit field deltas.
  function trackObject(obj, watchId) {
    if (!obj || typeof obj !== 'object') return false;
    obj.__tracked = true;
    if (watchId != null) obj.__watchId = watchId;
    return true;
  }
  function untrackObject(obj) {
    if (!obj || typeof obj !== 'object') return false;
    try { delete obj.__tracked; } catch (_) { obj.__tracked = false; }
    return true;
  }

  const API = {
    ApexEngine, ApexError, ApexMap, ApexSet, ApexObject, ApexDate, ApexDatetime, ApexTime, ApexBlob, ApexEnumValue,
    ApexJsonGenerator, ApexJsonParser,
    Environment, toApexString, typeNameOf, apexEquals, formatValue: toApexString, isSObject, sobjType,
    trackObject, untrackObject,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined') globalThis.ApexEngine = API;
})();

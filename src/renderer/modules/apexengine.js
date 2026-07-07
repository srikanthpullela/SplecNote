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

  /* ================= user-class instance ================= */
  class ApexObject {
    constructor(classInfo) {
      this.classInfo = classInfo;           // ClassInfo
      this.fields = new Map();              // lower-name -> { name, value }
    }
    getField(name) { const e = this.fields.get(name.toLowerCase()); return e ? e.value : undefined; }
    hasField(name) { return this.fields.has(name.toLowerCase()); }
    setField(name, value) {
      const lk = name.toLowerCase();
      const e = this.fields.get(lk);
      if (e) e.value = value; else this.fields.set(lk, { name, value });
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
    if (v instanceof ApexError) return v.toString();
    if (v instanceof ApexObject) {
      const parts = [];
      for (const e of v.fields.values()) parts.push(`${e.name}=${toApexString(e.value)}`);
      return `${v.classInfo.name}:[${parts.join(', ')}]`;
    }
    if (isSObject(v)) {
      // Schema describe-chain handles stringify to their API name (matches Apex,
      // e.g. `'' + ProductConfiguration__c.getSObjectType()` → 'ProductConfiguration__c').
      if (v.__sobjectType) return v.__sobjectType;
      if (v.__describeResult) return v.__describeResult;
      if (v.__fieldsHandle) return v.__fieldsHandle;
      if (v.__sobjectField) return v.__sobjectField.field;
      if (v.__describeFieldResult) return v.__describeFieldResult.field;
      if (v.__typeToken) return v.__typeToken;
      const parts = [];
      for (const k of Object.keys(v)) { if (k === 'attributes') continue; parts.push(`${k}=${toApexString(v[k])}`); }
      return `${sobjType(v)}:{${parts.join(', ')}}`;
    }
    return String(v);
  }
  function apexEquals(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
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
  const BUILTIN_TYPES = new Set(['string', 'integer', 'long', 'double', 'decimal', 'boolean', 'id', 'object', 'date', 'datetime', 'time', 'blob', 'list', 'map', 'set', 'math', 'json', 'system', 'database', 'limits', 'userinfo', 'test', 'schema', 'sobject', 'exception', 'type', 'url', 'void', 'string.format', 'logginglevel', 'apexpages', 'dom']);
  const BUILTIN_ENUMS = {
    'logginglevel': ['NONE', 'INTERNAL', 'FINEST', 'FINER', 'FINE', 'DEBUG', 'INFO', 'WARN', 'ERROR'],
    'apexpages.severity': ['CONFIRM', 'ERROR', 'FATAL', 'INFO', 'WARNING'],
    'triggeroperation': ['BEFORE_INSERT', 'BEFORE_UPDATE', 'BEFORE_DELETE', 'AFTER_INSERT', 'AFTER_UPDATE', 'AFTER_DELETE', 'AFTER_UNDELETE'],
    'quiddity': ['ANONYMOUS', 'AURA', 'BATCH_APEX', 'FUTURE', 'INVOCABLE_ACTION', 'QUEUEABLE', 'REST', 'RUNTEST_SYNC', 'SCHEDULED', 'SOAP', 'SYNCHRONOUS', 'VF'],
    'dom.xmlnodetype': ['ELEMENT', 'COMMENT', 'TEXT', 'CDATA', 'PROCESSING_INSTRUCTION'],
  };
  // Sentinel returned by org-eval helpers when a value could not be resolved from the org.
  const ENGINE_UNRESOLVED = Symbol('engine-unresolved');

  class ApexEngine {
    constructor(host) {
      this.host = host || {};
      this.registry = new ClassRegistry();
      this.callStack = [];                 // frames, bottom-first
      this.mode = 'into';                  // 'continue' | 'into' | 'over' | 'out'
      this.stepDepth = 0;
      this.paused = false;
      this.stopped = false;
      this.pauseRequested = false;
      this._resume = null;
      this.pendingBackend = null;          // label while awaiting org data
      this.maxSteps = 200000;
      this._steps = 0;
      this.dmlLog = [];
      this.pageMessages = [];
    }

    loadSource(fileName, source) {
      const unit = Lang.parse(source);
      return this.registry.register(unit, fileName);
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
      const r = this._resume; this._resume = null;
      if (r) r('stop');
    }

    /* ---------- the V8-style pause gate ---------- */
    async gate(node, frame, reason) {
      if (this.stopped) throw new StopSignal();
      if (!node || !node.line) return;
      frame.line = node.line;
      // Track the line currently executing and surface it to the UI so a running
      // (Continue) session shows WHERE it is — most valuable on a slow line that
      // then awaits the org (SOQL/describe/eval), which yields to let the UI paint
      // the highlight before the fetch returns.
      this.currentLine = node.line; this.currentFile = frame.file;
      if (this.host.onExecLine && (this._lastExecLine !== node.line || this._lastExecFile !== frame.file)) {
        this._lastExecLine = node.line; this._lastExecFile = frame.file;
        try { this.host.onExecLine({ line: node.line, file: frame.file }); } catch (_) { /* UI errors never kill execution */ }
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
          if (bp.condition) {
            try {
              const v = await this.evalExpressionInFrame(bp.condition, frame);
              if (v === true) pauseReason = 'breakpoint';
            } catch (err) { /* errored conditions never pause (Chrome behavior) */ }
          } else pauseReason = 'breakpoint';
        }
        // A breakpoint pauses once per arrival at the line, not for every
        // nested gate on the same line (for-init / body-block share lines).
        if (pauseReason === 'breakpoint' && this._lastBpKey === gateKey) pauseReason = null;
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

    /* ---------- entry points ---------- */
    async run(className, methodName, argValues) {
      this.stopped = false; this._steps = 0;
      // Reset per-session pause state so a RESTART re-honors breakpoints. Without
      // this, _lastBpKey retains the previous run's gate key and the breakpoint at
      // the same line+depth (e.g. the method's first line) is suppressed on re-run.
      this._lastBpKey = null;
      this._hasSteppedOnce = false;
      this.pauseRequested = false;
      this.callStack = [];
      this._recursionReported = false;
      this.pageMessages = [];
      this.dmlLog = [];
      const cls = this.registry.get(className) || await this.lazyLoadClass(className);
      if (!cls) throw new ApexError('System.TypeException', `Class not found: ${className}`, 0);
      const methods = cls.findMethods(methodName);
      if (!methods.length) throw new ApexError('System.NoSuchMethodException', `Method ${className}.${methodName} not found`, 0);
      const method = this.pickOverload(methods, argValues || []);
      try {
        let thisRef = null;
        if (!method.static) thisRef = await this.instantiate(cls, [], null, 0);
        const result = await this.invokeMethod(cls, method, thisRef, argValues || [], null);
        if (this.host.onDone) this.host.onDone(result);
        return result;
      } catch (e) {
        if (e instanceof StopSignal) { if (this.host.onDone) this.host.onDone(undefined); return undefined; }
        if (this.host.onError) this.host.onError(e);
        throw e;
      }
    }

    async runAnonymous(source, fileName) {
      this.stopped = false; this._steps = 0;
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

    pickOverload(methods, args) {
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
          score += this.scoreArgToParam(args[i], pt);
        }
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return best;
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
      if (arg instanceof ApexObject) {
        if (this.apexObjIsA(arg.classInfo, bl)) return 3;
        return -2;
      }
      if (isSObject(arg)) {
        if (bl === 'sobject') return 2;
        const t = String(sobjType(arg)).toLowerCase();
        if (t === bl || stripNs(t) === stripNs(bl)) return 3;
        // unknown/stub SObject vs a concrete object type -> weak compatible
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
      if (this.callStack.length > 500) {
        // Interpreter recursion guard. Surface the repeating cycle so the user
        // (and we) can see WHICH methods loop, instead of a bare limit error
        // that a CPQ `catch (Exception)` swallows far from the real cause.
        const cycle = this._describeRecursionCycle();
        if (this.host.log && !this._recursionReported) {
          this._recursionReported = true;
          this.host.log(`♻ Runaway recursion detected — the interpreter kept re-entering the same call cycle ${cycle.reps}× and stopped at depth ${this.callStack.length}. Repeating cycle:\n${cycle.text}`, 'system');
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
      return this.execStmtInner(stmt, frame);
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
      this.host.log(`⚠ Caught ${err.apexType || 'Exception'}: ${err.apexMessage || err.message || ''}${where} → handled by catch (${caughtAs}${catchClause && catchClause.name ? ' ' + catchClause.name : ''}). Execution continues in the catch block.`, 'system');
      if (err.apexStack && err.apexStack.length > 1) {
        this.host.log(err.apexStack.map(f => `      at ${f.className}.${f.methodName} (line ${f.line})`).join('\n'), 'system');
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
        if (this.host.log) this.host.log(`DML ${op.toUpperCase()}: ${records.length} ${records.length && records[0] ? sobjType(records[0]) : 'SObject'} record(s)`, 'dml');
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
      // maybe a class reference (for static access) — return a marker
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
          const ev = (ci.ast.enumValues || []).find(v => v.toLowerCase() === e.name.toLowerCase());
          if (ev) return ev;
        }
        if (ci.staticEnv.has(e.name)) return ci.staticEnv.get(e.name);
        const inner = this.registry.getInner(ci, e.name);
        if (inner) return { __classRef: inner };
        throw new ApexError('System.VariableDoesNotExistException', `Static ${ci.name}.${e.name} does not exist`, e.line);
      }
      if (target.__builtinRef) return await this.staticProp(target.__builtinRef, e.name, e.line);
      return this.memberGet(target, e.name, e.line, frame);
    }

    async memberGet(target, name, line, frame) {
      // Schema describe chain: `.fields` is accessed as a property on a
      // DescribeSObjectResult; the other handles expose no plain fields.
      if (target && typeof target === 'object' && !(target instanceof ApexObject)) {
        if (target.__describeResult && name.toLowerCase() === 'fields') return { __fieldsHandle: target.__describeResult };
        if (target.__sobjectType || target.__fieldsHandle || target.__sobjectField || target.__describeFieldResult || target.__typeToken) {
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
    async runSoql(e, frame) {
      const binds = {};
      for (const b of e.binds || []) {
        try {
          const ast = Lang.parseExpression(b.expr);
          binds[b.expr] = await this.evalExpr(ast, frame);
        } catch (err) { binds[b.expr] = null; }
      }      this.pendingBackend = 'SOQL query against org…';
      if (this.host.log) this.host.log(`SOQL → org: ${e.raw.replace(/\s+/g, ' ').slice(0, 200)}`, 'soql');
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
          binds[expr] = await this.evalExpr(ast, frame);
        } catch (_) { binds[expr] = null; }
      }
      return binds;
    }

    /* ---------- calls ---------- */
    async evalCall(e, frame) {
      // Unqualified call: method on this / current class statics
      if (!e.target) {
        const args = await this.evalArgs(e.args, frame);
        if (frame.classInfo) {
          const { ci, m } = this.findMethodInHierarchy(frame.classInfo, e.name, args);
          if (m) return this.invokeMethod(ci, m, m.static ? null : frame.thisRef, args, frame);
        }
        throw new ApexError('System.NoSuchMethodException', `Method ${e.name}(${args.length} args) not found`, e.line);
      }
      const target = await this.evalTargetMaybeType(e.target, frame);
      if (target === null || target === undefined) {
        if (e.safe) return null;
        throw npe(e.line, `Attempt to de-reference a null object (calling '${e.name}')`);
      }
      const args = await this.evalArgs(e.args, frame);
      if (target.__classRef) {
        const ci = target.__classRef;
        const { ci: foundCi, m } = this.findMethodInHierarchy(ci, e.name, args, true);
        if (m) {
          if (m.static) return this.invokeMethod(foundCi, m, null, args, frame);
          throw new ApexError('System.TypeException', `Non-static method ${e.name} called statically on ${ci.name}`, e.line);
        }
        // enum helpers
        if (ci.ast.isEnum && e.name.toLowerCase() === 'values') return (ci.ast.enumValues || []).slice();
        throw new ApexError('System.NoSuchMethodException', `Static method ${ci.name}.${e.name} not found`, e.line);
      }
      if (target.__builtinRef) return this.callStaticBuiltin(target.__builtinRef, e.name, args, e.line, frame);
      if (e.target.kind === 'super' && frame.classInfo) {
        const superCi = this.superOf(frame.classInfo);
        if (superCi) {
          const { ci: fci, m } = this.findMethodInHierarchy(superCi, e.name, args);
          if (m) return this.invokeMethod(fci, m, frame.thisRef, args, frame);
        }
      }
      return this.callInstanceMethod(target, e.name, args, e.line, frame);
    }

    findMethodInHierarchy(ci, name, args, staticsOnly) {
      let c = ci;
      while (c) {
        const ms = c.findMethods(name);
        if (ms.length) {
          const m = this.pickOverload(ms, args);
          return { ci: c, m };
        }
        c = this.superOf(c);
      }
      return { ci: null, m: null };
    }

    async callInstanceMethod(target, name, args, line, frame) {
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
      }
      if (target instanceof ApexObject) {
        const { ci, m } = this.findMethodInHierarchy(target.classInfo, name, args);
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
      if (target instanceof ApexDate) return this.callDateMethod(target, name, args, line);
      if (target instanceof ApexDatetime) return this.callDatetimeMethod(target, name, args, line);
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
      let info = { name, names: [], label: name, prefix: '', plural: name, error: null, resolved: false };
      if (this.host.describeSObject) {
        this.pendingBackend = `describe ${name} from org…`;
        try {
          const r = await this.host.describeSObject(name);
          if (r && Array.isArray(r.names) && r.names.length) {
            info = { name, names: r.names, label: r.label || name, prefix: r.prefix || '', plural: r.plural || name, error: null, resolved: true };
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
      if (this.host.log) this.host.log(`⚠ Schema.SObjectType.${name}() not simulated — returning null`, 'system');
      return null;
    }
    async callDescribeResultMethod(tok, name, args, line, frame) {
      const nm = tok.__describeResult; const info = await this.ensureDescribe(nm); const lk = name.toLowerCase();
      if (lk === 'getname') return nm;
      if (lk === 'getlocalname') return stripNs(nm);
      if (lk === 'getlabel') return info.label;
      if (lk === 'getlabelplural') return info.plural;
      if (lk === 'getkeyprefix') return info.prefix || null;
      if (lk === 'getsobjecttype') return nm;
      if (lk === 'fields' || lk === 'getfields') return { __fieldsHandle: nm };
      if (lk === 'tostring') return nm;
      if (lk === 'iscustom') return /__c$/i.test(nm);
      if (lk === 'iscustomsetting' || lk === 'isfeedenabled' || lk === 'ismergeenabled' ||
          lk === 'isdeprecatedandhidden') return false;
      // Permission/FLS flags: stepping runs in system context, so default these
      // to true (returning null would wrongly skip guarded code paths). No warning.
      if (lk === 'isaccessible' || lk === 'iscreateable' || lk === 'isupdateable' ||
          lk === 'isdeletable' || lk === 'isundeletable' || lk === 'isqueryable' ||
          lk === 'issearchable') return true;
      if (this.host.log) this.host.log(`⚠ DescribeSObjectResult.${name}() not simulated — returning null`, 'system');
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
      if (this.host.log) this.host.log(`⚠ Schema fields.${name}() not simulated — returning null`, 'system');
      return null;
    }
    callSObjectFieldMethod(tok, name, args, line) {
      const f = tok.__sobjectField; const lk = name.toLowerCase();
      if (lk === 'getdescribe') return { __describeFieldResult: f };
      if (lk === 'getsobjectfield') return tok;
      if (lk === 'getname' || lk === 'tostring') return f.field;
      if (this.host.log) this.host.log(`⚠ Schema.SObjectField.${name}() not simulated — returning null`, 'system');
      return null;
    }
    callDescribeFieldResultMethod(tok, name, args, line) {
      const f = tok.__describeFieldResult; const lk = name.toLowerCase();
      if (lk === 'getname' || lk === 'tostring') return f.field;
      if (lk === 'getlocalname') return stripNs(f.field);
      if (lk === 'getlabel') return f.field;
      if (lk === 'getsobjecttype') return f.sobject;
      if (lk === 'isaccessible' || lk === 'iscreateable' || lk === 'isupdateable' ||
          lk === 'isnillable' || lk === 'issortable' || lk === 'isfilterable') return true;
      if (lk === 'iscustom') return /__c$/i.test(f.field);
      if (this.host.log) this.host.log(`⚠ DescribeFieldResult.${name}() not simulated — returning null`, 'system');
      return null;
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
        case 'gettime': return dt.getTime();
        case 'format': return dt.format(a[0]);
        case 'year': return dt.d.getFullYear();
        case 'month': return dt.d.getMonth() + 1;
        case 'day': return dt.d.getDate();
        case 'hour': return dt.d.getHours();
        case 'minute': return dt.d.getMinutes();
        case 'second': return dt.d.getSeconds();
        case 'tostring': return dt.toString();
        default: throw new ApexError('System.NoSuchMethodException', `Datetime.${name} not supported`, line);
      }
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
          if (this.host.log) this.host.log(`⚠ SObject.${name}() is not simulated — returning null and continuing.`, 'system');
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
          if (this.host.log) this.host.log(`⚠ DOM.Document.${name}() is not simulated — returning null and continuing.`, 'system');
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
          if (this.host.log) this.host.log(`⚠ DOM.XmlNode.${name}() is not simulated — returning null and continuing.`, 'system');
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
      // Unknown static prop/constant. Before degrading to null, try to resolve the
      // real value from the org (a class constant we couldn't load locally, a
      // global static, etc.). Gated by Live data — a no-op when Live is off.
      if (!BUILTIN_TYPES.has(t)) {
        const orgVal = await this.resolveViaOrg(`${typeName}.${propName}`, {});
        if (orgVal !== ENGINE_UNRESOLVED) return orgVal;
      }
      // Degrade gracefully (never kill a session)
      if (this.host.log) this.host.log(`⚠ ${typeName}.${propName} is not simulated — returning null and continuing.`, 'system');
      return null;
    }

    async callStaticBuiltin(typeName, name, a, line, frame) {
      const t = typeName.toLowerCase();
      const n = name.toLowerCase();
      if (t === 'system') {
        switch (n) {
          case 'debug': {
            const msg = a.length > 1 ? `[${toApexString(a[0])}] ${toApexString(a[1])}` : toApexString(a[0]);
            if (this.host.log) this.host.log(msg, 'debug');
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
          case 'enqueuejob': { if (this.host.log) this.host.log('System.enqueueJob: queued (simulated, not executed)', 'system'); return fakeId('707'); }
          case 'schedule': { if (this.host.log) this.host.log('System.schedule: scheduled (simulated)', 'system'); return fakeId('708'); }
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
        }
        throw new ApexError('System.NoSuchMethodException', `Math.${name} not supported`, line);
      }
      if (t === 'json') {
        switch (n) {
          case 'serialize': return JSON.stringify(jsonify(a[0]));
          case 'serializepretty': return JSON.stringify(jsonify(a[0]), null, 2);
          case 'deserializeuntyped': return unjsonify(JSON.parse(a[0]));
          case 'deserialize': case 'deserializestrict': return unjsonify(JSON.parse(a[0]));
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
        }
        throw new ApexError('System.NoSuchMethodException', `Date.${name} not supported`, line);
      }
      if (t === 'datetime') {
        switch (n) {
          case 'now': return ApexDatetime.now();
          case 'newinstance': return new ApexDatetime(new Date(a[0], (a[1] || 1) - 1, a[2] || 1, a[3] || 0, a[4] || 0, a[5] || 0));
          case 'valueof': return new ApexDatetime(new Date(a[0]));
        }
        throw new ApexError('System.NoSuchMethodException', `Datetime.${name} not supported`, line);
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
              for (const en of a[1].m.values()) binds[toApexString(en.k)] = en.v;
            } else {
              binds = await this.resolveScopeBinds(raw, frame);
            }
            this.pendingBackend = 'Database.query against org…';
            if (this.host.log) this.host.log(`Database.query → org: ${raw.replace(/\s+/g, ' ').slice(0, 200)}`, 'soql');
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
          case 'rollback': { if (this.host.log) this.host.log('Database.rollback (simulated)', 'system'); return null; }
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
        return null;
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
            if (this.host.log) this.host.log(`ApexPages message [${sev}]: ${sum}`, 'system');
            return null;
          }
          case 'addmessages': {
            const arg = a[0];
            if (arg instanceof ApexError) {
              const synth = { attributes: { type: 'ApexPages.Message' }, severity: 'ERROR', summary: arg.apexMessage, detail: null };
              this.pageMessages.push(synth);
              if (this.host.log) this.host.log(`ApexPages message [ERROR]: ${arg.apexMessage}`, 'system');
            } else if (Array.isArray(arg)) {
              for (const m of arg) { this.pageMessages.push(m); }
            }
            return null;
          }
          case 'getmessages': return this.pageMessages.slice();
          case 'hasmessages': return this.pageMessages.length > 0;
          case 'currentpage':
            if (this.host.log) this.host.log('⚠ ApexPages.currentPage(): VF page context is not simulated — returning null.', 'system');
            return null;
          default:
            if (this.host.log) this.host.log(`⚠ ApexPages.${name}() is not simulated — returning null`, 'system');
            return null;
        }
      }
      if (t === 'schema') {
        if (this.host.log) this.host.log(`Schema.${name}: describe calls are not simulated locally`, 'system');
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
      // Graceful degradation (V8-style "keep going"): a genuinely unsupported static
      // method must NOT halt the whole debug session. Try to resolve the entire call
      // in the org when every argument is a serializable scalar; otherwise log a
      // warning and return null so line-by-line stepping continues.
      const orgVal = await this.tryOrgStaticCall(typeName, name, a);
      if (orgVal !== ENGINE_UNRESOLVED) return orgVal;
      if (this.host.log) this.host.log(`⚠ ${typeName}.${name}() is not simulated and could not be resolved in the org — returning null and continuing.`, 'system');
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
        if (this.host.log) this.host.log(`↳ ${typeName}.${methodName}(): org value unavailable — using an empty ${n === 'getall' ? 'map' : 'record'} stub so stepping continues.`, 'system');
        return n === 'getall' ? new ApexMap() : { attributes: { type: typeName } };
      }
      if (n === 'getall') {
        const m = new ApexMap();
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (const k of Object.keys(val)) m.put(k, this.orgJsonToSObject(val[k], typeName));
        }
        return m;
      }
      const rec = this.orgJsonToSObject(val, typeName);
      return (rec && typeof rec === 'object') ? rec : { attributes: { type: typeName } };
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
        const rows = await this.host.query(soql, {});
        if (Array.isArray(rows) && rows.length) {
          const val = sobjGet(rows[0], field);
          const resolved = val === undefined ? null : val;
          sobjSet(rec, field, resolved); // cache onto the live record
          return resolved;
        }
      } catch (_) { /* fall through to unresolved */ }
      finally { this.pendingBackend = null; }
      return ENGINE_UNRESOLVED;
    }
  }

  /* ================= exports ================= */
  const API = {
    ApexEngine, ApexError, ApexMap, ApexSet, ApexObject, ApexDate, ApexDatetime,
    Environment, toApexString, typeNameOf, apexEquals, formatValue: toApexString, isSObject, sobjType,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined') globalThis.ApexEngine = API;
})();

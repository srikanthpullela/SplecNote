/* ========================================================================
   Apex Debug Studio — Apex Language Front-End (apexlang.js)
   Real lexer + recursive-descent parser for Apex → full AST.
   Used by apexengine.js (the live interpreter) the same way V8's parser
   feeds its interpreter. No DOM dependencies — also loadable in Node
   for engine tests.
   ======================================================================== */
'use strict';

(function (global) {

  /* ================================================================
     LEXER
     ================================================================ */

  const KEYWORDS = new Set([
    'abstract', 'break', 'catch', 'class', 'continue', 'delete', 'do', 'else',
    'enum', 'extends', 'final', 'finally', 'for', 'global', 'if', 'implements',
    'insert', 'instanceof', 'interface', 'merge', 'new', 'null', 'on',
    'override', 'private', 'protected', 'public', 'return', 'static', 'super',
    'switch', 'testmethod', 'this', 'throw', 'transient', 'trigger', 'try',
    'undelete', 'update', 'upsert', 'virtual', 'void', 'webservice', 'when',
    'while', 'true', 'false', 'get', 'set', 'with', 'without', 'inherited',
    'sharing',
  ]);

  const PUNCT = [
    '>>>=', '<<=', '>>=', '>>>', '===', '!==', '==', '!=', '<=', '>=', '&&',
    '||', '++', '--', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '=>', '?.',
    '??', '<<', '{', '}', '(', ')', '[', ']', ';', ',', '.', '<', '>', '+',
    '-', '*', '/', '%', '=', '!', '?', ':', '&', '|', '^', '~', '@',
  ];

  function lex(source) {
    const tokens = [];
    let i = 0, line = 1, col = 1;
    const n = source.length;

    function push(t, v, ln, cl) { tokens.push({ t, v, line: ln, col: cl }); }

    while (i < n) {
      const c = source[i];
      const startLine = line, startCol = col;

      // whitespace
      if (c === '\n') { line++; col = 1; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; col++; continue; }

      // comments
      if (c === '/' && source[i + 1] === '/') {
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        i += 2; col += 2;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') { line++; col = 1; } else col++;
          i++;
        }
        i += 2; col += 2;
        continue;
      }

      // string literal (Apex uses single quotes)
      if (c === '\'') {
        let s = '', j = i + 1;
        col++;
        while (j < n && source[j] !== '\'') {
          if (source[j] === '\\' && j + 1 < n) {
            const e = source[j + 1];
            if (e === 'n') s += '\n';
            else if (e === 't') s += '\t';
            else if (e === 'r') s += '\r';
            else if (e === 'b') s += '\b';
            else if (e === 'f') s += '\f';
            else if (e === '\\') s += '\\';
            else if (e === '\'') s += '\'';
            else if (e === '"') s += '"';
            else if (e === 'u') { // unicode escape
              const hex = source.slice(j + 2, j + 6);
              s += String.fromCharCode(parseInt(hex, 16) || 0);
              j += 4; col += 4;
            } else s += e;
            j += 2; col += 2;
          } else {
            if (source[j] === '\n') { line++; col = 1; } else col++;
            s += source[j]; j++;
          }
        }
        i = j + 1; col++;
        push('str', s, startLine, startCol);
        continue;
      }

      // number
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] || ''))) {
        let j = i, numStr = '';
        while (j < n && /[0-9]/.test(source[j])) { numStr += source[j]; j++; }
        let isDec = false;
        if (source[j] === '.' && /[0-9]/.test(source[j + 1] || '')) {
          isDec = true; numStr += '.'; j++;
          while (j < n && /[0-9]/.test(source[j])) { numStr += source[j]; j++; }
        }
        if (source[j] === 'e' || source[j] === 'E') {
          const save = j;
          let expStr = source[j]; j++;
          if (source[j] === '+' || source[j] === '-') { expStr += source[j]; j++; }
          if (/[0-9]/.test(source[j] || '')) {
            isDec = true;
            while (j < n && /[0-9]/.test(source[j])) { expStr += source[j]; j++; }
            numStr += expStr;
          } else j = save;
        }
        let suffix = '';
        if (/[lLdD]/.test(source[j] || '')) { suffix = source[j].toLowerCase(); j++; }
        col += (j - i); i = j;
        push('num', { value: parseFloat(numStr), isDecimal: isDec || suffix === 'd', isLong: suffix === 'l' }, startLine, startCol);
        continue;
      }

      // identifier / keyword
      if (/[A-Za-z_$]/.test(c)) {
        let j = i, id = '';
        while (j < n && /[A-Za-z0-9_$]/.test(source[j])) { id += source[j]; j++; }
        col += (j - i); i = j;
        const lower = id.toLowerCase();
        if (KEYWORDS.has(lower)) push('kw', lower, startLine, startCol);
        else push('id', id, startLine, startCol);
        // keep original text for keywords too (get/set used as identifiers)
        tokens[tokens.length - 1].raw = id;
        continue;
      }

      // SOQL / SOSL literal: '[' followed by SELECT or FIND
      if (c === '[') {
        let j = i + 1;
        while (j < n && /[\s]/.test(source[j])) j++;
        const ahead = source.slice(j, j + 6).toLowerCase();
        if (ahead.startsWith('select') || ahead.startsWith('find')) {
          // scan to matching ']' honoring quotes and nested brackets
          let depth = 1, k = i + 1, raw = '';
          while (k < n && depth > 0) {
            const ch = source[k];
            if (ch === '\'') {
              raw += ch; k++;
              while (k < n && source[k] !== '\'') {
                if (source[k] === '\\') { raw += source[k]; k++; if (k < n) { raw += source[k]; k++; } continue; }
                if (source[k] === '\n') { line++; col = 1; }
                raw += source[k]; k++;
              }
              if (k < n) { raw += source[k]; k++; }
              continue;
            }
            if (ch === '[') depth++;
            if (ch === ']') { depth--; if (depth === 0) { k++; break; } }
            if (ch === '\n') { line++; col = 1; }
            raw += ch; k++;
          }
          i = k;
          push('soql', stripSoqlComments(raw).trim(), startLine, startCol);
          continue;
        }
      }

      // punctuation / operators
      let matched = null;
      for (const p of PUNCT) {
        if (source.startsWith(p, i)) { matched = p; break; }
      }
      if (matched) {
        i += matched.length; col += matched.length;
        push('p', matched, startLine, startCol);
        continue;
      }

      // unknown char — skip
      i++; col++;
    }
    push('eof', null, line, col);
    return tokens;
  }

  /* ================================================================
     PARSER
     ================================================================ */

  const MODIFIERS = new Set(['public', 'private', 'protected', 'global', 'static',
    'final', 'abstract', 'virtual', 'override', 'transient', 'testmethod', 'webservice']);

  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

  function ParseError(msg, tok) {
    const e = new Error(`${msg} (line ${tok ? tok.line : '?'})`);
    e.apexParse = true;
    e.line = tok ? tok.line : 0;
    return e;
  }

  // Render a parsed type node back to its Apex source form, e.g.
  // { name: 'Map', args: [{name:'String'}, {name:'List', args:[{name:'X'}]}] }
  // -> "Map<String,List<X>>". Used for generic type-class literals (List<X>.class).
  function typeToString(t) {
    if (!t) return '';
    let s = t.name;
    if (t.args && t.args.length) s += '<' + t.args.map(typeToString).join(',') + '>';
    return s;
  }

  // Flatten a parsed ident/prop chain (e.g. `RemoteCPQ.LineItemDO`) into a dotted
  // type-name string. Used for the `<Type>.class` type-literal in postfix position.
  // Returns null when the chain isn't a pure type reference (so we fall back to a
  // normal property access). `class` is a reserved word in Apex and can never be a
  // real member name, so intercepting `.class` here is always safe and general.
  function chainToTypeName(expr) {
    if (!expr) return null;
    if (expr.kind === 'ident') return expr.name;
    if (expr.kind === 'prop' && !expr.safe) {
      const base = chainToTypeName(expr.target);
      return base ? base + '.' + expr.name : null;
    }
    return null;
  }

  // Strip `//` line comments and `/* */` block comments from an inline SOQL/SOSL
  // literal, honoring single-quoted string literals so a legitimate slash inside a
  // string (e.g. 'http://x', or a LIKE pattern) is preserved. Apex removes these
  // comments from bracketed queries at compile time; if they leak through to the
  // org's query parser it rejects them with "unexpected token: '/'". Comments are
  // replaced by a single space so adjacent tokens stay separated. General — applies
  // to every inline query, not any specific one.
  function stripSoqlComments(src) {
    let out = '';
    const n = src.length;
    for (let i = 0; i < n; i++) {
      const c = src[i];
      if (c === '\'') {
        out += c; i++;
        while (i < n && src[i] !== '\'') {
          if (src[i] === '\\') { out += src[i]; i++; if (i < n) { out += src[i]; i++; } continue; }
          out += src[i]; i++;
        }
        if (i < n) out += src[i]; // closing quote
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        i += 2;
        while (i < n && src[i] !== '\n') i++;
        out += ' ';
        if (i < n) out += '\n'; // keep the newline that terminated the comment
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 1; // sit on the closing '/', for-loop i++ steps past it
        out += ' ';
        continue;
      }
      out += c;
    }
    return out;
  }

  class Parser {
    constructor(tokens) {
      this.toks = tokens;
      this.pos = 0;
    }
    peek(k = 0) { return this.toks[Math.min(this.pos + k, this.toks.length - 1)]; }
    next() { return this.toks[this.pos++]; }
    save() { return this.pos; }
    restore(p) { this.pos = p; }
    atEnd() { return this.peek().t === 'eof'; }

    isP(v, k = 0) { const t = this.peek(k); return t.t === 'p' && t.v === v; }
    isKw(v, k = 0) { const t = this.peek(k); return t.t === 'kw' && t.v === v; }
    isId(k = 0) { return this.peek(k).t === 'id'; }
    // identifier OR keyword-used-as-identifier (get/set/when/etc.)
    isName(k = 0) {
      const t = this.peek(k);
      return t.t === 'id' || (t.t === 'kw' && !!t.raw);
    }
    nameVal(t) { return t.raw !== undefined ? t.raw : t.v; }

    expectP(v) {
      if (!this.isP(v)) throw ParseError(`Expected '${v}' but found '${this.tokText()}'`, this.peek());
      return this.next();
    }
    expectKw(v) {
      if (!this.isKw(v)) throw ParseError(`Expected '${v}' but found '${this.tokText()}'`, this.peek());
      return this.next();
    }
    expectName() {
      if (!this.isName()) throw ParseError(`Expected identifier but found '${this.tokText()}'`, this.peek());
      return this.nameVal(this.next());
    }
    tokText() {
      const t = this.peek();
      if (t.t === 'eof') return '<end of file>';
      if (t.t === 'num') return String(t.v.value);
      return String(t.raw !== undefined ? t.raw : t.v);
    }

    /* ---------- annotations & modifiers ---------- */
    skipAnnotations() {
      const anns = [];
      while (this.isP('@')) {
        this.next();
        const name = this.expectName();
        let args = null;
        if (this.isP('(')) {
          // consume balanced parens
          let depth = 0; args = '';
          do {
            const t = this.next();
            if (t.t === 'p' && t.v === '(') depth++;
            else if (t.t === 'p' && t.v === ')') depth--;
            if (depth > 0 && !(t.t === 'p' && t.v === '(')) args += (t.raw !== undefined ? t.raw : (t.t === 'str' ? `'${t.v}'` : t.v)) + ' ';
          } while (depth > 0 && !this.atEnd());
        }
        anns.push({ name, args });
      }
      return anns;
    }

    parseModifiers() {
      const mods = [];
      for (;;) {
        const t = this.peek();
        if (t.t === 'kw' && MODIFIERS.has(t.v)) { mods.push(t.v); this.next(); continue; }
        // "with sharing" / "without sharing" / "inherited sharing"
        if (t.t === 'kw' && (t.v === 'with' || t.v === 'without' || t.v === 'inherited') && this.isKw('sharing', 1)) {
          mods.push(t.v + ' sharing'); this.next(); this.next(); continue;
        }
        break;
      }
      return mods;
    }

    /* ---------- types ---------- */
    // TypeRef: { name: 'Map', dotted: 'System.Type', args: [TypeRef], isArray: bool }
    tryParseType() {
      const start = this.save();
      try { return this.parseType(); }
      catch { this.restore(start); return null; }
    }

    parseType() {
      if (this.isKw('void')) { this.next(); return { name: 'void', args: [], line: this.peek().line }; }
      if (!this.isName()) throw ParseError('Expected type name', this.peek());
      const startTok = this.peek();
      let name = this.expectName();
      // dotted: Schema.Account, MyClass.Inner
      while (this.isP('.') && this.isName(1)) {
        // only continue dotting if it still looks like a type (letter start)
        const save = this.save();
        this.next();
        const part = this.nameVal(this.next());
        name += '.' + part;
        // (heuristic: keep — casts/decls re-verify context)
        void save;
      }
      let args = [];
      if (this.isP('<')) {
        const save = this.save();
        try {
          this.next();
          args.push(this.parseType());
          while (this.isP(',')) { this.next(); args.push(this.parseType()); }
          // may close with '>' or be part of '>>' when nested generics
          if (this.isP('>')) this.next();
          else if (this.isP('>>')) { const t = this.next(); t.v = '>'; this.toks.splice(this.pos, 0, { t: 'p', v: '>', line: t.line, col: t.col }); this.pos--; this.next(); }
          else if (this.isP('>>>')) { const t = this.next(); this.toks.splice(this.pos, 0, { t: 'p', v: '>>', line: t.line, col: t.col }); }
          else throw ParseError('Expected >', this.peek());
        } catch (e) {
          this.restore(save); args = [];
        }
      }
      let isArray = false;
      while (this.isP('[') && this.isP(']', 1)) { this.next(); this.next(); isArray = true; }
      if (isArray) return { name: 'List', args: [{ name, args, line: startTok.line }], isArray: true, line: startTok.line };
      return { name, args, line: startTok.line };
    }

    /* ---------- compilation unit ---------- */
    parseCompilationUnit() {
      const classes = [];
      let trigger = null;
      while (!this.atEnd()) {
        this.skipAnnotations();
        const mods = this.parseModifiers();
        if (this.isKw('class') || this.isKw('interface') || this.isKw('enum')) {
          classes.push(this.parseClass(mods));
        } else if (this.isKw('trigger')) {
          trigger = this.parseTrigger();
        } else if (this.isP(';')) { this.next(); }
        else if (this.atEnd()) break;
        else throw ParseError(`Unexpected '${this.tokText()}' at top level`, this.peek());
      }
      return { kind: 'unit', classes, trigger };
    }

    parseTrigger() {
      const line = this.peek().line;
      this.expectKw('trigger');
      const name = this.expectName();
      this.expectKw('on');
      const sobj = this.expectName();
      this.expectP('(');
      const events = [];
      while (!this.isP(')') && !this.atEnd()) {
        let ev = '';
        while (!this.isP(',') && !this.isP(')') && !this.atEnd()) ev += this.tokText() + ' ', this.next();
        events.push(ev.trim());
        if (this.isP(',')) this.next();
      }
      this.expectP(')');
      const body = this.parseBlock();
      return { kind: 'trigger', name, sobj, events, body, line };
    }

    parseClass(mods) {
      const line = this.peek().line;
      const isInterface = this.isKw('interface');
      const isEnum = this.isKw('enum');
      this.next(); // class/interface/enum
      const name = this.expectName();
      let superClass = null, interfaces = [];

      if (isEnum) {
        this.expectP('{');
        const values = [];
        while (!this.isP('}') && !this.atEnd()) {
          if (this.isName()) values.push(this.expectName());
          if (this.isP(',')) this.next();
        }
        this.expectP('}');
        return { kind: 'class', name, isEnum: true, enumValues: values, modifiers: mods, fields: [], methods: [], props: [], innerClasses: [], line };
      }

      if (this.isKw('extends')) { this.next(); superClass = this.parseType(); }
      if (this.isKw('implements')) {
        this.next();
        interfaces.push(this.parseType());
        while (this.isP(',')) { this.next(); interfaces.push(this.parseType()); }
      }
      this.expectP('{');

      const cls = { kind: 'class', name, superClass, interfaces, isInterface, modifiers: mods, fields: [], methods: [], props: [], innerClasses: [], line };
      while (!this.isP('}') && !this.atEnd()) {
        this.parseClassMember(cls);
      }
      const endTok = this.expectP('}');
      cls.endLine = endTok.line;
      return cls;
    }

    parseClassMember(cls) {
      this.skipAnnotations();
      const mods = this.parseModifiers();
      const line = this.peek().line;

      // inner class / interface / enum
      if (this.isKw('class') || this.isKw('interface') || this.isKw('enum')) {
        const inner = this.parseClass(mods);
        inner.outer = cls.name;
        cls.innerClasses.push(inner);
        return;
      }

      // instance initializer block  { ... }
      if (this.isP('{')) {
        const body = this.parseBlock();
        cls.methods.push({ kind: 'method', name: '<init-block>', params: [], returnType: null, modifiers: mods, body, isInitBlock: true, static: mods.includes('static'), line });
        return;
      }

      // constructor:  Name ( ... ) { }
      if (this.isName() && this.nameVal(this.peek()).toLowerCase() === cls.name.toLowerCase() && this.isP('(', 1)) {
        const name = this.expectName();
        const params = this.parseParams();
        const body = this.parseBlock();
        cls.methods.push({ kind: 'method', name, params, returnType: null, modifiers: mods, body, isConstructor: true, static: false, line, endLine: body.endLine });
        return;
      }

      // typed member: Type name ...
      const type = this.parseType();
      const name = this.expectName();

      // method
      if (this.isP('(')) {
        const params = this.parseParams();
        let body = null;
        if (this.isP('{')) body = this.parseBlock();
        else this.expectP(';'); // abstract / interface method
        cls.methods.push({
          kind: 'method', name, params, returnType: type, modifiers: mods, body,
          static: mods.includes('static') || mods.includes('testmethod') === false && mods.includes('static'),
          line, endLine: body ? body.endLine : line,
        });
        cls.methods[cls.methods.length - 1].static = mods.includes('static');
        return;
      }

      // property:  Type name { get; set; }
      if (this.isP('{')) {
        this.next();
        const prop = { kind: 'property', name, type, modifiers: mods, getter: null, setter: null, static: mods.includes('static'), line };
        while (!this.isP('}') && !this.atEnd()) {
          this.parseModifiers(); // accessor visibility
          const t = this.peek();
          const which = (t.raw || t.v || '').toLowerCase();
          if (which === 'get' || which === 'set') {
            this.next();
            if (this.isP('{')) prop[which === 'get' ? 'getter' : 'setter'] = this.parseBlock();
            else { this.expectP(';'); prop[which === 'get' ? 'getter' : 'setter'] = 'auto'; }
          } else throw ParseError(`Expected get/set in property but found '${this.tokText()}'`, t);
        }
        this.expectP('}');
        cls.props.push(prop);
        return;
      }

      // field(s):  Type a = expr, b, c = expr;
      const decls = [];
      let curName = name;
      for (;;) {
        let init = null;
        if (this.isP('=')) { this.next(); init = this.parseExpression(); }
        decls.push({ name: curName, init });
        if (this.isP(',')) { this.next(); curName = this.expectName(); continue; }
        break;
      }
      this.expectP(';');
      for (const d of decls) {
        cls.fields.push({ kind: 'field', name: d.name, type, modifiers: mods, init: d.init, static: mods.includes('static'), line });
      }
    }

    parseParams() {
      this.expectP('(');
      const params = [];
      while (!this.isP(')') && !this.atEnd()) {
        this.parseModifiers(); // final
        const type = this.parseType();
        const name = this.expectName();
        params.push({ name, type });
        if (this.isP(',')) this.next();
      }
      this.expectP(')');
      return params;
    }

    /* ---------- statements ---------- */
    parseBlock() {
      const open = this.expectP('{');
      const stmts = [];
      while (!this.isP('}') && !this.atEnd()) {
        stmts.push(this.parseStatement());
      }
      const close = this.expectP('}');
      return { kind: 'block', stmts, line: open.line, endLine: close.line };
    }

    parseStatement() {
      const t = this.peek();
      const line = t.line;

      if (this.isP('{')) return this.parseBlock();
      if (this.isP(';')) { this.next(); return { kind: 'empty', line }; }

      if (t.t === 'kw') {
        switch (t.v) {
          case 'if': return this.parseIf();
          case 'for': return this.parseFor();
          case 'while': {
            this.next(); this.expectP('(');
            const cond = this.parseExpression();
            this.expectP(')');
            const body = this.parseStatement();
            return { kind: 'while', cond, body, line };
          }
          case 'do': {
            this.next();
            const body = this.parseStatement();
            this.expectKw('while'); this.expectP('(');
            const cond = this.parseExpression();
            this.expectP(')'); this.expectP(';');
            return { kind: 'dowhile', cond, body, line };
          }
          case 'switch': return this.parseSwitch();
          case 'try': return this.parseTry();
          case 'return': {
            this.next();
            let expr = null;
            if (!this.isP(';')) expr = this.parseExpression();
            this.expectP(';');
            return { kind: 'return', expr, line };
          }
          case 'throw': {
            this.next();
            const expr = this.parseExpression();
            this.expectP(';');
            return { kind: 'throw', expr, line };
          }
          case 'break': { this.next(); this.expectP(';'); return { kind: 'break', line }; }
          case 'continue': { this.next(); this.expectP(';'); return { kind: 'continue', line }; }
          case 'insert': case 'update': case 'delete': case 'undelete': {
            // DML — but "delete" may also start an expression?? In Apex it's a statement.
            const op = t.v; this.next();
            // optional "as user/system" mode
            if (this.isName() && ['as'].includes(this.nameVal(this.peek()).toLowerCase())) { this.next(); this.next(); }
            const expr = this.parseExpression();
            this.expectP(';');
            return { kind: 'dml', op, expr, line };
          }
          case 'upsert': {
            this.next();
            const expr = this.parseExpression();
            let extField = null;
            if (!this.isP(';')) extField = this.parseExpression();
            this.expectP(';');
            return { kind: 'dml', op: 'upsert', expr, extField, line };
          }
          case 'merge': {
            this.next();
            const expr = this.parseExpression();
            const withExpr = this.parseExpression();
            this.expectP(';');
            return { kind: 'dml', op: 'merge', expr, withExpr, line };
          }
        }
      }

      // Local variable declaration?  Type name (= expr)? (, name (= expr)?)* ;
      const declStart = this.save();
      if (this.isKw('final')) this.next();
      if (this.isName()) {
        const type = this.tryParseType();
        if (type && this.isName()) {
          const firstName = this.expectName();
          if (this.isP('=') || this.isP(';') || this.isP(',')) {
            const decls = [];
            let curName = firstName;
            for (;;) {
              let init = null;
              if (this.isP('=')) { this.next(); init = this.parseExpression(); }
              decls.push({ name: curName, init });
              if (this.isP(',')) { this.next(); curName = this.expectName(); continue; }
              break;
            }
            this.expectP(';');
            return { kind: 'vardecl', type, decls, line };
          }
        }
      }
      this.restore(declStart);

      // Expression statement (incl. System.runAs(...){ } pseudo-block)
      const expr = this.parseExpression();
      if (this.isP('{') && expr.kind === 'call') {
        const body = this.parseBlock();
        return { kind: 'callblock', call: expr, body, line }; // e.g. System.runAs
      }
      this.expectP(';');
      return { kind: 'expr', expr, line };
    }

    parseIf() {
      const line = this.peek().line;
      this.expectKw('if'); this.expectP('(');
      const cond = this.parseExpression();
      this.expectP(')');
      const then = this.parseStatement();
      let els = null;
      if (this.isKw('else')) { this.next(); els = this.parseStatement(); }
      return { kind: 'if', cond, then, else: els, line };
    }

    parseFor() {
      const line = this.peek().line;
      this.expectKw('for'); this.expectP('(');

      // for-each:  for (Type name : expr)
      const save = this.save();
      const type = this.tryParseType();
      if (type && this.isName()) {
        const varName = this.expectName();
        if (this.isP(':')) {
          this.next();
          const iterable = this.parseExpression();
          this.expectP(')');
          const body = this.parseStatement();
          return { kind: 'foreach', type, varName, iterable, body, line };
        }
      }
      this.restore(save);

      // C-style
      let init = null;
      if (!this.isP(';')) {
        const s2 = this.save();
        const t2 = this.tryParseType();
        if (t2 && this.isName()) {
          const nm = this.expectName();
          if (this.isP('=') || this.isP(',') || this.isP(';')) {
            const decls = [];
            let cur = nm;
            for (;;) {
              let iv = null;
              if (this.isP('=')) { this.next(); iv = this.parseExpression(); }
              decls.push({ name: cur, init: iv });
              if (this.isP(',')) { this.next(); cur = this.expectName(); continue; }
              break;
            }
            init = { kind: 'vardecl', type: t2, decls, line };
          } else { this.restore(s2); init = { kind: 'expr', expr: this.parseExpression(), line }; }
        } else { this.restore(s2); init = { kind: 'expr', expr: this.parseExpression(), line }; }
      }
      this.expectP(';');
      let cond = null;
      if (!this.isP(';')) cond = this.parseExpression();
      this.expectP(';');
      const updates = [];
      if (!this.isP(')')) {
        updates.push(this.parseExpression());
        while (this.isP(',')) { this.next(); updates.push(this.parseExpression()); }
      }
      this.expectP(')');
      const body = this.parseStatement();
      return { kind: 'for', init, cond, updates, body, line };
    }

    parseSwitch() {
      const line = this.peek().line;
      this.expectKw('switch');
      // "on" keyword
      if (this.isKw('on') || (this.isName() && this.nameVal(this.peek()).toLowerCase() === 'on')) this.next();
      const disc = this.parseExpression();
      this.expectP('{');
      const cases = [];
      while (!this.isP('}') && !this.atEnd()) {
        this.expectKw('when');
        if (this.isKw('else')) {
          this.next();
          const body = this.parseBlock();
          cases.push({ isElse: true, body, line: body.line });
          continue;
        }
        // when Type var { }  (sObject type switch) OR when val1, val2 { }
        const values = [];
        let typeVar = null;
        const s = this.save();
        const maybeType = this.tryParseType();
        if (maybeType && this.isName() && this.isP('{', 1)) {
          typeVar = { type: maybeType, name: this.expectName() };
        } else {
          this.restore(s);
          values.push(this.parseExpression());
          while (this.isP(',')) { this.next(); values.push(this.parseExpression()); }
        }
        const body = this.parseBlock();
        cases.push({ values, typeVar, body, line: body.line });
      }
      this.expectP('}');
      return { kind: 'switch', disc, cases, line };
    }

    parseTry() {
      const line = this.peek().line;
      this.expectKw('try');
      const block = this.parseBlock();
      const catches = [];
      while (this.isKw('catch')) {
        this.next(); this.expectP('(');
        const type = this.parseType();
        const name = this.isName() ? this.expectName() : null;
        this.expectP(')');
        const cblock = this.parseBlock();
        catches.push({ type, name, block: cblock, line: cblock.line });
      }
      let finallyBlock = null;
      if (this.isKw('finally')) { this.next(); finallyBlock = this.parseBlock(); }
      return { kind: 'try', block, catches, finallyBlock, line };
    }

    /* ---------- expressions (precedence climbing) ---------- */
    parseExpression() { return this.parseAssignment(); }

    parseAssignment() {
      const left = this.parseTernary();
      const t = this.peek();
      if (t.t === 'p' && ASSIGN_OPS.has(t.v)) {
        this.next();
        const value = this.parseAssignment();
        return { kind: 'assign', op: t.v, target: left, value, line: left.line };
      }
      return left;
    }

    parseTernary() {
      const cond = this.parseNullCoalesce();
      if (this.isP('?') && !this.isP('?.')) {
        this.next();
        const t = this.parseAssignment();
        this.expectP(':');
        const f = this.parseAssignment();
        return { kind: 'ternary', cond, then: t, else: f, line: cond.line };
      }
      return cond;
    }

    parseNullCoalesce() {
      let left = this.parseOr();
      while (this.isP('??')) {
        this.next();
        const right = this.parseOr();
        left = { kind: 'binary', op: '??', left, right, line: left.line };
      }
      return left;
    }

    parseOr() {
      let left = this.parseAnd();
      while (this.isP('||')) {
        this.next();
        const right = this.parseAnd();
        left = { kind: 'binary', op: '||', left, right, line: left.line };
      }
      return left;
    }

    parseAnd() {
      let left = this.parseBitOr();
      while (this.isP('&&')) {
        this.next();
        const right = this.parseBitOr();
        left = { kind: 'binary', op: '&&', left, right, line: left.line };
      }
      return left;
    }

    parseBitOr() {
      let left = this.parseBitXor();
      while (this.isP('|')) {
        this.next();
        const right = this.parseBitXor();
        left = { kind: 'binary', op: '|', left, right, line: left.line };
      }
      return left;
    }

    parseBitXor() {
      let left = this.parseBitAnd();
      while (this.isP('^')) {
        this.next();
        const right = this.parseBitAnd();
        left = { kind: 'binary', op: '^', left, right, line: left.line };
      }
      return left;
    }

    parseBitAnd() {
      let left = this.parseEquality();
      while (this.isP('&')) {
        this.next();
        const right = this.parseEquality();
        left = { kind: 'binary', op: '&', left, right, line: left.line };
      }
      return left;
    }

    parseEquality() {
      let left = this.parseRelational();
      while (this.isP('==') || this.isP('!=') || this.isP('===') || this.isP('!==')) {
        const op = this.next().v;
        const right = this.parseRelational();
        left = { kind: 'binary', op, left, right, line: left.line };
      }
      return left;
    }

    parseRelational() {
      let left = this.parseShift();
      for (;;) {
        if (this.isP('<') || this.isP('>') || this.isP('<=') || this.isP('>=')) {
          const op = this.next().v;
          const right = this.parseShift();
          left = { kind: 'binary', op, left, right, line: left.line };
        } else if (this.isKw('instanceof')) {
          this.next();
          const type = this.parseType();
          left = { kind: 'instanceof', expr: left, type, line: left.line };
        } else break;
      }
      return left;
    }

    parseShift() {
      let left = this.parseAdditive();
      while (this.isP('<<') || this.isP('>>') || this.isP('>>>')) {
        const op = this.next().v;
        const right = this.parseAdditive();
        left = { kind: 'binary', op, left, right, line: left.line };
      }
      return left;
    }

    parseAdditive() {
      let left = this.parseMultiplicative();
      while (this.isP('+') || this.isP('-')) {
        const op = this.next().v;
        const right = this.parseMultiplicative();
        left = { kind: 'binary', op, left, right, line: left.line };
      }
      return left;
    }

    parseMultiplicative() {
      let left = this.parseUnary();
      while (this.isP('*') || this.isP('/') || this.isP('%')) {
        const op = this.next().v;
        const right = this.parseUnary();
        left = { kind: 'binary', op, left, right, line: left.line };
      }
      return left;
    }

    parseUnary() {
      const t = this.peek();
      if (this.isP('!') || this.isP('-') || this.isP('+') || this.isP('~')) {
        this.next();
        const expr = this.parseUnary();
        return { kind: 'unary', op: t.v, expr, line: t.line };
      }
      if (this.isP('++') || this.isP('--')) {
        this.next();
        const expr = this.parseUnary();
        return { kind: 'update', op: t.v, expr, prefix: true, line: t.line };
      }
      // cast: (Type) expr
      if (this.isP('(')) {
        const save = this.save();
        this.next();
        const type = this.tryParseType();
        if (type && this.isP(')')) {
          this.next();
          const nt = this.peek();
          const startsExpr =
            nt.t === 'id' || nt.t === 'num' || nt.t === 'str' || nt.t === 'soql' ||
            (nt.t === 'kw' && ['new', 'this', 'null', 'true', 'false', 'super'].includes(nt.v)) ||
            (nt.t === 'p' && ['(', '!'].includes(nt.v));
          const looksType = type.args.length > 0 || type.isArray || type.name.includes('.') ||
            /^(String|Integer|Decimal|Double|Long|Boolean|Id|Date|Datetime|Time|Object|Blob|SObject)$/i.test(type.name);
          if (startsExpr && (looksType || nt.t !== 'p')) {
            const expr = this.parseUnary();
            return { kind: 'cast', type, expr, line: t.line };
          }
        }
        this.restore(save);
      }
      return this.parsePostfix();
    }

    parsePostfix() {
      let expr = this.parsePrimary();
      for (;;) {
        if (this.isP('.') || this.isP('?.')) {
          const safe = this.isP('?.');
          this.next();
          // `<Type>.class` type literal (e.g. Account.class, RemoteCPQ.LineItemDO.class).
          // `class` is a reserved word and can never be a member name, so this is
          // unambiguous and applies to any type-reference chain — no hardcoding.
          if (!safe && this.isKw('class')) {
            const typeName = chainToTypeName(expr);
            if (typeName) {
              this.next(); // consume 'class'
              expr = { kind: 'classlit', typeName, line: expr.line };
              continue;
            }
          }
          const name = this.expectName();
          if (this.isP('(')) {
            const args = this.parseArgs();
            expr = { kind: 'call', target: expr, name, args, safe, line: expr.line };
          } else {
            expr = { kind: 'prop', target: expr, name, safe, line: expr.line };
          }
        } else if (this.isP('[')) {
          this.next();
          const index = this.parseExpression();
          this.expectP(']');
          expr = { kind: 'index', target: expr, index, line: expr.line };
        } else if (this.isP('++') || this.isP('--')) {
          const op = this.next().v;
          expr = { kind: 'update', op, expr, prefix: false, line: expr.line };
        } else break;
      }
      return expr;
    }

    parseArgs() {
      this.expectP('(');
      const args = [];
      while (!this.isP(')') && !this.atEnd()) {
        args.push(this.parseExpression());
        if (this.isP(',')) this.next();
      }
      this.expectP(')');
      return args;
    }

    parsePrimary() {
      const t = this.peek();
      const line = t.line;

      if (t.t === 'num') { this.next(); return { kind: 'lit', value: t.v.value, litType: t.v.isDecimal ? 'Decimal' : (t.v.isLong ? 'Long' : 'Integer'), line }; }
      if (t.t === 'str') { this.next(); return { kind: 'lit', value: t.v, litType: 'String', line }; }
      if (t.t === 'soql') { this.next(); return { kind: 'soql', raw: t.v, binds: extractBinds(t.v), line }; }
      if (this.isKw('true')) { this.next(); return { kind: 'lit', value: true, litType: 'Boolean', line }; }
      if (this.isKw('false')) { this.next(); return { kind: 'lit', value: false, litType: 'Boolean', line }; }
      if (this.isKw('null')) { this.next(); return { kind: 'lit', value: null, litType: 'null', line }; }
      if (this.isKw('this')) {
        this.next();
        if (this.isP('(')) { // this(...) constructor chain
          const args = this.parseArgs();
          return { kind: 'thiscall', args, line };
        }
        return { kind: 'this', line };
      }
      if (this.isKw('super')) {
        this.next();
        if (this.isP('(')) {
          const args = this.parseArgs();
          return { kind: 'supercall', args, line };
        }
        return { kind: 'super', line };
      }
      if (this.isKw('new')) return this.parseNew();

      if (this.isP('(')) {
        this.next();
        const expr = this.parseExpression();
        this.expectP(')');
        return expr;
      }

      if (this.isName()) {
        // Generic type-class literal: List<Foo>.class, Set<X>.class, Map<K,V>.class.
        // In expression position a bare '<' is normally the comparison operator, so
        // we speculatively parse a generic type and only accept it when it is
        // immediately followed by '.class'. Otherwise we restore and fall through,
        // leaving ordinary comparisons (a < b) completely untouched.
        if (this.isP('<', 1)) {
          const save = this.save();
          try {
            const gtype = this.parseType();
            if (gtype.args && gtype.args.length && this.isP('.') && this.isKw('class', 1)) {
              this.next(); // '.'
              this.next(); // 'class'
              return { kind: 'classlit', typeName: typeToString(gtype), line };
            }
          } catch (_) { /* not a generic type-class literal */ }
          this.restore(save);
        }
        const name = this.expectName();
        if (this.isP('(')) {
          const args = this.parseArgs();
          return { kind: 'call', target: null, name, args, line };
        }
        return { kind: 'ident', name, line };
      }

      throw ParseError(`Unexpected token '${this.tokText()}'`, t);
    }

    parseNew() {
      const line = this.peek().line;
      this.expectKw('new');
      const type = this.parseType();

      // collection initializer: new List<..>{a, b} / new Map<..>{k => v} / new Set<..>{..}
      if (this.isP('{')) {
        this.next();
        const base = type.name.toLowerCase();
        if (base === 'map') {
          const entries = [];
          while (!this.isP('}') && !this.atEnd()) {
            const k = this.parseExpression();
            this.expectP('=>');
            const v = this.parseExpression();
            entries.push({ key: k, value: v });
            if (this.isP(',')) this.next();
          }
          this.expectP('}');
          return { kind: 'new', type, mapEntries: entries, line };
        }
        const items = [];
        while (!this.isP('}') && !this.atEnd()) {
          items.push(this.parseExpression());
          if (this.isP(',')) this.next();
        }
        this.expectP('}');
        return { kind: 'new', type, listItems: items, line };
      }

      // new Type[size] array
      if (this.isP('[')) {
        this.next();
        let size = null;
        if (!this.isP(']')) size = this.parseExpression();
        this.expectP(']');
        if (this.isP('{')) { // new String[]{...}
          this.next();
          const items = [];
          while (!this.isP('}') && !this.atEnd()) {
            items.push(this.parseExpression());
            if (this.isP(',')) this.next();
          }
          this.expectP('}');
          return { kind: 'new', type: { name: 'List', args: [type] }, listItems: items, line };
        }
        return { kind: 'new', type: { name: 'List', args: [type] }, arraySize: size, line };
      }

      // constructor call — possibly with SObject named-field syntax: new Account(Name='x', ...)
      if (this.isP('(')) {
        const save = this.save();
        // try named-args form
        this.next();
        const named = [];
        let isNamed = true;
        if (this.isP(')')) { isNamed = false; }
        else {
          for (;;) {
            if (this.isName() && this.isP('=', 1) && !this.isP('==', 1)) {
              const fname = this.expectName();
              this.next(); // =
              const val = this.parseExpression();
              named.push({ name: fname, value: val });
              if (this.isP(',')) { this.next(); continue; }
              break;
            } else { isNamed = false; break; }
          }
        }
        if (isNamed && this.isP(')')) {
          this.next();
          return { kind: 'new', type, namedArgs: named, line };
        }
        this.restore(save);
        const args = this.parseArgs();
        return { kind: 'new', type, args, line };
      }

      return { kind: 'new', type, args: [], line };
    }
  }

  /* ---------- SOQL bind extraction: find ":expr" outside quotes ---------- */
  function extractBinds(soql) {
    const binds = [];
    let i = 0;
    const n = soql.length;
    while (i < n) {
      const c = soql[i];
      if (c === '\'') {
        i++;
        while (i < n && soql[i] !== '\'') { if (soql[i] === '\\') i++; i++; }
        i++;
        continue;
      }
      if (c === ':') {
        let j = i + 1;
        while (j < n && /\s/.test(soql[j])) j++;
        let expr = '';
        // capture dotted identifier chain + optional method call parens/index
        while (j < n && /[A-Za-z0-9_$.]/.test(soql[j])) { expr += soql[j]; j++; }
        // allow trailing () or (args) or [idx] chains
        while (j < n && (soql[j] === '(' || soql[j] === '[')) {
          const open = soql[j], close = open === '(' ? ')' : ']';
          let depth = 0;
          while (j < n) {
            if (soql[j] === open) depth++;
            else if (soql[j] === close) { depth--; if (depth === 0) { expr += soql[j]; j++; break; } }
            expr += soql[j]; j++;
          }
          while (j < n && /[A-Za-z0-9_$.]/.test(soql[j])) { expr += soql[j]; j++; }
        }
        if (expr) binds.push({ expr, start: i, end: j });
        i = j;
        continue;
      }
      i++;
    }
    return binds;
  }

  /* ================================================================
     PUBLIC API
     ================================================================ */

  function parse(source) {
    const tokens = lex(source);
    const p = new Parser(tokens);
    return p.parseCompilationUnit();
  }

  function parseExpression(source) {
    const tokens = lex(source);
    const p = new Parser(tokens);
    const expr = p.parseExpression();
    return expr;
  }

  function parseStatements(source) {
    const tokens = lex(source);
    const p = new Parser(tokens);
    const stmts = [];
    while (!p.atEnd()) stmts.push(p.parseStatement());
    return stmts;
  }

  const api = { lex, parse, parseExpression, parseStatements, extractBinds };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ApexLang = api;

})(typeof window !== 'undefined' ? window : globalThis);

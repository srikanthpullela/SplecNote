/* ========================================================================
   CongaCode — Apex Request Debugger (apexdebugger.js)
   Chrome DevTools-style in-editor debugger for Apex .cls files.
   Simulates execution locally using request JSON as input data.
   ======================================================================== */

'use strict';

/* ---- helpers from app.js ---- */
const _$ = (s) => document.querySelector(s);
const _$$ = (s) => [...document.querySelectorAll(s)];
const _esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* ================================================================
   1. DEBUG STATE
   ================================================================ */
const debugState = {
  active: false,               // Is a debug session running?
  paused: false,               // Paused at a breakpoint or step?
  // Source info
  entryFile: null,             // Path of the file containing the target method
  entryMethod: null,           // Name of the target method
  entryLine: 0,                // Line number where method starts
  // Execution
  callStack: [],               // [{ file, className, methodName, line, variables: {}, statements: [], pc: 0, classFields: {} }]
  currentFile: null,           // Currently highlighted file
  currentLine: 0,              // Currently highlighted line
  stepMode: null,              // 'continue' | 'stepOver' | 'stepInto' | 'stepOut'
  stepDepth: 0,                // Call stack depth at time of step command
  // Breakpoints: Map<string, Set<number>> — filePath → set of line numbers
  breakpoints: new Map(),
  breakpointDecorations: new Map(),  // filePath → decoration IDs array
  currentLineDecoration: [],         // decoration IDs for current execution line
  // Variable scopes
  variables: {},               // Current frame's variable map
  // Class-level fields: className → { publicFields: {}, privateFields: {}, staticFields: {} }
  classFieldsCache: new Map(),
  // Class index cache: className → filePath
  classIndex: null,
  // Parsed method cache: filePath:methodName → { statements, params }
  methodCache: new Map(),
  // Console log entries
  consoleLog: [],
  // Watch expressions
  watchExpressions: [],  // [{ expr: string, id: number }]
  watchNextId: 1,
  // Request data
  requestJson: null,
  parsedRequest: null,
  // UI
  miniEditorInstance: null,    // Monaco mini-editor for request JSON input
  debugPanelVisible: false,
  // Live Org context — resolve SOQL/data against a connected Salesforce org
  liveOrgMode: false,          // When true, SOQL runs against the connected org
  orgFetching: false,          // True while an org call is in flight
  orgQueryCache: new Map(),    // normalized SOQL string → { records, error, soql }
  orgRunning: false,           // True while the entry method is executing in the org
  orgActivity: null,           // Parsed result of the last "Run in Org" execution
  // Replay mode — step through a recorded org execution (from the debug log)
  replayMode: false,           // When true, step controls walk the recorded timeline
  replayTimeline: [],          // Array of recorded steps { file, line, depth, frames }
  replayIndex: 0,              // Current position in the timeline
  replayFatalError: null,      // Uncatchable error that ended the recorded run, if any
  // User-provided variable overrides — when the engine/org can't resolve a value
  // (shows null/undefined), the user may inject a value inline. Keyed by
  // `${className}::${scope}::${varName}` so overrides survive stepping/replay navigation.
  userOverrides: {},
  // Live interpreter (V8-style) engine mode — the editor executes Apex itself,
  // statement by statement, fetching real org data on demand (SOQL/eval).
  engineMode: false,           // When true, step controls drive the live interpreter
  engineSession: null,         // Active ApexEngine instance
  engineRunning: false,        // True while the engine is executing (not paused)
};

/* ================================================================
   2. APEX PARSER — Lightweight statement-level parser
   ================================================================ */

/**
 * Parse an Apex method body into a list of executable statements.
 * Each statement: { line, type, raw, varName?, expression?, className?, methodName?, args?,
 *                   condition?, thenBlock?, elseBlock?, body?, catchVar?, catchType? }
 */
function parseApexStatements(sourceLines, startLine, endLine) {
  const statements = [];
  let i = startLine;

  while (i <= endLine) {
    let rawLine = sourceLines[i] || '';
    let trimmed = rawLine.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      i++;
      continue;
    }

    // Multi-line statement joining: if line doesn't end with ;, {, }, or is a block-opening keyword,
    // join with subsequent lines until we find a terminator
    if (!trimmed.endsWith(';') && !trimmed.endsWith('{') && !trimmed.endsWith('}') &&
        !trimmed.startsWith('if') && !trimmed.startsWith('else') && !trimmed.startsWith('for') &&
        !trimmed.startsWith('while') && !trimmed.startsWith('try') && !trimmed.startsWith('catch') &&
        !trimmed.startsWith('switch') && !trimmed.startsWith('when') && !trimmed.startsWith('@') &&
        !trimmed.startsWith('//') && !trimmed.startsWith('{') && !trimmed.startsWith('}')) {
      let joined = trimmed;
      let joinedLine = i;
      while (i + 1 <= endLine) {
        const nextRaw = (sourceLines[i + 1] || '').trim();
        if (!nextRaw || nextRaw.startsWith('//') || nextRaw.startsWith('/*')) break;
        i++;
        joined += ' ' + nextRaw;
        if (nextRaw.endsWith(';') || nextRaw.endsWith('{') || nextRaw.endsWith('}')) break;
      }
      rawLine = joined;
      trimmed = joined;
    }

    // --- Declaration with method call on right side (MUST come before generic declaration) ---
    const declCallMatch = trimmed.match(/^(?:(?:final|static|transient)\s+)*(\w[\w<>,\s\[\]]*?)\s+(\w+)\s*=\s*([\w.]+)\s*\((.*)\)\s*;?\s*$/);
    // Only treat as a single step-into-able method call when the initializer is
    // exactly `Class.method(args)`. Chained calls (`Datetime.now().getTime()`) and
    // constructors (`new List<…>()`) must fall through to the expression evaluator,
    // otherwise the trailing `.getTime()` gets swallowed and the value comes back null.
    const declCallChained = declCallMatch && (/\)\s*\./.test(declCallMatch[4]) || /^new\s/.test(declCallMatch[3]));
    if (declCallMatch && !declCallChained && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('return') && !trimmed.startsWith('try')) {
      const callParts = declCallMatch[3].split('.');
      let cn = null;
      let mn = declCallMatch[3];
      if (callParts.length >= 2) { cn = callParts.slice(0, -1).join('.'); mn = callParts[callParts.length - 1]; }
      statements.push({
        line: i + 1, type: 'declWithCall', raw: trimmed,
        varType: declCallMatch[1].trim(), varName: declCallMatch[2],
        className: cn, methodName: mn, argsRaw: declCallMatch[4]
      });
      i++;
      continue;
    }

    // --- Variable declaration / assignment ---
    const declMatch = trimmed.match(/^(?:(?:final|static|transient)\s+)*(\w[\w<>,\s\[\]]*?)\s+(\w+)\s*=\s*(.+?)\s*;?\s*$/);
    if (declMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('return') && !trimmed.startsWith('try')) {
      statements.push({ line: i + 1, type: 'declaration', raw: trimmed, varType: declMatch[1].trim(), varName: declMatch[2], expression: declMatch[3].replace(/;$/, '') });
      i++;
      continue;
    }

    // --- Declaration without initialization: Type varName; ---
    const declOnlyMatch = trimmed.match(/^(?:(?:final|static|transient)\s+)*(\w[\w<>,\s\[\].]*?)\s+(\w+)\s*;\s*$/);
    if (declOnlyMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('return') && !trimmed.startsWith('try')) {
      const dtype = declOnlyMatch[1].trim();
      // Skip if it's a method signature (has access modifier + return type + name pattern followed by paren on next line)
      if (!/^(public|private|protected|global)$/.test(dtype)) {
        // Determine default value based on type
        let defaultVal = null;
        const dtypeLower = dtype.toLowerCase();
        if (dtypeLower === 'integer' || dtypeLower === 'int' || dtypeLower === 'long' || dtypeLower === 'double' || dtypeLower === 'decimal') defaultVal = 0;
        else if (dtypeLower === 'boolean') defaultVal = false;
        else if (dtypeLower === 'string') defaultVal = null;
        else if (dtypeLower.startsWith('list')) defaultVal = '[]';
        else if (dtypeLower.startsWith('set')) defaultVal = '[]';
        else if (dtypeLower.startsWith('map')) defaultVal = '{}';
        statements.push({ line: i + 1, type: 'declaration', raw: trimmed, varType: dtype, varName: declOnlyMatch[2], expression: null, _defaultVal: defaultVal });
        i++;
        continue;
      }
    }

    // --- Assignment with method call (existing var = method()) ---
    const assignCallMatch = trimmed.match(/^(\w[\w.[\]]*)\s*=\s*([\w.]+)\s*\((.*)\)\s*;?\s*$/);
    const assignCallChained = assignCallMatch && (/\)\s*\./.test(assignCallMatch[3]) || /^new\s/.test(assignCallMatch[2]));
    if (assignCallMatch && !assignCallChained && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('return')) {
      const callParts = assignCallMatch[2].split('.');
      let cn = null;
      let mn = assignCallMatch[2];
      if (callParts.length >= 2) { cn = callParts.slice(0, -1).join('.'); mn = callParts[callParts.length - 1]; }
      statements.push({
        line: i + 1, type: 'assignWithCall', raw: trimmed,
        varName: assignCallMatch[1], className: cn, methodName: mn, argsRaw: assignCallMatch[3]
      });
      i++;
      continue;
    }

    // --- Assignment (existing var) ---
    const assignMatch = trimmed.match(/^(\w[\w.[\]]*)\s*=\s*(.+?)\s*;?\s*$/);
    if (assignMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('return')) {
      statements.push({ line: i + 1, type: 'assignment', raw: trimmed, varName: assignMatch[1], expression: assignMatch[2].replace(/;$/, '') });
      i++;
      continue;
    }

    // --- Compound assignment: +=, -=, *=, /= ---
    const compoundMatch = trimmed.match(/^(\w[\w.[\]]*)\s*(\+=|-=|\*=|\/=)\s*(.+?)\s*;?\s*$/);
    if (compoundMatch) {
      const varN = compoundMatch[1];
      const op = compoundMatch[2];
      const rhs = compoundMatch[3].replace(/;$/, '');
      // Convert to simple assignment with expression
      const opChar = op[0]; // +, -, *, /
      statements.push({ line: i + 1, type: 'assignment', raw: trimmed, varName: varN, expression: `${varN} ${opChar} ${rhs}` });
      i++;
      continue;
    }

    // --- Increment/decrement: i++, i--, ++i, --i ---
    const incMatch = trimmed.match(/^(\w[\w.[\]]*)\s*(\+\+|--)\s*;?\s*$/);
    if (incMatch) {
      const varN = incMatch[1];
      const op = incMatch[2] === '++' ? '+ 1' : '- 1';
      statements.push({ line: i + 1, type: 'assignment', raw: trimmed, varName: varN, expression: `${varN} ${op}` });
      i++;
      continue;
    }
    const preIncMatch = trimmed.match(/^(\+\+|--)\s*(\w[\w.[\]]*)\s*;?\s*$/);
    if (preIncMatch) {
      const varN = preIncMatch[2];
      const op = preIncMatch[1] === '++' ? '+ 1' : '- 1';
      statements.push({ line: i + 1, type: 'assignment', raw: trimmed, varName: varN, expression: `${varN} ${op}` });
      i++;
      continue;
    }

    // --- continue / break ---
    if (trimmed === 'continue;' || trimmed === 'continue') {
      statements.push({ line: i + 1, type: 'continue', raw: trimmed });
      i++;
      continue;
    }
    if (trimmed === 'break;' || trimmed === 'break') {
      statements.push({ line: i + 1, type: 'break', raw: trimmed });
      i++;
      continue;
    }

    // --- Return ---
    if (trimmed.startsWith('return')) {
      const retExpr = trimmed.replace(/^return\s*/, '').replace(/;\s*$/, '');
      statements.push({ line: i + 1, type: 'return', raw: trimmed, expression: retExpr || null });
      i++;
      continue;
    }

    // --- Throw ---
    if (trimmed.startsWith('throw')) {
      const throwExpr = trimmed.replace(/^throw\s+/, '').replace(/;\s*$/, '');
      statements.push({ line: i + 1, type: 'throw', raw: trimmed, expression: throwExpr });
      i++;
      continue;
    }

    // --- Switch on (Apex switch statement) ---
    const switchMatch = trimmed.match(/^switch\s+on\s+(.+?)\s*\{?\s*$/);
    if (switchMatch) {
      const switchExpr = switchMatch[1];
      const switchEnd = findBlockEnd(sourceLines, i);
      const whenCases = [];
      // Parse when blocks inside the switch
      let wi = i + 1;
      while (wi < switchEnd) {
        const whenLine = (sourceLines[wi] || '').trim();
        const whenMatch = whenLine.match(/^when\s+(.+?)\s*\{?\s*$/);
        if (whenMatch) {
          const whenVal = whenMatch[1].trim();
          const whenEnd = findBlockEnd(sourceLines, wi);
          const whenBody = parseApexStatements(sourceLines, wi + 1, whenEnd - 1);
          whenCases.push({ value: whenVal, body: whenBody, line: wi + 1 });
          wi = whenEnd + 1;
        } else {
          wi++;
        }
      }
      statements.push({ line: i + 1, type: 'switch', raw: trimmed, switchExpr, whenCases });
      i = switchEnd + 1;
      continue;
    }

    // --- If / else if ---
    const ifMatch = trimmed.match(/^(?:}\s*)?(?:else\s+)?if\s*\((.+)\)\s*\{?\s*$/);
    if (ifMatch) {
      const condExpr = ifMatch[1];
      const thenEnd = findBlockEnd(sourceLines, i);
      const thenBlock = parseApexStatements(sourceLines, i + 1, thenEnd - 1);
      let elseBlock = [];
      let elseEnd = thenEnd;
      // Check for else / else-if
      const afterClose = (sourceLines[thenEnd] || '').trim();
      if (afterClose.match(/^}\s*else\s+if\s*\(/)) {
        // else-if chain — parse as nested conditional in elseBlock
        const elseIfStatements = parseApexStatements(sourceLines, thenEnd, endLine);
        if (elseIfStatements.length > 0) {
          elseBlock = elseIfStatements;
          // Find the end of the entire else-if chain
          const lastStmt = elseIfStatements[elseIfStatements.length - 1];
          // Scan forward to find the final closing brace
          let scanLine = thenEnd;
          let chainDepth = 0;
          for (let si = thenEnd; si <= endLine; si++) {
            const sl = (sourceLines[si] || '');
            for (const ch of sl) {
              if (ch === '{') chainDepth++;
              if (ch === '}') chainDepth--;
            }
            if (chainDepth <= 0) { elseEnd = si; break; }
          }
        }
      } else if (afterClose.match(/^}\s*else\s*\{/)) {
        elseEnd = findBlockEnd(sourceLines, thenEnd);
        elseBlock = parseApexStatements(sourceLines, thenEnd + 1, elseEnd - 1);
      }
      statements.push({ line: i + 1, type: 'conditional', raw: trimmed, condition: condExpr, thenBlock, elseBlock });
      i = Math.max(thenEnd + 1, elseEnd + 1);
      continue;
    }

    // --- Try-catch ---
    if (trimmed.startsWith('try') && trimmed.includes('{')) {
      const tryEnd = findBlockEnd(sourceLines, i);
      const tryBody = parseApexStatements(sourceLines, i + 1, tryEnd - 1);
      let catchBody = [];
      let catchVar = 'ex';
      let catchType = 'Exception';
      let finalEnd = tryEnd;
      const afterTry = (sourceLines[tryEnd] || '').trim();
      const catchMatch = afterTry.match(/^}\s*catch\s*\(\s*(\w+)\s+(\w+)\s*\)\s*\{/);
      if (catchMatch) {
        catchType = catchMatch[1];
        catchVar = catchMatch[2];
        finalEnd = findBlockEnd(sourceLines, tryEnd);
        catchBody = parseApexStatements(sourceLines, tryEnd + 1, finalEnd - 1);
      }
      // Check for finally
      const afterCatch = (sourceLines[finalEnd] || '').trim();
      if (afterCatch.match(/^}\s*finally\s*\{/)) {
        finalEnd = findBlockEnd(sourceLines, finalEnd);
      }
      statements.push({ line: i + 1, type: 'try', raw: trimmed, body: tryBody, catchBody, catchVar, catchType });
      i = finalEnd + 1;
      continue;
    }

    // --- For loop ---
    const forMatch = trimmed.match(/^for\s*\((.+)\)\s*\{?\s*$/);
    if (forMatch) {
      const loopEnd = findBlockEnd(sourceLines, i);
      const body = parseApexStatements(sourceLines, i + 1, loopEnd - 1);
      statements.push({ line: i + 1, type: 'loop', loopType: 'for', raw: trimmed, loopExpr: forMatch[1], body });
      i = loopEnd + 1;
      continue;
    }

    // --- While loop ---
    const whileMatch = trimmed.match(/^while\s*\((.+)\)\s*\{?\s*$/);
    if (whileMatch) {
      const loopEnd = findBlockEnd(sourceLines, i);
      const body = parseApexStatements(sourceLines, i + 1, loopEnd - 1);
      statements.push({ line: i + 1, type: 'loop', loopType: 'while', raw: trimmed, condition: whileMatch[1], body });
      i = loopEnd + 1;
      continue;
    }

    // --- SOQL ---
    if (trimmed.match(/\[\s*SELECT\b/i)) {
      const soqlAssign = trimmed.match(/^(?:(?:final|static|transient)\s+)*(\w[\w<>,\s]*?)\s+(\w+)\s*=\s*(\[.+)/);
      if (soqlAssign) {
        statements.push({ line: i + 1, type: 'soql', raw: trimmed, varName: soqlAssign[2], declType: (soqlAssign[1] || '').trim(), query: soqlAssign[3].replace(/;\s*$/, '') });
      } else {
        statements.push({ line: i + 1, type: 'soql', raw: trimmed, query: trimmed.replace(/;\s*$/, '') });
      }
      i++;
      continue;
    }

    // --- DML ---
    const dmlMatch = trimmed.match(/^(insert|update|delete|upsert|merge|undelete)\s+(.+?);\s*$/i);
    if (dmlMatch) {
      statements.push({ line: i + 1, type: 'dml', raw: trimmed, dmlOp: dmlMatch[1].toLowerCase(), target: dmlMatch[2] });
      i++;
      continue;
    }

    // --- Method call (standalone expression statement) ---
    const callMatch = trimmed.match(/^([\w.]+)\s*\((.*)\)\s*;?\s*$/);
    if (callMatch) {
      const parts = callMatch[1].split('.');
      let className = null;
      let methodName = callMatch[1];
      if (parts.length >= 2) {
        className = parts.slice(0, -1).join('.');
        methodName = parts[parts.length - 1];
      }
      statements.push({ line: i + 1, type: 'methodCall', raw: trimmed, className, methodName, argsRaw: callMatch[2] });
      i++;
      continue;
    }

    // (declCallMatch already handled above, before generic declaration)

    // --- Generic expression/statement (fallback) ---
    if (trimmed !== '{' && trimmed !== '}') {
      statements.push({ line: i + 1, type: 'expression', raw: trimmed });
    }
    i++;
  }

  return statements;
}

/**
 * Find the matching closing brace for a block starting at lineIdx.
 */
function findBlockEnd(lines, lineIdx) {
  let depth = 0;
  for (let i = lineIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth <= 0) return i; }
    }
  }
  return lines.length - 1;
}

/**
 * Find a method in source code, return { startLine (0-based body start), endLine (0-based body end), params: [{type, name}] }
 */
function findMethodInSource(source, methodName) {
  const lines = source.split('\n');
  const methodRegex = new RegExp(
    `(?:public|private|protected|global)\\s+(?:static\\s+)?(?:override\\s+)?(?:testMethod\\s+)?(?:[\\w<>\\[\\],.\\s]+?)\\s+${escapeRegex(methodName)}\\s*\\(`,
    'i'
  );
  for (let i = 0; i < lines.length; i++) {
    if (methodRegex.test(lines[i])) {
      // Extract parameters
      let sigText = '';
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        sigText += lines[j];
        if (sigText.includes(')')) break;
      }
      const paramsPart = sigText.match(/\(([^)]*)\)/);
      const params = [];
      if (paramsPart && paramsPart[1].trim()) {
        for (const p of paramsPart[1].split(',')) {
          const parts = p.trim().split(/\s+/);
          if (parts.length >= 2) {
            params.push({ type: parts.slice(0, -1).join(' '), name: parts[parts.length - 1] });
          }
        }
      }
      // Find the opening brace
      let braceStart = i;
      for (let j = i; j < Math.min(i + 10, lines.length); j++) {
        if (lines[j].includes('{')) { braceStart = j; break; }
      }
      const bodyEnd = findBlockEnd(lines, braceStart);
      return { startLine: braceStart + 1, endLine: bodyEnd - 1, params, signatureLine: i };
    }
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ================================================================
   3. EXPRESSION EVALUATOR — Simple Apex expression interpreter
   ================================================================ */

function evaluateExpression(expr, scope) {
  if (!expr) return undefined;
  expr = expr.trim();

  // null
  if (expr === 'null') return null;
  // Boolean
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(expr)) return parseFloat(expr);
  // String literal
  if (/^'(.*)'$/.test(expr)) return expr.slice(1, -1);
  if (/^"(.*)"$/.test(expr)) return expr.slice(1, -1);

  // this — resolve to current frame's class context
  if (expr === 'this') {
    if (debugState.active && debugState.callStack.length > 0) {
      const fr = debugState.callStack[debugState.callStack.length - 1];
      return { ...(fr.classFields || {}), ...fr.variables, __type__: fr.className };
    }
    return scope;
  }
  // this.field access
  if (expr.startsWith('this.')) {
    const afterThis = expr.substring(5);
    if (debugState.active && debugState.callStack.length > 0) {
      const fr = debugState.callStack[debugState.callStack.length - 1];
      const thisScope = { ...(fr.classFields || {}), ...fr.variables };
      return resolveProperty(thisScope, afterThis);
    }
    return resolveProperty(scope, afterThis);
  }

  // new ClassName{items} — collection initializer with curly braces
  const newCurlyMatch = expr.match(/^new\s+([\w.<>,\s]+?)\s*\{(.*)\}\s*$/s);
  if (newCurlyMatch) {
    const typeName = newCurlyMatch[1].trim();
    const typeNameLower = typeName.toLowerCase();
    const initContent = newCurlyMatch[2].trim();
    if (typeNameLower.startsWith('list') || typeNameLower.startsWith('set')) {
      if (!initContent) return typeNameLower.startsWith('set') ? new Set() : [];
      const items = splitArgs(initContent).map(a => evaluateExpression(a.trim(), scope));
      return typeNameLower.startsWith('set') ? new Set(items) : items;
    }
    if (typeNameLower.startsWith('map')) {
      const mapObj = {};
      if (initContent) {
        const pairs = splitArgs(initContent);
        for (const pair of pairs) {
          const arrowIdx = pair.indexOf('=>');
          if (arrowIdx > 0) {
            const key = evaluateExpression(pair.substring(0, arrowIdx).trim(), scope);
            const val = evaluateExpression(pair.substring(arrowIdx + 2).trim(), scope);
            mapObj[key] = val;
          }
        }
      }
      return mapObj;
    }
    // Custom class initializer
    const obj = { __type__: typeName };
    if (initContent) {
      const pairs = splitArgs(initContent);
      for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0 && pair[eqIdx + 1] !== '>') {
          const key = pair.substring(0, eqIdx).trim();
          const val = evaluateExpression(pair.substring(eqIdx + 1).trim(), scope);
          obj[key] = val;
        }
      }
    }
    return obj;
  }

  // new ClassName(...) — create object with class fields if available.
  // The type may carry generics, e.g. `new List<LineItem__c>()`,
  // `new Map<Integer, Integer>()`, `new Map<Id, List<X>>()` — capture the whole
  // type (non-greedy up to the constructor parens) so the `<…>` isn't later
  // mistaken for a less-than operator (which returned a bogus Boolean).
  const newMatch = expr.match(/^new\s+(.+?)\s*\((.*)\)$/s);
  if (newMatch) {
    const typeName = newMatch[1];
    const typeNameLower = typeName.toLowerCase();
    const argsStr = newMatch[2] ? newMatch[2].trim() : '';
    // Collection types
    if (typeNameLower.startsWith('list') || typeNameLower === 'list') {
      if (argsStr) {
        const items = splitArgs(argsStr).map(a => evaluateExpression(a.trim(), scope));
        return items.filter(i => i !== undefined);
      }
      return [];
    }
    if (typeNameLower.startsWith('set') || typeNameLower === 'set') {
      if (argsStr) {
        const items = splitArgs(argsStr).map(a => evaluateExpression(a.trim(), scope));
        return new Set(items);
      }
      return new Set();
    }
    if (typeNameLower.startsWith('map') || typeNameLower === 'map') return {};
    // Custom class — try to load its fields
    const obj = { __type__: typeName };
    const cached = debugState.classFieldsCache.get(typeName);
    if (cached) {
      // Pre-populate with default field values
      for (const [k, v] of Object.entries(cached.allFields)) {
        obj[k] = v.defaultValue !== undefined ? JSON.parse(JSON.stringify(v.defaultValue)) : null;
      }
    } else {
      // Schedule async field parsing (will be available next access)
      parseClassFieldsAsync(typeName);
    }
    return obj;
  }

  // Built-in Datetime/Date/System clock helpers — resolvable locally without the org.
  // Datetime.now() is just the server clock; getTime() yields epoch milliseconds (a Long).
  // These must run BEFORE the greedy static-call matcher, which would otherwise swallow
  // the trailing .getTime() chain and return an ISO string instead of the numeric Long.
  {
    const nowGetTime = expr.match(/^(?:System|Datetime)\s*\.\s*now\s*\(\s*\)\s*\.\s*getTime\s*\(\s*\)$/);
    if (nowGetTime) return Date.now();
    const nowCall = expr.match(/^(?:System|Datetime)\s*\.\s*now\s*\(\s*\)$/);
    if (nowCall) return new Date().toISOString();
    const todayCall = expr.match(/^(?:System|Date)\s*\.\s*today\s*\(\s*\)$/);
    if (todayCall) return new Date().toISOString().split('T')[0];
  }

  // Common Apex null/empty utility predicates (e.g. SystemUtil.nullOrEmpty(x),
  // String.isBlank(x)). These appear constantly in guard conditions; evaluating
  // them correctly lets branch selection during local method interpretation match
  // the real code path instead of defaulting to null/false.
  const emptyUtil = expr.match(/^[A-Za-z_][\w.]*\.(nullOrEmpty|isNullOrEmpty|isEmpty|isBlank)\s*\((.+)\)$/);
  if (emptyUtil) {
    const v = evaluateExpression(emptyUtil[2].trim(), scope);
    return isApexEmpty(v);
  }
  const notEmptyUtil = expr.match(/^[A-Za-z_][\w.]*\.(isNotBlank|isNotEmpty)\s*\((.+)\)$/);
  if (notEmptyUtil) {
    const v = evaluateExpression(notEmptyUtil[2].trim(), scope);
    return !isApexEmpty(v);
  }

  // Static method calls: Type.method(args) — common Apex static methods
  const staticCallMatch = expr.match(/^(\w+)\.(valueOf|parseInt|isBlank|isNotBlank|isNumeric|format|now|today|newInstance|getGlobalDescribe|join)\s*\((.*)\)$/);
  if (staticCallMatch) {
    const sClass = staticCallMatch[1];
    const sMethod = staticCallMatch[2];
    const sArgsStr = staticCallMatch[3];
    const sArgs = sArgsStr ? splitArgs(sArgsStr).map(a => evaluateExpression(a.trim(), scope)) : [];
    return simulateStaticCall(sClass, sMethod, sArgs);
  }

  // Negation: !expr
  if (expr.startsWith('!')) {
    return !evaluateExpression(expr.slice(1), scope);
  }

  // Ternary: condition ? trueVal : falseVal
  const ternary = findTopLevelOperator(expr, ['?']);
  if (ternary) {
    const colonOp = findTopLevelOperator(ternary.right, [':']);
    if (colonOp) {
      const cond = evaluateExpression(ternary.left, scope);
      return cond ? evaluateExpression(colonOp.left, scope) : evaluateExpression(colonOp.right, scope);
    }
  }

  // Boolean operators: && and ||
  // Find top-level && or ||
  const boolOp = findTopLevelOperator(expr, ['&&', '||']);
  if (boolOp) {
    const left = evaluateExpression(boolOp.left, scope);
    const right = evaluateExpression(boolOp.right, scope);
    return boolOp.op === '&&' ? (left && right) : (left || right);
  }

  // Comparison operators
  const compOp = findTopLevelOperator(expr, ['==', '!=', '>=', '<=', '>', '<']);
  if (compOp) {
    const left = evaluateExpression(compOp.left, scope);
    const right = evaluateExpression(compOp.right, scope);
    switch (compOp.op) {
      case '==': return left == right;
      case '!=': return left != right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '<': return left < right;
    }
  }

  // Instanceof
  if (expr.includes(' instanceof ')) {
    return true; // assume true in simulation
  }

  // Arithmetic operators: +, -, *, /
  const arithOp = findTopLevelOperator(expr, ['+', '-', '*', '/']);
  if (arithOp) {
    const left = evaluateExpression(arithOp.left, scope);
    const right = evaluateExpression(arithOp.right, scope);
    switch (arithOp.op) {
      case '+': return (typeof left === 'string' || typeof right === 'string') ? `${left}${right}` : (left || 0) + (right || 0);
      case '-': return (left || 0) - (right || 0);
      case '*': return (left || 0) * (right || 0);
      case '/': return right ? (left || 0) / right : 0;
    }
  }

  // Method call: obj.method(args) or ClassName.method(args)
  // Extended list of known Apex collection/string methods
  const methodCallMatch = expr.match(/^([\w.[\]]+)\.(size|isEmpty|add|addAll|put|putAll|get|remove|contains|containsKey|containsAll|clear|clone|sort|intValue|longValue|doubleValue|toString|toLowerCase|toUpperCase|trim|length|substring|split|replace|replaceAll|startsWith|endsWith|indexOf|lastIndexOf|charAt|equals|equalsIgnoreCase|valueOf|values|keySet|format|abbreviate|capitalize|center|deleteWhitespace|isBlank|isNotBlank|isNumeric|join|left|mid|right|repeat|reverse|stripHtmlTags|getTime|day|month|year)\s*\((.*)\)\s*$/);
  if (methodCallMatch) {
    const obj = resolveProperty(scope, methodCallMatch[1]);
    const method = methodCallMatch[2];
    const args = methodCallMatch[3] ? splitArgs(methodCallMatch[3]).map(a => evaluateExpression(a.trim(), scope)) : [];
    return simulateMethodCall(obj, method, args);
  }

  // Method chaining: expr.method().method2()
  const chainMatch = expr.match(/^(.+)\.([\w]+)\s*\((.*)\)$/);
  if (chainMatch && !expr.startsWith("'")) {
    const baseExpr = chainMatch[1];
    const method = chainMatch[2];
    const argsStr = chainMatch[3];
    // Try to resolve the base first
    const baseVal = evaluateExpression(baseExpr, scope);
    if (baseVal !== undefined && baseVal !== null) {
      const args = argsStr ? splitArgs(argsStr).map(a => evaluateExpression(a.trim(), scope)) : [];
      const result = simulateMethodCall(baseVal, method, args);
      if (result !== undefined) return result;
    }
    return null; // Can't evaluate unknown method call
  }

  // Cast: (Type)expr
  const castMatch = expr.match(/^\(\s*[\w.<>,\s]+\s*\)\s*(.+)$/);
  if (castMatch) {
    return evaluateExpression(castMatch[1], scope);
  }

  // Property access / variable reference
  const resolved = resolveProperty(scope, expr);
  if (resolved !== undefined) return resolved;

  // If nothing matched and it looks like a method call, return null
  if (expr.match(/\(.*\)\s*$/)) return null;

  return undefined;
}

/**
 * Split arguments string respecting nested parens, brackets, and strings.
 */
function splitArgs(argsStr) {
  const result = [];
  let depth = 0;
  let inString = false;
  let stringChar = null;
  let current = '';
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inString) {
      current += ch;
      if (ch === stringChar && argsStr[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') { inString = true; stringChar = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

/** Apex-style emptiness test for null/empty utility predicates. */
function isApexEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Set) return v.size === 0;
  if (typeof v === 'object') return Object.keys(v).filter(k => !k.startsWith('__')).length === 0;
  return false;
}

/**
 * Pure, side-effect-free interpreter for a parsed Apex block. Operates on a plain
 * `scope` object (no debugState mutation) and returns a control-flow signal:
 *   {} normal, {returned:true,value}, {broke:true}, {continued:true}, {threw:true}.
 * This is what lets hover evaluate a real getter like primaryLineItemSO() against
 * the already-resolved receiver object, honoring its if/else + loops (V8-style).
 */
function interpretApexBlock(statements, scope, depth) {
  for (const stmt of statements || []) {
    const r = interpretApexStmt(stmt, scope, depth);
    if (r && (r.returned || r.broke || r.continued || r.threw)) return r;
  }
  return {};
}

function interpretApexStmt(stmt, scope, depth) {
  switch (stmt.type) {
    case 'declaration': {
      let v = stmt._directValue !== undefined ? stmt._directValue
        : (stmt.expression != null ? evaluateExpression(stmt.expression, scope) : undefined);
      if (v === undefined) v = defaultForApexType(stmt.varType);
      scope[stmt.varName] = v;
      return {};
    }
    case 'assignment': {
      const v = evaluateExpression(stmt.expression, scope);
      assignProperty(scope, stmt.varName, v);
      return {};
    }
    case 'declWithCall':
    case 'assignWithCall': {
      // Best-effort: rebuild the call and evaluate it (handles known collection/util calls).
      const callExpr = `${stmt.className ? stmt.className + '.' : ''}${stmt.methodName}(${stmt.argsRaw || ''})`;
      let v = evaluateExpression(callExpr, scope);
      if (v === undefined && stmt.varType) v = defaultForApexType(stmt.varType);
      scope[stmt.varName] = v === undefined ? null : v;
      return {};
    }
    case 'conditional': {
      const cond = evaluateExpression(stmt.condition, scope);
      if (cond) return interpretApexBlock(stmt.thenBlock || [], scope, depth);
      if (stmt.elseBlock && stmt.elseBlock.length) return interpretApexBlock(stmt.elseBlock, scope, depth);
      return {};
    }
    case 'switch': {
      const sv = evaluateExpression(stmt.switchExpr, scope);
      let elseCase = null;
      for (const wc of stmt.whenCases || []) {
        if (/^else$/i.test(wc.value)) { elseCase = wc; continue; }
        const vals = wc.value.split(',').map(x => evaluateExpression(x.trim(), scope));
        if (vals.some(x => x == sv)) return interpretApexBlock(wc.body, scope, depth);
      }
      if (elseCase) return interpretApexBlock(elseCase.body, scope, depth);
      return {};
    }
    case 'return':
      return { returned: true, value: stmt.expression != null ? evaluateExpression(stmt.expression, scope) : null };
    case 'break': return { broke: true };
    case 'continue': return { continued: true };
    case 'throw': return { threw: true };
    case 'try':
      return interpretApexBlock(stmt.body || [], scope, depth);
    case 'loop': {
      if (stmt.loopType === 'for') {
        const fe = stmt.loopExpr && stmt.loopExpr.match(/^\s*([\w<>\[\],.\s]+?)\s+(\w+)\s*:\s*(.+)$/);
        if (fe) {
          const coll = evaluateExpression(fe[3].trim(), scope);
          const arr = Array.isArray(coll) ? coll : (coll instanceof Set ? [...coll] : []);
          let n = 0;
          for (const item of arr) {
            if (n++ > 5000) break;
            scope[fe[2]] = item;
            const r = interpretApexBlock(stmt.body || [], scope, depth);
            if (r.returned || r.threw) return r;
            if (r.broke) break;
          }
        }
        return {};
      }
      if (stmt.loopType === 'while') {
        let guard = 0;
        while (evaluateExpression(stmt.condition, scope) && guard++ < 5000) {
          const r = interpretApexBlock(stmt.body || [], scope, depth);
          if (r.returned || r.threw) return r;
          if (r.broke) break;
        }
        return {};
      }
      return {};
    }
    default:
      return {};
  }
}

/**
 * Evaluate a user-defined instance method locally against an already-resolved
 * receiver object. Finds the method source (by the receiver's declared/inferred
 * type, its outer class, or the current frame's class), parses the body, and
 * interprets it with the receiver's fields as `this`-scope + bound params.
 * Returns the method's return value, or undefined if it can't be evaluated
 * locally (e.g. it does SOQL/DML and needs the org).
 */
async function evaluateUserMethodLocally(receiverObj, methodName, argValues, typeHint, depth = 0) {
  if (depth > 3) return undefined;
  if (receiverObj == null || typeof receiverObj !== 'object' || Array.isArray(receiverObj) || receiverObj instanceof Set) return undefined;

  const names = [];
  const push = (n) => { if (n && !names.includes(n)) names.push(n); };
  const t = typeHint || receiverObj.__type__;
  if (t) {
    const bare = String(t).replace(/<.*>/, '').replace(/\[\s*\]$/, '').trim();
    push(bare);
    if (bare.includes('.')) { push(bare.split('.')[0]); push(bare.split('.').pop()); }
  }
  const cf = debugState.callStack && debugState.callStack[debugState.callStack.length - 1];
  if (cf && cf.className) push(cf.className);

  let methodInfo = null, source = null;
  for (const n of names) {
    let file;
    try { file = await resolveClassFile(n); } catch { file = null; }
    if (!file) continue;
    let src;
    try { src = await window.congacode.readFile(file); } catch { continue; }
    if (!src) continue;
    const mi = findMethodInSource(src, methodName);
    if (mi) { methodInfo = mi; source = src; break; }
  }
  if (!methodInfo) return undefined;

  const lines = source.split('\n');
  const stmts = parseApexStatements(lines, methodInfo.startLine, methodInfo.endLine);
  // Receiver fields become the method's `this`-scope; then bind the parameters.
  const scope = Object.assign({}, receiverObj);
  (methodInfo.params || []).forEach((p, i) => { scope[p.name] = argValues[i]; });
  try {
    const r = interpretApexBlock(stmts, scope, depth + 1);
    return r && r.returned ? r.value : undefined;
  } catch (_) {
    return undefined;
  }
}


function parseClassFields(source) {
  const lines = source.split('\n');
  const fields = { publicFields: {}, privateFields: {}, staticFields: {}, allFields: {} };
  const fieldRegex = /^\s*(?:(public|private|protected|global)\s+)?(?:(static)\s+)?(?:(final)\s+)?(\w[\w<>,\s.\[\]]*?)\s+(\w+)\s*(?:=\s*(.+?))?\s*;\s*$/;
  // Only parse fields before the first method declaration
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Track class body entry
    if (!inClass && /^\s*(?:public|private|protected|global)\s+(?:(?:virtual|abstract|with|without)\s+)*(?:sharing\s+)?class\s/i.test(trimmed)) {
      inClass = true;
    }
    for (const ch of trimmed) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    // Only parse fields at class body depth (depth === 1 after class declaration)
    if (!inClass || depth !== 1) continue;
    // Skip method declarations
    if (/(?:public|private|protected|global)\s+(?:static\s+)?(?:override\s+)?(?:testMethod\s+)?(?:[\w<>\[\],.\s]+?)\s+\w+\s*\(/.test(trimmed)) continue;
    // Skip comments, annotations
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('@')) continue;

    const m = trimmed.match(fieldRegex);
    if (m) {
      const access = m[1] || 'private';
      const isStatic = !!m[2];
      const isFinal = !!m[3];
      const type = m[4].trim();
      const name = m[5];
      const defaultExpr = m[6] ? m[6].replace(/;$/, '').trim() : null;
      let defaultValue = null;
      if (defaultExpr) {
        try { defaultValue = evaluateExpression(defaultExpr, {}); } catch(_) {}
      }
      const fieldInfo = { type, access, isStatic, isFinal, defaultValue };
      fields.allFields[name] = fieldInfo;
      if (isStatic) fields.staticFields[name] = fieldInfo;
      if (access === 'public' || access === 'global') fields.publicFields[name] = fieldInfo;
      else fields.privateFields[name] = fieldInfo;
    }
  }
  return fields;
}

/**
 * Async helper to parse and cache class fields.
 */
async function parseClassFieldsAsync(className) {
  if (debugState.classFieldsCache.has(className)) return debugState.classFieldsCache.get(className);
  const filePath = await resolveClassFile(className);
  if (!filePath) return null;
  try {
    const source = await window.congacode.readFile(filePath);
    if (!source) return null;
    const fields = parseClassFields(source);
    debugState.classFieldsCache.set(className, fields);
    return fields;
  } catch(_) { return null; }
}

function findTopLevelOperator(expr, operators) {
  let depth = 0;
  let inString = false;
  let stringChar = null;

  // Sort operators by length desc so we match longer ones first
  operators.sort((a, b) => b.length - a.length);

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inString) {
      if (ch === stringChar && expr[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') { inString = true; stringChar = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (depth > 0) continue;

    for (const op of operators) {
      if (expr.substring(i, i + op.length) === op) {
        const left = expr.substring(0, i).trim();
        const right = expr.substring(i + op.length).trim();
        if (left && right) return { op, left, right };
      }
    }
  }
  return null;
}

function resolveProperty(scope, path) {
  if (!path) return undefined;
  path = path.trim();

  // Handle array index: path[expr]
  const indexParts = path.match(/^([\w.]+)\[(.+?)\](.*)$/);
  if (indexParts) {
    const obj = resolveProperty(scope, indexParts[1]);
    // Evaluate index expression (could be a number or a variable)
    let idx = indexParts[2].trim();
    if (/^\d+$/.test(idx)) {
      idx = parseInt(idx);
    } else {
      idx = evaluateExpression(idx, scope);
    }
    const rest = indexParts[3];
    let item;
    if (Array.isArray(obj)) {
      item = obj[idx];
    } else if (typeof obj === 'object' && obj !== null) {
      item = obj[idx];
    } else {
      item = undefined;
    }
    if (rest && rest.startsWith('.')) {
      return resolveProperty({ __item__: item }, '__item__' + rest);
    }
    return item;
  }

  const parts = path.split('.');
  let current = scope;
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    if (current == null) return undefined;
    if (typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      // Try searching up the call stack for the first part
      if (pi === 0 && debugState.active) {
        let found = false;
        for (let fi = debugState.callStack.length - 1; fi >= 0; fi--) {
          const frame = debugState.callStack[fi];
          if (part in frame.variables) {
            current = frame.variables[part];
            found = true;
            break;
          }
          // Also check class fields
          if (frame.classFields && part in frame.classFields) {
            current = frame.classFields[part];
            found = true;
            break;
          }
        }
        if (!found) return undefined;
      } else {
        return undefined;
      }
    }
  }
  return current;
}

function simulateMethodCall(obj, method, args) {
  if (obj == null && method !== 'valueOf') return undefined;
  switch (method) {
    case 'size': return Array.isArray(obj) ? obj.length : (obj instanceof Set ? obj.size : (typeof obj === 'object' ? Object.keys(obj).length : 0));
    case 'isEmpty': return Array.isArray(obj) ? obj.length === 0 : (typeof obj === 'object' ? Object.keys(obj).length === 0 : true);
    case 'add': if (Array.isArray(obj)) { obj.push(args[0]); return; } if (obj instanceof Set) { obj.add(args[0]); return; } return;
    case 'addAll': if (Array.isArray(obj) && Array.isArray(args[0])) { obj.push(...args[0]); } return;
    case 'put': if (typeof obj === 'object') obj[args[0]] = args[1]; return;
    case 'putAll': if (typeof obj === 'object' && typeof args[0] === 'object') { Object.assign(obj, args[0]); } return;
    case 'get': return Array.isArray(obj) ? obj[args[0]] : (typeof obj === 'object' ? obj[args[0]] : undefined);
    case 'remove': if (Array.isArray(obj)) { return obj.splice(args[0], 1)[0]; } else if (typeof obj === 'object') { const v = obj[args[0]]; delete obj[args[0]]; return v; } return;
    case 'contains': return Array.isArray(obj) ? obj.includes(args[0]) : (obj instanceof Set ? obj.has(args[0]) : false);
    case 'containsKey': return typeof obj === 'object' ? (args[0] in obj) : false;
    case 'containsAll': return Array.isArray(obj) && Array.isArray(args[0]) ? args[0].every(i => obj.includes(i)) : false;
    case 'clear': if (Array.isArray(obj)) obj.length = 0; else if (typeof obj === 'object') { for (const k of Object.keys(obj)) delete obj[k]; } return;
    case 'clone': return JSON.parse(JSON.stringify(obj));
    case 'sort': if (Array.isArray(obj)) obj.sort(); return obj;
    case 'intValue': return typeof obj === 'number' ? Math.floor(obj) : parseInt(obj);
    case 'longValue': return typeof obj === 'number' ? Math.floor(obj) : parseInt(obj);
    case 'doubleValue': return typeof obj === 'number' ? obj : parseFloat(obj);
    case 'toString': return String(obj);
    case 'toLowerCase': return typeof obj === 'string' ? obj.toLowerCase() : String(obj).toLowerCase();
    case 'toUpperCase': return typeof obj === 'string' ? obj.toUpperCase() : String(obj).toUpperCase();
    case 'trim': return typeof obj === 'string' ? obj.trim() : obj;
    case 'length': return typeof obj === 'string' ? obj.length : (Array.isArray(obj) ? obj.length : 0);
    case 'substring': return typeof obj === 'string' ? obj.substring(args[0], args[1]) : obj;
    case 'split': return typeof obj === 'string' ? obj.split(args[0] || ',') : [obj];
    case 'replace': return typeof obj === 'string' ? obj.replace(args[0], args[1]) : obj;
    case 'replaceAll': return typeof obj === 'string' ? obj.replaceAll(args[0], args[1]) : obj;
    case 'startsWith': return typeof obj === 'string' ? obj.startsWith(args[0]) : false;
    case 'endsWith': return typeof obj === 'string' ? obj.endsWith(args[0]) : false;
    case 'indexOf': return typeof obj === 'string' ? obj.indexOf(args[0]) : (Array.isArray(obj) ? obj.indexOf(args[0]) : -1);
    case 'lastIndexOf': return typeof obj === 'string' ? obj.lastIndexOf(args[0]) : -1;
    case 'charAt': return typeof obj === 'string' ? obj.charAt(args[0]) : '';
    case 'equals': return obj === args[0];
    case 'equalsIgnoreCase': return typeof obj === 'string' && typeof args[0] === 'string' ? obj.toLowerCase() === args[0].toLowerCase() : obj === args[0];
    case 'valueOf': return obj;
    case 'values': return typeof obj === 'object' ? Object.values(obj) : [];
    case 'keySet': return typeof obj === 'object' ? Object.keys(obj) : [];
    case 'format': return typeof obj === 'string' ? obj : String(obj);
    case 'isBlank': return typeof obj === 'string' ? obj.trim().length === 0 : true;
    case 'isNotBlank': return typeof obj === 'string' ? obj.trim().length > 0 : false;
    case 'join': return Array.isArray(obj) ? obj.join(args[0] || ',') : String(obj);
    case 'getTime': {
      const t = (obj instanceof Date ? obj : new Date(obj)).getTime();
      return isNaN(t) ? null : t;
    }
    case 'day': { const d = new Date(obj); return isNaN(d.getTime()) ? null : d.getUTCDate(); }
    case 'month': { const d = new Date(obj); return isNaN(d.getTime()) ? null : d.getUTCMonth() + 1; }
    case 'year': { const d = new Date(obj); return isNaN(d.getTime()) ? null : d.getUTCFullYear(); }
    default: return undefined;
  }
}

/**
 * Simulate common Apex static method calls.
 */
function simulateStaticCall(className, methodName, args) {
  const cls = className.toLowerCase();
  switch (methodName) {
    case 'valueOf':
      if (cls === 'string') return args[0] != null ? String(args[0]) : 'null';
      if (cls === 'integer' || cls === 'int') return parseInt(args[0]) || 0;
      if (cls === 'long') return parseInt(args[0]) || 0;
      if (cls === 'double' || cls === 'decimal') return parseFloat(args[0]) || 0;
      if (cls === 'boolean') return args[0] === 'true' || args[0] === true;
      if (cls === 'date' || cls === 'datetime') return String(args[0]);
      return args[0];
    case 'parseInt':
      return parseInt(args[0]) || 0;
    case 'isBlank':
      return args[0] == null || (typeof args[0] === 'string' && args[0].trim().length === 0);
    case 'isNotBlank':
      return args[0] != null && (typeof args[0] === 'string' && args[0].trim().length > 0);
    case 'isNumeric':
      return typeof args[0] === 'string' && /^\d+$/.test(args[0]);
    case 'format':
      if (cls === 'string' && typeof args[0] === 'string') {
        let formatted = args[0];
        for (let fi = 1; fi < args.length; fi++) {
          formatted = formatted.replace(`{${fi - 1}}`, String(args[fi] ?? ''));
        }
        return formatted;
      }
      return String(args[0]);
    case 'join':
      if (Array.isArray(args[0])) return args[0].join(args[1] || ',');
      return String(args[0]);
    case 'now':
      return new Date().toISOString();
    case 'today':
      return new Date().toISOString().split('T')[0];
    case 'newInstance':
      return {};
    case 'getGlobalDescribe':
      return {};
    default:
      return null;
  }
}

/* ================================================================
   4. REQUEST PARSER — Parse VF Remoting / REST / raw JSON
   ================================================================ */

function parseRequest(jsonText) {
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { return { error: `Invalid JSON: ${e.message}` }; }

  // VF Remoting format
  if (obj.action && obj.method && obj.data) {
    const ns = obj.ctx?.ns || '';
    const actionParts = obj.action.replace(ns + '.', '').split('.');
    const className = actionParts[actionParts.length - 1];
    const methodName = obj.method;
    const params = Array.isArray(obj.data) ? obj.data : [obj.data];
    return { format: 'vfRemoting', className, methodName, namespace: ns, params };
  }

  // REST format (has url or path)
  if (obj.url || obj.path || obj.endpoint) {
    const url = obj.url || obj.path || obj.endpoint;
    const pathMatch = url.match(/\/services\/apexrest\/(.+)/);
    if (pathMatch) {
      return { format: 'rest', urlMapping: pathMatch[1], method: obj.method || 'GET', body: obj.body || obj.data, params: obj.body ? [obj.body] : [] };
    }
  }

  // Raw parameter object — treat as the single parameter
  return { format: 'raw', params: [obj], className: null, methodName: null };
}

/* ================================================================
   5. CLASS INDEX — Map className → filePath for cross-file resolution
   ================================================================ */

async function buildClassIndex() {
  if (debugState.classIndex) return debugState.classIndex;
  const folder = window.state?.folderPath;
  if (!folder) return {};

  try {
    const allFiles = await window.congacode.getAllFiles(folder);
    const index = {};
    for (const f of allFiles) {
      if (f.endsWith('.cls') || f.endsWith('.trigger')) {
        const name = f.split('/').pop().replace(/\.(cls|trigger)$/, '');
        index[name] = f;
        // Also store lowercase for case-insensitive lookup
        index[name.toLowerCase()] = f;
      }
    }
    debugState.classIndex = index;
    return index;
  } catch (e) {
    console.error('buildClassIndex error:', e);
    return {};
  }
}

async function resolveClassFile(className) {
  const index = await buildClassIndex();
  // Direct match
  if (index[className]) return index[className];
  // Case-insensitive
  if (index[className.toLowerCase()]) return index[className.toLowerCase()];
  // Try stripping namespace prefix (e.g., "Apttus_Config2.RemoteCPQService" → "RemoteCPQService")
  const dotIdx = className.lastIndexOf('.');
  if (dotIdx >= 0) {
    const shortName = className.substring(dotIdx + 1);
    if (index[shortName]) return index[shortName];
    if (index[shortName.toLowerCase()]) return index[shortName.toLowerCase()];
  }
  return null;
}

/* ================================================================
   6. EXECUTION CONTROLLER — Step through parsed statements
   ================================================================ */

async function startDebugSession(filePath, methodName, requestParams) {
  const source = await window.congacode.readFile(filePath);
  if (!source) { window.showToast?.('Could not read file', 'error'); return; }

  const methodInfo = findMethodInSource(source, methodName);
  if (!methodInfo) { window.showToast?.(`Method "${methodName}" not found`, 'error'); return; }

  // Reset state
  debugState.active = true;
  debugState.paused = true;
  debugState.entryFile = filePath;
  debugState.entryMethod = methodName;
  debugState.entryLine = methodInfo.signatureLine + 1;
  debugState.consoleLog = [];
  debugState.methodCache.clear();
  debugState.classIndex = null; // refresh on next use
  debugState.classFieldsCache.clear();
  debugState.orgQueryCache.clear();
  debugState.orgActivity = null;

  // Parse class-level fields
  const classFields = parseClassFields(source);
  const className = filePath.split('/').pop().replace(/\.(cls|trigger)$/, '');
  debugState.classFieldsCache.set(className, classFields);

  // Build class field variable scope (static + instance fields)
  const classFieldVars = {};
  for (const [name, info] of Object.entries(classFields.allFields)) {
    classFieldVars[name] = info.defaultValue !== undefined ? JSON.parse(JSON.stringify(info.defaultValue)) : null;
  }

  // Build initial variable scope from parameters
  const variables = {};
  if (methodInfo.params && requestParams) {
    methodInfo.params.forEach((p, idx) => {
      variables[p.name] = requestParams[idx] !== undefined ? JSON.parse(JSON.stringify(requestParams[idx])) : null;
    });
  }

  // Parse the method body
  const lines = source.split('\n');
  const statements = parseApexStatements(lines, methodInfo.startLine, methodInfo.endLine);

  // Push initial call stack frame
  debugState.callStack = [{
    file: filePath,
    className,
    methodName,
    line: statements.length > 0 ? statements[0].line : methodInfo.signatureLine + 1,
    variables: { ...variables },
    classFields: classFieldVars,
    statements,
    pc: 0  // program counter — index into statements array
  }];

  // Open file in editor at method start
  const content = await window.congacode.readFile(filePath);
  await window.openFile(filePath, content);

  // Show debug UI
  showDebugUI();
  updateDebugPanels();
  updateLiveOrgIndicator();

  // Highlight first line
  if (statements.length > 0) {
    debugState.currentFile = filePath;
    debugState.currentLine = statements[0].line;
    highlightCurrentLine();
    navigateToLine(debugState.currentLine);
  }

  addConsoleEntry('info', `▶ Debug session started: ${className}.${methodName}()`);
  addConsoleEntry('info', `  Parameters: ${methodInfo.params.map(p => p.name).join(', ')}`);
  if (Object.keys(classFieldVars).length > 0) {
    addConsoleEntry('info', `  Class fields: ${Object.keys(classFieldVars).join(', ')}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIMARY ENGINE = REAL EXECUTION REPLAY (the "V8 for Apex" path).
  // Apex runs on Salesforce servers, so — exactly like Salesforce's own Apex
  // Replay Debugger and Chrome DevTools' model — we execute the method ONCE in
  // the org (wrapped in a savepoint + rollback, read-only), capture the FINEST
  // trace, and reconstruct the real execution: every line that actually ran, in
  // real branch/loop order, with real variable values, the full call stack
  // (incl. private + cross-class methods) and static/global state. The user then
  // steps through that with full breakpoints/step-into/over/out + scope + hover.
  //
  // The local statement simulator set up above is only a FALLBACK PREVIEW for
  // when no org is connected (it can only guess values/branches).
  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // PRIMARY ENGINE = LIVE INTERPRETER ("V8 for Apex").
  // The editor executes the Apex source itself — real call stack, scope chain,
  // step into/over/out/continue and conditional breakpoints — while SOQL and
  // org-dependent values are fetched from the connected org ON DEMAND, pausing
  // execution while the data loads (exactly like awaiting I/O in Chrome).
  // If the source can't be parsed by the interpreter, we fall back to the
  // org-replay path, then to the local statement simulator.
  // ─────────────────────────────────────────────────────────────────────────
  const engineStarted = await startEngineSession(filePath, methodName, requestParams, source);
  if (engineStarted) {
    addConsoleEntry('info', '⚡ Live interpreter active — the editor is executing this method like a JS engine. Step buttons walk real execution; SOQL lines fetch REAL data from the org on demand.');
    if (!liveOrgAvailable()) {
      addConsoleEntry('warn', 'No org connected — SOQL will return 0 rows. Connect an org for live data.');
    }
    return;
  }

  if (liveOrgAvailable()) {
    debugState.liveOrgMode = true;
    updateLiveOrgIndicator();
    addConsoleEntry('info', '⚡ Live Org connected — executing the method in the org and reconstructing its REAL execution to step through (savepoint + rollback, nothing is modified)…');
    await runEntryMethodInOrg();  // runs in org → builds timeline → enterReplayMode() on success
    if (debugState.replayMode) {
      addConsoleEntry('info', '✅ Real-execution replay ready. Step Over / Into / Out and Continue now walk the actual run with real values. Set breakpoints and hover any variable.');
    } else {
      addConsoleEntry('info', '⚠ Could not reconstruct the real execution (see the error above — usually FINEST logging not enabled or a compile/auth issue). Falling back to a LOCAL PREVIEW that guesses values. Fix the issue, then Restart.');
    }
  } else {
    addConsoleEntry('info', 'ℹ No org connected — this is a LOCAL PREVIEW that only guesses values and branches. Connect an org and enable Live Org for real, V8-style debugging of the actual execution.');
  }
}

function stopDebugSession() {
  if (debugState.engineSession) {
    try { debugState.engineSession.stop(); } catch (_) {}
    debugState.engineSession = null;
  }
  debugState.engineMode = false;
  debugState.engineRunning = false;
  debugState.active = false;
  debugState.paused = false;
  debugState.callStack = [];
  debugState.stepMode = null;
  debugState.replayMode = false;
  debugState.replayTimeline = [];
  debugState.replayIndex = 0;
  debugState.replayFatalError = null;
  debugState.userOverrides = {};
  if (debugState.orgEvalCache) debugState.orgEvalCache.clear();
  if (debugState.orgQueryCache) debugState.orgQueryCache.clear();
  debugState._soqlHoverLogged = null;
  clearCurrentLineHighlight();
  hideDebugUI();
  addConsoleEntry('info', '⏹ Debug session ended');
}

/* ================================================================
   LIVE INTERPRETER ENGINE MODE — "V8 for Apex"
   The editor executes the Apex source itself (apexlang.js parser +
   apexengine.js async interpreter): real call stack, scope chain,
   step into/over/out/continue, conditional breakpoints, and REAL org
   data fetched on demand — execution pauses while SOQL runs against
   the connected org, exactly like awaiting I/O in Chrome DevTools.
   ================================================================ */

/** Convert an engine runtime value into a plain JS value for the UI panels. */
function engineValToPlain(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (depth > 6) return '…';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  const E = window.ApexEngine;
  if (Array.isArray(v)) return v.map(x => engineValToPlain(x, depth + 1));
  if (E && v instanceof E.ApexMap) {
    const o = {};
    for (const e of v.m.values()) o[typeof e.k === 'string' ? e.k : E.toApexString(e.k)] = engineValToPlain(e.v, depth + 1);
    return o;
  }
  if (E && v instanceof E.ApexSet) return v.items().map(x => engineValToPlain(x, depth + 1));
  if (E && (v instanceof E.ApexDate || v instanceof E.ApexDatetime)) return v.toString();
  if (E && v instanceof E.ApexError) return `${v.apexType}: ${v.apexMessage}`;
  if (E && v instanceof E.ApexObject) {
    const o = {};
    for (const e of v.fields.values()) o[e.name] = engineValToPlain(e.value, depth + 1);
    return o;
  }
  if (t === 'object') {
    const o = {};
    for (const k of Object.keys(v)) { if (k === 'attributes') continue; o[k] = engineValToPlain(v[k], depth + 1); }
    return o;
  }
  return String(v);
}

/** Mirror the engine's call stack into debugState.callStack so every existing
    panel (variables, call stack, hover, watch) keeps working unchanged. */
function mirrorEngineStack(engineStack) {
  const frames = [];
  // engine stack is top-first; debugState.callStack is bottom-first
  for (let i = engineStack.length - 1; i >= 0; i--) {
    const f = engineStack[i];
    const variables = {};
    const classFields = {};
    for (const v of f.variables || []) {
      if (v.name === 'this') continue;
      if (v.scope && String(v.scope).startsWith('static')) classFields[v.name] = engineValToPlain(v.value);
      else variables[v.name] = engineValToPlain(v.value);
    }
    if (f.thisRef && f.thisRef.fields) {
      for (const e of f.thisRef.fields.values()) classFields[e.name] = engineValToPlain(e.value);
    }
    frames.push({
      file: f.file, className: f.className, methodName: f.methodName,
      line: f.line, variables, classFields, statements: [], pc: 0,
    });
  }
  debugState.callStack = frames;
}

/** Inline resolved bind values into a SOQL string so it can run via the CLI. */
function engineBuildSoql(raw, binds) {
  let q = String(raw || '').trim().replace(/^\[/, '').replace(/\]\s*;?$/, '').trim();
  const entries = Object.entries(binds || {}).sort((a, b) => b[0].length - a[0].length);
  for (const [expr, val] of entries) {
    const plain = engineValToPlain(val);
    const lit = toSoqlLiteral(plain);
    if (lit == null) continue;
    q = q.replace(new RegExp(':\\s*' + escapeRegex(expr) + '(?![\\w.])', 'g'), lit);
  }
  return q;
}

/** Called when the engine pauses (step / breakpoint). Sync the whole UI. */
async function onEnginePause(info) {
  debugState.paused = true;
  debugState.engineRunning = false;
  mirrorEngineStack(info.stack || []);
  debugState.currentLine = info.line;
  // Cross-file step-into: open the paused file if it isn't the current one
  if (info.file && info.file !== debugState.currentFile && /\.(cls|trigger)$/.test(info.file)) {
    try {
      const content = await window.congacode.readFile(info.file);
      if (content != null) { await window.openFile(info.file, content); }
      debugState.currentFile = info.file;
    } catch (_) { /* keep current file */ }
  } else if (info.file) {
    debugState.currentFile = info.file;
  }
  highlightCurrentLine();
  navigateToLine(info.line);
  updateDebugPanels();
}

/**
 * Boot a live-interpreter debug session. Returns true when the engine
 * successfully parsed the source and started (paused on the first statement).
 */
async function startEngineSession(filePath, methodName, requestParams, source) {
  if (!window.ApexEngine || !window.ApexLang) return false;
  const E = window.ApexEngine;

  const host = {
    log: (msg, level) => {
      const map = { debug: 'log', soql: 'info', dml: 'info', system: 'info' };
      addConsoleEntry(map[level] || 'log', level === 'debug' ? `USER_DEBUG: ${msg}` : msg);
      renderConsolePanel();
    },
    query: async (rawSoql, binds) => {
      if (!liveOrgAvailable()) {
        addConsoleEntry('warn', 'SOQL needs a connected org — returning 0 rows. Connect an org for real data.');
        return [];
      }
      const soql = engineBuildSoql(rawSoql, binds);
      debugState.orgFetching = true;
      updateLiveOrgIndicator();
      addConsoleEntry('info', `⏳ Fetching from org: ${soql.replace(/\s+/g, ' ').slice(0, 180)}`);
      renderConsolePanel();
      try {
        const res = await execSoql(soql);
        if (res.error) {
          addConsoleEntry('error', `SOQL error: ${res.error}`);
          throw Object.assign(new E.ApexError('System.QueryException', res.error, 0), {});
        }
        addConsoleEntry('info', `✓ ${res.records.length} row(s) from org`);
        return res.records;
      } finally {
        debugState.orgFetching = false;
        updateLiveOrgIndicator();
        renderConsolePanel();
      }
    },
    dml: async (op, value) => {
      const records = Array.isArray(value) ? value : [value];
      addConsoleEntry('warn', `DML ${op.toUpperCase()} simulated locally (${records.length} record(s)) — the org is never modified by the debugger.`);
      renderConsolePanel();
    },
    loadClassSource: async (className) => {
      const file = await resolveClassFile(className);
      if (!file) return null;
      try {
        const src = await window.congacode.readFile(file);
        if (src) addConsoleEntry('info', `↳ Loaded ${className} from ${file.split('/').pop()} (step-into available)`);
        return src ? { source: src, path: file } : null;
      } catch (_) { return null; }
    },
    getBreakpoint: (file, line) => {
      const bps = debugState.breakpoints.get(file);
      if (!bps || !bps.has(line)) return null;
      return bps.get(line) || {};
    },
    onPause: (info) => { onEnginePause(info); },
    onDone: (result) => {
      if (!debugState.active) return;
      debugState.paused = false;
      debugState.engineRunning = false;
      clearCurrentLineHighlight();
      if (result !== undefined && result !== null) {
        const plain = engineValToPlain(result);
        addConsoleEntry('result', `⏹ Method returned: ${typeof plain === 'object' ? JSON.stringify(plain, null, 2) : formatValue(plain)}`);
      }
      addConsoleEntry('info', '✅ Execution finished. Restart (⟳) to run again.');
      updateDebugPanels();
    },
    onError: (err) => {
      if (!debugState.active) return;
      debugState.paused = false;
      debugState.engineRunning = false;
      const msg = err && err.apexType ? `${err.apexType}: ${err.apexMessage}` : (err && err.message) || String(err);
      addConsoleEntry('error', `✖ Uncaught exception: ${msg}`);
      if (err && err.apexStack && err.apexStack.length) {
        addConsoleEntry('error', err.apexStack.map(f => `    at ${f.className}.${f.methodName} (line ${f.line})`).join('\n'));
      }
      updateDebugPanels();
    },
  };

  let engine;
  try {
    engine = new E.ApexEngine(host);
    engine.loadSource(filePath, source);
  } catch (e) {
    console.warn('[engine] parse failed, falling back:', e);
    addConsoleEntry('warn', `Live interpreter could not parse this file (${e.message || e}) — falling back to org-replay mode.`);
    return false;
  }

  const className = filePath.split('/').pop().replace(/\.(cls|trigger)$/, '');
  if (!engine.registry.get(className)) return false;
  const methods = engine.registry.get(className).findMethods(methodName);
  if (!methods.length) return false;

  const args = (methods[0].params || []).map((p, i) =>
    requestParams && requestParams[i] !== undefined ? JSON.parse(JSON.stringify(requestParams[i])) : null);

  debugState.engineMode = true;
  debugState.engineSession = engine;
  engine.mode = 'into';                    // pause on the very first statement
  debugState.engineRunning = true;

  // Fire and let the pause gate drive the UI; completion handled by onDone/onError.
  engine.run(className, methodName, args).catch(() => { /* reported via onError */ });
  return true;
}

/** Resume the live interpreter with a step action ('continue'|'into'|'over'|'out'). */
function engineStep(action) {
  const eng = debugState.engineSession;
  if (!eng) return;
  debugState.paused = false;
  debugState.engineRunning = true;
  clearCurrentLineHighlight();
  eng.resume(action);
}

/** Console / watch evaluation inside the live interpreter's top frame. */
async function evaluateEngineConsole(expr) {
  const eng = debugState.engineSession;
  if (!eng || !eng.topFrame()) { addConsoleEntry('error', 'No active engine frame'); return; }
  try {
    const val = await eng.evalExpressionInFrame(expr, eng.topFrame());
    const plain = engineValToPlain(val);
    if (plain !== null && typeof plain === 'object') addConsoleEntry('result-json', JSON.stringify(plain, null, 2));
    else addConsoleEntry('result', formatValue(plain));
    // Assignments may have mutated scope — refresh panels
    mirrorEngineStack(eng.getCallStack());
    updateDebugPanels();
  } catch (e) {
    addConsoleEntry('error', e && e.apexType ? `${e.apexType}: ${e.apexMessage}` : (e.message || String(e)));
  }
  renderConsolePanel();
}

/* ================================================================
   LIVE ORG CONTEXT — resolve SOQL against a connected org
   ================================================================ */

/** Read the currently selected/connected Salesforce org (from salesforce.js). */
function getActiveOrg() {
  try { return (typeof window.sfGetActiveOrg === 'function') ? window.sfGetActiveOrg() : null; }
  catch { return null; }
}

/** True when Live Org mode is usable (enabled + an org is connected). */
function liveOrgAvailable() {
  const o = getActiveOrg();
  return !!(o && o.connected && o.org);
}

/**
 * Robustly parse JSON from `sf` CLI stdout. The CLI can prepend noise such as
 * "› Warning: @salesforce/cli update available…" before the JSON payload, which
 * breaks a naive JSON.parse. This slices from the first '{' to the last '}'.
 */
function parseSfJson(stdout) {
  if (!stdout) return null;
  try { return JSON.parse(stdout); } catch { /* fall through to slice */ }
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stdout.slice(start, end + 1)); } catch { return null; }
}

/** Strip sf CLI noise (update-available warnings, `›` banner lines, blank lines). */
function cleanSfNoise(text) {
  if (!text) return '';
  return String(text)
    .split('\n')
    .filter(l => {
      const t = l.trim().replace(/^[›»>]\s*/, '');
      if (!t) return false;
      if (/^Warning:\s*@salesforce\/cli update available/i.test(t)) return false;
      if (/update available from [\d.]+ to [\d.]+/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Extract the most meaningful error text from an sf CLI invocation.
 * Prefers the parsed JSON's message/compileProblem, then cleaned stderr/stdout,
 * so the real cause (auth, compile, runtime) is shown instead of the update banner.
 */
function sfErrorText(cli, stderr, stdout, fallback) {
  if (cli) {
    if (cli.status && cli.status !== 0 && cli.message) return String(cli.message).split('\n')[0];
    const r = cli.result || cli.data || {};
    if (r.compileProblem) return `Compile error: ${r.compileProblem}`;
    if (r.exceptionMessage) return r.exceptionMessage;
    if (cli.message && !r.success) return String(cli.message).split('\n')[0];
  }
  const cleaned = cleanSfNoise(stderr) || cleanSfNoise(stdout);
  if (cleaned) return cleaned.split('\n')[0];
  return fallback || 'Org returned no result';
}

/** Format a JS value as a SOQL literal for bind-variable substitution. */
function toSoqlLiteral(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return '(' + val.map(toSoqlLiteral).join(', ') + ')';
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') {
    // sObject-like: bind on Id if present, else stringify
    if (val.Id) return `'${String(val.Id).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  const s = String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${s}'`;
}

/** Strip enclosing [ ] and substitute :bind variables from the current scope. */
function buildLiveQuery(rawQuery, scope) {
  let q = (rawQuery || '').trim();
  const m = q.match(/^\[([\s\S]*)\]\s*;?$/);
  q = (m ? m[1] : q.replace(/^\[/, '').replace(/\]\s*;?$/, '')).trim();
  // Replace SOQL bind expressions like :varName or : obj.field with real values.
  q = q.replace(/:\s*([A-Za-z_]\w*(?:\.\w+)*)/g, (whole, expr) => {
    const val = resolveProperty(scope, expr);
    if (val === undefined) return whole; // leave unresolved — surface the error
    return toSoqlLiteral(val);
  });
  return q;
}

/** Recursively strip Salesforce "attributes" noise from returned records. */
function cleanSObject(rec) {
  if (Array.isArray(rec)) return rec.map(cleanSObject);
  if (rec && typeof rec === 'object') {
    const out = {};
    for (const k of Object.keys(rec)) {
      if (k === 'attributes') continue;
      const v = rec[k];
      out[k] = (v && typeof v === 'object') ? cleanSObject(v) : v;
    }
    return out;
  }
  return rec;
}

/** True when a SOQL result should be assigned as a List (vs. a single sObject). */
function soqlIsList(declType) {
  if (!declType) return true;
  return /^(List|Set|Iterable)\s*</i.test(declType) || /\[\]\s*$/.test(declType);
}

/** Run a SOQL query against the connected org via the sf CLI (cached). */
async function runLiveQuery(rawQuery, scope) {
  const org = getActiveOrg();
  const soql = buildLiveQuery(rawQuery, scope);
  if (debugState.orgQueryCache.has(soql)) return debugState.orgQueryCache.get(soql);

  const folder = window.state?.folderPath;
  const escaped = soql.replace(/"/g, '\\"');
  const cmd = `sf data query --query "${escaped}" --json --target-org ${org.org}`;
  let result = { records: [], error: null, soql };
  try {
    const { stdout, stderr } = await window.congacode.sfExec(cmd, folder, 60000);
    const parsed = parseSfJson(stdout);
    if (parsed && parsed.status === 0 && parsed.result) {
      result.records = (parsed.result.records || []).map(cleanSObject);
    } else {
      result.error = sfErrorText(parsed, stderr, stdout, 'Query failed');
    }
  } catch (e) {
    result.error = e?.message || String(e);
  }
  debugState.orgQueryCache.set(soql, result);
  return result;
}

/** Execute a fully-resolved SOQL string against the org via `sf data query` (cached). */
async function execSoql(soql) {
  const org = getActiveOrg();
  if (!org) return { records: [], error: 'No org connected', soql };
  if (debugState.orgQueryCache.has(soql)) return debugState.orgQueryCache.get(soql);

  let result = await _runSoqlOnce(soql);
  // Managed-package objects/fields need their namespace prefix when queried via the
  // CLI (which runs outside the package namespace). Retry with the prefix on failure.
  if (result.error && /not supported|INVALID_TYPE|INVALID_FIELD|No such column|did.?n.?t understand/i.test(result.error)) {
    const ns = await getPackageNamespace();
    const nsSoql = applyNamespaceToSoql(soql, ns);
    if (ns && nsSoql !== soql) {
      const r2 = await _runSoqlOnce(nsSoql);
      if (!r2.error) result = { ...r2, soql: nsSoql };
      else result = { ...result, error: `${result.error} (also tried ${ns} namespace: ${r2.error})` };
    }
  }
  debugState.orgQueryCache.set(soql, result);
  return result;
}

/** Single `sf data query` invocation (no caching, no retry). */
async function _runSoqlOnce(soql) {
  const org = getActiveOrg();
  const folder = window.state?.folderPath;
  const escaped = soql.replace(/"/g, '\\"');
  const cmd = `sf data query --query "${escaped}" --json --target-org ${org.org}`;
  let result = { records: [], error: null, soql };
  try {
    const { stdout, stderr } = await window.congacode.sfExec(cmd, folder, 60000);
    const parsed = parseSfJson(stdout);
    if (parsed && parsed.status === 0 && parsed.result) {
      result.records = (parsed.result.records || []).map(cleanSObject);
    } else {
      result.error = sfErrorText(parsed, stderr, stdout, 'Query failed');
    }
  } catch (e) {
    result.error = e?.message || String(e);
  }
  return result;
}

/** Read the package namespace from the open folder's sfdx-project.json (cached). */
async function getPackageNamespace() {
  if (debugState._nsResolved) return debugState._namespace;
  debugState._nsResolved = true;
  debugState._namespace = null;
  try {
    const folder = window.state?.folderPath;
    if (folder && window.congacode?.readFile) {
      const txt = await window.congacode.readFile(`${folder}/sfdx-project.json`);
      const j = JSON.parse(txt);
      if (j && j.namespace) debugState._namespace = j.namespace;
    }
  } catch (_) { /* no namespace / not an sfdx project */ }
  return debugState._namespace;
}

/** Prefix unqualified custom (__c/__r/__mdt/…) API names in a SOQL string with the namespace. */
function applyNamespaceToSoql(soql, ns) {
  if (!ns) return soql;
  const nsPrefix = ns.toLowerCase() + '__';
  return soql.replace(/\b(\w+?)__(c|r|mdt|e|b|x|share|history|kav)\b/gi, (full) => {
    if (full.toLowerCase().startsWith(nsPrefix)) return full; // already namespaced
    return ns + '__' + full;
  });
}

/**
 * Resolve a SOQL query's bind variables using the current frame and run it in the org.
 * Scalar binds are inlined from scope; binds not in scope (e.g. static constants like
 * SObjectConstants.LIMIT_ROWS) are resolved by evaluating them in the org.
 * Returns { records, error, soql, unresolved }.
 */
async function evaluateSoqlInOrg(rawQuery, frame) {
  if (!liveOrgAvailable()) return { error: 'Connect an org and enable Live Org first' };
  const scope = { ...(frame?.classFields || {}), ...(frame?.variables || {}) };

  // Strip enclosing [ ] and trailing ; .
  let q = (rawQuery || '').trim();
  const m = q.match(/^\[([\s\S]*)\]\s*;?$/);
  q = (m ? m[1] : q.replace(/^\[/, '').replace(/\]\s*;?$/, '')).trim();

  const binds = [...new Set([...q.matchAll(/:\s*([A-Za-z_]\w*(?:\.\w+)*)/g)].map(x => x[1]))];
  const unresolved = [];
  for (const b of binds) {
    // Detect the SOQL context of the bind: IN/INCLUDES/EXCLUDES expect a
    // collection; comparison operators expect a scalar. This lets us reject
    // placeholder values (e.g. an uninitialised Set logged as `false`).
    const opM = q.match(new RegExp('(\\bIN\\b|\\bINCLUDES\\b|\\bEXCLUDES\\b|<=|>=|!=|<>|=|<|>|\\bLIKE\\b)\\s*:\\s*' + escapeRegex(b) + '\\b', 'i'));
    const collectionCtx = opM ? /^(IN|INCLUDES|EXCLUDES)$/i.test(opM[1]) : false;

    let val = resolveProperty(scope, b);
    if (val === undefined && frame) {
      // Not a local var — could be a static constant / expression. Ask the org.
      const r = await evaluateInOrg(b, frame);
      if (!r.error) val = r.value;
    }
    if (val === undefined) { unresolved.push(b); continue; }
    // A collection bind (IN …) must be an array. A runtime Set/List that hasn't
    // been populated yet is logged as a scalar placeholder — don't inline it.
    if (collectionCtx && !Array.isArray(val)) { unresolved.push(b); continue; }
    const lit = toSoqlLiteral(val);
    if (lit == null) { unresolved.push(b); continue; }
    q = q.replace(new RegExp(':\\s*' + escapeRegex(b) + '\\b', 'g'), lit);
  }
  if (unresolved.length) {
    return { error: `Can't resolve bind variable(s): ${unresolved.join(', ')}. They're runtime collections/objects built inside the method — enable Live Org and use ▶ Run in Org, then step to this line so they're populated (or set a value in the Console, e.g. \`${unresolved[0]} = ['id1','id2']\`).`, soql: q, unresolved };
  }
  const res = await execSoql(q);
  return { ...res, unresolved: [] };
}

/** Refresh the Live Org toggle/status indicator in the debug toolbar. */
function updateLiveOrgIndicator() {
  const checkbox = _$('#dbg-liveorg-checkbox');
  const status = _$('#dbg-liveorg-status');
  const runBtn = _$('#dbg-btn-run-org');
  const org = getActiveOrg();
  const connected = !!(org && org.connected && org.org);
  if (checkbox) {
    checkbox.disabled = !connected;
    checkbox.checked = debugState.liveOrgMode && connected;
  }
  if (runBtn) {
    const canRun = connected && debugState.liveOrgMode && debugState.active && !debugState.orgRunning;
    runBtn.disabled = !canRun;
    runBtn.textContent = debugState.orgRunning ? '⏳ Running…' : '▶ Run in Org';
    runBtn.classList.toggle('active', debugState.liveOrgMode && connected);
  }
  if (status) {
    if (debugState.orgRunning) {
      status.textContent = '⏳ executing in org…';
      status.className = 'dbg-liveorg-status fetching';
    } else if (debugState.orgFetching) {
      status.textContent = '⏳ querying org…';
      status.className = 'dbg-liveorg-status fetching';
    } else if (!connected) {
      status.textContent = 'no org connected';
      status.className = 'dbg-liveorg-status disconnected';
    } else if (debugState.liveOrgMode) {
      status.textContent = `⚡ ${org.org}`;
      status.className = 'dbg-liveorg-status connected';
    } else {
      status.textContent = `${org.org} (simulated)`;
      status.className = 'dbg-liveorg-status idle';
    }
  }
}

/** Toggle Live Org mode from the toolbar checkbox. */
function toggleLiveOrgMode() {
  if (!liveOrgAvailable()) {
    debugState.liveOrgMode = false;
    window.showToast?.('Connect a Salesforce org first (Salesforce panel)', 'warning');
    updateLiveOrgIndicator();
    return;
  }
  debugState.liveOrgMode = !debugState.liveOrgMode;
  debugState.orgQueryCache.clear();
  if (debugState.orgEvalCache) debugState.orgEvalCache.clear();
  updateLiveOrgIndicator();

  if (debugState.liveOrgMode) {
    addConsoleEntry('info', `⚡ Live Org ON — hovering/console now pull real values from "${getActiveOrg().org}" on demand.`);
    // Auto-capture the full picture: replay the entry method once so every line's
    // real values are ready without a separate "Run in Org" click.
    if (debugState.active && !debugState.orgRunning && !debugState.replayMode) {
      addConsoleEntry('info', '↻ Auto-running the method in the org to capture real values for every line…');
      runEntryMethodInOrg();
    }
  } else {
    addConsoleEntry('info', '○ Live Org OFF — values come from the local simulator (org not queried).');
  }
}

/* ================================================================
   ORG REPLAY — execute the entry method against the org (read-only)
   Wrapped in savepoint + rollback so nothing is persisted. Parses the
   returned debug log into "Org Activity" (SOQL, DML, debug, limits).
   ================================================================ */

/** Escape a JS string for embedding inside an Apex single-quoted string literal. */
function escapeApexString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

/** Extract signature info (return type, static flag, params) for a method. */
function getEntrySignature(source, methodName) {
  const lines = source.split('\n');
  const re = new RegExp(
    `((?:public|private|protected|global)\\s+(?:(static)\\s+)?(?:override\\s+)?(?:testMethod\\s+)?([\\w<>\\[\\],.\\s]+?)\\s+${escapeRegex(methodName)}\\s*\\()`,
    'i'
  );
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m && !/\b(class|interface|enum|trigger)\b/i.test(lines[i])) {
      let sigText = '';
      for (let j = i; j < Math.min(i + 6, lines.length); j++) {
        sigText += lines[j] + ' ';
        if (sigText.includes(')')) break;
      }
      const paramsPart = sigText.match(/\(([^)]*)\)/);
      const params = [];
      if (paramsPart && paramsPart[1].trim()) {
        for (const p of paramsPart[1].split(',')) {
          const parts = p.trim().split(/\s+/);
          if (parts.length >= 2) params.push({ type: parts.slice(0, -1).join(' '), name: parts[parts.length - 1] });
        }
      }
      return { returnType: (m[3] || '').trim(), isStatic: !!m[2], params };
    }
  }
  return null;
}

/** Build the anonymous Apex that runs the entry method inside a savepoint/rollback.
 *  NOTE: Apex identifiers may not contain two consecutive underscores, so local
 *  variables use a "ccDbg" camelCase prefix (the __CC_*__ tokens are string markers). */
function buildEntryApex(className, sig, argValues) {
  const argDecls = [];
  const argNames = [];
  (sig.params || []).forEach((p, idx) => {
    const val = argValues[idx];
    const json = (val === undefined) ? 'null' : JSON.stringify(val);
    const varName = `ccDbgA${idx}`;
    argNames.push(varName);
    // Use the declared param type as the deserialize target so typed DOs reconstruct.
    argDecls.push(`    ${p.type} ${varName} = (${p.type}) JSON.deserialize('${escapeApexString(json)}', ${p.type}.class);`);
  });

  const invoker = sig.isStatic
    ? `${className}.${sig.__methodName}(${argNames.join(', ')})`
    : `new ${className}().${sig.__methodName}(${argNames.join(', ')})`;

  const isVoid = /^void$/i.test(sig.returnType || '');
  const callLine = isVoid
    ? `    ${invoker};`
    : `    ccDbgRet = (Object)( ${invoker} );`;

  return [
    `Savepoint ccDbgSp = Database.setSavepoint();`,
    `Object ccDbgRet;`,
    `String ccDbgStatus = 'ok';`,
    `String ccDbgErr = '';`,
    `try {`,
    ...argDecls,
    callLine,
    `} catch (Exception ccDbgE) {`,
    `    ccDbgStatus = 'error';`,
    `    ccDbgErr = ccDbgE.getTypeName() + ': ' + ccDbgE.getMessage() + ' @ ' + ccDbgE.getStackTraceString();`,
    `} finally {`,
    `    try { Database.rollback(ccDbgSp); } catch (Exception ccDbgRe) {}`,
    `}`,
    `String ccDbgOut;`,
    `try { ccDbgOut = JSON.serialize(ccDbgRet); } catch (Exception ccDbgSe) { ccDbgOut = '"<unserializable>"'; }`,
    `System.debug(LoggingLevel.ERROR, '__CC_STATUS__' + ccDbgStatus);`,
    `System.debug(LoggingLevel.ERROR, '__CC_ERR__' + ccDbgErr);`,
    `System.debug(LoggingLevel.ERROR, '__CC_RET__' + ccDbgOut);`,
  ].join('\n');
}

/** Parse a Salesforce Apex debug log into structured Org Activity. */
function parseApexLog(log) {
  const out = { soql: [], dml: [], debug: [], methods: [], limits: {}, exceptions: [], status: null, error: null, returnValue: undefined, returnRaw: null, truncated: false };
  if (!log) return out;
  const lines = log.split('\n');
  let pendingSoql = null;
  for (const raw of lines) {
    const parts = raw.split('|');
    if (parts.length < 2) continue;
    const ev = parts[1];
    const lineNo = (parts[2] && parts[2].match(/\[(\d+)\]/)) ? parseInt(parts[2].match(/\[(\d+)\]/)[1]) : null;
    switch (ev) {
      case 'SOQL_EXECUTE_BEGIN':
        pendingSoql = { line: lineNo, query: parts.slice(4).join('|').trim(), rows: null };
        break;
      case 'SOQL_EXECUTE_END': {
        const rowsM = raw.match(/Rows:(\d+)/);
        if (pendingSoql) { pendingSoql.rows = rowsM ? parseInt(rowsM[1]) : null; out.soql.push(pendingSoql); pendingSoql = null; }
        break;
      }
      case 'DML_BEGIN': {
        const op = (raw.match(/Op:(\w+)/) || [])[1] || '';
        const type = (raw.match(/Type:([\w.]+)/) || [])[1] || '';
        const rows = (raw.match(/Rows:(\d+)/) || [])[1];
        out.dml.push({ line: lineNo, op, type, rows: rows ? parseInt(rows) : null });
        break;
      }
      case 'USER_DEBUG': {
        const msg = parts.slice(4).join('|');
        if (msg.startsWith('__CC_STATUS__')) out.status = msg.slice('__CC_STATUS__'.length);
        else if (msg.startsWith('__CC_ERR__')) out.error = msg.slice('__CC_ERR__'.length) || null;
        else if (msg.startsWith('__CC_RET__')) out.returnRaw = msg.slice('__CC_RET__'.length);
        else out.debug.push({ line: lineNo, msg });
        break;
      }
      case 'METHOD_ENTRY': {
        const name = parts.slice(4).join('|').trim();
        if (name) out.methods.push({ line: lineNo, name });
        break;
      }
      case 'EXCEPTION_THROWN':
      case 'FATAL_ERROR':
        out.exceptions.push({ line: lineNo, msg: parts.slice(2).join('|').trim() });
        break;
      default:
        break;
    }
  }
  // Governor limits (from the cumulative usage block)
  const soqlM = log.match(/Number of SOQL queries:\s*(\d+)\s*out of\s*(\d+)/);
  if (soqlM) out.limits.soql = `${soqlM[1]}/${soqlM[2]}`;
  const dmlM = log.match(/Number of DML statements:\s*(\d+)\s*out of\s*(\d+)/);
  if (dmlM) out.limits.dml = `${dmlM[1]}/${dmlM[2]}`;
  const rowsM = log.match(/Number of query rows:\s*(\d+)\s*out of\s*(\d+)/);
  if (rowsM) out.limits.rows = `${rowsM[1]}/${rowsM[2]}`;
  const cpuM = log.match(/Maximum CPU time:\s*(\d+)\s*out of\s*(\d+)/);
  if (cpuM) out.limits.cpu = `${cpuM[1]}/${cpuM[2]} ms`;
  // Detect a truncated return value
  if (out.returnRaw != null) {
    try { out.returnValue = JSON.parse(out.returnRaw); }
    catch { out.truncated = true; out.returnValue = out.returnRaw; }
  }
  // If our markers never ran (e.g. an uncatchable System.LimitException killed the
  // transaction), surface the fatal error so the panel/console explains the outcome.
  if (out.status == null && out.exceptions.length) {
    out.status = 'error';
    if (!out.error) out.error = out.exceptions[0].msg.replace(/^FATAL_ERROR\|?/, '').trim();
    out.uncatchable = true;
  }
  return out;
}

/** Best-effort: ensure the running user has a FINEST trace flag so the org emits
 *  STATEMENT_EXECUTE + VARIABLE_ASSIGNMENT events (needed for line-by-line replay).
 *  Uses the Tooling API. Trace flags auto-expire; they are debug-logging setup only
 *  and never touch business data. Returns true if a flag is in place. */
async function ensureFinestLogging(orgAlias) {
  const folder = window.state?.folderPath;
  const run = (cmd) => window.congacode.sfExec(cmd, folder, 60000);
  const jparse = (s) => parseSfJson(s);
  try {
    // 1. Resolve the running user's Id.
    const disp = jparse((await run(`sf org display --json --target-org ${orgAlias}`)).stdout);
    const username = disp?.result?.username;
    if (!username) return false;
    const uq = jparse((await run(`sf data query --json --target-org ${orgAlias} -q "SELECT Id FROM User WHERE Username = '${username}'"`)).stdout);
    const userId = uq?.result?.records?.[0]?.Id;
    if (!userId) return false;

    // 2. Find or create a FINEST DebugLevel. ApexCode=FINEST is what emits the
    //    STATEMENT_EXECUTE + VARIABLE_ASSIGNMENT events the replay engine needs.
    let dlId;
    const dlq = jparse((await run(`sf data query --use-tooling-api --json --target-org ${orgAlias} -q "SELECT Id FROM DebugLevel WHERE DeveloperName = 'CongaCodeFinest'"`)).stdout);
    dlId = dlq?.result?.records?.[0]?.Id;
    if (!dlId) {
      const created = jparse((await run(`sf data create record --use-tooling-api --sobject DebugLevel --target-org ${orgAlias} --json --values "DeveloperName=CongaCodeFinest MasterLabel=CongaCodeFinest ApexCode=FINEST ApexProfiling=NONE Callout=NONE Database=FINEST System=FINE Validation=NONE Visualforce=NONE Workflow=NONE"`)).stdout);
      dlId = created?.result?.id;
    } else {
      // Ensure a pre-existing level is really at FINEST (it may have been created
      // wrong in an earlier build), otherwise the log won't contain step detail.
      await run(`sf data update record --use-tooling-api --sobject DebugLevel --record-id ${dlId} --target-org ${orgAlias} --json --values "ApexCode=FINEST Database=FINEST System=FINE"`);
    }
    if (!dlId) return false;

    // 3. Replace any existing developer-log trace flags for this user with a fresh 1h one.
    const tfq = jparse((await run(`sf data query --use-tooling-api --json --target-org ${orgAlias} -q "SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'DEVELOPER_LOG'"`)).stdout);
    for (const tf of (tfq?.result?.records || [])) {
      await run(`sf data delete record --use-tooling-api --sobject TraceFlag --record-id ${tf.Id} --target-org ${orgAlias} --json`);
    }
    const now = new Date();
    const start = now.toISOString();
    const exp = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const created = jparse((await run(`sf data create record --use-tooling-api --sobject TraceFlag --target-org ${orgAlias} --json --values "TracedEntityId=${userId} DebugLevelId=${dlId} LogType=DEVELOPER_LOG StartDate=${start} ExpirationDate=${exp}"`)).stdout);
    return !!(created?.result?.id);
  } catch { return false; }
}

/** Fetch the most recent Apex debug log body from the org (used to get FINEST detail). */
async function fetchLatestApexLog(orgAlias) {
  const folder = window.state?.folderPath;
  const run = (cmd) => window.congacode.sfExec(cmd, folder, 60000);
  try {
    const list = parseSfJson((await run(`sf apex log list --json --target-org ${orgAlias}`)).stdout);
    const recs = list?.result || [];
    if (!recs.length) return null;
    recs.sort((a, b) => new Date(b.StartTime || 0) - new Date(a.StartTime || 0));
    const id = recs[0].Id || recs[0].id;
    if (!id) return null;
    const got = parseSfJson((await run(`sf apex log get --log-id ${id} --json --target-org ${orgAlias}`)).stdout);
    const r = got?.result;
    if (Array.isArray(r)) return r[0]?.log || null;
    if (typeof r === 'string') return r;
    return r?.log || null;
  } catch { return null; }
}

/** Execute the entry method against the connected org (read-only) and show activity. */
async function runEntryMethodInOrg() {
  if (!debugState.active) { window.showToast?.('Start a debug session first', 'warning'); return; }
  if (!liveOrgAvailable()) { window.showToast?.('Enable Live Org and connect an org first', 'warning'); return; }
  if (debugState.orgRunning) return;

  const filePath = debugState.entryFile;
  const methodName = debugState.entryMethod;
  const org = getActiveOrg();
  const source = await window.congacode.readFile(filePath);
  if (!source) { window.showToast?.('Could not read entry file', 'error'); return; }

  const sig = getEntrySignature(source, methodName);
  if (!sig) { window.showToast?.(`Could not parse signature for ${methodName}`, 'error'); return; }
  sig.__methodName = methodName;

  const className = filePath.split('/').pop().replace(/\.(cls|trigger)$/, '');
  const argValues = (debugState.parsedRequest?.params) || [];

  // Warn if the method appears to make callouts (can't be rolled back)
  if (/\b(HttpRequest|Http\s*\(|\.send\s*\(|WebServiceCallout|Messaging\.sendEmail)\b/.test(source)) {
    addConsoleEntry('info', '⚠ Entry class references callouts/email — those side effects cannot be rolled back.');
  }

  const apex = buildEntryApex(className, sig, argValues);

  debugState.orgRunning = true;
  updateLiveOrgIndicator();
  renderOrgActivityPanel();
  switchToOrgTab();
  addConsoleEntry('info', `▶ Running ${className}.${methodName}() in org "${org.org}" (savepoint + rollback)…`);

  // Ensure the org emits FINEST logs so replay can reconstruct real variable values.
  addConsoleEntry('info', '⚙ Enabling FINEST Apex logging (temporary 1h trace flag, debug-only)…');
  const finestOn = await ensureFinestLogging(org.org);
  if (!finestOn) addConsoleEntry('info', '⚠ Could not auto-enable FINEST logging (needs "View/Manage All Data" or Tooling access). Stepping may lack variable values.');

  try {
    const paths = await window.congacode.getPaths?.();
    const dir = paths?.congacodeDir || paths?.home || '.';
    const tmpFile = `${dir}/.cc_debug_run.apex`;
    await window.congacode.writeFile(tmpFile, apex);

    const cmd = `sf apex run --file "${tmpFile}" --json --target-org ${org.org}`;
    const { stdout, stderr } = await window.congacode.sfExec(cmd, window.state?.folderPath, 180000);

    let cli = parseSfJson(stdout);
    if (!cli) {
      debugState.orgActivity = { error: (stderr || stdout || 'No response from sf CLI').split('\n').slice(0, 5).join('\n') };
      addConsoleEntry('error', `sf CLI returned non-JSON. stdout(${(stdout||'').length}b): ${(stdout||'').slice(0,300)} | stderr: ${(stderr||'').slice(0,300)}`);
    } else {
      // On success the payload is under result; on compile failure it's under data.
      const res = cli.result || cli.data || {};
      const rawLog = res.logs || '';
      // Diagnostics — surface exactly what the org returned.
      addConsoleEntry('info', `sf apex run: success=${res.success} compiled=${res.compiled} logLen=${rawLog.length}b${res.compileProblem ? ' compileProblem=' + res.compileProblem : ''}${res.exceptionMessage ? ' exception=' + res.exceptionMessage : ''}`);
      if (res.compiled === false && res.compileProblem) {
        addConsoleEntry('error', `Compile failed (line ${res.line}): ${res.compileProblem}`);
      }
      const parsed = parseApexLog(rawLog);
      parsed.compiled = res.compiled;
      parsed.success = res.success;
      parsed.compileProblem = res.compileProblem || (cli.name === 'executeCompileFailure' ? (cli.message || 'Compilation failed') : null);
      parsed.exceptionMessage = res.exceptionMessage || null;
      parsed.rawLog = rawLog;
      if (!parsed.error && res.exceptionMessage) parsed.error = res.exceptionMessage;
      if (!parsed.error && parsed.compileProblem) { parsed.error = parsed.compileProblem; parsed.status = 'error'; }
      parsed.org = org.org;
      parsed.entry = `${className}.${methodName}`;
      debugState.orgActivity = parsed;

      // Surface the real return value into the console
      if (parsed.returnValue !== undefined && parsed.status !== 'error') {
        addConsoleEntry('info', `✓ Returned from org: ${formatValue(parsed.returnValue)}${parsed.truncated ? ' (log-truncated)' : ''}`);
      } else if (parsed.error) {
        addConsoleEntry('error', `Org execution error: ${parsed.error.split('@')[0]}`);
      }
      addConsoleEntry('info', `↩ Rolled back — org "${org.org}" was not modified. SOQL: ${parsed.soql.length}, DML: ${parsed.dml.length} (simulated/rolled back).`);

      // Stage 2: build a step-by-step replay timeline from the debug log.
      if (parsed.status !== 'error' || (res.logs && res.logs.length)) {
        try {
          const classIndex = await buildClassIndex();
          let logForReplay = res.logs || '';
          let timeline = buildReplayTimeline(logForReplay, classIndex);

          // The inline `sf apex run` log is frequently empty or truncated, so the
          // authoritative source is the full ApexLog recorded on the server. When
          // FINEST is on, always fetch it and use whichever reconstructs MORE steps.
          if (finestOn && (!timeline.hasDetail || !timeline.steps.length || (res.logs || '').length < 4000)) {
            addConsoleEntry('info', '⏳ Fetching the full recorded FINEST log from the org…');
            const full = await fetchLatestApexLog(org.org);
            if (full && full.length) {
              const fullTimeline = buildReplayTimeline(full, classIndex);
              if (fullTimeline.steps.length >= timeline.steps.length) {
                logForReplay = full;
                timeline = fullTimeline;
              }
            }
          }
          if (timeline.steps.length && timeline.hasDetail) {
            addConsoleEntry('info', `🎬 Reconstructed ${timeline.steps.length} steps from the org log.`);
            enterReplayMode(timeline);
          } else if (!finestOn) {
            addConsoleEntry('error', '⚠ FINEST logging is not enabled for the running user, so the real execution can\'t be reconstructed. It needs the "View All Data"/Tooling permission to auto-enable, or set the running user\'s Apex debug level to FINEST (ApexCode=FINEST) in Setup → Debug Logs, then Restart.');
          } else if (logForReplay) {
            addConsoleEntry('info', `⚠ The org log came back without step detail (${logForReplay.length}b). Replay needs STATEMENT_EXECUTE + VARIABLE_ASSIGNMENT (ApexCode=FINEST). Confirm the CongaCodeFinest debug level is FINEST and Restart.`);
          } else {
            addConsoleEntry('info', '⚠ The org returned an empty log. If the method compiled, enable FINEST for the running user and Restart.');
          }
        } catch (re) {
          addConsoleEntry('error', `Replay build failed: ${re?.message || re}`);
        }
      }
    }
  } catch (e) {
    debugState.orgActivity = { error: e?.message || String(e) };
    addConsoleEntry('error', `Run in Org failed: ${e?.message || e}`);
  } finally {
    debugState.orgRunning = false;
    updateLiveOrgIndicator();
    renderOrgActivityPanel();
  }
}

/** Switch the debug bottom panel to the Org Activity tab. */
function switchToOrgTab() {
  const tab = _$('#debug-panel .dbg-panel-tab[data-tab="dbg-orgactivity"]');
  if (tab) tab.click();
}

/** Render the Org Activity panel from debugState.orgActivity. */
function renderOrgActivityPanel() {
  const container = _$('#dbg-orgactivity-body');
  if (!container) return;

  if (debugState.orgRunning) {
    container.innerHTML = '<div class="dbg-org-loader"><span class="dbg-spinner"></span> Executing in org… fetching real data (this can take a moment).</div>';
    return;
  }

  const a = debugState.orgActivity;
  if (!a) {
    container.innerHTML = '<div class="dbg-empty">Enable ⚡ Live Org and click "Run in Org" to execute the entry method against the connected org (read-only — changes are rolled back).</div>';
    return;
  }
  if (a.error && !a.entry) {
    container.innerHTML = `<div class="dbg-org-error">✕ ${_esc(a.error)}</div>`;
    return;
  }

  let html = '';
  html += `<div class="dbg-org-summary">`;
  html += `<div class="dbg-org-head">⚡ ${_esc(a.entry || '')} <span class="dbg-org-org">@ ${_esc(a.org || '')}</span></div>`;
  if (a.compileProblem) html += `<div class="dbg-org-error">Compile error: ${_esc(a.compileProblem)}</div>`;
  if (a.status === 'error' || (a.error && a.entry)) html += `<div class="dbg-org-error">Runtime error: ${_esc((a.error || a.exceptionMessage || '').split('@')[0])}</div>`;
  html += `<div class="dbg-org-badges">`;
  html += `<span class="dbg-org-badge">SOQL ${a.soql?.length || 0}</span>`;
  html += `<span class="dbg-org-badge">DML ${a.dml?.length || 0}</span>`;
  html += `<span class="dbg-org-badge">Debug ${a.debug?.length || 0}</span>`;
  if (a.limits?.soql) html += `<span class="dbg-org-badge muted">Queries ${_esc(a.limits.soql)}</span>`;
  if (a.limits?.cpu) html += `<span class="dbg-org-badge muted">CPU ${_esc(a.limits.cpu)}</span>`;
  html += `</div>`;
  html += `<div class="dbg-org-note">↩ Executed in a savepoint and rolled back — the org was not modified.</div>`;
  html += `</div>`;

  // Diagnostics — when nothing was parsed, show the raw log so we can see why.
  const nothingParsed = !(a.soql?.length) && !(a.dml?.length) && !(a.debug?.length) && a.returnValue === undefined;
  if (nothingParsed && a.rawLog != null) {
    const raw = a.rawLog;
    html += `<div class="dbg-org-section"><div class="dbg-org-title">Raw org log (${raw.length} bytes) — no SOQL/DML/debug/return parsed</div>`;
    html += raw.length
      ? `<pre class="dbg-org-json" style="max-height:320px;overflow:auto">${_esc(raw.slice(0, 6000))}${raw.length > 6000 ? '\n… (truncated)' : ''}</pre>`
      : `<div class="dbg-org-note">The org returned an empty log. The anonymous Apex may have failed to compile (check the request param types) or the debug level is NONE. Enable FINEST for the running user, or paste this panel's console diagnostics.</div>`;
    html += `</div>`;
  }

  // Return value
  if (a.returnValue !== undefined) {
    html += `<div class="dbg-org-section"><div class="dbg-org-title">Return value${a.truncated ? ' (log-truncated)' : ''}</div>`;
    html += `<pre class="dbg-org-json">${_esc(typeof a.returnValue === 'string' ? a.returnValue : JSON.stringify(a.returnValue, null, 2))}</pre></div>`;
  }

  // SOQL
  if (a.soql?.length) {
    html += `<div class="dbg-org-section"><div class="dbg-org-title">SOQL queries (${a.soql.length})</div>`;
    for (const q of a.soql) {
      html += `<div class="dbg-org-row"><span class="dbg-org-rows">${q.rows != null ? q.rows + ' rows' : ''}</span><code>${_esc(q.query)}</code></div>`;
    }
    html += `</div>`;
  }

  // DML
  if (a.dml?.length) {
    html += `<div class="dbg-org-section"><div class="dbg-org-title">DML (${a.dml.length}) — rolled back</div>`;
    for (const d of a.dml) {
      html += `<div class="dbg-org-row"><span class="dbg-org-dml">${_esc(d.op)}</span> <code>${_esc(d.type)}</code> <span class="dbg-org-rows">${d.rows != null ? d.rows + ' rows' : ''}</span></div>`;
    }
    html += `</div>`;
  }

  // Debug lines
  if (a.debug?.length) {
    html += `<div class="dbg-org-section"><div class="dbg-org-title">System.debug (${a.debug.length})</div>`;
    for (const d of a.debug.slice(0, 200)) {
      html += `<div class="dbg-org-row"><span class="dbg-org-line">L${d.line ?? '?'}</span> <span>${_esc(d.msg)}</span></div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;
}

/* ================================================================
   REPLAY ENGINE — reconstruct a step-by-step timeline from the
   org's Apex debug log, with real variable values at every line.
   ================================================================ */

/** Parse a debug-log value token into a JS value (objects, refs, primitives). */
function parseLogValue(raw, addrMap) {
  if (raw === undefined || raw === null) return null;
  let v = String(raw).trim();
  if (v === '') return '';
  if (/^0x[0-9a-fA-F]+$/.test(v)) return addrMap.has(v) ? addrMap.get(v) : `→ ${v}`;
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try { return JSON.parse(v); } catch { /* fallthrough */ }
  }
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  return v; // raw string (e.g. a Datetime like "2024-01-01 10:00:00")
}

/** Regex for a heap-address string as stored by parseLogValue (bare or "→ 0x..."). */
const ADDR_RE = /^(?:→ )?(0x[0-9a-fA-F]+)$/;

/**
 * Recursively replace heap-address placeholder strings with their real objects
 * from addrMap. Uses memoization + a seen-set so shared/cyclic references are
 * handled once and cheaply (the timeline shares nested object references across
 * many shallow frame snapshots).
 */
function resolveAddresses(value, addrMap, seen, memo, depth) {
  if (depth > 24) return value;
  if (typeof value === 'string') {
    const m = value.match(ADDR_RE);
    if (m && addrMap.has(m[1])) {
      return resolveAddresses(addrMap.get(m[1]), addrMap, seen, memo, depth + 1);
    }
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (memo.has(value)) return memo.get(value);
  if (seen.has(value)) return value; // cycle guard
  seen.add(value);
  memo.set(value, value); // resolve in place so shared refs update everywhere
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = resolveAddresses(value[i], addrMap, seen, memo, depth + 1);
    }
  } else {
    for (const k of Object.keys(value)) {
      value[k] = resolveAddresses(value[k], addrMap, seen, memo, depth + 1);
    }
  }
  seen.delete(value);
  return value;
}

/**
 * Build a replay timeline from an Apex debug log.
 * Requires the log to contain STATEMENT_EXECUTE + VARIABLE_ASSIGNMENT (FINEST).
 * @returns { steps: [...], returnRaw, hasDetail }
 */
function buildReplayTimeline(log, classIndex) {
  const result = { steps: [], returnRaw: null, hasDetail: false, fatalError: null };
  if (!log) return result;
  const clsIdx = classIndex || {};
  const lines = log.split('\n');
  const stack = [];        // frames: { className, methodName, file, line, variables, classFields }
  const addrMap = new Map();

  const top = () => stack[stack.length - 1];
  const resolveFile = (cls) => cls ? (clsIdx[cls] || clsIdx[cls.toLowerCase()] || null) : null;

  // Resolve a qualified Apex name (possibly namespaced) to { className, methodName, file }.
  // Handles: "Ns.Class.method(args)", "Class.method", "Ns.Outer.Inner.method",
  //          constructors "Ns.Class.Class()". Namespace segments won't resolve to a
  //          file, so we scan the class path L→R and pick the first segment that maps
  //          to a workspace file (that's the top-level class the code lives in).
  const resolveQualified = (qname) => {
    const beforeParen = String(qname).split('(')[0].trim();
    const segs = beforeParen.split('.').filter(Boolean);
    const methodName = segs.length ? segs[segs.length - 1] : qname;
    const classSegs = segs.slice(0, -1);
    let file = null, className = classSegs[classSegs.length - 1] || methodName;
    for (const s of classSegs) { const f = resolveFile(s); if (f) { file = f; className = s; break; } }
    return { className, methodName, file };
  };

  // Shallow snapshot: variable VALUES are replaced (never mutated) on reassignment,
  // so a shallow copy of each frame's maps preserves history cheaply (no deep clone).
  const snapshot = (lineNo) => {
    if (!stack.length) return;
    const t = top();
    if (lineNo != null) t.line = lineNo;
    if (!t.file) return; // no source to show — skip (steps focus on user's files)
    const frames = stack.map(f => ({
      className: f.className,
      methodName: f.methodName,
      file: f.file,
      line: f.line,
      variables: { ...(f.variables || {}) },
      classFields: { ...(f.classFields || {}) },
      statements: [{ line: f.line }],
      pc: 0,
    }));
    result.steps.push({ file: t.file, line: t.line, depth: stack.length });
    result.steps[result.steps.length - 1].frames = frames;
  };

  for (const raw of lines) {
    const parts = raw.split('|');
    if (parts.length < 2) continue;
    const ev = parts[1];
    const lineNo = (parts[2] && /\[(\d+)\]/.test(parts[2])) ? parseInt(parts[2].match(/\[(\d+)\]/)[1], 10) : null;

    switch (ev) {
      case 'METHOD_ENTRY': {
        // parts: ts|METHOD_ENTRY|[line]|id|Ns.Class.method(args)
        const qname = parts.slice(4).join('|').trim() || parts.slice(3).join('|').trim();
        const r = resolveQualified(qname);
        stack.push({ className: r.className, methodName: r.methodName, file: r.file, line: lineNo || 0, variables: {}, classFields: {} });
        break;
      }
      case 'CONSTRUCTOR_ENTRY': {
        // parts: ts|CONSTRUCTOR_ENTRY|[line]|id|<init>(args)|Ns.Class
        const typeName = (parts[5] || parts[4] || '').trim();
        const r = resolveQualified(typeName + '.<init>');
        stack.push({ className: r.className, methodName: r.className, file: r.file, line: lineNo || 0, variables: {}, classFields: {} });
        break;
      }
      case 'METHOD_EXIT':
      case 'CONSTRUCTOR_EXIT':
        if (stack.length) stack.pop();
        break;
      case 'VARIABLE_SCOPE_BEGIN': {
        // ts|VARIABLE_SCOPE_BEGIN|[line]|name|type|...
        const name = parts[3];
        if (top() && name && !name.includes('.') && !(name in top().variables)) top().variables[name] = null;
        break;
      }
      case 'VARIABLE_ASSIGNMENT': {
        result.hasDetail = true;
        const name = parts[3];
        // value = fields after name, minus a trailing 0x address if present
        let addr = null;
        let valParts = parts.slice(4);
        if (valParts.length && /^0x[0-9a-fA-F]+$/.test(valParts[valParts.length - 1])) {
          addr = valParts[valParts.length - 1];
          valParts = valParts.slice(0, -1);
        }
        const val = parseLogValue(valParts.join('|'), addrMap);
        if (top() && name) {
          if (name.includes('.')) {
            // Qualified name → a class static/instance field. Store under short name.
            const short = name.split('.').pop();
            top().classFields[short] = val;
          } else {
            top().variables[name] = val;
          }
          if (addr && val && typeof val === 'object') addrMap.set(addr, val);
        }
        break;
      }
      case 'STATEMENT_EXECUTE':
        result.hasDetail = true;
        snapshot(lineNo);
        break;
      case 'USER_DEBUG': {
        const msg = parts.slice(4).join('|');
        if (msg.startsWith('__CC_RET__')) result.returnRaw = msg.slice('__CC_RET__'.length);
        break;
      }
      case 'FATAL_ERROR':
        if (!result.fatalError) result.fatalError = parts.slice(2).join('|').trim();
        break;
      default:
        break;
    }
  }

  // Final pass: now that addrMap is fully populated, resolve heap-address
  // placeholders (e.g. request.lineItems = "0x43f5d50") into their real objects.
  // Object references are shared across shallow frame snapshots, so a single
  // memoized walk resolves them everywhere at once.
  if (result.steps.length) {
    const memo = new Map();
    const seen = new Set();
    for (const step of result.steps) {
      for (const f of step.frames) {
        for (const k of Object.keys(f.variables)) {
          f.variables[k] = resolveAddresses(f.variables[k], addrMap, seen, memo, 0);
        }
        for (const k of Object.keys(f.classFields)) {
          f.classFields[k] = resolveAddresses(f.classFields[k], addrMap, seen, memo, 0);
        }
      }
    }
  }
  return result;
}

/** Enter replay mode using a built timeline. */
function enterReplayMode(timeline) {
  if (!timeline.steps.length) return false;
  debugState.replayMode = true;
  debugState.replayTimeline = timeline.steps;
  debugState.replayIndex = 0;
  debugState.replayFatalError = timeline.fatalError || null;
  debugState.active = true;
  debugState.paused = true;
  addConsoleEntry('info', `🎬 Replay mode — stepping ${timeline.steps.length} recorded statements with real org values. Use Step/Continue.`);
  if (timeline.fatalError) {
    addConsoleEntry('error', `⚠ Execution ended with an uncatchable error: ${timeline.fatalError.split('\n')[0]}. You can still step through everything up to that point.`);
  }
  replayGoto(0);
  return true;
}

/** Move the replay cursor to a specific step and refresh the UI. */
async function replayGoto(index) {
  const steps = debugState.replayTimeline;
  if (!steps.length) return;
  index = Math.max(0, Math.min(index, steps.length - 1));
  debugState.replayIndex = index;
  const step = steps[index];
  debugState.callStack = step.frames;
  debugState.currentFile = step.file;
  debugState.currentLine = step.line;
  if (step.file) {
    await navigateToFile(step.file, step.line);
    highlightCurrentLine();
  }
  updateDebugPanels();
}

/** True if a step's file+line has an active breakpoint. */
function stepHasBreakpoint(step) {
  if (!step || !step.file) return false;
  const bps = debugState.breakpoints.get(step.file);
  return !!(bps && bps.has(step.line));
}

/** Advance the replay cursor forward to the first step matching a predicate. */
async function replayAdvance(predicate, stopAtBreakpoints) {
  const steps = debugState.replayTimeline;
  let i = debugState.replayIndex + 1;
  for (; i < steps.length; i++) {
    if (stopAtBreakpoints && stepHasBreakpoint(steps[i])) break;
    if (predicate(steps[i])) break;
  }
  if (i >= steps.length) {
    await replayGoto(steps.length - 1);
    if (debugState.replayFatalError) {
      addConsoleEntry('error', `■ Execution stopped here — ${debugState.replayFatalError.split('\n')[0]}`);
    } else {
      addConsoleEntry('info', '✓ End of recorded execution reached.');
    }
    if (debugState.orgActivity?.returnValue !== undefined) {
      addConsoleEntry('info', `return → ${formatValue(debugState.orgActivity.returnValue)}`);
    }
    return;
  }
  await replayGoto(i);
}

async function replayStepInto() { await replayAdvance(() => true, true); }
async function replayContinue() { await replayAdvance(() => false, true); }
async function replayStepOver() {
  const depth = debugState.replayTimeline[debugState.replayIndex]?.depth ?? 1;
  await replayAdvance((s) => s.depth <= depth, true);
}
async function replayStepOut() {
  const depth = debugState.replayTimeline[debugState.replayIndex]?.depth ?? 1;
  await replayAdvance((s) => s.depth < depth, true);
}

/**
 * Whether a branch/condition expression should be resolved against the org.
 * True when Live Org is on and the local guess is unreliable — i.e. the value
 * is null/undefined, or the expression contains a method call whose result the
 * local simulator can't compute (e.g. SystemUtil.isFieldExpressionEnabled()).
 */
function conditionNeedsOrg(expr, localVal) {
  if (!(debugState.liveOrgMode && liveOrgAvailable())) return false;
  if (localVal === undefined || localVal === null) return true;
  return /[A-Za-z_][\w.]*\s*\(/.test(String(expr || ''));
}

/**
 * Resolve a boolean branch condition, preferring the REAL org value when the
 * local simulator can't compute it. This makes `if`/`while`/ternaries honour
 * true/false exactly like the running org (Chrome-style), not a guess.
 */
async function resolveBranchCondition(expr, scope, frame, line) {
  const local = evaluateExpression(expr, scope);
  if (frame && conditionNeedsOrg(expr, local)) {
    debugState.orgFetching = true; updateLiveOrgIndicator();
    try {
      const r = await evaluateInOrg(expr, frame);
      if (!r.error && r.value != null) {
        const b = typeof r.value === 'boolean' ? r.value : !!r.value;
        addConsoleEntry('branch', `↳ ${expr} → ${b} (real org value)`, line);
        return b;
      }
      if (r.error) addConsoleEntry('info', `↳ couldn't resolve "${expr}" in org (${r.error.split('\n')[0]}); using local value ${!!local}`, line);
    } catch (e) {
      addConsoleEntry('info', `↳ org eval failed for "${expr}": ${e?.message || e}`, line);
    } finally {
      debugState.orgFetching = false; updateLiveOrgIndicator();
    }
  }
  return !!local;
}

/**
 * Resolve a loop's collection, preferring REAL org data when the local value is
 * empty/unknown, so `for (x : coll)` iterates the true number of times.
 */
async function resolveLoopCollection(expr, scope, frame, line) {
  const local = evaluateExpression(expr, scope);
  const localArr = Array.isArray(local)
    ? local
    : (local && typeof local === 'object' ? Object.values(local) : null);
  if ((!localArr || localArr.length === 0) && frame && debugState.liveOrgMode && liveOrgAvailable()) {
    debugState.orgFetching = true; updateLiveOrgIndicator();
    try {
      const r = await evaluateInOrg(expr, frame);
      if (!r.error && Array.isArray(r.value)) {
        addConsoleEntry('loop', `↳ ${expr} → ${r.value.length} item(s) (real org value)`, line);
        return r.value;
      }
    } catch (_) { /* fall back to local */ }
    finally { debugState.orgFetching = false; updateLiveOrgIndicator(); }
  }
  return localArr || [];
}

/**
 * Execute the current statement and advance the program counter.
 * Returns true if execution should pause (breakpoint, step, or end of method).
 */
async function executeCurrentStatement() {
  const frame = debugState.callStack[debugState.callStack.length - 1];
  if (!frame || frame.pc >= frame.statements.length) {
    // End of method — pop frame
    if (debugState.callStack.length > 1) {
      const returnedFrame = debugState.callStack.pop();
      addConsoleEntry('nav', `↩ Returned from ${returnedFrame.className}.${returnedFrame.methodName}()`);
      const parentFrame = debugState.callStack[debugState.callStack.length - 1];
      parentFrame.pc++;
      debugState.currentFile = parentFrame.file;
      debugState.currentLine = parentFrame.statements[parentFrame.pc]?.line || parentFrame.line;
      await navigateToFile(parentFrame.file, debugState.currentLine);
      updateDebugPanels();
      return true;
    } else {
      // Top-level method finished
      addConsoleEntry('info', '✓ Method execution completed');
      stopDebugSession();
      return true;
    }
  }

  const stmt = frame.statements[frame.pc];
  debugState.currentLine = stmt.line;
  debugState.currentFile = frame.file;

  // Build merged scope: local variables + class fields (local takes priority)
  const scope = { ...(frame.classFields || {}), ...frame.variables };

  // Execute based on statement type
  switch (stmt.type) {
    case 'declaration':
      if (stmt._directValue !== undefined) {
        frame.variables[stmt.varName] = JSON.parse(JSON.stringify(stmt._directValue));
      } else if (stmt._defaultVal !== undefined && stmt.expression === null) {
        // Declaration without initialization — use type-appropriate default
        const dv = stmt._defaultVal;
        frame.variables[stmt.varName] = dv === '[]' ? [] : dv === '{}' ? {} : dv;
      } else {
        let declVal = evaluateExpression(stmt.expression, scope);
        // If the initializer couldn't be resolved locally, seed a type-appropriate
        // empty value (List->[], Map->{}, numeric->0, Boolean->false) from the
        // declared type instead of leaving it undefined/null.
        if (declVal === undefined) declVal = defaultForApexType(stmt.varType);
        frame.variables[stmt.varName] = declVal;
      }
      // Remember the declared Apex type so hover can label it (e.g. List<LineItem__c>).
      if (stmt.varType) (frame.varTypes || (frame.varTypes = {}))[stmt.varName] = stmt.varType;
      addConsoleEntry('var', `${stmt.varName} = ${formatValue(frame.variables[stmt.varName])}`, stmt.line);
      frame.pc++;
      break;

    case 'assignment':
      if (stmt._directValue !== undefined) {
        assignProperty(frame.variables, stmt.varName, JSON.parse(JSON.stringify(stmt._directValue)));
        // Loop-variable binding → advance the iteration counter so hover/panels
        // show which element (i of n) is currently bound.
        if (stmt._loopVar) {
          frame._iter = frame._iter || {};
          frame._iter[stmt._loopVar] = { index: stmt._loopIndex, total: stmt._loopTotal, collection: stmt._loopCollection, elemType: stmt._loopElemType };
        }
      } else {
        const assignVal = evaluateExpression(stmt.expression, scope);
        // Handle this.field assignment → goes to classFields
        if (stmt.varName.startsWith('this.') && frame.classFields) {
          const fieldName = stmt.varName.substring(5);
          assignProperty(frame.classFields, fieldName, assignVal);
        } else if (frame.classFields && stmt.varName in frame.classFields && !(stmt.varName in frame.variables)) {
          // Class field assignment (no this. prefix)
          frame.classFields[stmt.varName] = assignVal;
        } else {
          assignProperty(frame.variables, stmt.varName, assignVal);
        }
      }
      addConsoleEntry('var', `${stmt.varName} = ${formatValue(resolveProperty(scope, stmt.varName))}`, stmt.line);
      frame.pc++;
      break;

    case 'conditional': {
      const condResult = await resolveBranchCondition(stmt.condition, scope, frame, stmt.line);
      addConsoleEntry('branch', `if (${stmt.condition}) → ${condResult ? 'true' : 'false'}`, stmt.line);
      if (condResult && stmt.thenBlock.length > 0) {
        // Insert then-block statements at current position
        frame.statements.splice(frame.pc + 1, 0, ...stmt.thenBlock);
      } else if (!condResult && stmt.elseBlock.length > 0) {
        frame.statements.splice(frame.pc + 1, 0, ...stmt.elseBlock);
      }
      frame.pc++;
      break;
    }

    case 'throw': {
      const throwVal = evaluateExpression(stmt.expression, scope);
      addConsoleEntry('error', `throw ${stmt.expression} → ${formatValue(throwVal)}`, stmt.line);
      // Look for a try-catch in the current frame
      // For now, stop execution (like an unhandled exception)
      if (debugState.callStack.length > 1) {
        const thrown = debugState.callStack.pop();
        addConsoleEntry('error', `Exception in ${thrown.className}.${thrown.methodName}()`);
        const parentFrame = debugState.callStack[debugState.callStack.length - 1];
        parentFrame.pc++;
        debugState.currentFile = parentFrame.file;
        debugState.currentLine = parentFrame.statements[parentFrame.pc]?.line || parentFrame.line;
        await navigateToFile(parentFrame.file, debugState.currentLine);
        updateDebugPanels();
        return true;
      } else {
        addConsoleEntry('error', `Unhandled exception: ${formatValue(throwVal)}`);
        stopDebugSession();
        return true;
      }
    }

    case 'switch': {
      const switchVal = evaluateExpression(stmt.switchExpr, scope);
      addConsoleEntry('branch', `switch on ${stmt.switchExpr} → ${formatValue(switchVal)}`, stmt.line);
      let matched = false;
      let elseCase = null;
      for (const wCase of stmt.whenCases) {
        if (wCase.value === 'else') {
          elseCase = wCase;
          continue;
        }
        // when value can be comma-separated: when 'A', 'B'
        const whenValues = splitArgs(wCase.value).map(v => {
          const trimV = v.trim();
          // Handle SObject type matching: when Account a, Contact c
          if (/^\w+\s+\w+$/.test(trimV)) return trimV.split(/\s+/)[0];
          return evaluateExpression(trimV, scope);
        });
        if (whenValues.some(wv => wv == switchVal || wv === String(switchVal))) {
          addConsoleEntry('branch', `when ${wCase.value} → matched`, wCase.line);
          frame.statements.splice(frame.pc + 1, 0, ...wCase.body);
          matched = true;
          break;
        }
      }
      if (!matched && elseCase) {
        addConsoleEntry('branch', `when else`, elseCase.line);
        frame.statements.splice(frame.pc + 1, 0, ...elseCase.body);
      }
      frame.pc++;
      break;
    }

    case 'loop': {
      if (stmt.loopType === 'for') {
        const forEachMatch = stmt.loopExpr?.match(/^\s*([\w<>\[\],.\s]+)\s+(\w+)\s*:\s*(.+)$/);
        if (forEachMatch) {
          const iterVar = forEachMatch[2];
          const collectionExpr = forEachMatch[3].trim();
          // Track the loop variable's declared element type (e.g. RemoteCPQ.LineItemDO)
          // so hover can resolve instance-method calls on it.
          const elemType = forEachMatch[1] ? forEachMatch[1].trim() : null;
          if (elemType) (frame.varTypes || (frame.varTypes = {}))[iterVar] = elemType;
          const items = await resolveLoopCollection(collectionExpr, scope, frame, stmt.line);
          addConsoleEntry('loop', `for (${iterVar} : ${collectionExpr}) — ${items.length} iteration(s)`, stmt.line);
          // Record iteration metadata so hover/panels can show "iteration i of n"
          // and clearly distinguish the single ELEMENT (lineItemDO) from the
          // COLLECTION (lineItemDOs) — important when the list has only 1 item.
          frame._iter = frame._iter || {};
          frame._iter[iterVar] = { index: items.length ? 0 : -1, total: items.length, collection: collectionExpr, elemType };
          // Preview-bind the loop variable to the first element the instant we
          // reach the `for` line (V8/DevTools-style), so hovering the header shows
          // one element — never the whole collection.
          if (items.length) frame.variables[iterVar] = JSON.parse(JSON.stringify(items[0]));
          // Unroll loop: insert body for each item
          const expanded = [];
          items.forEach((item, idx) => {
            expanded.push({ line: stmt.line, type: 'assignment', raw: `${iterVar} = [loop item ${idx + 1}/${items.length}]`, varName: iterVar, _directValue: item, _loopVar: iterVar, _loopIndex: idx, _loopTotal: items.length, _loopCollection: collectionExpr, _loopElemType: elemType });
            expanded.push(...JSON.parse(JSON.stringify(stmt.body)));
          });
          frame.statements.splice(frame.pc + 1, 0, ...expanded);
        } else {
          // C-style for loop: for (init; condition; increment)
          const cParts = stmt.loopExpr.split(';').map(s => s.trim());
          if (cParts.length === 3) {
            const initPart = cParts[0];  // e.g. "Integer i = 0"
            const condPart = cParts[1];  // e.g. "i < list.size()"
            const incrPart = cParts[2];  // e.g. "i++"
            // Parse init
            const initDecl = initPart.match(/^(\w[\w<>,\s]*?)\s+(\w+)\s*=\s*(.+)$/);
            let loopVar = null;
            if (initDecl) {
              loopVar = initDecl[2];
              frame.variables[loopVar] = evaluateExpression(initDecl[3], scope);
            }
            // Execute loop up to 100 iterations
            const maxIter = 100;
            let iter = 0;
            const expanded = [];
            // Rebuild scope with loop var
            const loopScope = { ...(frame.classFields || {}), ...frame.variables };
            while (iter < maxIter) {
              const condVal = evaluateExpression(condPart, { ...loopScope, ...frame.variables });
              if (!condVal) break;
              expanded.push(...JSON.parse(JSON.stringify(stmt.body)));
              // Parse increment
              if (incrPart.endsWith('++')) {
                const v = incrPart.replace('++', '').trim();
                expanded.push({ line: stmt.line, type: 'assignment', raw: incrPart, varName: v, expression: `${v} + 1` });
              } else if (incrPart.endsWith('--')) {
                const v = incrPart.replace('--', '').trim();
                expanded.push({ line: stmt.line, type: 'assignment', raw: incrPart, varName: v, expression: `${v} - 1` });
              } else if (incrPart.startsWith('++')) {
                const v = incrPart.replace('++', '').trim();
                expanded.push({ line: stmt.line, type: 'assignment', raw: incrPart, varName: v, expression: `${v} + 1` });
              } else if (incrPart.startsWith('--')) {
                const v = incrPart.replace('--', '').trim();
                expanded.push({ line: stmt.line, type: 'assignment', raw: incrPart, varName: v, expression: `${v} - 1` });
              } else if (incrPart.includes('=')) {
                const incAssign = incrPart.match(/^(\w+)\s*(?:\+=|-=|\*=|\/=|=)\s*(.+)$/);
                if (incAssign) {
                  const op = incrPart.match(/(\+=|-=|\*=|\/=|=)/)[1];
                  if (op === '=') {
                    expanded.push({ line: stmt.line, type: 'assignment', raw: incrPart, varName: incAssign[1], expression: incAssign[2] });
                  } else {
                    expanded.push({ line: stmt.line, type: 'assignment', raw: incrPart, varName: incAssign[1], expression: `${incAssign[1]} ${op[0]} ${incAssign[2]}` });
                  }
                }
              }
              iter++;
              // Simulate: advance loop var for condition check
              if (loopVar && loopVar in frame.variables) {
                frame.variables[loopVar] = (frame.variables[loopVar] || 0) + 1;
              }
            }
            // Reset loop var to initial value (will be set properly during execution)
            if (initDecl && loopVar) {
              frame.variables[loopVar] = evaluateExpression(initDecl[3], scope);
            }
            addConsoleEntry('loop', `for (${stmt.loopExpr}) — ${iter} iterations`, stmt.line);
            frame.statements.splice(frame.pc + 1, 0, ...expanded);
          } else {
            addConsoleEntry('loop', `for loop (unrecognized format, max 3 iterations)`, stmt.line);
            const expanded = [];
            for (let li = 0; li < 3; li++) {
              expanded.push(...JSON.parse(JSON.stringify(stmt.body)));
            }
            frame.statements.splice(frame.pc + 1, 0, ...expanded);
          }
        }
      } else if (stmt.loopType === 'while') {
        // While loop — unroll with condition check, max 50 iterations
        const condResult = await resolveBranchCondition(stmt.condition, scope, frame, stmt.line);
        if (condResult && stmt.body.length > 0) {
          addConsoleEntry('loop', `while (${stmt.condition}) → true, entering loop`, stmt.line);
          const bodyClone = JSON.parse(JSON.stringify(stmt.body));
          // Re-insert the while check after body
          const syntheticWhile = JSON.parse(JSON.stringify(stmt));
          syntheticWhile._whileIter = (stmt._whileIter || 0) + 1;
          if (syntheticWhile._whileIter < 50) {
            frame.statements.splice(frame.pc + 1, 0, ...bodyClone, syntheticWhile);
          } else {
            addConsoleEntry('loop', `while loop — max 50 iterations reached`, stmt.line);
          }
        } else {
          addConsoleEntry('loop', `while (${stmt.condition}) → false, skipping`, stmt.line);
        }
      } else {
        addConsoleEntry('loop', `loop (unknown type, skipped)`, stmt.line);
      }
      frame.pc++;
      break;
    }

    case 'continue':
      // Skip remaining statements until next loop iteration
      addConsoleEntry('info', `continue`, stmt.line);
      frame.pc++;
      while (frame.pc < frame.statements.length) {
        const next = frame.statements[frame.pc];
        if (next.type === 'loop' || (next.type === 'assignment' && next._directValue !== undefined)) break;
        frame.pc++;
      }
      break;

    case 'break':
      // Skip remaining loop body
      addConsoleEntry('info', `break`, stmt.line);
      frame.pc++;
      while (frame.pc < frame.statements.length) {
        const next = frame.statements[frame.pc];
        if (next.type === 'loop') { frame.pc++; break; }
        frame.pc++;
      }
      break;

    case 'try':
      // Insert try-body statements
      addConsoleEntry('info', `try { ... }`, stmt.line);
      if (stmt.body.length > 0) {
        frame.statements.splice(frame.pc + 1, 0, ...stmt.body);
      }
      frame.pc++;
      break;

    case 'soql':
      if (debugState.liveOrgMode && liveOrgAvailable()) {
        debugState.orgFetching = true;
        updateLiveOrgIndicator();
        const res = await runLiveQuery(stmt.query, scope);
        debugState.orgFetching = false;
        updateLiveOrgIndicator();
        if (res.error) {
          addConsoleEntry('error', `[SOQL·live] ${res.soql} → ${res.error}`, stmt.line);
          if (stmt.varName) frame.variables[stmt.varName] = soqlIsList(stmt.declType) ? [] : null;
        } else {
          addConsoleEntry('soql', `[SOQL·live] ${res.soql} → ${res.records.length} row(s)`, stmt.line);
          if (stmt.varName) {
            frame.variables[stmt.varName] = soqlIsList(stmt.declType)
              ? res.records
              : (res.records[0] || null);
          }
        }
      } else {
        addConsoleEntry('soql', `[SOQL] ${stmt.query}`, stmt.line);
        if (stmt.varName) {
          frame.variables[stmt.varName] = soqlIsList(stmt.declType) ? [] : null;
        }
      }
      frame.pc++;
      break;

    case 'dml':
      addConsoleEntry('dml', `[DML] ${stmt.dmlOp} ${stmt.target}${debugState.liveOrgMode ? '  (simulated — not written to org)' : ''}`, stmt.line);
      frame.pc++;
      break;

    case 'methodCall': {
      if (stmt.methodName === 'debug' && (stmt.className === 'System' || stmt.className === 'system')) {
        const debugVal = evaluateExpression(stmt.argsRaw, scope);
        addConsoleEntry('debug', `System.debug: ${formatValue(debugVal)}`, stmt.line);
        frame.pc++;
        break;
      }
      // Check if we should step into this method
      if (debugState.stepMode === 'stepInto') {
        // For same-class calls (className null), use current frame's class
        const resolvedClass = stmt.className || frame.className;
        const didStepIn = await stepIntoMethod(resolvedClass, stmt.methodName, stmt.argsRaw, frame);
        if (didStepIn) return true;
      }
      addConsoleEntry('call', `${stmt.className ? stmt.className + '.' : ''}${stmt.methodName}(...)`, stmt.line);
      frame.pc++;
      break;
    }

    case 'assignWithCall': {
      // Existing variable = methodCall()
      if (debugState.stepMode === 'stepInto') {
        const resolvedClass = stmt.className || frame.className;
        const didStepIn = await stepIntoMethod(resolvedClass, stmt.methodName, stmt.argsRaw, frame, stmt.varName);
        if (didStepIn) return true;
      }
      // Not stepping in — try known method, else interpret the user method locally
      // against the resolved receiver, else set null.
      const existingObj = stmt.className ? resolveProperty(scope, stmt.className) : null;
      if (existingObj && typeof existingObj === 'object') {
        const exArgs = stmt.argsRaw ? splitArgs(stmt.argsRaw).map(a => evaluateExpression(a.trim(), scope)) : [];
        const simResult = simulateMethodCall(existingObj, stmt.methodName, exArgs);
        if (simResult !== undefined) {
          assignProperty(frame.variables, stmt.varName, simResult);
          addConsoleEntry('call', `${stmt.varName} = ${formatValue(resolveProperty(frame.variables, stmt.varName))}`, stmt.line);
          frame.pc++;
          break;
        }
        const typeHint = (frame.varTypes && frame.varTypes[stmt.className]) || existingObj.__type__;
        const userRes = await evaluateUserMethodLocally(existingObj, stmt.methodName, exArgs, typeHint, 0);
        if (userRes !== undefined) {
          assignProperty(frame.variables, stmt.varName, userRes);
          addConsoleEntry('call', `${stmt.varName} = ${formatValue(userRes)}  (computed from live object)`, stmt.line);
          frame.pc++;
          break;
        }
      }
      assignProperty(frame.variables, stmt.varName, null);
      addConsoleEntry('call', `${stmt.varName} = ${stmt.className ? stmt.className + '.' : ''}${stmt.methodName}(...) → null  ⌨ set value in console`, stmt.line);
      frame.pc++;
      break;
    }

    case 'declWithCall': {
      if (debugState.stepMode === 'stepInto') {
        const resolvedClass = stmt.className || frame.className;
        const didStepIn = await stepIntoMethod(resolvedClass, stmt.methodName, stmt.argsRaw, frame, stmt.varName);
        if (didStepIn) return true;
      }
      // Not stepping in — try evaluating as a known method, else interpret the
      // user method locally against the resolved receiver, else set null.
      const declObj = stmt.className ? resolveProperty(scope, stmt.className) : null;
      if (declObj && typeof declObj === 'object') {
        const declArgs = stmt.argsRaw ? splitArgs(stmt.argsRaw).map(a => evaluateExpression(a.trim(), scope)) : [];
        const simResult = simulateMethodCall(declObj, stmt.methodName, declArgs);
        if (simResult !== undefined) {
          frame.variables[stmt.varName] = simResult;
          if (stmt.varType) (frame.varTypes || (frame.varTypes = {}))[stmt.varName] = stmt.varType;
          addConsoleEntry('call', `${stmt.varName} = ${formatValue(frame.variables[stmt.varName])}`, stmt.line);
          frame.pc++;
          break;
        }
        const typeHint = (frame.varTypes && frame.varTypes[stmt.className]) || declObj.__type__;
        const userRes = await evaluateUserMethodLocally(declObj, stmt.methodName, declArgs, typeHint, 0);
        if (userRes !== undefined) {
          frame.variables[stmt.varName] = userRes;
          if (stmt.varType) (frame.varTypes || (frame.varTypes = {}))[stmt.varName] = stmt.varType;
          addConsoleEntry('call', `${stmt.varName} = ${formatValue(userRes)}  (computed from live object)`, stmt.line);
          frame.pc++;
          break;
        }
      }
      frame.variables[stmt.varName] = null;
      addConsoleEntry('call', `${stmt.varName} = ${stmt.className ? stmt.className + '.' : ''}${stmt.methodName}(...) → null  ⌨ set value in console`, stmt.line);
      frame.pc++;
      break;
    }

    case 'return': {
      const returnVal = stmt.expression ? evaluateExpression(stmt.expression, scope) : undefined;
      addConsoleEntry('info', `return ${stmt.expression ? formatValue(returnVal) : '(void)'}`, stmt.line);
      // Pop current frame
      if (debugState.callStack.length > 1) {
        const returned = debugState.callStack.pop();
        const parentFrame = debugState.callStack[debugState.callStack.length - 1];
        // If parent statement expects a return value (declWithCall), assign it
        const parentStmt = parentFrame.statements[parentFrame.pc];
        if (parentStmt?.varName && returnVal !== undefined) {
          parentFrame.variables[parentStmt.varName] = returnVal;
          addConsoleEntry('var', `${parentStmt.varName} = ${formatValue(returnVal)}  ↩ returned from ${returned.methodName}()`, parentStmt.line);
        }
        // Also check frame-level _assignVar (for step-into from declWithCall)
        if (returned._assignVar && returnVal !== undefined) {
          parentFrame.variables[returned._assignVar] = returnVal;
          addConsoleEntry('var', `${returned._assignVar} = ${formatValue(returnVal)}  ↩ returned from ${returned.methodName}()`, parentStmt?.line);
        }
        parentFrame.pc++;
        debugState.currentFile = parentFrame.file;
        debugState.currentLine = parentFrame.statements[parentFrame.pc]?.line || parentFrame.line;
        await navigateToFile(parentFrame.file, debugState.currentLine);
        updateDebugPanels();
        return true;
      } else {
        addConsoleEntry('info', `✓ Method returned: ${formatValue(returnVal)}`);
        stopDebugSession();
        return true;
      }
    }

    default:
      // Handle _directValue (loop variable assignment)
      if (stmt._directValue !== undefined) {
        frame.variables[stmt.varName] = JSON.parse(JSON.stringify(stmt._directValue));
      }
      frame.pc++;
      break;
  }

  // Check if we need to pause
  const nextStmt = frame.statements[frame.pc];
  if (!nextStmt) {
    // End of statements in current frame
    return await executeCurrentStatement(); // recurse to handle frame pop
  }

  debugState.currentLine = nextStmt.line;

  // Check breakpoint
  const bpKey = debugState.currentFile;
  if (debugState.breakpoints.has(bpKey) && debugState.breakpoints.get(bpKey).has(nextStmt.line)) {
    const bpInfo = debugState.breakpoints.get(bpKey).get(nextStmt.line);
    if (bpInfo && bpInfo.condition) {
      // Conditional breakpoint — evaluate condition
      const bpScope = { ...(frame.classFields || {}), ...frame.variables };
      const condResult = evaluateExpression(bpInfo.condition, bpScope);
      if (condResult) {
        addConsoleEntry('bp', `⬤ Conditional breakpoint hit at line ${nextStmt.line} (${bpInfo.condition} → true)`);
        return true;
      }
      // Condition false — don't pause
    } else {
      addConsoleEntry('bp', `⬤ Breakpoint hit at line ${nextStmt.line}`);
      return true; // pause
    }
  }

  // Check step mode
  if (debugState.stepMode === 'stepOver' || debugState.stepMode === 'stepInto') {
    return true; // pause on each line
  }
  if (debugState.stepMode === 'stepOut' && debugState.callStack.length < debugState.stepDepth) {
    return true; // paused after returning from a frame
  }

  return false; // continue running
}

async function stepIntoMethod(className, methodName, argsRaw, currentFrame, assignVar) {
  let filePath = await resolveClassFile(className);
  // Same-class (often private) method: the class name may not resolve on its own
  // (inner classes, bare calls) — fall back to the current frame's own file.
  if (!filePath && currentFrame && (!className || className === currentFrame.className)) {
    filePath = currentFrame.file;
  }
  if (!filePath) return false;

  try {
    const source = await window.congacode.readFile(filePath);
    const methodInfo = findMethodInSource(source, methodName);
    if (!methodInfo) return false;

    const lines = source.split('\n');
    const statements = parseApexStatements(lines, methodInfo.startLine, methodInfo.endLine);
    if (statements.length === 0) return false;

    // Build variables from args (best effort)
    const variables = {};
    if (methodInfo.params && argsRaw) {
      const parentScope = { ...(currentFrame.classFields || {}), ...currentFrame.variables };
      const argValues = splitArgs(argsRaw).map(a => evaluateExpression(a.trim(), parentScope));
      methodInfo.params.forEach((p, idx) => {
        variables[p.name] = argValues[idx] !== undefined ? argValues[idx] : null;
      });
    }

    // Parse class fields for the target class
    const clsName = filePath.split('/').pop().replace(/\.(cls|trigger)$/, '');
    let classFieldVars = {};
    if (!debugState.classFieldsCache.has(clsName)) {
      const classFields = parseClassFields(source);
      debugState.classFieldsCache.set(clsName, classFields);
    }
    const cached = debugState.classFieldsCache.get(clsName);
    if (cached) {
      for (const [name, info] of Object.entries(cached.allFields)) {
        classFieldVars[name] = info.defaultValue !== undefined ? JSON.parse(JSON.stringify(info.defaultValue)) : null;
      }
    }
    // If same class as parent, inherit parent's class fields (shared state)
    if (clsName === currentFrame.className && currentFrame.classFields) {
      classFieldVars = currentFrame.classFields;
    }

    debugState.callStack.push({
      file: filePath,
      className: clsName,
      methodName,
      line: statements[0].line,
      variables,
      classFields: classFieldVars,
      statements,
      pc: 0,
      _assignVar: assignVar  // variable to assign return value to in parent frame
    });

    addConsoleEntry('nav', `↘ Stepped into ${clsName}.${methodName}()`);
    debugState.currentFile = filePath;
    debugState.currentLine = statements[0].line;
    await navigateToFile(filePath, debugState.currentLine);
    updateDebugPanels();
    return true;
  } catch (e) {
    return false;
  }
}

function assignProperty(scope, path, value) {
  const parts = path.split('.');
  if (parts.length === 1) {
    scope[path] = value;
    return;
  }
  let current = scope;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

/* ================================================================
   7. DEBUG COMMANDS — Continue, Step Over, Step Into, Step Out, Stop
   ================================================================ */

async function debugContinue() {
  if (!debugState.active) return;
  if (debugState.engineMode) { engineStep('continue'); return; }
  if (debugState.replayMode) { await replayContinue(); return; }
  debugState.paused = false;
  debugState.stepMode = 'continue';

  while (debugState.active && !debugState.paused) {
    const shouldPause = await executeCurrentStatement();
    if (shouldPause) {
      debugState.paused = true;
      break;
    }
  }

  if (debugState.active) {
    highlightCurrentLine();
    navigateToLine(debugState.currentLine);
    updateDebugPanels();
  }
}

async function debugStepOver() {
  if (!debugState.active || !debugState.paused) return;
  if (debugState.engineMode) { engineStep('over'); return; }
  if (debugState.replayMode) { await replayStepOver(); return; }
  debugState.stepMode = 'stepOver';
  debugState.stepDepth = debugState.callStack.length;
  debugState.paused = false;

  const shouldPause = await executeCurrentStatement();
  debugState.paused = true;

  if (debugState.active) {
    highlightCurrentLine();
    navigateToLine(debugState.currentLine);
    updateDebugPanels();
  }
}

async function debugStepInto() {
  if (!debugState.active || !debugState.paused) return;
  if (debugState.engineMode) { engineStep('into'); return; }
  if (debugState.replayMode) { await replayStepInto(); return; }
  debugState.stepMode = 'stepInto';
  debugState.stepDepth = debugState.callStack.length;
  debugState.paused = false;

  const shouldPause = await executeCurrentStatement();
  debugState.paused = true;

  if (debugState.active) {
    highlightCurrentLine();
    navigateToLine(debugState.currentLine);
    updateDebugPanels();
  }
}

async function debugStepOut() {
  if (!debugState.active || !debugState.paused) return;
  if (debugState.engineMode) { engineStep('out'); return; }
  if (debugState.replayMode) { await replayStepOut(); return; }
  debugState.stepMode = 'stepOut';
  debugState.stepDepth = debugState.callStack.length;
  debugState.paused = false;

  while (debugState.active && !debugState.paused) {
    const shouldPause = await executeCurrentStatement();
    if (shouldPause) {
      debugState.paused = true;
      break;
    }
  }

  if (debugState.active) {
    highlightCurrentLine();
    navigateToLine(debugState.currentLine);
    updateDebugPanels();
  }
}

async function debugRestart() {
  if (!debugState.entryFile || !debugState.entryMethod) return;
  const params = debugState.parsedRequest?.params || [];
  stopDebugSession();
  await startDebugSession(debugState.entryFile, debugState.entryMethod, params);
}

/* ================================================================
   8. BREAKPOINT MANAGEMENT
   ================================================================ */

function toggleBreakpoint(filePath, lineNumber, condition) {
  if (!debugState.breakpoints.has(filePath)) {
    debugState.breakpoints.set(filePath, new Map());
  }
  const bps = debugState.breakpoints.get(filePath);
  if (bps.has(lineNumber) && condition === undefined) {
    bps.delete(lineNumber);
  } else {
    bps.set(lineNumber, { condition: condition || null });
  }
  renderBreakpointDecorations(filePath);
  updateBreakpointsPanel();
}

function renderBreakpointDecorations(filePath) {
  const editor = window.state?.editor;
  if (!editor) return;

  // Only apply decorations if the current model matches the filePath
  const model = editor.getModel();
  if (!model) return;
  const currentUri = model.uri.toString();
  const targetUri = monaco.Uri.file(filePath).toString();
  if (currentUri !== targetUri) return;

  const oldDecos = debugState.breakpointDecorations.get(filePath) || [];
  const bps = debugState.breakpoints.get(filePath);
  const newDecos = [];

  if (bps) {
    for (const [line, bpInfo] of bps) {
      const isCond = bpInfo && bpInfo.condition;
      newDecos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: isCond ? 'debug-breakpoint-conditional' : 'debug-breakpoint',
          glyphMarginHoverMessage: { value: isCond ? `Conditional: ${bpInfo.condition}` : 'Breakpoint' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        }
      });
    }
  }

  const ids = editor.deltaDecorations(oldDecos, newDecos);
  debugState.breakpointDecorations.set(filePath, ids);
}

function renderAllBreakpointDecorations() {
  for (const [filePath] of debugState.breakpoints) {
    renderBreakpointDecorations(filePath);
  }
}

/* ================================================================
   9. EDITOR DECORATIONS — Current line highlight
   ================================================================ */

function highlightCurrentLine() {
  const editor = window.state?.editor;
  if (!editor || !debugState.active) return;

  clearCurrentLineHighlight();

  const line = debugState.currentLine;
  if (!line) return;

  debugState.currentLineDecoration = editor.deltaDecorations([], [
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: 'debug-current-line',
        glyphMarginClassName: 'debug-current-arrow',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    }
  ]);
}

function clearCurrentLineHighlight() {
  const editor = window.state?.editor;
  if (!editor) return;
  if (debugState.currentLineDecoration.length > 0) {
    editor.deltaDecorations(debugState.currentLineDecoration, []);
    debugState.currentLineDecoration = [];
  }
}

function navigateToLine(line) {
  const editor = window.state?.editor;
  if (!editor || !line) return;
  editor.revealLineInCenter(line);
}

async function navigateToFile(filePath, line) {
  const content = await window.congacode.readFile(filePath);
  await window.openFile(filePath, content);
  // Wait for model to be set, then apply decorations
  setTimeout(() => {
    renderBreakpointDecorations(filePath);
    highlightCurrentLine();
    navigateToLine(line);
  }, 50);
}

/* ================================================================
   10. CONSOLE LOG
   ================================================================ */

function addConsoleEntry(type, message, line) {
  debugState.consoleLog.push({ type, message, line, time: new Date() });
  renderConsolePanel();
}

function formatValue(val) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') {
    if (ADDR_RE.test(val)) return '‹ref: not in log›';
    return `"${val.length > 80 ? val.substring(0, 80) + '...' : val}"`;
  }
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return `List (${val.length} items)`;
  if (val instanceof Set) return `Set (${val.size} items)`;
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length <= 3) return `{ ${keys.map(k => `${k}: ${formatValueShort(val[k])}`).join(', ')} }`;
    return `Object (${keys.length} fields)`;
  }
  return String(val);
}

function formatValueShort(val) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') {
    if (ADDR_RE.test(val)) return '‹ref›';
    return `"${val.length > 20 ? val.substring(0, 20) + '...' : val}"`;
  }
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return `[${val.length}]`;
  if (typeof val === 'object') return `{...}`;
  return String(val);
}

/* ================================================================
   11. VARIABLE TREE RENDERER
   ================================================================ */

function renderVariableTree(obj, depth = 0, maxDepth = 4) {
  if (depth >= maxDepth) return '<span class="dbg-val-muted">...</span>';
  if (obj === null) return '<span class="dbg-val-null">null</span>';
  if (obj === undefined) return '<span class="dbg-val-null">undefined</span>';
  if (typeof obj === 'string') return `<span class="dbg-val-string">"${_esc(obj.length > 100 ? obj.substring(0, 100) + '...' : obj)}"</span>`;
  if (typeof obj === 'number') return `<span class="dbg-val-number">${obj}</span>`;
  if (typeof obj === 'boolean') return `<span class="dbg-val-bool">${obj}</span>`;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span class="dbg-val-muted">[] (empty)</span>';
    let html = `<span class="dbg-val-muted">List (${obj.length})</span>`;
    html += '<div class="dbg-var-children">';
    for (let i = 0; i < Math.min(obj.length, 20); i++) {
      html += `<div class="dbg-var-row"><span class="dbg-var-key">[${i}]</span>: ${renderVariableTree(obj[i], depth + 1, maxDepth)}</div>`;
    }
    if (obj.length > 20) html += `<div class="dbg-var-row dbg-val-muted">... ${obj.length - 20} more</div>`;
    html += '</div>';
    return html;
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj).filter(k => !k.startsWith('__'));
    if (keys.length === 0) return '<span class="dbg-val-muted">{} (empty)</span>';
    let html = `<span class="dbg-val-muted">Object (${keys.length} fields)</span>`;
    html += '<div class="dbg-var-children">';
    for (const key of keys.slice(0, 30)) {
      html += `<div class="dbg-var-row"><span class="dbg-var-key">${_esc(key)}</span>: ${renderVariableTree(obj[key], depth + 1, maxDepth)}</div>`;
    }
    if (keys.length > 30) html += `<div class="dbg-var-row dbg-val-muted">... ${keys.length - 30} more</div>`;
    html += '</div>';
    return html;
  }

  return `<span>${_esc(String(obj))}</span>`;
}

/* ================================================================
   12. UI RENDERING — Debug panels
   ================================================================ */

function showDebugUI() {
  debugState.debugPanelVisible = true;
  _$('#debug-toolbar')?.classList.remove('hidden');
  _$('#debug-panel')?.classList.remove('hidden');
  // Enable glyphMargin
  window.state?.editor?.updateOptions({ glyphMargin: true });
  // Trigger layout so editor shrinks above the panel
  setTimeout(() => window.state?.editor?.layout(), 50);
}

function hideDebugUI() {
  debugState.debugPanelVisible = false;
  _$('#debug-toolbar')?.classList.add('hidden');
  _$('#debug-panel')?.classList.add('hidden');
  clearCurrentLineHighlight();
  // Restore editor layout
  setTimeout(() => window.state?.editor?.layout(), 50);
}

function updateDebugPanels() {
  applyUserOverridesToStack();
  renderVariablesPanel();
  renderWatchPanel();
  renderCallStackPanel();
  renderConsolePanel();
  renderBreakpointsPanel();
  renderOrgActivityPanel();
  updateLiveOrgIndicator();
}

/* --- User variable overrides (inline value entry for null/unresolved vars) --- */

/** Interpret a user-typed string as an Apex-ish literal value. */
function parseUserInputValue(raw) {
  const s = (raw ?? '').trim();
  if (s === '' || s.toLowerCase() === 'null') return null;
  if (s.toLowerCase() === 'true') return true;
  if (s.toLowerCase() === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  // Quoted string
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  // JSON object / array
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { return JSON.parse(s); } catch { /* fall through to raw string */ }
  }
  return s;
}

function overrideKey(className, scopeType, varName) {
  return `${className || '?'}::${scopeType}::${varName}`;
}

/** Re-apply stored user overrides onto the live call stack, but only where the
 *  current value is null/undefined — real engine/org values always take precedence. */
function applyUserOverridesToStack() {
  const overrides = debugState.userOverrides;
  if (!overrides || !Object.keys(overrides).length) return;
  for (const frame of debugState.callStack) {
    if (!frame) continue;
    for (const [k, v] of Object.entries(overrides)) {
      const [cls, scopeType, varName] = k.split('::');
      if (cls !== (frame.className || '?')) continue;
      const target = scopeType === 'field' ? (frame.classFields || (frame.classFields = {})) : frame.variables;
      if (!target) continue;
      const cur = target[varName];
      if (cur === null || cur === undefined) target[varName] = v;
    }
  }
}

/** Commit a user-entered value for a variable, update the live context, refresh UI. */
window._dbgCommitVar = function (scopeType, key, rawValue) {
  const frame = scopeType === 'closure'
    ? debugState.callStack[debugState.callStack.length - 2]
    : debugState.callStack[debugState.callStack.length - 1];
  if (!frame) return;
  const value = parseUserInputValue(rawValue);
  const target = scopeType === 'field' ? (frame.classFields || (frame.classFields = {})) : frame.variables;
  target[key] = value;
  // Persist so it survives stepping/replay navigation (applied while value stays null).
  const storeScope = scopeType === 'field' ? 'field' : 'local';
  debugState.userOverrides[overrideKey(frame.className, storeScope, key)] = value;
  addConsoleEntry('var', `✎ ${key} = ${formatValue(value)}  (you set this value)`, debugState.currentLine);
  updateDebugPanels();
};

/** Clear a user override for a variable and re-render. */
window._dbgClearVarOverride = function (scopeType, key) {
  const frame = scopeType === 'closure'
    ? debugState.callStack[debugState.callStack.length - 2]
    : debugState.callStack[debugState.callStack.length - 1];
  if (!frame) return;
  const storeScope = scopeType === 'field' ? 'field' : 'local';
  delete debugState.userOverrides[overrideKey(frame.className, storeScope, key)];
  updateDebugPanels();
};

/** Swap a variable row into an inline text input for editing. */
window._dbgEditVar = function (scopeType, key, ev) {
  if (ev) ev.stopPropagation();
  const entry = document.querySelector(`.dbg-var-entry[data-var="${CSS.escape(key)}"][data-scope="${scopeType}"]`);
  if (!entry) return;
  const valEl = entry.querySelector('.dbg-var-value, .dbg-var-setnull');
  if (!valEl) return;
  const current = valEl.getAttribute('data-raw') || '';
  valEl.outerHTML = `<span class="dbg-var-edit"><input type="text" class="dbg-var-edit-input" spellcheck="false" autocomplete="off" placeholder="value…" value="${_esc(current)}" /></span>`;
  const input = entry.querySelector('.dbg-var-edit-input');
  if (!input) return;
  input.focus();
  input.select();
  const commit = () => window._dbgCommitVar(scopeType, key, input.value);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); updateDebugPanels(); }
  });
  input.addEventListener('blur', () => { updateDebugPanels(); });
};

function renderVariablesPanel() {
  const container = _$('#dbg-variables-body');
  if (!container) return;

  const frame = debugState.callStack[debugState.callStack.length - 1];
  if (!frame) {
    container.innerHTML = '<div class="dbg-empty">No active frame</div>';
    return;
  }

  let html = '';

  // --- Local Variables section ---
  const vars = frame.variables;
  const localKeys = Object.keys(vars);
  html += '<div class="dbg-scope-section">';
  html += '<div class="dbg-scope-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">▼ Local</div>';
  if (localKeys.length === 0) {
    html += '<div class="dbg-empty" style="padding-left:16px">No local variables</div>';
  } else {
    for (const key of localKeys) {
      html += renderVarEntry(key, vars[key], 'local', frame._iter && frame._iter[key]);
    }
  }
  html += '</div>';

  // --- Class Fields section (if available) ---
  if (frame.classFields && Object.keys(frame.classFields).length > 0) {
    html += '<div class="dbg-scope-section">';
    html += `<div class="dbg-scope-header" onclick="this.parentElement.classList.toggle('collapsed')">▼ Class Fields (${_esc(frame.className)})</div>`;
    for (const key of Object.keys(frame.classFields)) {
      html += renderVarEntry(key, frame.classFields[key], 'field');
    }
    html += '</div>';
  }

  // --- Closure / Parent Scope section (for stepped-into methods) ---
  if (debugState.callStack.length > 1) {
    const parentFrame = debugState.callStack[debugState.callStack.length - 2];
    html += '<div class="dbg-scope-section collapsed">';
    html += `<div class="dbg-scope-header" onclick="this.parentElement.classList.toggle('collapsed')">▶ Closure (${_esc(parentFrame.className)}.${_esc(parentFrame.methodName)})</div>`;
    for (const key of Object.keys(parentFrame.variables)) {
      html += renderVarEntry(key, parentFrame.variables[key], 'closure');
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

function renderWatchPanel() {
  const container = _$('#dbg-watch-body');
  if (!container) return;

  if (debugState.watchExpressions.length === 0) {
    container.innerHTML = '<div class="dbg-empty">No watch expressions. Add one below.</div>';
    return;
  }

  const frame = debugState.callStack[debugState.callStack.length - 1];
  const watchScope = frame ? { ...(frame.classFields || {}), ...frame.variables } : {};

  let html = '';
  for (const watch of debugState.watchExpressions) {
    let value;
    let error = null;
    try {
      if (frame) {
        // Try resolving as property path first
        value = resolveProperty(watchScope, watch.expr);
        if (value === undefined) {
          value = evaluateExpression(watch.expr, watchScope);
        }
      } else {
        value = undefined;
      }
    } catch (e) {
      error = e.message;
    }

    html += `<div class="dbg-watch-entry" data-watch-id="${watch.id}">`;
    html += `<div class="dbg-watch-row">`;
    html += `<span class="dbg-watch-expr">${_esc(watch.expr)}</span>`;
    if (error) {
      html += `<span class="dbg-watch-error">${_esc(error)}</span>`;
    } else if (value !== undefined && value !== null && typeof value === 'object') {
      html += `<span class="dbg-watch-val">${formatValue(value)}</span>`;
      html += `</div>`;
      html += `<div class="dbg-watch-expand hidden">${renderVariableTree(value, 0, 4)}</div>`;
    } else {
      html += `<span class="dbg-watch-val">${formatValue(value)}</span>`;
      html += `</div>`;
    }
    html += `<button class="dbg-watch-remove" onclick="window._dbgRemoveWatch(${watch.id})" title="Remove">✕</button>`;
    html += `</div>`;
  }
  container.innerHTML = html;

  // Attach click-to-expand handlers
  container.querySelectorAll('.dbg-watch-entry').forEach(entry => {
    const row = entry.querySelector('.dbg-watch-row');
    const expand = entry.querySelector('.dbg-watch-expand');
    if (row && expand) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        expand.classList.toggle('hidden');
      });
    }
  });
}

window._dbgRemoveWatch = function(watchId) {
  debugState.watchExpressions = debugState.watchExpressions.filter(w => w.id !== watchId);
  renderWatchPanel();
};

function renderVarEntry(key, val, scopeType = 'local', iterInfo = null) {
  const isExpandable = val !== null && typeof val === 'object';
  const isNullish = val === null || val === undefined;
  const rawAttr = _esc(rawValueString(val));
  let html = `<div class="dbg-var-entry${isExpandable ? ' expandable' : ''}" data-var="${_esc(key)}" data-scope="${scopeType}">`;
  html += `<div class="dbg-var-header" onclick="window._dbgToggleVar(this)">`;
  if (isExpandable) html += `<span class="dbg-var-arrow">▶</span>`;
  html += `<span class="dbg-var-name">${_esc(key)}</span>`;
  // For-each loop variable → show which element of the collection is bound now,
  // so a single element is never confused with the whole collection.
  if (iterInfo) {
    const badge = iterInfo.index >= 0
      ? `↻ ${iterInfo.index + 1}/${iterInfo.total} of ${_esc(iterInfo.collection)}`
      : `↻ empty ${_esc(iterInfo.collection)}`;
    html += `<span class="dbg-var-iter" title="for-each element">${badge}</span>`;
  }
  if (isNullish) {
    // Nothing resolved yet — invite the user to supply a value inline,
    // and (when connected) to fetch the real value from the org on demand.
    html += `<span class="dbg-var-setnull" data-raw="" onclick="window._dbgEditVar('${scopeType}', '${_escJs(key)}', event)" title="No value resolved. Click to enter one.">${formatValue(val)} <span class="dbg-var-set-hint">✎ set value</span></span>`;
    if (liveOrgAvailable() && scopeType !== 'closure') {
      html += `<span class="dbg-var-orgbtn" onclick="window._dbgFetchVarFromOrg('${scopeType}', '${_escJs(key)}', event)" title="Execute in the connected org and pull the real value">▶ org</span>`;
    }
  } else {
    html += `<span class="dbg-var-value" data-raw="${rawAttr}">${formatValue(val)}</span>`;
    html += `<span class="dbg-var-editbtn" onclick="window._dbgEditVar('${scopeType}', '${_escJs(key)}', event)" title="Edit value">✎</span>`;
  }
  html += `</div>`;
  if (isExpandable) {
    html += `<div class="dbg-var-expand hidden">${renderVariableTree(val, 0, 4)}</div>`;
  }
  html += `</div>`;
  return html;
}

/** Render a value as an editable raw string for the inline input. */
function rawValueString(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try { return JSON.stringify(val); } catch { return String(val); }
}

/** Escape a string for safe embedding inside a single-quoted JS attribute handler. */
function _escJs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

window._dbgToggleVar = function(headerEl) {
  const entry = headerEl.closest('.dbg-var-entry');
  if (!entry) return;
  const expand = entry.querySelector('.dbg-var-expand');
  const arrow = entry.querySelector('.dbg-var-arrow');
  if (expand) {
    expand.classList.toggle('hidden');
    if (arrow) arrow.textContent = expand.classList.contains('hidden') ? '▶' : '▼';
  }
};

function renderCallStackPanel() {
  const container = _$('#dbg-callstack-body');
  if (!container) return;

  if (debugState.callStack.length === 0) {
    container.innerHTML = '<div class="dbg-empty">No active call stack</div>';
    return;
  }

  let html = '';
  if (debugState.callStack.length > 1) {
    html += '<div class="dbg-stack-hint">⇧F11 to step out and return to caller</div>';
  }
  for (let i = debugState.callStack.length - 1; i >= 0; i--) {
    const frame = debugState.callStack[i];
    const currentStmt = frame.statements[frame.pc];
    const line = currentStmt ? currentStmt.line : frame.line;
    const isCurrent = i === debugState.callStack.length - 1;
    const depthArrow = i < debugState.callStack.length - 1 ? '← ' : '▶ ';
    html += `<div class="dbg-stack-frame${isCurrent ? ' current' : ''}" onclick="window._dbgSelectFrame(${i})">`;
    html += `<span class="dbg-stack-depth">${depthArrow}</span>`;
    html += `<span class="dbg-stack-method">${_esc(frame.className)}.${_esc(frame.methodName)}()</span>`;
    html += `<span class="dbg-stack-location">line ${line}</span>`;
    html += `</div>`;
  }
  container.innerHTML = html;
}

window._dbgSelectFrame = async function(frameIdx) {
  const frame = debugState.callStack[frameIdx];
  if (!frame) return;
  await navigateToFile(frame.file, frame.statements[frame.pc]?.line || frame.line);
  // Temporarily show this frame's variables
  renderVariablesForFrame(frameIdx);
};

function renderVariablesForFrame(frameIdx) {
  const container = _$('#dbg-variables-body');
  if (!container) return;
  const frame = debugState.callStack[frameIdx];
  if (!frame) return;

  let html = `<div class="dbg-frame-label">${_esc(frame.className)}.${_esc(frame.methodName)}()</div>`;

  // Local variables
  html += '<div class="dbg-scope-section">';
  html += '<div class="dbg-scope-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">▼ Local</div>';
  for (const key of Object.keys(frame.variables)) {
    html += renderVarEntry(key, frame.variables[key], 'local', frame._iter && frame._iter[key]);
  }
  html += '</div>';

  // Class fields
  if (frame.classFields && Object.keys(frame.classFields).length > 0) {
    html += '<div class="dbg-scope-section">';
    html += `<div class="dbg-scope-header" onclick="this.parentElement.classList.toggle('collapsed')">▼ Class Fields</div>`;
    for (const key of Object.keys(frame.classFields)) {
      html += renderVarEntry(key, frame.classFields[key]);
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

function renderConsolePanel() {
  const container = _$('#dbg-console-body');
  if (!container) return;

  if (debugState.consoleLog.length === 0) {
    container.innerHTML = '<div class="dbg-empty">Debug console</div>';
    return;
  }

  let html = '';
  for (let ei = 0; ei < debugState.consoleLog.length; ei++) {
    const entry = debugState.consoleLog[ei];
    const typeClass = `dbg-console-${entry.type}`;

    if (entry.type === 'result-json') {
      // Collapsible JSON tree with copy button
      const collapsed = entry.message.length > 200;
      html += `<div class="dbg-console-entry ${typeClass}">`;
      html += `<div class="dbg-json-header">`;
      html += `<button class="dbg-json-toggle" data-idx="${ei}" title="Expand/Collapse">${collapsed ? '▶' : '▼'}</button>`;
      html += `<span class="dbg-json-label">Object</span>`;
      html += `<button class="dbg-json-copy" data-idx="${ei}" title="Copy JSON">📋 Copy</button>`;
      html += `</div>`;
      html += `<pre class="dbg-json-block${collapsed ? ' collapsed' : ''}" data-idx="${ei}">${syntaxHighlightJSON(_esc(entry.message))}</pre>`;
      html += `</div>`;
    } else {
      html += `<div class="dbg-console-entry ${typeClass}">`;
      if (entry.line) html += `<span class="dbg-console-line">L${entry.line}</span>`;
      html += `<span class="dbg-console-msg">${_esc(entry.message)}</span>`;
      html += `</div>`;
    }
  }
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;

  // Attach toggle handlers
  container.querySelectorAll('.dbg-json-toggle').forEach(btn => {
    btn.onclick = () => {
      const idx = btn.dataset.idx;
      const pre = container.querySelector(`pre.dbg-json-block[data-idx="${idx}"]`);
      if (pre) {
        pre.classList.toggle('collapsed');
        btn.textContent = pre.classList.contains('collapsed') ? '▶' : '▼';
      }
    };
  });

  // Attach copy handlers
  container.querySelectorAll('.dbg-json-copy').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx);
      const text = debugState.consoleLog[idx]?.message || '';
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✓ Copied';
        setTimeout(() => btn.textContent = '📋 Copy', 1500);
      });
    };
  });
}

function syntaxHighlightJSON(escaped) {
  // escaped is already HTML-escaped. Apply color spans for JSON syntax.
  return escaped
    .replace(/(&quot;[^&]*?&quot;)\s*:/g, '<span class="dbg-json-key">$1</span>:')
    .replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="dbg-json-str">$1</span>')
    .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="dbg-json-num">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="dbg-json-bool">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="dbg-json-null">$1</span>');
}

function renderBreakpointsPanel() {
  const container = _$('#dbg-breakpoints-body');
  if (!container) return;

  let count = 0;
  let html = '';
  for (const [filePath, bpMap] of debugState.breakpoints) {
    for (const [line, bpInfo] of bpMap) {
      const filename = filePath.split('/').pop();
      count++;
      const condLabel = bpInfo.condition ? ` [${_esc(bpInfo.condition)}]` : '';
      html += `<div class="dbg-bp-entry${bpInfo.condition ? ' conditional' : ''}" onclick="window._dbgGoToBreakpoint('${_esc(filePath)}', ${line})">`;
      html += `<span class="dbg-bp-dot">${bpInfo.condition ? '◆' : '●'}</span>`;
      html += `<span class="dbg-bp-file">${_esc(filename)}</span>`;
      html += `<span class="dbg-bp-line">:${line}</span>`;
      if (bpInfo.condition) html += `<span class="dbg-bp-cond">${condLabel}</span>`;
      html += `<button class="dbg-bp-edit" onclick="event.stopPropagation(); window._dbgEditBreakpoint('${_esc(filePath)}', ${line})" title="Edit condition">✎</button>`;
      html += `<button class="dbg-bp-remove" onclick="event.stopPropagation(); window._dbgRemoveBreakpoint('${_esc(filePath)}', ${line})" title="Remove">✕</button>`;
      html += `</div>`;
    }
  }

  if (count === 0) {
    html = '<div class="dbg-empty">No breakpoints set. Click in the gutter margin to add breakpoints.</div>';
  } else {
    html += `<button class="dbg-bp-clear-all" onclick="window._dbgClearAllBreakpoints()">Remove All</button>`;
  }
  container.innerHTML = html;
}

window._dbgGoToBreakpoint = async function(filePath, line) {
  await navigateToFile(filePath, line);
};

window._dbgRemoveBreakpoint = function(filePath, line) {
  toggleBreakpoint(filePath, line);
};

window._dbgEditBreakpoint = function(filePath, line) {
  const bps = debugState.breakpoints.get(filePath);
  const current = bps?.get(line);
  const condition = prompt('Enter breakpoint condition (leave empty for unconditional):', current?.condition || '');
  if (condition !== null) {
    toggleBreakpoint(filePath, line, condition || null);
  }
};

window._dbgClearAllBreakpoints = function() {
  debugState.breakpoints.clear();
  // Clear all decorations
  const editor = window.state?.editor;
  if (editor) {
    for (const [, decoIds] of debugState.breakpointDecorations) {
      editor.deltaDecorations(decoIds, []);
    }
  }
  debugState.breakpointDecorations.clear();
  updateBreakpointsPanel();
};

function updateBreakpointsPanel() {
  renderBreakpointsPanel();
}

/* ================================================================
   13. REQUEST INPUT MODAL
   ================================================================ */

function showRequestModal(filePath, methodName, signatureLine) {
  const modal = _$('#debug-request-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const titleEl = _$('#dbg-modal-title');
  if (titleEl) {
    const className = filePath.split('/').pop().replace(/\.(cls|trigger)$/, '');
    titleEl.textContent = `Debug: ${className}.${methodName}()`;
  }

  // Store target info
  modal.dataset.filePath = filePath;
  modal.dataset.methodName = methodName;

  // Create mini Monaco editor for JSON input if not already created
  if (!debugState.miniEditorInstance) {
    const container = _$('#dbg-request-editor');
    if (container && typeof monaco !== 'undefined') {
      debugState.miniEditorInstance = monaco.editor.create(container, {
        value: '// Paste your request JSON here\n{\n  \n}',
        language: 'json',
        theme: window.state?.editor?.getRawOptions?.()?.theme || 'vs-dark',
        minimap: { enabled: false },
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontSize: 13,
        wordWrap: 'on',
        glyphMargin: false,
        folding: true,
        tabSize: 2,
      });
    }
  }

  // Focus the mini editor
  setTimeout(() => debugState.miniEditorInstance?.focus(), 100);
}

function hideRequestModal() {
  const modal = _$('#debug-request-modal');
  if (modal) modal.classList.add('hidden');
}

function startDebugFromModal() {
  const modal = _$('#debug-request-modal');
  if (!modal) return;

  const filePath = modal.dataset.filePath;
  const methodName = modal.dataset.methodName;
  const jsonText = debugState.miniEditorInstance?.getValue() || '';

  // Parse the request
  const parsed = parseRequest(jsonText);
  if (parsed.error) {
    window.showToast?.(parsed.error, 'error');
    return;
  }

  debugState.parsedRequest = parsed;
  debugState.requestJson = jsonText;
  hideRequestModal();

  // Start debug session
  startDebugSession(filePath, methodName, parsed.params);
}

/* ================================================================
   14. CODELENS & HOVER PROVIDER — "▶ Debug with Request"
   ================================================================ */

// Map of line → {filePath, methodName} for CodeLens click resolution
const _codeLensMap = new Map();

function registerDebugProviders() {
  if (typeof monaco === 'undefined') return;

  const CMD_ID = 'congacode.debugMethod';

  // CodeLens: "▶ Debug with Request" above each method
  monaco.languages.registerCodeLensProvider('apex', {
    provideCodeLenses: (model) => {
      const lenses = [];
      const lines = model.getLinesContent();
      const uri = model.uri;
      const uriKey = uri.toString();
      const methodRegex = /(?:public|private|protected|global)\s+(?:static\s+)?(?:override\s+)?(?:testMethod\s+)?(?:[\w<>\[\],.\s]+?)\s+(\w+)\s*\(/i;

      // Clear previous entries for this model
      for (const key of _codeLensMap.keys()) {
        if (key.startsWith(uriKey + ':')) _codeLensMap.delete(key);
      }

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(methodRegex);
        if (match) {
          // Skip if this looks like a class declaration
          if (/\b(class|interface|enum|trigger)\b/i.test(lines[i])) continue;
          // Skip annotations-only lines
          if (lines[i].trim().startsWith('@')) continue;
          // Skip constructors (method name matches class name)
          const fileName = uri.path.split('/').pop().replace(/\.(cls|trigger)$/, '');
          if (match[1] === fileName) continue;

          const filePath = uri.fsPath || uri.path;
          const lineNum = i + 1;
          _codeLensMap.set(uriKey + ':' + lineNum, { filePath, methodName: match[1], line: lineNum });

          lenses.push({
            range: { startLineNumber: lineNum, startColumn: 1, endLineNumber: lineNum, endColumn: 1 },
            command: {
              id: CMD_ID,
              title: '▶ Debug with Request',
              arguments: [filePath, match[1], lineNum]
            }
          });
        }
      }
      return { lenses, dispose: () => {} };
    },
    resolveCodeLens: (_, lens) => lens
  });

  // Register a no-op action so the command ID is valid and Monaco
  // renders clickable links (addAction doesn't forward CodeLens args,
  // so we use a DOM click interceptor below for the actual logic).
  const waitForEditor = setInterval(() => {
    const editor = window.state?.editor;
    if (!editor) return;
    clearInterval(waitForEditor);

    editor.addAction({
      id: CMD_ID,
      label: '▶ Debug This Method',
      contextMenuGroupId: 'z_debug',
      contextMenuOrder: 0,
      run: (ed) => {
        // Fallback for context menu (not CodeLens): detect method at cursor
        const model = ed.getModel();
        const position = ed.getPosition();
        if (!model || !position) return;
        const fp = model.uri.fsPath || model.uri.path;
        const lines = model.getLinesContent();
        const mRe = /(?:public|private|protected|global)\s+(?:static\s+)?(?:override\s+)?(?:testMethod\s+)?(?:[\w<>\[\],.\s]+?)\s+(\w+)\s*\(/i;
        for (let i = position.lineNumber - 1; i >= Math.max(0, position.lineNumber - 20); i--) {
          const m = lines[i].match(mRe);
          if (m && !/\b(class|interface|enum|trigger)\b/i.test(lines[i]) && !lines[i].trim().startsWith('@')) {
            showRequestModal(fp, m[1], i + 1);
            return;
          }
        }
      }
    });
  }, 200);

  // DOM click interceptor: catches clicks on "▶ Debug with Request" CodeLens
  // links and resolves the method from _codeLensMap using editor position.
  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.('a') || (e.target?.tagName === 'A' ? e.target : null);
    if (!el) return;
    const text = el.textContent?.trim();
    if (!text || !text.includes('Debug with Request')) return;

    const editor = window.state?.editor;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const uriKey = model.uri.toString();

    // Use the clicked element's position to find the source line
    const rect = el.getBoundingClientRect();
    const target = editor.getTargetAtClientPoint(rect.left + 1, rect.bottom + 4);
    if (target?.position) {
      const line = target.position.lineNumber;
      // Check this line and nearby lines (CodeLens sits above the method)
      for (let offset = 0; offset <= 3; offset++) {
        const data = _codeLensMap.get(uriKey + ':' + (line + offset));
        if (data) {
          e.preventDefault();
          e.stopPropagation();
          showRequestModal(data.filePath, data.methodName, data.line);
          return;
        }
      }
    }

    // Last resort: if getTargetAtClientPoint didn't work, use scroll-based approach
    const scrollTop = editor.getScrollTop();
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const editorRect = editor.getDomNode().getBoundingClientRect();
    const relY = rect.bottom - editorRect.top + scrollTop;
    const approxLine = Math.round(relY / lineHeight);
    for (let offset = -2; offset <= 5; offset++) {
      const data = _codeLensMap.get(uriKey + ':' + (approxLine + offset));
      if (data) {
        e.preventDefault();
        e.stopPropagation();
        showRequestModal(data.filePath, data.methodName, data.line);
        return;
      }
    }
  }, true);
}

/**
 * If the given absolute offset in `text` sits inside a `[ SELECT ... ]` SOQL
 * literal, return that literal (including brackets); otherwise null.
 * Works across newlines so multi-line queries are captured whole.
 */
function extractSoqlAtOffset(text, offset) {
  let open = -1, depth = 0;
  for (let i = offset; i >= 0; i--) {
    const c = text[i];
    if (c === ';' || c === '{' || c === '}') break;
    if (c === ']') depth++;
    else if (c === '[') { if (depth === 0) { open = i; break; } depth--; }
  }
  if (open < 0) return null;
  let d = 0, close = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '[') d++;
    else if (c === ']') { d--; if (d === 0) { close = i; break; } }
  }
  if (close < 0 || offset > close) return null;
  const inner = text.slice(open + 1, close);
  if (!/^\s*SELECT\b/i.test(inner)) return null;
  return text.slice(open, close + 1);
}

/**
 * Starting at `parenOffset` (which should point at a '('), return the offset
 * just past the matching ')'. Scans across newlines. Null if unbalanced.
 */
function matchCloseParen(text, parenOffset) {
  if (text[parenOffset] !== '(') return null;
  let d = 0;
  for (let i = parenOffset; i < text.length; i++) {
    const c = text[i];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return i + 1; }
  }
  return null;
}

/**
 * True when an argument list looks like a method-definition parameter list
 * (each arg is a `Type name` pair) rather than a call's actual arguments.
 * e.g. "ID priceListID, List<ID> productGroupIds" -> true;
 *      "priceListId, productGroupIds" or "getId(), 5" -> false.
 */
function looksLikeParamList(argsStr) {
  const inner = (argsStr || '').trim();
  if (!inner) return false;
  // Split on top-level commas (ignore commas inside <...> generics or (...) calls).
  const parts = [];
  let depth = 0, buf = '';
  for (const ch of inner) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; }
    else buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  if (!parts.length) return false;
  for (const raw of parts) {
    const a = raw.trim();
    if (!a) return false;
    // Real arguments contain literals/operators/assignments/calls — reject those.
    if (/['"]|==|!=|>=|<=|&&|\|\||\?|=|\(|\)/.test(a)) return false;
    // Must be exactly: Type identifier  (type may carry generics/arrays).
    if (!/^(?:final\s+)?[A-Za-z_][\w.]*(?:\s*<[^)]*>)?(?:\s*\[\s*\])?\s+[A-Za-z_]\w*$/.test(a)) return false;
  }
  return true;
}

/**
 * Infer a local variable's declared Apex type by reading the source above the
 * cursor — the same way a developer would. Recognizes for-each loop variables,
 * plain declarations, and method parameters. Returns e.g. "RemoteCPQ.LineItemDO".
 */
function inferVarTypeFromSource(model, uptoLine, varName) {
  if (!model || !varName || /[.[\]()]/.test(varName)) return null;
  const v = escapeRegex(varName);
  const typeCore = '([A-Za-z_][\\w.]*(?:\\s*<[^>]*>)?(?:\\s*\\[\\s*\\])?)';
  const patterns = [
    new RegExp(`\\bfor\\s*\\(\\s*(?:final\\s+)?${typeCore}\\s+${v}\\s*:`),        // for-each
    new RegExp(`(?:^\\s*|[({,;]\\s*)(?:final\\s+)?${typeCore}\\s+${v}\\s*(?:[=;)]|:)`), // decl / param
  ];
  const skip = new Set(['return', 'new', 'else', 'if', 'while', 'for', 'instanceof']);
  const total = model.getLineCount ? model.getLineCount() : uptoLine;
  const end = Math.min(uptoLine, total);
  let best = null;
  for (let ln = 1; ln <= end; ln++) {
    const text = model.getLineContent(ln);
    if (!text.includes(varName)) continue;
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1] && !skip.has(m[1].trim().toLowerCase())) {
        best = m[1].replace(/\s+/g, '').trim(); // closest (latest) declaration wins
      }
    }
  }
  return best;
}

/**
 * Register the hover provider that shows debug info during active sessions.
 * Shows Chrome DevTools-style value tooltips on variable hover.
 */
function registerDebugHoverProvider() {
  if (typeof monaco === 'undefined') return;

  // Apex keywords that should never show hover values
  const APEX_KEYWORDS = new Set([
    'public','private','protected','global','static','final','override','virtual','abstract',
    'class','interface','enum','trigger','extends','implements','with','sharing','without',
    'if','else','for','while','do','switch','when','try','catch','finally','throw',
    'return','break','continue','new','this','super','null','true','false',
    'void','String','Integer','Long','Double','Decimal','Boolean','Date','Datetime','Time',
    'Id','Blob','Object','List','Set','Map','SObject','Database','System','Test',
    'insert','update','delete','upsert','merge','undelete',
    'SELECT','FROM','WHERE','AND','OR','NOT','IN','LIKE','ORDER','BY','GROUP','HAVING',
    'LIMIT','OFFSET','ASC','DESC','NULLS','FIRST','LAST','TRUE','FALSE'
  ]);

  monaco.languages.registerHoverProvider('apex', {
    provideHover: (model, position) => {
      if (!debugState.active || !debugState.paused) return null;

      const word = model.getWordAtPosition(position);
      if (!word) return null;
      // Skip Apex keywords and type names
      if (APEX_KEYWORDS.has(word.word)) return null;

      const lineContent = model.getLineContent(position.lineNumber);

      // Build the full dotted expression by scanning left/right from the word bounds
      const wordStart = word.startColumn - 1; // 0-based index in lineContent
      const wordEnd = word.endColumn - 1;

      // Scan left from wordStart for ".word" patterns
      let exprStart = wordStart;
      while (exprStart > 0 && lineContent[exprStart - 1] === '.') {
        let j = exprStart - 2;
        while (j >= 0 && /[\w]/.test(lineContent[j])) j--;
        if (j < exprStart - 2) {
          exprStart = j + 1;
        } else {
          break;
        }
      }

      // Scan right from wordEnd for ".word" patterns
      let exprEnd = wordEnd;
      while (exprEnd < lineContent.length && lineContent[exprEnd] === '.') {
        let j = exprEnd + 1;
        while (j < lineContent.length && /[\w]/.test(lineContent[j])) j++;
        if (j > exprEnd + 1) {
          exprEnd = j;
        } else {
          break;
        }
      }

      const fullPath = lineContent.substring(exprStart, exprEnd);
      const rangeStart = exprStart + 1; // back to 1-based
      const rangeEnd = exprEnd + 1;

      // Work against the full document text so multi-line calls / SOQL are captured.
      const fullText = model.getValue();
      const cursorOffset = model.getOffsetAt(position);
      const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

      // ---- SOQL: if the cursor is inside a [SELECT ...] literal, run it in the org. ----
      const soqlLiteral = extractSoqlAtOffset(fullText, cursorOffset);

      // ---- Method call: capture the full (possibly multi-line) call expression. ----
      const exprEndOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: exprEnd + 1 });
      let callExpr = null;
      let callArgsInner = null;
      let callFollowedByBrace = false;
      {
        let j = exprEndOffset;
        while (j < fullText.length && (fullText[j] === ' ' || fullText[j] === '\t')) j++;
        if (fullText[j] === '(') {
          const close = matchCloseParen(fullText, j);
          if (close != null) {
            const exprStartOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: exprStart + 1 });
            callExpr = fullText.slice(exprStartOffset, close).replace(/\s+/g, ' ').trim();
            callArgsInner = fullText.slice(j + 1, close - 1);
            // Peek past the close paren: a method *definition* is followed by `{`
            // (and, for interfaces/abstract, `;`), whereas a real call is followed by
            // `;`, `.`, `,`, `)`, or an operator.
            let k = close;
            while (k < fullText.length && /\s/.test(fullText[k])) k++;
            callFollowedByBrace = fullText[k] === '{';
          }
        }
      }

      // Also try just the hovered word in case fullPath doesn't resolve
      const paths = [fullPath];
      if (fullPath !== word.word) paths.push(word.word);

      // Search all frames in the call stack (current frame first, then up)
      let value;
      let resolvedPath = null;
      for (let fi = debugState.callStack.length - 1; fi >= 0; fi--) {
        const frame = debugState.callStack[fi];
        const hoverScope = { ...(frame.classFields || {}), ...frame.variables };
        for (const p of paths) {
          const v = resolveProperty(hoverScope, p);
          if (v !== undefined) { value = v; resolvedPath = p; break; }
        }
        if (resolvedPath) break;
      }

      const topFrame = debugState.callStack[debugState.callStack.length - 1];

      // Look up a variable's declared Apex type across the call stack.
      const lookupVarType = (name) => {
        if (!name || /[.[\]()]/.test(name)) return null;
        for (let fi = debugState.callStack.length - 1; fi >= 0; fi--) {
          const vt = debugState.callStack[fi].varTypes;
          if (vt && name in vt) return vt[name];
        }
        return null;
      };

      // Look up for-each iteration state (index/total/collection) for a variable.
      const lookupLoopIter = (name) => {
        if (!name || /[.[\]()]/.test(name)) return null;
        for (let fi = debugState.callStack.length - 1; fi >= 0; fi--) {
          const it = debugState.callStack[fi]._iter;
          if (it && name in it) return it[name];
        }
        return null;
      };

      // Build a Monaco hover payload for a resolved value.
      const makeHover = (displayPath, val, opts = {}) => {
        const contents = [];
        const declaredType = opts.declaredType || lookupVarType(displayPath);
        const typeName = getValueTypeName(val, declaredType);
        const tag = opts.realOrg ? ' · _real org value_' : '';
        // Distinguish a for-each ELEMENT from its COLLECTION so a 1-item list
        // (where element ≈ collection) is never ambiguous.
        const iter = lookupLoopIter(displayPath);
        const iterTag = iter
          ? (iter.index >= 0
              ? ` · _element ${iter.index + 1} of ${iter.total} from \`${iter.collection}\`_`
              : ` · _no elements in \`${iter.collection}\`_`)
          : '';
        contents.push({ value: `**\`${displayPath}\`** : *${typeName}*${tag}${iterTag}` });
        if (val === null) {
          contents.push({ value: '```\nnull\n```' });
        } else if (typeof val === 'object') {
          const cleanValue = Array.isArray(val) ? val : (() => {
            const o = {}; for (const k of Object.keys(val).filter(k => !k.startsWith('__'))) o[k] = val[k]; return o;
          })();
          const jsonStr = JSON.stringify(cleanValue, null, 2);
          const typeLabel = Array.isArray(val) ? `List (${val.length} items)` : `Object (${Object.keys(cleanValue).length} fields)`;
          contents.push({ value: `\`${typeLabel}\`\n\n` + '```json\n' + jsonStr + '\n```' });
        } else {
          contents.push({ value: '```\n' + String(val) + '\n```' });
        }
        if (opts.realOrg) contents.push({ value: '_↳ also saved to the Console tab_' });
        const range = opts.range || (resolvedPath === word.word
          ? wordRange
          : new monaco.Range(position.lineNumber, rangeStart, position.lineNumber, rangeEnd));
        return { range, contents };
      };

      const errHover = (title, msg) => ({ range: wordRange, contents: [{ value: `**\`${title}\`**\n\n_org eval:_ ${msg}` }] });

      // 1) Resolved locally to a concrete (non-null) value → show it immediately.
      if (value !== undefined && value !== null && !soqlLiteral) {
        return makeHover(resolvedPath || fullPath, value);
      }

      // 2) SOQL literal under the cursor → run it against the org.
      if (soqlLiteral && liveOrgAvailable()) {
        return evaluateSoqlInOrg(soqlLiteral, topFrame).then((r) => {
          if (r.error) return errHover('SOQL', r.error + (r.soql ? `\n\n\`\`\`sql\n${r.soql}\n\`\`\`` : ''));
          const preview = r.records.slice(0, 15);
          const body = [
            `**SOQL** · _${r.records.length} row(s) from the org_`,
            '```sql\n' + r.soql + '\n```',
            '```json\n' + JSON.stringify(preview, null, 2) + '\n```',
            '_↳ also saved to the Console tab_'
          ].join('\n\n');
          // Persist once per unique query so repeat hovers don't spam the console.
          if (!debugState._soqlHoverLogged) debugState._soqlHoverLogged = new Set();
          if (!debugState._soqlHoverLogged.has(r.soql)) {
            debugState._soqlHoverLogged.add(r.soql);
            addConsoleEntry('soql', `[SOQL] ${r.soql} → ${r.records.length} row(s)`);
            if (r.records.length) addConsoleEntry('result-json', JSON.stringify(preview, null, 2));
          }
          return { range: wordRange, contents: [{ value: body }] };
        }).catch(() => null);
      }

      // 3) Method call or qualified expression not resolvable locally → org eval.
      const orgExpr = callExpr || fullPath;
      // A method *definition* / signature is not an evaluable expression. Detect it
      // (args are `Type name` pairs and/or the call is immediately followed by `{`)
      // and show an informative hover instead of a bogus "Compilation failed" error.
      if (callExpr && (callFollowedByBrace || looksLikeParamList(callArgsInner))) {
        const params = (splitArgs(callArgsInner || '') || [])
          .map(p => p.trim()).filter(Boolean);
        const lines = [`**\`${word.word}\`** : *method definition*`];
        if (params.length) {
          lines.push('Parameters:\n' + params.map(p => `- \`${p}\``).join('\n'));
        } else {
          lines.push('_No parameters._');
        }
        lines.push('_Step into this method (F11) to watch it execute with real values._');
        return { range: wordRange, contents: [{ value: lines.join('\n\n') }] };
      }

      // Fallback org-eval, wrapped so local interpretation can defer to it.
      const orgEvalHover = () => {
        const canOrgEval = liveOrgAvailable() && topFrame && (callExpr || fullPath.includes('.'));
        if (canOrgEval) {
          const cache = debugState.orgEvalCache;
          const rw = (() => { try { return rewriteExprForOrg(orgExpr, topFrame); } catch { return null; } })();
          if (rw && cache && cache.has(rw.resolvedExpr)) {
            const cached = cache.get(rw.resolvedExpr);
            if (cached.error) return errHover(orgExpr, cached.error);
            return makeHover(orgExpr, cached.value, { realOrg: true, range: wordRange });
          }
          return evaluateInOrg(orgExpr, topFrame).then((r) => {
            if (r.error) {
              addConsoleEntry('info', `${orgExpr} → (org eval) ${r.error}`);
              return errHover(orgExpr, r.error);
            }
            addConsoleEntry('result', `${orgExpr} → ${formatValue(r.value)}  (real org value)`);
            return makeHover(orgExpr, r.value, { realOrg: true, range: wordRange });
          }).catch(() => null);
        }
        // Local null with no org available → still show the null.
        if (value === null) return makeHover(resolvedPath || fullPath, null);
        return null;
      };

      // 3.5) Instance method call on an already-resolved object → interpret the
      // method locally against that object (honors its if/else + loops, V8-style).
      // e.g. lineItemDO.primaryLineItemSO() returns chargeLines[0].lineItemSO.
      const instCall = callExpr && callExpr.match(/^([A-Za-z_][\w.[\]]*)\.(\w+)\s*\((.*)\)$/);
      if (instCall) {
        const recvPath = instCall[1], methodNm = instCall[2], argsRaw = instCall[3];
        let recvObj, recvFrameScope;
        for (let fi = debugState.callStack.length - 1; fi >= 0; fi--) {
          const frame = debugState.callStack[fi];
          const s = { ...(frame.classFields || {}), ...frame.variables };
          const o = resolveProperty(s, recvPath);
          if (o !== undefined) { recvObj = o; recvFrameScope = s; break; }
        }
        if (recvObj && typeof recvObj === 'object') {
          const typeHint = inferVarTypeFromSource(model, position.lineNumber, recvPath)
            || lookupVarType(recvPath) || recvObj.__type__;
          const argVals = argsRaw && argsRaw.trim()
            ? splitArgs(argsRaw).map(a => evaluateExpression(a.trim(), recvFrameScope)) : [];
          return evaluateUserMethodLocally(recvObj, methodNm, argVals, typeHint, 0).then((res) => {
            if (res !== undefined) {
              addConsoleEntry('result', `${callExpr} → ${formatValue(res)}  (computed from live object)`);
              return makeHover(callExpr, res, { realOrg: true, range: wordRange });
            }
            return orgEvalHover();
          }).catch(() => orgEvalHover());
        }
      }

      return orgEvalHover();
    }
  });
}

function getValueTypeName(val, declaredType) {
  // Prefer the declared Apex type for empty-but-typed collections/values so hover
  // shows e.g. `List<LineItem__c>` instead of the generic `List<Object>[0]`.
  if (declaredType) {
    const dt = declaredType.trim();
    const dtLower = dt.toLowerCase();
    if (Array.isArray(val)) return `${dt} (${val.length})`;
    if (val instanceof Set) return `${dt} (${val.size})`;
    if (val && typeof val === 'object' && dtLower.startsWith('map')) {
      return `${dt} (${Object.keys(val).filter(k => !k.startsWith('__')).length})`;
    }
    if ((val === null || val === undefined) && dt) return dt;
    if (typeof val !== 'object') return dt;
  }
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return 'String';
  if (typeof val === 'number') return Number.isInteger(val) ? 'Integer' : 'Decimal';
  if (typeof val === 'boolean') return 'Boolean';
  if (Array.isArray(val)) return `List<Object>[${val.length}]`;
  if (val instanceof Set) return `Set<Object>(${val.size})`;
  if (typeof val === 'object') {
    if (val.__type__) return val.__type__;
    return `Object{${Object.keys(val).filter(k => !k.startsWith('__')).length}}`;
  }
  return typeof val;
}

/**
 * Default value for an Apex type, matching how Apex initializes locals:
 * List/Set -> [], Map -> {}, numeric -> 0, Boolean -> false, everything else -> null.
 */
function defaultForApexType(varType) {
  if (!varType) return null;
  const t = varType.trim().toLowerCase();
  if (t.startsWith('list') || t.startsWith('set') || t.endsWith('[]')) return [];
  if (t.startsWith('map')) return {};
  if (t === 'integer' || t === 'int' || t === 'long' || t === 'double' || t === 'decimal') return 0;
  if (t === 'boolean') return false;
  return null;
}

/* ================================================================
   15. GUTTER CLICK HANDLER — Toggle breakpoints
   ================================================================ */

function registerGutterClickHandler() {
  const editor = window.state?.editor;
  if (!editor) return;

  editor.onMouseDown((e) => {
    // Target type 2 = GUTTER_GLYPH_MARGIN
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      const line = e.target.position.lineNumber;
      const model = editor.getModel();
      if (!model) return;
      const uri = model.uri;
      const filePath = uri.fsPath || uri.path;
      // Only allow breakpoints on .cls and .trigger files
      if (!filePath.endsWith('.cls') && !filePath.endsWith('.trigger')) return;

      if (e.event.rightButton) {
        // Right-click: add/edit conditional breakpoint
        e.event.preventDefault();
        const bps = debugState.breakpoints.get(filePath);
        const current = bps?.get(line);
        const condition = prompt('Enter breakpoint condition:', current?.condition || '');
        if (condition !== null) {
          toggleBreakpoint(filePath, line, condition || null);
        }
      } else {
        toggleBreakpoint(filePath, line);
      }
    }
  });
}

/* ================================================================
   16. DEBUG PANEL TAB SWITCHING
   ================================================================ */

function initDebugPanelTabs() {
  const tabs = _$$('#debug-panel .dbg-panel-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      // Update active tab
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // Show target content
      _$$('#debug-panel .dbg-tab-content').forEach(c => c.classList.remove('active'));
      _$(`#${target}`)?.classList.add('active');
    });
  });
}

/* ================================================================
   17. INIT — Wire everything together
   ================================================================ */

function initApexDebugger() {
  registerDebugProviders();
  registerDebugHoverProvider();

  // Need to wait for editor to be ready
  const checkEditor = setInterval(() => {
    if (window.state?.editor) {
      clearInterval(checkEditor);
      registerGutterClickHandler();

      // Enable glyphMargin for breakpoint gutter
      window.state.editor.updateOptions({ glyphMargin: true });

      // Listen for model changes to re-apply breakpoint decorations
      window.state.editor.onDidChangeModel(() => {
        const model = window.state.editor.getModel();
        if (model) {
          const uri = model.uri;
          const filePath = uri.fsPath || uri.path;
          if (filePath.endsWith('.cls') || filePath.endsWith('.trigger')) {
            renderBreakpointDecorations(filePath);
            if (debugState.active) {
              highlightCurrentLine();
            }
          }
        }
      });

      // Register CodeLens command handler
      window.state.editor.addAction({
        id: 'congacode.debugMethod',
        label: '▶ Debug This Method',
        contextMenuGroupId: 'z_debug',
        contextMenuOrder: 0,
        run: (ed, ...args) => {
          // If called from CodeLens, args contain [filePath, methodName, line]
          if (args.length >= 2 && typeof args[0] === 'string' && typeof args[1] === 'string') {
            showRequestModal(args[0], args[1], args[2]);
            return;
          }

          // Fallback: context menu — detect method at cursor
          const model = ed.getModel();
          const position = ed.getPosition();
          if (!model || !position) return;
          const fp = (model.uri.fsPath || model.uri.path);

          const lines = model.getLinesContent();
          const methodRegex = /(?:public|private|protected|global)\s+(?:static\s+)?(?:override\s+)?(?:testMethod\s+)?(?:[\w<>\[\],.\s]+?)\s+(\w+)\s*\(/i;
          let targetMethod = null;
          let targetLine = 0;
          for (let i = position.lineNumber - 1; i >= Math.max(0, position.lineNumber - 20); i--) {
            const m = lines[i].match(methodRegex);
            if (m && !/\b(class|interface|enum|trigger)\b/i.test(lines[i]) && !lines[i].trim().startsWith('@')) {
              targetMethod = m[1];
              targetLine = i + 1;
              break;
            }
          }
          if (targetMethod) {
            showRequestModal(fp, targetMethod, targetLine);
          }
        }
      });
    }
  }, 200);

  // Wire up debug toolbar buttons
  _$('#dbg-btn-continue')?.addEventListener('click', debugContinue);
  _$('#dbg-btn-step-over')?.addEventListener('click', debugStepOver);
  _$('#dbg-btn-step-into')?.addEventListener('click', debugStepInto);
  _$('#dbg-btn-step-out')?.addEventListener('click', debugStepOut);
  _$('#dbg-btn-stop')?.addEventListener('click', stopDebugSession);
  _$('#dbg-btn-restart')?.addEventListener('click', debugRestart);

  // Live Org toggle
  _$('#dbg-liveorg-checkbox')?.addEventListener('change', toggleLiveOrgMode);
  _$('#dbg-btn-run-org')?.addEventListener('click', runEntryMethodInOrg);

  // Wire up request modal
  _$('#dbg-modal-start')?.addEventListener('click', startDebugFromModal);
  _$('#dbg-modal-close')?.addEventListener('click', hideRequestModal);
  _$('#dbg-modal-cancel')?.addEventListener('click', hideRequestModal);

  // Debug panel tabs
  initDebugPanelTabs();

  // Debug panel resizer
  initDebugPanelResizer();

  // Console input for expression evaluation
  initConsoleInput();

  // Watch expression input
  initWatchInput();

  // Console clear button
  _$('#dbg-console-clear')?.addEventListener('click', () => {
    debugState.consoleLog = [];
    renderConsolePanel();
  });

  // Global keyboard handler for CodeLens command
  document.addEventListener('congacode-debug-method', (e) => {
    const { filePath, methodName, line } = e.detail;
    showRequestModal(filePath, methodName, line);
  });

  // Breakpoint toggle from keyboard (F9 via app.js)
  document.addEventListener('congacode-toggle-breakpoint', (e) => {
    const { filePath, line } = e.detail;
    toggleBreakpoint(filePath, line);
  });
}

function initDebugPanelResizer() {
  const resizer = _$('#debug-panel-resizer');
  const panel = _$('#debug-panel');
  if (!resizer || !panel) return;

  let startY, startHeight;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startHeight = panel.offsetHeight;
    resizer.classList.add('dragging');
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onStop);
  });
  function onDrag(e) {
    const delta = startY - e.clientY;
    const newH = Math.max(80, Math.min(600, startHeight + delta));
    panel.style.height = newH + 'px';
    // Trigger Monaco layout refresh so editor resizes above the panel
    window.state?.editor?.layout();
  }
  function onStop() {
    resizer.classList.remove('dragging');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onStop);
    window.state?.editor?.layout();
  }
}

/* ================================================================
   18. WATCH EXPRESSIONS & CONSOLE EVALUATOR
   ================================================================ */

function initWatchInput() {
  const input = _$('#dbg-watch-input');
  if (!input) return;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const expr = input.value.trim();
      if (!expr) return;
      debugState.watchExpressions.push({ expr, id: debugState.watchNextId++ });
      input.value = '';
      renderWatchPanel();
    }
  });
}

function initConsoleInput() {
  const input = _$('#dbg-console-input');
  if (!input) return;

  const history = [];
  let histIdx = -1;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const expr = input.value.trim();
      if (!expr) return;

      history.push(expr);
      histIdx = history.length;
      input.value = '';

      evaluateConsoleExpression(expr);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histIdx > 0) {
        histIdx--;
        input.value = history[histIdx];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < history.length - 1) {
        histIdx++;
        input.value = history[histIdx];
      } else {
        histIdx = history.length;
        input.value = '';
      }
    }
  });
}

/* ================================================================
   LIVE ORG EXPRESSION EVALUATION
   Evaluate an arbitrary Apex expression (method call, custom setting,
   label, describe, SOQL, etc.) against the connected org using the
   CURRENT frame's real variable values as bindings. This is what makes
   the debugger behave like a real engine: by the time you reach a line,
   any org-dependent value can be resolved on demand with real data.
   Read-only: wrapped in a savepoint + rollback so the org is untouched.
   ================================================================ */

const APEX_TYPE_NAMES = new Set([
  'string','integer','long','double','decimal','boolean','date','datetime','time',
  'id','blob','object','list','set','map','sobject','database','system','test',
  'schema','math','json','limits','userinfo','type','label','cache','featuremanagement'
]);

/** Convert a JS scalar to an Apex literal for inline substitution. Returns null for non-scalars. */
function toApexLiteral(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    // Unresolved heap ref → can't substitute meaningfully.
    if (ADDR_RE.test(val)) return null;
    return `'${escapeApexString(val)}'`;
  }
  return null; // objects / arrays / collections not inline-substitutable
}

/** Whether an identifier is a built-in Apex type/namespace (so we don't class-qualify it). */
function isApexTypeName(name) {
  return APEX_TYPE_NAMES.has(String(name).toLowerCase());
}

/**
 * Rewrite an expression so it can run as anonymous Apex:
 *  - substitute in-scope scalar variables with their real literal values,
 *  - qualify a leading bare method call with the current frame's class.
 * Returns { resolvedExpr, unresolved: [names of object/ref vars we couldn't inline] }.
 */
function rewriteExprForOrg(expr, frame) {
  const scope = { ...(frame.classFields || {}), ...frame.variables };
  const unresolved = [];
  const resolvedExpr = expr.replace(/(?<![.\w$])([A-Za-z_]\w*)\b/g, (m, id, offset, str) => {
    // Skip method-call names (identifier immediately followed by '(').
    if (/^\s*\(/.test(str.slice(offset + id.length))) return m;
    if (isApexTypeName(id)) return m;
    if (!(id in scope)) return m;
    const lit = toApexLiteral(scope[id]);
    if (lit != null) return lit;
    unresolved.push(id); // in scope but a complex object we can't inline
    return m;
  });
  // Qualify a leading bare method call (e.g. getConstraintMode(...)) with the frame's class.
  let out = resolvedExpr;
  const bareCall = out.match(/^([A-Za-z_]\w*)\s*\(/);
  if (bareCall && frame.className && !isApexTypeName(bareCall[1])) {
    out = `${frame.className}.${out}`;
  }
  return { resolvedExpr: out, unresolved };
}

/** Build the anonymous Apex that evaluates a single expression read-only. */
function buildEvalApex(resolvedExpr) {
  return [
    `Savepoint ccEvSp = Database.setSavepoint();`,
    `Object ccEvVal;`,
    `String ccEvErr = '';`,
    `try {`,
    `    ccEvVal = (Object)( ${resolvedExpr} );`,
    `} catch (Exception ccEvE) {`,
    `    ccEvErr = ccEvE.getTypeName() + ': ' + ccEvE.getMessage();`,
    `} finally {`,
    `    try { Database.rollback(ccEvSp); } catch (Exception ccEvRe) {}`,
    `}`,
    `String ccEvOut;`,
    `try { ccEvOut = JSON.serialize(ccEvVal); } catch (Exception ccEvSe) { ccEvOut = '"<unserializable: ' + String.valueOf(ccEvVal) + '>"'; }`,
    `System.debug(LoggingLevel.ERROR, '__CC_EVAL__' + ccEvOut);`,
    `System.debug(LoggingLevel.ERROR, '__CC_EVALERR__' + ccEvErr);`,
  ].join('\n');
}

/** Prefix a leading managed-package Apex class reference with the namespace (ns.Class…). */
function applyNamespaceToApex(expr, ns) {
  if (!ns) return expr;
  const m = expr.match(/^([A-Za-z_]\w*)\s*\./);
  if (!m) return expr;
  const head = m[1];
  if (isApexTypeName(head) || head === ns) return expr;
  return ns + '.' + expr;
}

/** Run one anonymous-Apex evaluation of a resolved expression. Returns { value?, error?, compileFailed?, resolvedExpr }. */
async function _runEvalApex(resolvedExpr) {
  const org = getActiveOrg();
  const apex = buildEvalApex(resolvedExpr);
  try {
    const paths = await window.congacode.getPaths?.();
    const dir = paths?.congacodeDir || paths?.home || '.';
    const tmpFile = `${dir}/.cc_debug_eval.apex`;
    await window.congacode.writeFile(tmpFile, apex);
    const cmd = `sf apex run --file "${tmpFile}" --json --target-org ${org.org}`;
    const { stdout, stderr } = await window.congacode.sfExec(cmd, window.state?.folderPath, 60000);
    const cli = parseSfJson(stdout);
    const res = (cli && (cli.result || cli.data)) || {};
    const log = res.logs || '';
    // Auth / CLI-level failure (e.g. IP restriction) → surface the real message.
    if (cli && cli.status && cli.status !== 0 && !res.logs) {
      return { error: sfErrorText(cli, stderr, stdout, 'Org command failed'), resolvedExpr };
    }
    const compileProblem = res.compileProblem || (res.compiled === false ? (cli && cli.message) : null);
    if (res.compiled === false || compileProblem) {
      return { error: `Compile failed: ${compileProblem || 'unknown'}`, compileFailed: true, resolvedExpr };
    }
    let raw = null, evalErr = '';
    for (const line of log.split('\n')) {
      const pipe = line.split('|');
      const msg = pipe.length >= 5 ? pipe.slice(4).join('|') : '';
      if (msg.startsWith('__CC_EVAL__')) raw = msg.slice('__CC_EVAL__'.length);
      else if (msg.startsWith('__CC_EVALERR__')) evalErr = msg.slice('__CC_EVALERR__'.length);
    }
    if (evalErr) return { error: evalErr, resolvedExpr };
    if (raw != null) {
      let value;
      try { value = JSON.parse(raw); } catch { value = raw; }
      return { value, resolvedExpr };
    }
    // No markers and no clear failure flag — report the real reason, not the update banner.
    return { error: sfErrorText(cli, stderr, stdout, 'Org returned no debug output (is FINEST logging enabled for the running user?)'), resolvedExpr };
  } catch (e) {
    return { error: e?.message || String(e), resolvedExpr };
  }
}

/**
 * Evaluate an expression against the connected org using the given frame's
 * bindings. Cached per resolved-expression. Returns { value?, error?, resolvedExpr }.
 */
async function evaluateInOrg(expr, frame) {
  if (!frame) return { error: 'No active frame' };
  if (!liveOrgAvailable()) return { error: 'Connect an org and enable Live Org first' };

  // A method definition / signature (args are `Type name` pairs) is not an evaluable
  // expression — don't send it to the compiler, explain instead.
  const sigCall = expr.match(/^\s*[A-Za-z_][\w.]*\s*\((.*)\)\s*$/s);
  if (sigCall && looksLikeParamList(sigCall[1])) {
    return { error: `That's a method definition, not a value. Set a breakpoint inside it or Step Into (F11) to watch it run with real values.`, resolvedExpr: expr };
  }

  // Pure field-access path (no method calls) → resolve from the replay-captured
  // frame directly. After ▶ Run in Org, object variables hold real state, so
  // `configSO.PriceListId__c` etc. return real values with no org round-trip.
  if (/^[A-Za-z_][\w.]*$/.test(expr) && expr.includes('.')) {
    const scope = { ...(frame.classFields || {}), ...frame.variables };
    const local = resolveProperty(scope, expr);
    if (local !== undefined) return { value: local, resolvedExpr: expr, fromFrame: true };
  }

  const { resolvedExpr, unresolved } = rewriteExprForOrg(expr, frame);
  if (unresolved.length) {
    const names = [...new Set(unresolved)].join(', ');
    return { error: `Can't evaluate: ${names} ${unresolved.length > 1 ? 'are' : 'is'} a runtime object built inside the method, and anonymous Apex can't call methods on it or rebuild it (private helpers/state aren't reachable). Use ▶ Run in Org to replay the whole method, then hover the variable itself for its real value — or set a value in the Console (e.g. \`${unresolved[0]} = …\`).`, resolvedExpr };
  }

  if (!debugState.orgEvalCache) debugState.orgEvalCache = new Map();
  if (debugState.orgEvalCache.has(resolvedExpr)) {
    return debugState.orgEvalCache.get(resolvedExpr);
  }

  let result = await _runEvalApex(resolvedExpr);
  // Managed-package Apex classes may need the namespace prefix
  // (e.g. SObjectConstants → Apttus_Config2.SObjectConstants). Retry once.
  if (result.compileFailed) {
    const ns = await getPackageNamespace();
    const nsExpr = applyNamespaceToApex(resolvedExpr, ns);
    if (ns && nsExpr !== resolvedExpr) {
      const r2 = await _runEvalApex(nsExpr);
      if (!r2.error) result = r2;
    }
  }
  const out = result.error ? { error: result.error, resolvedExpr: result.resolvedExpr || resolvedExpr }
                           : { value: result.value, resolvedExpr: result.resolvedExpr || resolvedExpr };
  debugState.orgEvalCache.set(resolvedExpr, out);
  return out;
}

/** Console-triggered org evaluation: runs the expression in the org and prints the result. */
async function evaluateExpressionInOrg(expr) {
  const frame = debugState.callStack[debugState.callStack.length - 1];
  addConsoleEntry('info', `⚙ Evaluating in org: ${expr} …`);
  const r = await evaluateInOrg(expr, frame);
  if (r.error) {
    addConsoleEntry('error', `Org eval error: ${r.error}`);
  } else {
    if (r.resolvedExpr && r.resolvedExpr !== expr) addConsoleEntry('info', `↳ ran: ${r.resolvedExpr}`);
    if (typeof r.value === 'object' && r.value !== null) {
      addConsoleEntry('result-json', JSON.stringify(r.value, null, 2));
    } else {
      addConsoleEntry('result', `${expr} → ${formatValue(r.value)}  (real org value)`);
    }
  }
}

/** Console-triggered SOQL: resolves binds from the frame, runs the query in the org, prints rows. */
async function runConsoleSoql(rawQuery) {
  const frame = debugState.callStack[debugState.callStack.length - 1];
  addConsoleEntry('info', `⚙ Running SOQL in org…`);
  const r = await evaluateSoqlInOrg(rawQuery, frame);
  if (r.soql) addConsoleEntry('info', `↳ ${r.soql}`);
  if (r.error) { addConsoleEntry('error', `SOQL error: ${r.error}`); return; }
  addConsoleEntry('soql', `${r.records.length} row(s) returned`);
  if (r.records.length) addConsoleEntry('result-json', JSON.stringify(r.records.slice(0, 25), null, 2));
}

/** Clickable affordance handler: evaluate an expression in the org and inject it as a variable. */
window._dbgEvalInOrg = async function (varName, expr) {
  const frame = debugState.callStack[debugState.callStack.length - 1];
  if (!frame) return;
  addConsoleEntry('info', `⚙ Fetching real value of "${expr}" from org…`);
  const r = await evaluateInOrg(expr, frame);
  if (r.error) {
    addConsoleEntry('error', `Org eval error for ${expr}: ${r.error}`);
    window.showToast?.(`Org eval failed: ${r.error}`, 'error');
    return;
  }
  if (varName) frame.variables[varName] = r.value;
  addConsoleEntry('result', `${expr} → ${formatValue(r.value)}  (real org value)`);
  updateDebugPanels();
};

/**
 * Derive the best org-evaluable expression for a variable in a frame.
 * Prefers the variable's initializer from source (e.g. `flow = getFlow(configReq)`),
 * then a class-qualified reference for class fields, else the bare name.
 */
function deriveOrgExprForVar(scopeType, key, frame) {
  // 1) Try to find an initializer for this variable in the source.
  try {
    const model = window.state?.editor?.getModel?.();
    const src = model ? model.getValue() : '';
    if (src) {
      // Match `... key = <rhs>;` (declaration or reassignment), capture the RHS.
      const re = new RegExp('(?:^|[;{}\\s])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*([^;]+);');
      const m = src.match(re);
      if (m && m[1] && !/^\s*new\s/i.test(m[1])) {
        return m[1].trim();
      }
    }
  } catch (_) { /* ignore */ }
  // 2) Class field → qualify with the class name (works for statics/constants).
  if (scopeType === 'field' && frame && frame.className) {
    return `${frame.className}.${key}`;
  }
  // 3) Fallback: the bare name (rewriteExprForOrg may still class-qualify calls).
  return key;
}

window._dbgFetchVarFromOrg = async function (scopeType, key, ev) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  const frame = debugState.callStack[debugState.callStack.length - 1];
  if (!frame) return;
  const expr = deriveOrgExprForVar(scopeType, key, frame);
  await window._dbgEvalInOrg(key, expr);
};

function evaluateConsoleExpression(expr) {
  addConsoleEntry('eval', `> ${expr}`);

  if (!debugState.active || !debugState.paused) {
    addConsoleEntry('error', 'No active debug session');
    return;
  }

  const frame = debugState.callStack[debugState.callStack.length - 1];
  if (!frame) {
    addConsoleEntry('error', 'No active frame');
    return;
  }

  // Explicit org-eval prefix: ">>expr" or "org: expr" forces live org evaluation.
  const orgForced = expr.match(/^(?:>>|org:)\s*(.+)$/i);
  if (orgForced) { evaluateExpressionInOrg(orgForced[1].trim()); return; }

  // SOQL: `[SELECT ...]`, `SELECT ...`, or `soql: SELECT ...` runs against the org.
  const soqlMatch = expr.match(/^(?:soql:\s*)?(\[?\s*SELECT\b[\s\S]*)$/i);
  if (soqlMatch) { runConsoleSoql(soqlMatch[1].trim()); return; }

  // Live interpreter: evaluate in the real engine frame (supports method calls,
  // assignments, object graphs — anything the interpreter can execute).
  if (debugState.engineMode && debugState.engineSession) {
    evaluateEngineConsole(expr);
    return;
  }

  try {
    // Check for assignment: varName = value  or  obj.prop = value
    const assignMatch = expr.match(/^([\w.\[\]]+)\s*=\s*(.+)$/);
    if (assignMatch && !expr.match(/^[\w.\[\]]+\s*==[=]?/)) {
      const lhs = assignMatch[1].trim();
      const rhs = assignMatch[2].trim();
      const consoleScope = { ...(frame.classFields || {}), ...frame.variables };
      let newValue;
      // Try parsing as JSON first
      try { newValue = JSON.parse(rhs); } catch(_) {
        // Try evaluating as expression
        newValue = evaluateExpression(rhs, consoleScope);
      }
      // Assign to class field if it exists there, otherwise local
      if (frame.classFields && lhs in frame.classFields && !(lhs in frame.variables)) {
        assignProperty(frame.classFields, lhs, newValue);
      } else {
        assignProperty(frame.variables, lhs, newValue);
      }
      const assigned = resolveProperty(consoleScope, lhs);
      if (typeof assigned === 'object' && assigned !== null) {
        addConsoleEntry('result-json', JSON.stringify(assigned, null, 2));
      } else {
        addConsoleEntry('result', `${lhs} = ${formatValue(assigned)}`);
      }
      updateDebugPanels();
      return;
    }

    // Search all frames in the call stack (current first, then up)
    const evalScope = { ...(frame.classFields || {}), ...frame.variables };
    let value;
    for (let fi = debugState.callStack.length - 1; fi >= 0; fi--) {
      const f = debugState.callStack[fi];
      const fScope = { ...(f.classFields || {}), ...f.variables };
      const v = resolveProperty(fScope, expr);
      if (v !== undefined) { value = v; break; }
    }

    // If not found as a path, try evaluating as an expression against current frame
    if (value === undefined) {
      value = evaluateExpression(expr, evalScope);
    }

    if (value === undefined) {
      if (liveOrgAvailable()) {
        addConsoleEntry('info', `(not resolved locally — evaluating in org)`);
        evaluateExpressionInOrg(expr);
      } else {
        addConsoleEntry('result', 'undefined');
      }
    } else if (value === null) {
      // A local null may just mean "not executed yet" — offer the real org value.
      if (liveOrgAvailable() && /[.(]/.test(expr)) {
        addConsoleEntry('info', `(local value is null — evaluating in org for the real value)`);
        evaluateExpressionInOrg(expr);
      } else {
        addConsoleEntry('result', 'null');
      }
    } else if (typeof value === 'object') {
      addConsoleEntry('result-json', JSON.stringify(value, null, 2));
    } else {
      addConsoleEntry('result', String(value));
    }
  } catch (err) {
    addConsoleEntry('error', `Error: ${err.message}`);
  }

  // Switch to console tab if not already active
  const consoleTab = _$('.dbg-panel-tab[data-tab="dbg-console"]');
  if (consoleTab && !consoleTab.classList.contains('active')) {
    consoleTab.click();
  }
}

// Expose globally
window.initApexDebugger = initApexDebugger;
window.debugContinue = debugContinue;
window.debugStepOver = debugStepOver;
window.debugStepInto = debugStepInto;
window.debugStepOut = debugStepOut;
window.debugStop = stopDebugSession;
window.debugRestart = debugRestart;
window.showRequestModal = showRequestModal;
window.startDebugFromModal = startDebugFromModal;
window.debugState = debugState;

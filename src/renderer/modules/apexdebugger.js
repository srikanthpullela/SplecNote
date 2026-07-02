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
    if (declCallMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('return') && !trimmed.startsWith('try')) {
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
    if (assignCallMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('return')) {
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

  // new ClassName(...) — create object with class fields if available
  const newMatch = expr.match(/^new\s+([\w.]+)\s*\((.*)\)$/);
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
  const methodCallMatch = expr.match(/^([\w.[\]]+)\.(size|isEmpty|add|addAll|put|putAll|get|remove|contains|containsKey|containsAll|clear|clone|sort|intValue|longValue|doubleValue|toString|toLowerCase|toUpperCase|trim|length|substring|split|replace|replaceAll|startsWith|endsWith|indexOf|lastIndexOf|charAt|equals|equalsIgnoreCase|valueOf|values|keySet|format|abbreviate|capitalize|center|deleteWhitespace|isBlank|isNotBlank|isNumeric|join|left|mid|right|repeat|reverse|stripHtmlTags)\s*\((.*)\)\s*$/);
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

/**
 * Parse class-level fields from source code.
 * Returns { publicFields: {name: {type, value}}, privateFields: {...}, staticFields: {...}, allFields: {...} }
 */
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
}

function stopDebugSession() {
  debugState.active = false;
  debugState.paused = false;
  debugState.callStack = [];
  debugState.stepMode = null;
  clearCurrentLineHighlight();
  hideDebugUI();
  addConsoleEntry('info', '⏹ Debug session ended');
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
  // Replace SOQL bind expressions like :varName or :obj.field with real values.
  q = q.replace(/:([A-Za-z_]\w*(?:\.\w+)*)/g, (whole, expr) => {
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
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-JSON output */ }
    if (parsed && parsed.status === 0 && parsed.result) {
      result.records = (parsed.result.records || []).map(cleanSObject);
    } else {
      result.error = (parsed && parsed.message) || (stderr || stdout || 'Query failed').split('\n')[0];
    }
  } catch (e) {
    result.error = e?.message || String(e);
  }
  debugState.orgQueryCache.set(soql, result);
  return result;
}

/** Refresh the Live Org toggle/status indicator in the debug toolbar. */
function updateLiveOrgIndicator() {
  const checkbox = _$('#dbg-liveorg-checkbox');
  const status = _$('#dbg-liveorg-status');
  const org = getActiveOrg();
  const connected = !!(org && org.connected && org.org);
  if (checkbox) {
    checkbox.disabled = !connected;
    checkbox.checked = debugState.liveOrgMode && connected;
  }
  if (status) {
    if (debugState.orgFetching) {
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
  addConsoleEntry('info', debugState.liveOrgMode
    ? `⚡ Live Org mode ON — SOQL will query "${getActiveOrg().org}" (DML stays simulated)`
    : '○ Live Org mode OFF — SOQL returns simulated (empty) results');
  updateLiveOrgIndicator();
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
        frame.variables[stmt.varName] = evaluateExpression(stmt.expression, scope);
      }
      addConsoleEntry('var', `${stmt.varName} = ${formatValue(frame.variables[stmt.varName])}`, stmt.line);
      frame.pc++;
      break;

    case 'assignment':
      if (stmt._directValue !== undefined) {
        assignProperty(frame.variables, stmt.varName, JSON.parse(JSON.stringify(stmt._directValue)));
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
      const condResult = evaluateExpression(stmt.condition, scope);
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
          const collection = evaluateExpression(collectionExpr, scope);
          const items = Array.isArray(collection) ? collection : (collection != null && typeof collection === 'object' ? Object.values(collection) : []);
          addConsoleEntry('loop', `for (${iterVar} : ${collectionExpr}) — ${items.length} iterations`, stmt.line);
          // Unroll loop: insert body for each item
          const expanded = [];
          for (const item of items) {
            expanded.push({ line: stmt.line, type: 'assignment', raw: `${iterVar} = [loop item]`, varName: iterVar, _directValue: item });
            expanded.push(...JSON.parse(JSON.stringify(stmt.body)));
          }
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
        const condResult = evaluateExpression(stmt.condition, scope);
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
      // Not stepping in — try evaluating as a known method, else set null
      const existingObj = stmt.className ? resolveProperty(scope, stmt.className) : null;
      if (existingObj && typeof existingObj === 'object') {
        const simResult = simulateMethodCall(existingObj, stmt.methodName, stmt.argsRaw ? splitArgs(stmt.argsRaw).map(a => evaluateExpression(a.trim(), scope)) : []);
        if (simResult !== undefined) {
          assignProperty(frame.variables, stmt.varName, simResult);
          addConsoleEntry('call', `${stmt.varName} = ${formatValue(resolveProperty(frame.variables, stmt.varName))}`, stmt.line);
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
      // Not stepping in — try evaluating as a known method, else set null
      const declObj = stmt.className ? resolveProperty(scope, stmt.className) : null;
      if (declObj && typeof declObj === 'object') {
        const simResult = simulateMethodCall(declObj, stmt.methodName, stmt.argsRaw ? splitArgs(stmt.argsRaw).map(a => evaluateExpression(a.trim(), scope)) : []);
        if (simResult !== undefined) {
          frame.variables[stmt.varName] = simResult;
          addConsoleEntry('call', `${stmt.varName} = ${formatValue(frame.variables[stmt.varName])}`, stmt.line);
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
  const filePath = await resolveClassFile(className);
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
  if (typeof val === 'string') return `"${val.length > 80 ? val.substring(0, 80) + '...' : val}"`;
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
  if (typeof val === 'string') return `"${val.length > 20 ? val.substring(0, 20) + '...' : val}"`;
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
  renderVariablesPanel();
  renderWatchPanel();
  renderCallStackPanel();
  renderConsolePanel();
  renderBreakpointsPanel();
  updateLiveOrgIndicator();
}

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
      html += renderVarEntry(key, vars[key]);
    }
  }
  html += '</div>';

  // --- Class Fields section (if available) ---
  if (frame.classFields && Object.keys(frame.classFields).length > 0) {
    html += '<div class="dbg-scope-section">';
    html += `<div class="dbg-scope-header" onclick="this.parentElement.classList.toggle('collapsed')">▼ Class Fields (${_esc(frame.className)})</div>`;
    for (const key of Object.keys(frame.classFields)) {
      html += renderVarEntry(key, frame.classFields[key]);
    }
    html += '</div>';
  }

  // --- Closure / Parent Scope section (for stepped-into methods) ---
  if (debugState.callStack.length > 1) {
    const parentFrame = debugState.callStack[debugState.callStack.length - 2];
    html += '<div class="dbg-scope-section collapsed">';
    html += `<div class="dbg-scope-header" onclick="this.parentElement.classList.toggle('collapsed')">▶ Closure (${_esc(parentFrame.className)}.${_esc(parentFrame.methodName)})</div>`;
    for (const key of Object.keys(parentFrame.variables)) {
      html += renderVarEntry(key, parentFrame.variables[key]);
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

function renderVarEntry(key, val) {
  const isExpandable = val !== null && typeof val === 'object';
  let html = `<div class="dbg-var-entry${isExpandable ? ' expandable' : ''}" data-var="${_esc(key)}">`;
  html += `<div class="dbg-var-header" onclick="window._dbgToggleVar(this)">`;
  if (isExpandable) html += `<span class="dbg-var-arrow">▶</span>`;
  html += `<span class="dbg-var-name">${_esc(key)}</span>`;
  html += `<span class="dbg-var-value">${formatValue(val)}</span>`;
  html += `</div>`;
  if (isExpandable) {
    html += `<div class="dbg-var-expand hidden">${renderVariableTree(val, 0, 4)}</div>`;
  }
  html += `</div>`;
  return html;
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
    html += renderVarEntry(key, frame.variables[key]);
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

      if (value === undefined) return null;

      // Format the tooltip content (Chrome-style)
      const displayPath = resolvedPath || fullPath;
      const contents = [];
      const typeName = getValueTypeName(value);
      contents.push({ value: `**\`${displayPath}\`** : *${typeName}*` });

      if (value === null) {
        contents.push({ value: '```\nnull\n```' });
      } else if (typeof value === 'object') {
        // Object or Array: show full JSON
        const cleanValue = Array.isArray(value) ? value : (() => {
          const o = {};
          for (const k of Object.keys(value).filter(k => !k.startsWith('__'))) o[k] = value[k];
          return o;
        })();
        const jsonStr = JSON.stringify(cleanValue, null, 2);
        const typeLabel = Array.isArray(value) ? `List (${value.length} items)` : `Object (${Object.keys(cleanValue).length} fields)`;
        let preview = `\`${typeLabel}\`\n\n`;
        preview += '```json\n' + jsonStr + '\n```';
        preview += '\n\n---\n_Ctrl+C to copy selected text from preview_';
        contents.push({ value: preview });
      } else {
        contents.push({ value: '```\n' + String(value) + '\n```' });
      }

      // Use exact range of the resolved path for highlighting
      const hoverRangeStart = resolvedPath === word.word ? word.startColumn : rangeStart;
      const hoverRangeEnd = resolvedPath === word.word ? word.endColumn : rangeEnd;

      return {
        range: new monaco.Range(position.lineNumber, hoverRangeStart, position.lineNumber, hoverRangeEnd),
        contents
      };
    }
  });
}

function getValueTypeName(val) {
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
      addConsoleEntry('result', 'undefined');
    } else if (value === null) {
      addConsoleEntry('result', 'null');
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

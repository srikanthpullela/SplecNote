/* ========================================================================
   Apex Debug Studio — Apex Request Debugger (apexdebugger.js)
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
  entryDeclLine: 0,            // Line of the entry method's signature (for replay trimming)
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
  execLineDecoration: [],            // decoration IDs for the line executing during a running (Continue) session
  exceptionDecoration: [],           // decoration IDs for the "thrown here" / failing-call-chain markers
  exceptionInfo: null,               // { type, message, stack:[{file,line,className,methodName}] } — stack[0] = throw site
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
  // Org/engine activity log (SOQL, DML, branch/loop traces, status) — shown in
  // the ⚡ Org tab, kept OUT of the Console so the Console only holds user output.
  orgLog: [],
  // Replay: high-water mark of the furthest step whose System.debug output has
  // been streamed to the Console, so stepping back/forward never double-prints.
  replayDebugHigh: -1,
  // Watch expressions
  watchExpressions: [],  // [{ expr: string, id: number }]
  watchNextId: 1,
  // Watch by IDENTITY — objects/fields pinned from the hover value-tree. We follow
  // the live engine reference (not its position), so a value buried inside a huge
  // collection stays tracked even as the collection changes.
  //   watchPins: [{ id, watchId, kind:'object'|'field', field?, label, typeName, path }]
  //   trackedObjects: Map<watchId, { obj, kind, field?, label, typeName }>  (per run)
  //   watchNextObjId: next runtime object id
  watchPins: [],
  trackedObjects: new Map(),
  watchNextObjId: 1,
  // Watch WITH HISTORY — delta-only timeline per tracked object (per run). Only real
  // execution writes where the value actually changed are recorded.
  //   Map<watchId, [{ seq, field, oldDisp, newDisp, step, line, file, className, methodName }]>
  watchHistory: new Map(),
  _watchHistoryCap: 500,       // ring cap per tracked object (bounds memory on deep runs)
  _watchTrackedCap: 40,        // max simultaneously tracked objects
  // DATA FLOW — how tracked objects move through methods (per run). Deduped event
  // stream (methodKey|watchId|access) with per-method access counts, from which both
  // the per-method table and the per-object flow are derived at render time.
  //   events: [{ watchId, methodKey, className, methodName, file, line, access, count, firstStep }]
  dataFlow: { events: [], seen: new Map(), focusWatchId: null },
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
  sysHelper: new Map(),        // org username → 'ready'|'declined'|'unavailable'|Promise (system-mode helper class status)
  // System-mode preference is tri-state ('auto'|'on'|'off'); see loadSystemModePref.
  // 'auto' (default) resumes system mode on any org where the helper class is ALREADY
  // deployed (nothing is ever deployed automatically) and stays in user mode elsewhere.
  // systemModeEnabled is the EFFECTIVE state for the currently connected org.
  systemModePref: 'auto',
  systemModeEnabled: false,
  _generatedOrgLogs: false,    // true once the app has run anonymous Apex this session (=> ApexLogs exist to clean up)
  // FINEST-logging warm-up cache (per org alias). Avoids re-doing the ~7 serial `sf`
  // CLI calls that set up the temporary debug TraceFlag on every run: once a valid
  // ApexDebugStudioFinest flag exists it is reused until it nears expiry. Value shape:
  // { promise:Promise<bool>, expiresAt:number|null, userId:string|null, debugLevelId:string|null }.
  // Populated in the background the moment a debug session starts (overlaps the wait).
  _finestWarm: new Map(),
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
  engineAction: null,          // Last resume action ('continue'|'into'|'over'|'out') — decides cross-file navigation
  currentQueryText: null,      // Short text of the in-flight SOQL, shown in the exec-status while querying
  pausedElsewhere: null,       // { file, line, reason } when paused in a file that isn't on screen (click to open)
  // Engine-mode reverse stepping: a bounded, in-memory timeline of the REAL state
  // captured at each engine pause this run (view-only — the engine is never rewound;
  // we redisplay states it genuinely reached). Mirrors the ⚡ Live-Org replay model so
  // Step Back works in "Debug with Request" runs too. All values are real captures.
  engineHistory: [],           // [{ file, line, frames, exceptionInfo, reason }] oldest→newest
  engineHistoryIndex: -1,      // index currently DISPLAYED; the live edge is length-1
  engineViewingHistory: false, // true while displaying an earlier snapshot (not the live edge)
  _engineHistoryCap: 400,      // retain the most recent N pauses (bounds memory on deep runs)
  _engineStepBackNoted: false,
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
    try { src = await window.apexStudio.readFile(file); } catch { continue; }
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
    const source = await window.apexStudio.readFile(filePath);
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
    const allFiles = await window.apexStudio.getAllFiles(folder);
    const index = {};
    for (const f of allFiles) {
      if (f.endsWith('.cls') || f.endsWith('.trigger')) {
        const name = f.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
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
  const source = await window.apexStudio.readFile(filePath);
  if (!source) { window.showToast?.('Could not read file', 'error'); return; }

  const methodInfo = findMethodInSource(source, methodName);
  if (!methodInfo) { window.showToast?.(`Method "${methodName}" not found`, 'error'); return; }

  // Start FINEST-logging setup in the BACKGROUND now (if an org is connected), so the
  // one-time ~20-35s trace-flag dance overlaps session setup / the user reading code
  // instead of stalling the first org run. Cached + deduped: the later org run reuses
  // this result. Debug metadata only — never touches business data.
  warmUpLiveOrg();

  // Reset state
  debugState.active = true;
  debugState.paused = true;
  debugState.entryFile = filePath;
  debugState.entryMethod = methodName;
  debugState.entryLine = methodInfo.signatureLine + 1;
  debugState.consoleLog = [];
  debugState.orgLog = [];
  debugState.replayDebugHigh = -1;
  debugState.classIndex = null; // refresh on next use
  debugState.classFieldsCache.clear();
  debugState.orgQueryCache.clear();
  debugState.orgActivity = null;

  // Parse class-level fields
  const classFields = parseClassFields(source);
  const className = filePath.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
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
  const content = await window.apexStudio.readFile(filePath);
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
  debugState.engineAction = null;
  debugState.currentQueryText = null;
  debugState.pausedElsewhere = null;
  debugState.exceptionInfo = null;
  debugState.active = false;
  debugState.paused = false;
  debugState.callStack = [];
  debugState.stepMode = null;
  debugState.currentFrame = null;
  debugState._frameSelSig = null;
  if (typeof _hideHoverTree === 'function') _hideHoverTree();
  debugState.replayMode = false;
  debugState.replayTimeline = [];
  debugState.replayIndex = 0;
  debugState.replayFatalError = null;
  debugState._steppedBackNoted = false;
  debugState.engineHistory = [];
  debugState.engineHistoryIndex = -1;
  debugState.engineViewingHistory = false;
  debugState._engineStepBackNoted = false;
  debugState.userOverrides = {};
  if (debugState.orgEvalCache) debugState.orgEvalCache.clear();
  if (debugState.orgQueryCache) debugState.orgQueryCache.clear();
  debugState._soqlHoverLogged = null;
  debugState.orgFetching = false;
  debugState.orgRunning = false;
  debugState._execCurrentFile = null;
  debugState._execCurrentLine = 0;
  _updateExecStatus(null);
  updateQueryBanner();
  clearExceptionMarkers();
  clearCurrentLineHighlight();
  // Keep the debug panel (Console / Org & Log) VISIBLE after the session ends so
  // the user can still read and copy the output; only the floating step-toolbar is
  // dismissed. The user closes the panel themselves with its ✕, and starting a new
  // run refreshes everything.
  _$('#debug-toolbar')?.classList.add('hidden');
  setTimeout(() => window.state?.editor?.layout(), 50);
  addConsoleEntry('info', '⏹ Debug session ended — output kept below. Close this panel with ✕, or start a new run to refresh.');
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
function engineValToPlain(v, depth = 0, seen) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (t === 'object' && v.__typeToken) return v.__typeToken;   // System.Type / Schema.SObjectType handle → its API name
  if (t === 'object') {
    // Schema describe-chain handles → readable API-name strings.
    if (v.__sobjectType) return `SObjectType(${v.__sobjectType})`;
    if (v.__describeResult) return `DescribeSObjectResult(${v.__describeResult})`;
    if (v.__fieldsHandle) return `fields(${v.__fieldsHandle})`;
    if (v.__sobjectField) return `SObjectField(${v.__sobjectField.field})`;
    if (v.__describeFieldResult) return `DescribeFieldResult(${v.__describeFieldResult.field})`;
  }
  // Recursion guards. A WeakSet breaks true cycles (self-referencing ApexObject
  // graphs); the depth cap bounds pathological breadth. Real org query data is an
  // acyclic tree only a few relationship levels deep, so with these guards its REAL
  // values are shown in full — no longer collapsed to a bare "…" that looks like
  // missing/fabricated data. If a marker ever appears, it names the actual reason.
  if (t === 'object' || Array.isArray(v)) {
    if (!seen) seen = new WeakSet();
    if (seen.has(v)) return '…(circular reference — same object already shown above)';
    seen.add(v);
  }
  if (depth > 20) return '…(nested beyond display depth 20 — the real value was fetched, not missing)';
  const E = window.ApexEngine;
  if (Array.isArray(v)) return v.map(x => engineValToPlain(x, depth + 1, seen));
  if (E && v instanceof E.ApexMap) {
    const o = {};
    for (const e of v.m.values()) o[typeof e.k === 'string' ? e.k : E.toApexString(e.k)] = engineValToPlain(e.v, depth + 1, seen);
    return o;
  }
  if (E && v instanceof E.ApexSet) return v.items().map(x => engineValToPlain(x, depth + 1, seen));
  if (E && (v instanceof E.ApexDate || v instanceof E.ApexDatetime)) return v.toString();
  if (E && v instanceof E.ApexError) return `${v.apexType}: ${v.apexMessage}`;
  if (E && v instanceof E.ApexObject) {
    const o = {};
    for (const e of v.fields.values()) o[e.name] = engineValToPlain(e.value, depth + 1, seen);
    return o;
  }
  if (t === 'object') {
    const o = {};
    for (const k of Object.keys(v)) { if (k === 'attributes') continue; o[k] = engineValToPlain(v[k], depth + 1, seen); }
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

/** Mirror an exception's throw-site stack (captured at throw time, top-first,
    each frame carrying a snapshotVars() array) into debugState.callStack so the
    Call Stack panel shows the FULL chain that led to the throw — not the single
    catching frame the live stack has already unwound to. */
function mirrorExceptionStack(excStack) {
  const frames = [];
  // exception stack is top-first (innermost throw site first); panel wants bottom-first
  for (let i = excStack.length - 1; i >= 0; i--) {
    const f = excStack[i];
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
function engineBuildSoql(raw, binds) {
  let q = String(raw || '').trim().replace(/^\[/, '').replace(/\]\s*;?$/, '').trim();
  const entries = Object.entries(binds || {}).sort((a, b) => b[0].length - a[0].length);
  for (const [expr, val] of entries) {
    const plain = engineValToPlain(val);
    const lit = toSoqlLiteral(plain);
    if (lit == null) continue;
    const ex = escapeRegex(expr);
    // Apex binds a collection to `=` as IN and to `!=`/`<>` as NOT IN.
    if (Array.isArray(plain)) {
      q = q.replace(new RegExp('([=!<>]{1,2})\\s*:\\s*' + ex + '(?![\\w.])', 'g'), (mm, op) => {
        if (op === '=') return 'IN ' + lit;
        if (op === '!=' || op === '<>') return 'NOT IN ' + lit;
        return op + ' ' + lit;
      });
    }
    q = q.replace(new RegExp(':\\s*' + ex + '(?![\\w.])', 'g'), lit);
  }
  return q;
}

/* ---- Engine-mode reverse stepping (view-only recorded history) --------------
 * "Debug with Request" runs the live interpreter forward, and real side effects can't
 * be un-run. But every pause already materialises a full, INDEPENDENT plain snapshot
 * of the visible state (mirrorEngineStack deep-copies via engineValToPlain), so we
 * retain the most recent N of them and let the user walk BACKWARD through the states
 * execution genuinely reached, then forward again toward the live edge. This is
 * honest — every value is a real capture from THIS run, nothing fabricated — and it
 * mirrors the ⚡ Live-Org replay model so Step Back behaves the same in both modes. */
function captureEngineHistory(reason) {
  if (!debugState.engineMode) return;
  const h = debugState.engineHistory;
  h.push({
    file: debugState.currentFile,
    line: debugState.currentLine,
    // mirrorEngineStack builds a fresh array of fresh frames each pause, so retaining
    // this reference is safe: later pauses REASSIGN debugState.callStack, they never
    // mutate the array captured here.
    frames: debugState.callStack,
    exceptionInfo: debugState.exceptionInfo,
    reason: reason || null,
  });
  if (h.length > debugState._engineHistoryCap) h.shift();
  debugState.engineHistoryIndex = h.length - 1;
  debugState.engineViewingHistory = false;
}

/** Redisplay a recorded engine snapshot (view-only). Does NOT touch the engine — it
 *  only repaints the editor + panels with the real state captured at that step. */
async function engineHistoryGoto(index) {
  const h = debugState.engineHistory;
  if (!h.length) return;
  index = Math.max(0, Math.min(index, h.length - 1));
  const snap = h[index];
  debugState.engineHistoryIndex = index;
  debugState.engineViewingHistory = index < h.length - 1;
  debugState.callStack = snap.frames || [];
  debugState.currentFrame = null;               // show the top (executing) frame of that step
  debugState.currentFile = snap.file;
  debugState.currentLine = snap.line;
  debugState.exceptionInfo = snap.exceptionInfo || null;
  _hideHoverTree();                              // the code under any open hover just moved
  if (snap.file) {
    await navigateToFile(snap.file, snap.line);
    highlightCurrentLine();
  }
  paintExceptionMarkers();
  setDebugBusyUI();
  updateDebugPanels();
}

/** Step Back in engine mode: return to the previous recorded pause of this run. */
async function engineStepBack() {
  if (debugState.engineRunning || debugState.orgFetching) return;
  if (debugState.engineHistoryIndex <= 0) {
    window.showToast?.(debugState.engineHistory.length > 1
      ? 'Already at the first captured step of this run.'
      : 'No earlier step yet — step or hit a breakpoint first, then Step Back walks back through the run.', 'info');
    return;
  }
  if (!debugState._engineStepBackNoted) {
    debugState._engineStepBackNoted = true;
    addConsoleEntry('info', '⏪ Stepping back through this run’s captured pauses — the real values recorded at each earlier step. Step forward (F10/F11) to walk toward where you were; at the newest step, stepping resumes live execution. (Backward view only — the engine is not rewound, so no side effects are undone.)');
  }
  await engineHistoryGoto(debugState.engineHistoryIndex - 1);
}

/** Pure decision for a forward step while positioned in recorded history. Returns
 *  { mode:'resume'|'history', index }: 'history' redisplays `index` (view-only),
 *  'resume' runs the real engine. Continue (and being at the live edge) always
 *  resumes. Exported for unit tests. */
function planEngineForward(action, index, lastIdx, viewing) {
  if (!viewing) return { mode: 'resume', index: lastIdx };
  if (action === 'continue') return { mode: 'resume', index: lastIdx };
  return { mode: 'history', index: Math.min(index + 1, lastIdx) };
}

/** When the user has stepped back into recorded history, forward commands re-walk that
 *  history toward the live edge instead of resuming real execution — exactly like the
 *  replay timeline. Returns true when the command was fully handled here (caller must
 *  NOT resume the engine). Continue snaps to the live edge and lets execution resume. */
function engineForwardViaHistory(action) {
  if (!debugState.engineMode || !debugState.engineViewingHistory) return false;
  const lastIdx = debugState.engineHistory.length - 1;
  const plan = planEngineForward(action, debugState.engineHistoryIndex, lastIdx, true);
  if (plan.mode === 'resume') {
    // Abandon the backward view and let the engine run on from where it actually is.
    debugState.engineHistoryIndex = lastIdx;
    debugState.engineViewingHistory = false;
    return false;
  }
  engineHistoryGoto(plan.index);
  return true;
}

/** Called when the engine pauses (step / breakpoint). Sync the whole UI. */
async function onEnginePause(info) {
  debugState.paused = true;
  debugState.engineRunning = false;
  debugState._hoverCache = new Map();   // clear per-pause hover cache
  clearExecutingLineHighlight();
  mirrorEngineStack(info.stack || []);
  debugState.currentLine = info.line;
  // Announce an exception pause so it's obvious WHY we stopped (and why the try
  // block handed control to catch), then let the user inspect state before continuing.
  const isException = (info.reason === 'caught-exception' || info.reason === 'exception') && info.error;
  debugState.exceptionInfo = null;
  if (isException) {
    const e = info.error;
    // The live stack has already unwound to the catching frame by the time the
    // catch handler runs, so it would show only ONE method. The exception's
    // throw-site stack (captured with real variables at throw time) is the true
    // chain the user needs to see — mirror THAT into the Call Stack panel.
    if (e.stack && e.stack.length) {
      mirrorExceptionStack(e.stack);
      debugState.currentFrame = debugState.callStack.length - 1;
      // Navigate the editor to the actual THROW SITE (top of the exception stack),
      // which may live in a different file than the catching frame.
      if (e.stack[0].file) info.file = e.stack[0].file;
      if (e.stack[0].line) { info.line = e.stack[0].line; debugState.currentLine = e.stack[0].line; }
    }
    // Remember the exception so we can mark the EXACT throw line (and the failing
    // call chain) inline on the code, on whichever file the user opens.
    debugState.exceptionInfo = {
      type: e.type || 'Exception',
      message: e.message || '',
      reason: info.reason,
      stack: (e.stack || []).map(f => ({ file: f.file, line: f.line, className: f.className, methodName: f.methodName })),
    };
    const site = debugState.exceptionInfo.stack[0];
    if (site && site.file) {
      const siteName = site.file.split(/[/\\]/).pop() || site.file;
      // The single most important line: exactly WHERE and WHY it was thrown.
      addConsoleEntry('error', `💥 ${e.type || 'Exception'} thrown at ${siteName}:${site.line} (${site.className}.${site.methodName}) — ${e.message || ''}`);
    }
    addConsoleEntry('error', `⏸ Paused on ${info.reason === 'caught-exception' ? 'caught ' : ''}exception: ${e.type || 'Exception'}: ${e.message || ''}`);
    if (e.stack && e.stack.length) {
      addConsoleEntry('error', e.stack.map((f, i) => `      ${i === 0 ? '➤ throw ' : '  called '}at ${f.className}.${f.methodName} (${(f.file || '').split(/[/\\]/).pop()}:${f.line})`).join('\n'));
    }
    addConsoleEntry('info', 'The exact throw line is marked 💥 in the code. ▶ Continue resumes into the catch block.');
    renderConsolePanel();
  }
  // Navigation on pause: every pause is now user-intentional — a breakpoint the
  // user set, an explicit Step Into/Over/Out, or a manual pause. (Caught exceptions
  // no longer pause at all.) So we ALWAYS go to the pause location: if it's in a
  // different file — even one the user forgot they'd set a breakpoint in — we open
  // that file and navigate to the exact line. We never auto-open/scroll during a
  // free RUN (see revealExecutingLocation); only on an actual stop like this.
  debugState.pausedElsewhere = null;
  const differentFile = info.file && info.file !== debugState.currentFile && /\.(cls|trigger)$/.test(info.file);
  if (differentFile) {
    try {
      const content = await window.apexStudio.readFile(info.file);
      if (content != null) { await window.openFile(info.file, content); }
    } catch (_) { /* fall through — keep whatever is open */ }
  }
  if (info.file) debugState.currentFile = info.file;
  // Reveal the paused line. On a file switch the new model needs a layout pass
  // before it will scroll, so revealPauseLocation defers + force-centers there;
  // same-file stepping stays synchronous and jump-free.
  revealPauseLocation(info.line, differentFile);
  captureEngineHistory(info.reason);
  setDebugBusyUI();
  // Re-attach any watch pins whose object now resolves in this frame (new run /
  // restored definitions), and follow any stable binding that was reassigned to a
  // different object so the Watch + Data Flow tabs stay continuous across the swap.
  try { await syncWatchPins(); } catch (_) {}
  updateDebugPanels();
}

/** Open the file the engine paused in when we chose not to auto-navigate. */
async function openPausedElsewhere() {
  const p = debugState.pausedElsewhere;
  if (!p) return;
  await navigateToFile(p.file, p.line);
  debugState.currentFile = p.file;
  debugState.currentLine = p.line;
  debugState.pausedElsewhere = null;
  _updateExecStatus(null);
  highlightCurrentLine();
  paintExceptionMarkers();
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
      // Route by level: user output ('debug') → Console; everything else
      // (soql/dml/system/info/warn/…) → the ⚡ Org activity log.
      const map = { debug: 'debug', soql: 'soql', dml: 'dml', system: 'info' };
      addConsoleEntry(map[level] || level || 'info', level === 'debug' ? `USER_DEBUG: ${msg}` : msg);
    },
    debug: (payload) => {
      // Chrome-style user print from System.debug: display text + an optional
      // expandable value tree. Always lands in the Console (user output).
      const p = payload || {};
      addConsoleEntry('debug', p.text != null ? p.text : String(payload), p.line, p.tree);
    },
    query: async (rawSoql, binds, opts) => {
      // Internal field-existence probes (hydrateSObjectField) pass { probe:true } so a
      // handled, expected miss doesn't spam the console with a red "SOQL error" or a
      // scary "record not found → will throw NPE" warning. The fetch still runs and
      // still throws on error so the engine can classify absence; it just stays quiet.
      const probe = !!(opts && opts.probe);
      if (!liveOrgAvailable()) {
        if (!probe) addConsoleEntry('warn', 'SOQL needs a connected org — returning 0 rows. Connect an org for real data.');
        return [];
      }
      const soql = engineBuildSoql(rawSoql, binds);
      debugState.orgFetching = true;
      debugState.currentQueryText = soql.replace(/\s+/g, ' ').trim().slice(0, 90);
      updateLiveOrgIndicator();
      if (!probe) {
        maybeOpenOrgTabForLiveQuery();
        addConsoleEntry('info', `⏳ Fetching from org: ${soql.replace(/\s+/g, ' ').trim()}`);
        renderConsolePanel();
      }
      try {
        // If the user already made a session decision for this query shape, honor it
        // silently so a failing query inside a loop doesn't re-prompt every iteration.
        if (!probe) {
          if (!debugState._soqlSessionDecision) debugState._soqlSessionDecision = new Map();
          if (debugState._soqlSessionDecision.get(normalizeSoqlKey(soql)) === 'zero') {
            addConsoleEntry('warn', '↳ (remembered this session) continuing with 0 rows for this query.');
            return [];
          }
        }
        const res = await execSoql(soql);
        if (res._appliedSavedFix && !probe) {
          addConsoleEntry('info', '🛠 Applied your saved SOQL fix for this query.');
        }
        if (res.error) {
          if (!probe) {
            // Offer an inline fix so a per-org schema mismatch doesn't dead-end the whole
            // session: the user edits the SOQL, runs it, and continues with the results.
            const key = normalizeSoqlKey(soql);
            if (!debugState._soqlSessionDecision) debugState._soqlSessionDecision = new Map();
            const aborted = debugState._soqlSessionDecision.get(key) === 'abort';
            if (!aborted && isFixableSoqlError(res.error)) {
              const outcome = await showSoqlFixModal({ soql, error: res.error, resolvedSoql: res.soql || soql });
              if (outcome.action === 'continue') {
                if (!debugState._soqlSessionFixes) debugState._soqlSessionFixes = new Map();
                debugState._soqlSessionFixes.set(key, toSoqlTemplate(outcome.soql));
                if (outcome.remember) {
                  try {
                    await saveSoqlFix(soql, outcome.soql);
                    addConsoleEntry('info', '💾 Saved this fix for this project — future runs apply it automatically (until the schema changes).');
                  } catch (_) { /* persistence is best-effort */ }
                }
                addConsoleEntry('info', `✓ Applied your SOQL fix — ${outcome.records.length} row(s) from org.`);
                renderConsolePanel();
                return outcome.records;
              }
              if (outcome.action === 'zero') {
                debugState._soqlSessionDecision.set(key, 'zero');
                addConsoleEntry('warn', '↳ Continuing with 0 rows (your choice). Downstream code that dereferences the empty result may throw a NullPointerException — exactly as it would in real Apex.');
                renderConsolePanel();
                return [];
              }
              // Abort → remember for the session so we don't re-prompt, then throw as usual.
              debugState._soqlSessionDecision.set(key, 'abort');
            }
            const hint = soqlPermissionHint(res.error);
            addConsoleEntry(hint ? 'warn' : 'error', hint || `SOQL error: ${res.error}`);
          }
          // Tag as org-origin so the engine attributes it correctly: a semantic
          // rejection (bad query/data) reads as "real Apex error reported by the org",
          // while an infra failure (CLI crash/auth/timeout) reads as an org/CLI issue —
          // never as an engine bug.
          throw Object.assign(new E.ApexError('System.QueryException', res.error, 0), { __origin: 'org' });
        }
        if (!probe && res.records.length === 0) {
          // Truthful diagnostics: report an empty result like a 404 so the user
          // knows the record isn't in the org (rather than silently returning []
          // and surfacing a confusing downstream NPE). We do NOT fabricate data.
          const info = describeEmptyQuery(soql);
          addConsoleEntry('warn', `🔎 0 rows from org — ${info.subject} not found in org${info.org ? ' ' + info.org : ''}.`);
          if (res.droppedColumns && res.droppedColumns.length) {
            addConsoleEntry('warn', `↳ Note: column(s) ${res.droppedColumns.join(', ')} don't exist on this object in the connected org (installed package version differs from the source); the query was rewritten without them.`);
          }
          if (info.byId) {
            const sysNote = res.mode === 'system'
              ? ' This ran in system mode (FLS/CRUD/sharing bypassed), so a missing permission is NOT the cause — the record genuinely is not in the org.'
              : '';
            addConsoleEntry('warn', `↳ This record does not exist in the connected org (it may be a transient record that was already cleaned up).${sysNote} Any code that dereferences this empty result will get null — and will throw a NullPointerException, exactly as it would in real Apex. No data is being generated to hide this.`);
            // Temp/transient objects (e.g. Apttus_Config2__TempObject__c) are deleted
            // shortly after the request that created them completes, so re-running an old
            // captured request will always 404 on its temp Id. Steer the user to re-capture.
            if (/TempObject/i.test(info.subject)) {
              addConsoleEntry('warn', `⚠ This looks like a transient temp record (TempObject) that the org has already cleaned up. Replaying an old captured request won't find it. ➜ Re-capture the LATEST request from the org (redo the action so a fresh temp Id is generated), then debug that one — the stale Id from the previous run can't be recovered.`);
            }
          }
          renderConsolePanel();
        } else if (!probe) {
          addConsoleEntry('info', `✓ ${res.records.length} row(s) from org${res.mode === 'system' ? ' (system mode — full permissions)' : res.mode === 'user' ? ' (user mode)' : ''}`);
          if (res.droppedColumns && res.droppedColumns.length) {
            addConsoleEntry('warn', `⚠ Column(s) ${res.droppedColumns.join(', ')} don't exist on this object in the connected org (the installed managed-package version differs from the source) — fetched without them, so those fields read as null. No data is fabricated.`);
          }
        }
        return res.records;
      } finally {
        debugState.orgFetching = false;
        debugState.currentQueryText = null;
        updateLiveOrgIndicator();
        if (!probe) renderConsolePanel();
      }
    },
    dml: async (op, value) => {
      const records = Array.isArray(value) ? value : [value];
      addConsoleEntry('warn', `DML ${op.toUpperCase()} simulated locally (${records.length} record(s)) — the org is never modified by the debugger.`);
      renderConsolePanel();
    },
    // Resolve a read-only Apex expression (custom settings, unsupported statics, etc.)
    // against the connected org so the engine gets REAL values instead of halting.
    // Never throws; returns { ok, value } or { ok:false, error }.
    evalOrg: async (apexExpr) => {
      if (!liveOrgAvailable()) return { ok: false, error: 'no org' };
      try {
        if (!debugState.engineOrgEvalCache) debugState.engineOrgEvalCache = new Map();
        if (debugState.engineOrgEvalCache.has(apexExpr)) return debugState.engineOrgEvalCache.get(apexExpr);
        debugState.orgFetching = true;
        debugState.currentQueryText = apexExpr.replace(/\s+/g, ' ').trim().slice(0, 90);
        updateLiveOrgIndicator();
        maybeOpenOrgTabForLiveQuery();
        addConsoleEntry('info', `⚙ Resolving in org: ${apexExpr}`);
        renderConsolePanel();
        let r = await _runEvalApex(apexExpr);
        if (r.compileFailed) {
          const ns = await getPackageNamespace();
          if (ns) {
            const nsExpr = nsPrefixApexExpr(apexExpr, ns);
            if (nsExpr !== apexExpr) {
              const r2 = await _runEvalApex(nsExpr);
              if (!r2.error) r = r2;
            }
          }
        }
        const out = r.error ? { ok: false, error: r.error } : { ok: true, value: r.value };
        if (out.ok) {
          debugState.engineOrgEvalCache.set(apexExpr, out);
          const preview = typeof out.value === 'object' && out.value !== null ? '{…}' : formatValue(out.value);
          addConsoleEntry('info', `↳ ${apexExpr} → ${preview} (real org value)`);
        } else {
          addConsoleEntry('warn', `Org resolve failed for ${apexExpr}: ${out.error}`);
        }
        return out;
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      } finally {
        debugState.orgFetching = false;
        debugState.currentQueryText = null;
        updateLiveOrgIndicator();
        renderConsolePanel();
      }
    },
    // Describe an SObject's REAL fields from the org (used by the Schema describe
    // chain, e.g. Type.getSObjectType().getDescribe().fields.getMap()). Cached,
    // with a namespace-prefix retry so bare names like ProductConfiguration__c
    // resolve in a managed-package org (Apttus_Config2__ProductConfiguration__c).
    describeSObject: async (name) => {
      if (!liveOrgAvailable()) return { error: 'no org' };
      if (!debugState.engineDescribeCache) debugState.engineDescribeCache = new Map();
      // Key by connected org too: field lists differ per org (a field may exist in
      // one org but not another), so a describe cached under a prior org must never
      // be reused for a different one.
      const _org = getActiveOrg();
      const key = `${_org && _org.org ? _org.org : '?'}::${String(name).toLowerCase()}`;
      if (debugState.engineDescribeCache.has(key)) return debugState.engineDescribeCache.get(key);
      debugState.orgFetching = true;
      debugState.currentQueryText = `Describe ${name}`;
      updateLiveOrgIndicator();
      maybeOpenOrgTabForLiveQuery();
      addConsoleEntry('info', `⚙ Describing ${name} in org…`); renderConsolePanel();
      // Prefer the REST describe (no debug log, nothing deployed). Only fall back to the
      // anonymous-Apex describe when REST truly can't run AND system mode is on (it needs
      // FINEST logging). This keeps user mode log-free.
      let r = await _runDescribeViaRest(name);
      if ((!r || !r.names || !r.names.length) && String(name).split('__').length < 3) {
        const ns = await getPackageNamespace();
        if (ns) {
          const r2 = await _runDescribeViaRest(`${ns}__${name}`);
          if (r2 && r2.names && r2.names.length) r = r2;
        }
      }
      if ((!r || !r.names || !r.names.length) && r && r._restUnavailable && isSystemModeEnabled()) {
        let ra = await _runDescribeViaApex(name);
        if ((!ra || !ra.names || !ra.names.length) && String(name).split('__').length < 3) {
          const ns = await getPackageNamespace();
          if (ns) {
            const ra2 = await _runDescribeViaApex(`${ns}__${name}`);
            if (ra2 && ra2.names && ra2.names.length) ra = ra2;
          }
        }
        if (ra && ra.names && ra.names.length) r = ra;
      }
      const out = (r && r.names) ? r : { names: [], error: (r && r.error) || 'describe failed' };
      if (out.names && out.names.length) addConsoleEntry('info', `↳ ${name}: ${out.names.length} fields resolved from org`);
      else addConsoleEntry('warn', `Describe ${name} returned no fields${out.error ? ' — ' + out.error : ''}`);
      debugState.orgFetching = false; debugState.currentQueryText = null; updateLiveOrgIndicator(); renderConsolePanel();
      debugState.engineDescribeCache.set(key, out);
      return out;
    },
    loadClassSource: async (className) => {
      const file = await resolveClassFile(className);
      if (!file) return null;
      try {
        const src = await window.apexStudio.readFile(file);
        if (src) addConsoleEntry('info', `↳ Loaded ${className} from ${file.split(/[/\\]/).pop()} (step-into available)`);
        return src ? { source: src, path: file } : null;
      } catch (_) { return null; }
    },
    getBreakpoint: (file, line) => activeBreakpoint(file, line),
    onPause: (info) => { onEnginePause(info); },
    // Fired as each line begins executing during a running session. We FOLLOW
    // execution across files (open the executing class + reveal/highlight the
    // line) so the user can watch where the interpreter is — especially on slow
    // lines that await the org, and to make loops visible. Throttled so a fast
    // run doesn't thrash the editor.
    onExecLine: (info) => {
      if (!debugState.active) return;
      followExecutingLine(info);
    },
    // Watch + data-flow field observers. Fired by the engine ONLY for objects the
    // user pinned (obj.__tracked), and only during real execution (never during
    // hover/console evals or while paused). Cheap: a couple of Map ops per event.
    onFieldWrite: (ev) => { try { recordFieldWrite(ev); } catch (_) {} },
    onFieldRead: (ev) => { try { recordFieldRead(ev); } catch (_) {} },
    onDone: (result) => {
      if (!debugState.active) return;
      debugState.paused = false;
      debugState.engineRunning = false;
      debugState.pausedElsewhere = null;
      clearCurrentLineHighlight();
      _updateExecStatus(null);
      if (result !== undefined && result !== null) {
        const plain = engineValToPlain(result);
        addConsoleEntry('result', `⏹ Method returned: ${typeof plain === 'object' ? JSON.stringify(plain, null, 2) : formatValue(plain)}`);
      }
      addConsoleEntry('info', '✅ Execution finished.');
      // Issue 1: the run is complete, so leave the DEBUGGING state entirely —
      // stop the spinner, disable stepping, drop the "querying" banner. The
      // console output above (including the returned value) stays visible.
      // Re-run via "Debug with Request".
      stopDebugSession();
    },
    onError: async (err) => {
      if (!debugState.active) return;
      debugState.paused = false;
      debugState.engineRunning = false;
      debugState.pausedElsewhere = null;
      _updateExecStatus(null);
      const msg = err && err.apexType ? `${err.apexType}: ${err.apexMessage}` : (err && err.message) || String(err);
      addConsoleEntry('error', `✖ Uncaught exception: ${msg}`);
      if (err && err.apexStack && err.apexStack.length) {
        // Record the throw site so we can mark the EXACT failing line inline.
        debugState.exceptionInfo = {
          type: err.apexType || 'Exception',
          message: err.apexMessage || err.message || '',
          reason: 'exception',
          stack: err.apexStack.map(f => ({ file: f.file, line: f.line, className: f.className, methodName: f.methodName })),
        };
        const site = debugState.exceptionInfo.stack[0];
        if (site && site.file) {
          const siteName = site.file.split(/[/\\]/).pop() || site.file;
          addConsoleEntry('error', `💥 ${debugState.exceptionInfo.type} thrown at ${siteName}:${site.line} (${site.className}.${site.methodName}) — ${debugState.exceptionInfo.message}`);
        }
        addConsoleEntry('error', err.apexStack.map((f, i) => `      ${i === 0 ? '➤ throw ' : '  called '}at ${f.className}.${f.methodName} (${(f.file || '').split(/[/\\]/).pop()}:${f.line})`).join('\n'));
        // A fatal error is exactly where the user needs to look — open that file and
        // navigate to the throw line automatically, then mark it 💥.
        renderConsolePanel();
        if (site && site.file) {
          if (site.file !== debugState.currentFile) {
            debugState.currentFile = site.file;
            await navigateToFile(site.file, site.line);
          } else {
            debugState.currentLine = site.line;
            navigateToLine(site.line);
          }
          paintExceptionMarkers();
        }
      }
      setDebugBusyUI();
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

  const className = filePath.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
  if (!engine.registry.get(className)) return false;
  const methods = engine.registry.get(className).findMethods(methodName);
  if (!methods.length) return false;

  const args = (methods[0].params || []).map((p, i) =>
    requestParams && requestParams[i] !== undefined ? JSON.parse(JSON.stringify(requestParams[i])) : null);

  debugState.engineMode = true;
  debugState.engineSession = engine;
  engine.mode = 'into';                    // pause on the very first statement
  debugState.engineRunning = true;
  // Fresh run → clear per-run watch history / data-flow and unbind identity pins
  // (object identities from the previous run no longer exist). Watch DEFINITIONS
  // (expressions + pin paths) are preserved so they can re-bind by path this run.
  resetWatchRuntime();

  // Fix 2: seed real user info into the host so UserInfo.getUserId() etc. return
  // the actual running user's Id rather than a synthetic placeholder. Non-blocking
  // so session start isn't delayed; the engine uses the real id as soon as it resolves.
  if (liveOrgAvailable()) {
    getOrgUserInfo().then(ui => { if (ui) host.userInfo = ui; });
  }

  // Fire and let the pause gate drive the UI; completion handled by onDone/onError.
  engine.run(className, methodName, args).catch(() => { /* reported via onError */ });
  return true;
}

/** Resume the live interpreter with a step action ('continue'|'into'|'over'|'out'). */
function engineStep(action) {
  const eng = debugState.engineSession;
  if (!eng) return;
  if (debugState.engineRunning || debugState.orgFetching) return; // ignore while already busy
  debugState.engineAction = action;
  debugState.pausedElsewhere = null;
  debugState.exceptionInfo = null;
  clearExceptionMarkers();
  debugState.paused = false;
  debugState.engineRunning = true;
  clearCurrentLineHighlight();
  _updateExecStatus(null);
  setDebugBusyUI();
  eng.resume(action);
}

/** Console / watch evaluation inside the live interpreter's top frame.
 *  Uses a sandboxed eval (stack saved/restored, depth-capped) so a bad expression
 *  in the console can't corrupt the paused call stack. quiet=false so engine logs
 *  (System.debug, DML notifications) still appear in the console. */
async function evaluateEngineConsole(expr) {
  const eng = debugState.engineSession;
  if (!eng || !eng.topFrame()) { addConsoleEntry('error', 'No active engine frame'); return; }
  try {
    const val = await eng.evalExpressionSandboxed(expr, eng.topFrame(), false);
    const plain = engineValToPlain(val);
    if (plain !== null && typeof plain === 'object') addConsoleEntry('result-json', JSON.stringify(plain, null, 2), null, plain);
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
  try { return JSON.parse(stdout.slice(start, end + 1)); } catch {
    // Last resort: extract a structured error from truncated CLI output
    if (stdout.includes('"name"') && stdout.includes('"message"')) {
      const mMatch = stdout.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const nMatch = stdout.match(/"name"\s*:\s*"([^"]*)"/);
      if (mMatch) {
        let msg = mMatch[1];
        try { msg = JSON.parse('"' + mMatch[1] + '"'); } catch {}
        return { status: 1, truncated: true, name: nMatch ? nMatch[1] : 'unknown', message: msg };
      }
    }
    return null;
  }
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
 * Build a clean, actionable error string when `sf apex run` returns no parseable
 * JSON. Old Salesforce CLI versions crash with a JS "Maximum call stack size
 * exceeded" while serializing a very large --json payload (e.g. a big FINEST debug
 * log). That's a CLI bug, not an org/data problem — the method still ran in the org
 * (savepoint + rollback, nothing modified), so we say so and recommend updating the CLI
 * instead of dumping the raw stack trace + update-nag banner.
 */
function describeOrgRunFailure(stderr, stdout) {
  const combined = `${stderr || ''}\n${stdout || ''}`;
  if (/Maximum call stack size exceeded|RangeError/i.test(combined)) {
    const upd = combined.match(/update available from ([\d.]+) to ([\d.]+)/i);
    const updHint = upd
      ? ` Your Salesforce CLI is ${upd[1]}; update it to ${upd[2]} (run \`npm i -g @salesforce/cli\`), then Restart (⟳).`
      : ' Update the Salesforce CLI (\`npm i -g @salesforce/cli\`), then Restart (⟳).';
    return `The Salesforce CLI crashed while returning the org response ("Maximum call stack size exceeded"). This is a known CLI bug with very large debug logs — the method DID run in the org and nothing was modified.${updHint}`;
  }
  const cleaned = cleanSfNoise(stderr) || cleanSfNoise(stdout);
  return (cleaned || 'No response from the Salesforce CLI.').split('\n').slice(0, 5).join('\n');
}

/**
 * Normalize a compile-error string from the CLI: flatten newlines to spaces,
 * collapse whitespace, and cap at 300 chars so the real error text is visible.
 */
function normCompileErr(s) {
  return String(s || '').replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
}

/**
 * Extract the most meaningful error text from an sf CLI invocation.
 * Prefers the parsed JSON's message/compileProblem, then cleaned stderr/stdout,
 * so the real cause (auth, compile, runtime) is shown instead of the update banner.
 */
function sfErrorText(cli, stderr, stdout, fallback) {
  if (cli) {
    const r = cli.result || cli.data || {};
    // compileProblem is the canonical error for compile failures — check before message.
    if (r.compileProblem) {
      const loc = r.line ? ` at line ${r.line}${r.column ? ' col ' + r.column : ''}` : '';
      return `Compile failed${loc}: ${r.compileProblem}`;
    }
    if (r.exceptionMessage) return r.exceptionMessage;
    if (cli.status && cli.status !== 0 && cli.message) {
      // Preserve full compile error — the CLI may embed it after a newline.
      const afterErr = cli.message.match(/with the error:\s*([\s\S]+)/i);
      if (afterErr) return `Compile failed: ${afterErr[1].trim()}`;
      return String(cli.message).replace(/\r?\n/g, ' ').trim();
    }
    if (cli.message && !r.success) {
      const afterErr = cli.message.match(/with the error:\s*([\s\S]+)/i);
      if (afterErr) return `Compile failed: ${afterErr[1].trim()}`;
      return String(cli.message).replace(/\r?\n/g, ' ').trim();
    }
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
  // Engine collection (ApexSet/ApexMap) that slipped through un-normalized.
  if (val && typeof val.items === 'function') val = val.items();
  else if (val && typeof val.vals === 'function') val = val.vals();
  if (Array.isArray(val)) {
    // Empty IN-bind matches nothing in Apex; `IN ()` is invalid SOQL, so emit
    // `(null)` which is valid and returns 0 rows for id/reference filters.
    if (val.length === 0) return '(null)';
    return '(' + val.map(toSoqlLiteral).join(', ') + ')';
  }
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') {
    // sObject-like: bind on Id if present, else stringify
    if (typeof val.iso === 'function') return val.iso();
    if (val.__sobjectType) return `'${String(val.__sobjectType).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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
  // An optional leading comparison operator is captured so a collection bound with
  // `=`/`!=` is rewritten to `IN`/`NOT IN` (matching Apex bind semantics).
  q = q.replace(/(=|!=|<>)?(\s*):\s*([A-Za-z_]\w*(?:\.\w+)*)/g, (whole, op, ws, expr) => {
    const val = resolveProperty(scope, expr);
    if (val === undefined) return whole; // leave unresolved — surface the error
    const lit = toSoqlLiteral(val);
    const isColl = Array.isArray(val) || (val && (typeof val.items === 'function' || typeof val.vals === 'function'));
    if (isColl && op === '=') return 'IN ' + lit;
    if (isColl && (op === '!=' || op === '<>')) return 'NOT IN ' + lit;
    return (op || '') + ws + lit;
  });
  return q;
}

/** Recursively strip Salesforce "attributes" noise from returned records, but
 *  preserve the SObject type token (`attributes.type`) so the engine can resolve
 *  overloads, getSObjectType(), and instanceof-style checks. Field iteration in
 *  the engine already skips `attributes`, so keeping the type adds no noise. */
function cleanSObject(rec) {
  if (Array.isArray(rec)) return rec.map(cleanSObject);
  if (rec && typeof rec === 'object') {
    const out = {};
    if (rec.attributes && rec.attributes.type) out.attributes = { type: rec.attributes.type };
    for (const k of Object.keys(rec)) {
      if (k === 'attributes') continue;
      const v = rec[k];
      // Child-relationship subquery result. Salesforce returns a parent-to-child
      // subquery (e.g. `(SELECT ... FROM Attributes__r)`) as a wrapper object
      // { totalSize, done, records:[...] }. In Apex that field IS a List, so unwrap
      // it to the (cleaned) array — otherwise `for (X x : parent.Child__r)` throws a
      // bogus "System.TypeException: Cannot iterate over SObject". A null child
      // relationship (no rows) becomes an empty list, matching Apex.
      if (v && typeof v === 'object' && !Array.isArray(v)
          && Array.isArray(v.records) && ('done' in v || 'totalSize' in v)) {
        out[k] = v.records.map(cleanSObject);
      } else {
        out[k] = (v && typeof v === 'object') ? cleanSObject(v) : v;
      }
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
    const { stdout, stderr } = await window.apexStudio.sfExec(cmd, folder, 60000);
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

/** Summarize an empty SOQL result for a truthful, API-404-style diagnostic. */
function describeEmptyQuery(soql) {
  const org = getActiveOrg();
  const orgName = org ? `(${org.org})` : '';
  const flat = String(soql || '').replace(/\s+/g, ' ').trim();
  const fromM = flat.match(/\bFROM\s+([A-Za-z0-9_.]+)/i);
  const obj = fromM ? fromM[1] : 'record';
  const idM = flat.match(/\bWHERE\b[\s\S]*?\bId\s*=\s*'([^']+)'/i);
  if (idM) return { subject: `${obj} with Id '${idM[1]}'`, byId: true, org: orgName };
  return { subject: `${obj} matching the query`, byId: false, org: orgName };
}

/**
 * When a user-mode query fails because the connected user can't see an object/field
 * (FLS/CRUD), return a friendly 🔒 explanation instead of a raw platform error — but only
 * while system mode is OFF (with it on, the helper would have read the field). Returns
 * null when the error isn't a permission/visibility problem, so genuine query errors are
 * still shown verbatim. Never fabricates data.
 */
function soqlPermissionHint(errText) {
  if (isSystemModeEnabled()) return null;
  const t = String(errText || '');
  if (!/No such column|sObject type .* is not supported|INVALID_TYPE|INVALID_FIELD|not supported for query|INSUFFICIENT_ACCESS|is not accessible|didn.?t understand/i.test(t)) return null;
  const col = t.match(/No such column '([\w.]+)'/i);
  const typ = t.match(/sObject type '([\w.]+)'/i) || t.match(/on entity '([\w.]+)'/i);
  const what = col ? `field ${col[1]}` : (typ ? `object ${typ[1]}` : 'that field/object');
  return `🔒 ${what} isn't readable by the connected user (no permission). Nothing was fabricated. To read it, enable ⚡ System mode (deploys a read-only helper — needs deploy rights) or grant the user access. Original: ${t}`;
}

/**
 * True when a SOQL error is a query-STRUCTURE problem the user can fix by editing the
 * query (bad field/relationship/object/type, malformed SOQL) — as opposed to an infra
 * failure (CLI/auth/network/timeout) or a plain empty result. Gates the interactive
 * "Fix SOQL & continue" dialog so we only offer it when editing the query can help.
 */
function isFixableSoqlError(errText) {
  const t = String(errText || '');
  if (!t) return false;
  // Never offer the editor for infra/auth problems — editing SOQL won't fix those.
  if (/No org connected|not authorized|expired access token|INVALID_SESSION|ENOTFOUND|ECONNRESET|ETIMEDOUT|timed out|sf:? not found|command not found/i.test(t)) return false;
  return /No such column|No such relationship|INVALID_FIELD|INVALID_TYPE|not supported for query|sObject type .* is not supported|Didn.?t understand relationship|MALFORMED_QUERY|unexpected token|INVALID_QUERY_FILTER_OPERATOR|on entity '|line \d+:\d+/i.test(t);
}

/* ================================================================
   Interactive "Fix SOQL & continue" — per-project persistence
   ----------------------------------------------------------------
   Every org/project has a different schema, so a query the debugger (or
   the user's own Apex) builds can reference a field/relationship that
   doesn't exist in THIS org. Instead of dead-ending the whole session,
   the user can edit the failing SOQL and continue — and we remember the
   correction so the same query shape just works next time. Stored PER
   PROJECT FOLDER in ~/ApexDebugStudio/soql-fixes.json.

   Keying: literals (quoted strings, numbers) are masked to '?' so a fix
   for one record Id applies to every record Id of the same shape. The
   corrected query is kept as a template with the same '?' markers; at
   apply time the CURRENT query's literals are re-injected positionally,
   but ONLY when the count matches (otherwise we re-prompt, never guess).
   ================================================================ */
const SOQL_LITERAL_RE = /'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b/g;

/** Ordered list of literal tokens (quoted strings + bare numbers) in a query. */
function soqlLiterals(soql) {
  const out = [];
  String(soql || '').replace(SOQL_LITERAL_RE, (m) => { out.push(m); return m; });
  return out;
}

/** Whitespace-collapsed, literal-masked, lower-cased key for matching query shapes. */
function normalizeSoqlKey(soql) {
  return String(soql || '').replace(/\s+/g, ' ').trim().replace(SOQL_LITERAL_RE, '?').toLowerCase();
}

/** Turn a concrete query into a reusable template (literals → '?'), whitespace-collapsed. */
function toSoqlTemplate(soql) {
  return String(soql || '').replace(/\s+/g, ' ').trim().replace(SOQL_LITERAL_RE, '?');
}

/** Re-inject a query's current literals into a saved template. Null if the counts differ. */
function applySoqlTemplate(template, currentSoql) {
  const lits = soqlLiterals(currentSoql);
  const holes = (String(template).match(/\?/g) || []).length;
  if (holes !== lits.length) return null; // shape changed → caller should re-prompt
  let i = 0;
  return String(template).replace(/\?/g, () => lits[i++]);
}

let _soqlFixesCache = null; // { "<folderPath>": { "<key>": "<template>" } }

function _soqlProjectKey() { return (window.state && window.state.folderPath) || '__global__'; }

async function _soqlFixesPath() {
  const paths = await window.apexStudio.getPaths?.();
  const base = paths?.appDataDir || paths?.home || '.';
  return `${base}/soql-fixes.json`;
}

async function loadSoqlFixes() {
  if (_soqlFixesCache) return _soqlFixesCache;
  try {
    const raw = await window.apexStudio.readFile(await _soqlFixesPath());
    _soqlFixesCache = raw ? (JSON.parse(raw) || {}) : {};
  } catch (_) { _soqlFixesCache = {}; }
  return _soqlFixesCache;
}

/** Persist a corrected query (as a template) for the current project + query shape. */
async function saveSoqlFix(originalSoql, correctedSoql) {
  const all = await loadSoqlFixes();
  const proj = _soqlProjectKey();
  if (!all[proj]) all[proj] = {};
  all[proj][normalizeSoqlKey(originalSoql)] = toSoqlTemplate(correctedSoql);
  _soqlFixesCache = all;
  try { await window.apexStudio.writeFile(await _soqlFixesPath(), JSON.stringify(all, null, 2)); } catch (_) { /* best effort */ }
}

/**
 * Best available corrected query for a concrete SOQL, or null. Session fixes (chosen
 * "continue" WITHOUT "remember") take precedence over persisted ones. Returns a
 * ready-to-run query with the current literals re-injected.
 */
async function getEffectiveSoqlFix(soql) {
  const key = normalizeSoqlKey(soql);
  const sess = debugState._soqlSessionFixes && debugState._soqlSessionFixes.get(key);
  if (sess) { const applied = applySoqlTemplate(sess, soql); if (applied && applied !== soql) return applied; }
  const all = await loadSoqlFixes();
  const proj = all[_soqlProjectKey()];
  const tpl = proj && proj[key];
  if (!tpl) return null;
  const applied = applySoqlTemplate(tpl, soql);
  return (applied && applied !== soql) ? applied : null;
}

/** Execute a fully-resolved SOQL string against the org via `sf data query` (cached). */
async function execSoql(soql, opts) {
  const org = getActiveOrg();
  if (!org) return { records: [], error: 'No org connected', soql };

  // Transparently apply a previously-saved (project) or session-scoped interactive fix
  // for this query's shape. Skipped for the fix dialog's own test run (noSavedFix) so it
  // tests exactly what the user typed.
  let appliedSavedFix = false;
  if (!(opts && opts.noSavedFix)) {
    try {
      const fixed = await getEffectiveSoqlFix(soql);
      if (fixed && fixed !== soql) { soql = fixed; appliedSavedFix = true; }
    } catch (_) { /* fixes are best-effort — fall back to the original query */ }
  }

  if (debugState.orgQueryCache.has(soql)) {
    const cached = debugState.orgQueryCache.get(soql);
    return appliedSavedFix ? { ...cached, _appliedSavedFix: true } : cached;
  }

  let result = await _runSoqlOnce(soql);
  // Managed-package objects/fields need their namespace prefix when queried via the
  // CLI (which runs outside the package namespace). Retry with the prefix when the
  // query FAILS, and also when a by-Id / filtered lookup succeeds with 0 rows — in a
  // namespaced org an unqualified object name can resolve to a different (empty)
  // object, so 0 rows by Id is a strong signal we queried the wrong namespace. We
  // only switch to the namespaced result when it actually returns rows, so a record
  // that is genuinely absent still reports 0 rows truthfully.
  const compileErr = result.error && /not supported|INVALID_TYPE|INVALID_FIELD|No such column|did.?n.?t understand/i.test(result.error);
  const emptyResult = !result.error && (result.records || []).length === 0;
  if (compileErr || emptyResult) {
    const ns = await getPackageNamespace();
    const nsSoql = await applyNamespaceToSoql(soql, ns);
    if (ns && nsSoql !== soql) {
      const r2 = await _runSoqlOnce(nsSoql);
      if (!r2.error && (r2.records || []).length > 0) {
        result = { ...r2, soql: nsSoql };           // namespaced object had the real data
      } else if (compileErr && !r2.error) {
        result = { ...r2, soql: nsSoql };           // bare name didn't compile; namespaced did (0 rows, truthful)
      } else if (compileErr && r2.error) {
        // The namespaced ENTITY can resolve while some COLUMNS don't exist in the
        // package version installed in this org (e.g. Apttus_Config2__TempObject__c
        // has no Data__c/ConfigurationId__c here). In that case adopt the namespaced
        // query so the drop-missing-column retry below can strip the absent fields and
        // still return the real row — degrading those fields to null instead of hard
        // failing the whole query. Only keep the combined error when even the
        // namespaced entity is unknown (a genuine object/type mismatch).
        const nsEntityResolved = /No such column\s+'[\w.]+'\s+on entity\s+'[\w.]+'/i.test(r2.error)
          || /INVALID_FIELD/i.test(r2.error)
          || /Didn.?t understand relationship/i.test(r2.error);
        if (nsEntityResolved) {
          result = { ...r2, soql: nsSoql };
        } else {
          result = { ...result, error: `${result.error} (also tried ${ns} namespace: ${r2.error})` };
        }
      }
      // (emptyResult && r2 also empty) → keep the original 0-row result: truly not found.
    }
  }

  // Fix 1: drop-invisible-column retry — some managed-package columns are not
  // visible outside the package (deprecated/protected). When the org reports
  // "No such column 'X' on entity 'Y'", strip X from the SELECT list and retry,
  // up to 6 times. The engine treats absent fields as null, matching in-org behavior.
  const droppedColumns = [];
  let colRetryQuery = result.soql || soql;
  for (let dropAttempt = 0; dropAttempt < 6 && result.error; dropAttempt++) {
    const noColM = result.error.match(/No such column '([\w.]+)' on entity '[\w.]+'/i)
      || result.error.match(/Didn.?t understand relationship '([\w.]+)'/i)
      || result.error.match(/INVALID_FIELD[^']*'([\w.]+)'/i);
    if (!noColM) break; // not a column-visibility error we can fix
    const badCol = noColM[1];
    const stripped = stripColumnFromSoql(colRetryQuery, badCol);
    if (!stripped) break; // col not in SELECT (e.g. only in WHERE/ORDER BY) — can't fix
    colRetryQuery = stripped;
    droppedColumns.push(badCol);
    const r3 = await _runSoqlOnce(colRetryQuery);
    result = { ...r3, soql: colRetryQuery };
  }
  if (!result.error && droppedColumns.length) result.droppedColumns = droppedColumns;
  if (appliedSavedFix) result._appliedSavedFix = true;

  debugState.orgQueryCache.set(soql, result);
  return result;
}

/* ======================================================================
 * SYSTEM-MODE helper class
 * ----------------------------------------------------------------------
 * Anonymous Apex runs in the connected user's context and CANNOT self-escalate
 * to system mode — Salesforce blocks both `AccessLevel.SYSTEM_MODE` and the
 * `WITH SYSTEM_MODE` clause there (verified: "Cannot use SYSTEM_MODE access
 * level in anonymous execution of Apex."). The only truthful way to read
 * managed-package data the user lacks FLS/CRUD for is to run the query inside a
 * DEPLOYED `without sharing` class, which we then call from anonymous Apex. That
 * class executes in system mode, so blocked objects/fields are returned intact.
 *
 * We never deploy without consent: the first time an org needs system mode and
 * the helper isn't present, we show a pop-up explaining exactly what will be
 * deployed. Deploy only happens on the user's OK; otherwise we fall back to
 * user-mode queries. Status is cached per org for the session.
 * ==================================================================== */
const SYS_HELPER_CLASS = 'ApexDebugStudioSystemQuery';
const SYS_HELPER_API_VERSION = '58.0';

/* ----------------------------------------------------------------------
 * System-mode opt-in
 * --------------------------------------------------------------------
 * The preference is tri-state and persisted per app:
 *   'auto' (default) — resume system mode automatically on any org where the read-only
 *                      helper class is ALREADY deployed; stay in user mode everywhere else.
 *                      Nothing is ever deployed in 'auto' — we only DETECT an existing class,
 *                      so locked-down customer orgs (no helper) are never touched.
 *   'on'            — user explicitly forced system mode (offers to deploy the helper if absent).
 *   'off'           — user explicitly forced user mode (never uses system mode).
 * `debugState.systemModeEnabled` is the EFFECTIVE state for the connected org.
 * ------------------------------------------------------------------- */
const DBG_SYSMODE_KEY = 'apexstudio.debug.systemMode.v1';

/** True when reads should run in system mode for the connected org. */
function isSystemModeEnabled() {
  return !!debugState.systemModeEnabled;
}

/** The persisted preference: 'auto' | 'on' | 'off'. */
function systemModePref() {
  return debugState.systemModePref || 'auto';
}

/** Load the persisted system-mode preference (called once at init). */
function loadSystemModePref() {
  let pref = 'auto';
  try {
    const raw = localStorage.getItem(DBG_SYSMODE_KEY);
    if (raw === 'on' || raw === '1') pref = 'on';   // '1' = legacy explicit-on
    else if (raw === 'off') pref = 'off';           // legacy '0' falls through to 'auto'
  } catch (_) { /* default auto */ }
  debugState.systemModePref = pref;
  // 'auto' starts OFF until a connected org with the helper flips it on (onOrgConnectedCheckHelper).
  debugState.systemModeEnabled = (pref === 'on');
  return pref;
}

/**
 * Explicit user choice via the ⚡ toggle. Persists 'on'/'off' so it sticks and so
 * auto-resume no longer overrides it. Use setSystemModeAuto() for the automatic path.
 */
function setSystemMode(on) {
  debugState.systemModeEnabled = !!on;
  debugState.systemModePref = on ? 'on' : 'off';
  try { localStorage.setItem(DBG_SYSMODE_KEY, on ? 'on' : 'off'); } catch (_) {}
  updateSystemModeUi();
}

/** Set the EFFECTIVE state from the auto-resume path WITHOUT changing the 'auto' preference. */
function setSystemModeAuto(on) {
  debugState.systemModeEnabled = !!on;
  updateSystemModeUi();
}

/** Reflect the current system-mode state onto the org-bar + debug-panel toggle buttons. */
function updateSystemModeUi() {
  const on = isSystemModeEnabled();
  const auto = systemModePref() === 'auto';
  const label = on ? '⚡ System mode' : '🔒 User mode';
  const title = on
    ? `System mode ON${auto ? ' (auto-resumed — helper already on this org)' : ''} — reads FLS-hidden managed-package fields via the read-only helper class. Click to switch to user mode.`
    : 'User mode — reads only what the connected user can see; nothing is deployed. System mode resumes automatically on orgs where the helper class already exists; click to enable it here (deploys the helper if the org does not have it yet).';
  for (const id of ['sf-systemmode-toggle', 'dbg-systemmode-toggle']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.classList.toggle('on', on);
    btn.textContent = label;
    btn.title = title;
  }
}

/**
 * Toggle system mode from the UI. Turning it ON immediately verifies/deploys the helper
 * on the active org (with the existing consent modal); turning it OFF is instant and
 * deploys nothing. Returns the resulting boolean state.
 */
async function toggleSystemMode() {
  const next = !isSystemModeEnabled();
  setSystemMode(next);
  if (next) {
    const org = getActiveOrg();
    if (!org || !org.org) {
      addConsoleEntry('warn', 'System mode enabled, but no org is connected yet — connect an org, then it will offer to deploy the read-only helper when a hidden field is needed.');
      renderConsolePanel();
    } else {
      // Explicit opt-in → run the consent + deploy flow now so the first hidden-field read is instant.
      debugState.sysHelper.delete(org.org);
      try {
        const status = await ensureSystemHelper(org);
        if (status === 'declined') { addConsoleEntry('info', 'System mode left OFF — helper deploy was declined. Reads stay in user mode.'); setSystemMode(false); }
        else if (status === 'unavailable') { addConsoleEntry('warn', 'System mode is ON, but the helper class could not be deployed to this org (likely no deploy permission). Hidden fields will show as 🔒 until it can be deployed or the user is granted access.'); }
        else if (status === 'privileged') { addConsoleEntry('info', "System mode ON — you're connected as a System Administrator (full data access), so user-mode reads already return every field. No helper class was deployed."); }
      } catch (_) { /* non-fatal */ }
      renderConsolePanel();
    }
  } else {
    addConsoleEntry('info', 'System mode OFF — reads run in user mode via the Query API (nothing deployed, no debug logs).');
    renderConsolePanel();
  }
  return isSystemModeEnabled();
}

/** The read-only system-mode helper class source. */
function sysHelperApexBody() {
  return [
    'public without sharing class ' + SYS_HELPER_CLASS + ' {',
    '    // Deployed by the Apex Debug Studio Apex debugger. Runs READ-ONLY SOQL that you',
    '    // trigger in system mode (AccessLevel.SYSTEM_MODE), so managed-package',
    "    // data your user lacks permission for (e.g. Apttus_Config2__TempObject__c)",
    '    // can be inspected truthfully. It never performs any DML.',
    '    public static String ccQuery(String soql) {',
    '        List<SObject> rows = Database.query(soql, AccessLevel.SYSTEM_MODE);',
    '        return JSON.serialize(rows);',
    '    }',
    '}',
    '',
  ].join('\n');
}

/** Minimal HTML escaping for text interpolated into the consent modal. */
function dbgEscapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Helper-class presence on the org: true (present), false (absent), null (couldn't check). */
async function systemHelperExists(org) {
  if (!org || !org.org) return null;
  const folder = window.state?.folderPath;
  const cmd = `sf data query --use-tooling-api --query "SELECT Id FROM ApexClass WHERE Name='${SYS_HELPER_CLASS}' LIMIT 1" --json --target-org ${org.org}`;
  try {
    const { stdout } = await window.apexStudio.sfExec(cmd, folder, 60000);
    const parsed = parseSfJson(stdout);
    if (parsed && parsed.status === 0 && parsed.result) {
      return (parsed.result.records || []).length > 0;
    }
  } catch (_) { /* fall through → unknown */ }
  return null; // query itself failed (auth/CLI) — org not verifiable right now
}

/**
 * Whether the connected user already has org-wide data access — i.e. the stock
 * "System Administrator" profile, or any profile / permission set that grants
 * "Modify All Data" or "View All Data". Such a user reads every field in plain
 * user mode, so the system-mode helper class is unnecessary and we skip the
 * deploy consent for them entirely. Returns true / false / null (couldn't tell).
 * Cached per org on debugState._userFullAccess.
 */
async function connectedUserHasFullAccess(org) {
  if (!org || !org.org) return null;
  const cache = debugState._userFullAccess;
  if (cache && cache.org === org.org && typeof cache.value === 'boolean') return cache.value;

  const folder = window.state?.folderPath;
  const ui = await getOrgUserInfo();
  // Fast path: the stock System Administrator profile always carries Modify All Data.
  if (ui && ui.profileName && /^system administrator$/i.test(String(ui.profileName).trim())) {
    debugState._userFullAccess = { org: org.org, value: true };
    return true;
  }
  const userId = ui && ui.id;
  if (!userId) return null; // can't verify who's connected → let the caller prompt

  // Robust path: any assigned permission set (which includes the profile's own
  // permission set) granting Modify All Data / View All Data.
  const soql = `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId='${userId}' AND (PermissionSet.PermissionsModifyAllData=true OR PermissionSet.PermissionsViewAllData=true) LIMIT 1`;
  try {
    const { stdout } = await window.apexStudio.sfExec(
      `sf data query --query "${soql}" --json --target-org ${org.org}`, folder, 60000);
    const parsed = parseSfJson(stdout);
    if (parsed && parsed.status === 0 && parsed.result) {
      const value = (parsed.result.records || []).length > 0;
      debugState._userFullAccess = { org: org.org, value };
      return value;
    }
  } catch (_) { /* fall through → unknown */ }
  return null;
}

/** Deploy the helper class via a throwaway SFDX project. Returns { ok, error }. */
async function deploySystemHelper(org) {
  if (!org || !org.org) return { ok: false, error: 'no org' };
  try {
    const paths = await window.apexStudio.getPaths?.();
    const base = (paths?.appDataDir || paths?.home || '.') + '/.cc_sys_helper';
    const projFile = `${base}/sfdx-project.json`;
    const clsFile = `${base}/force-app/main/default/classes/${SYS_HELPER_CLASS}.cls`;
    const metaFile = `${clsFile}-meta.xml`;
    await window.apexStudio.writeFile(projFile, JSON.stringify({
      packageDirectories: [{ path: 'force-app', default: true }],
      namespace: '', sourceApiVersion: SYS_HELPER_API_VERSION,
    }, null, 2));
    await window.apexStudio.writeFile(clsFile, sysHelperApexBody());
    await window.apexStudio.writeFile(metaFile,
      `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${SYS_HELPER_API_VERSION}</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`);
    const cmd = `sf project deploy start --source-dir force-app --target-org ${org.org} --json`;
    const { stdout, stderr } = await window.apexStudio.sfExec(cmd, base, 120000);
    const parsed = parseSfJson(stdout);
    if (parsed && parsed.status === 0 && parsed.result && parsed.result.success) return { ok: true };
    return { ok: false, error: sfErrorText(parsed, stderr, stdout, 'Deploy failed') };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Consent pop-up shown before deploying the helper class. Explains what will be
 * deployed and why. Resolves true (deploy) or false (use user mode).
 */
function showSystemHelperConsent(org) {
  return new Promise((resolve) => {
    const prev = document.getElementById('cc-syshelper-overlay');
    if (prev) prev.remove();
    const orgLabel = org?.info?.alias || org?.org || 'the connected org';
    const overlay = document.createElement('div');
    overlay.id = 'cc-syshelper-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'z-index:2000;';
    overlay.innerHTML = `
      <div class="curl-import-modal" style="width:540px;max-width:92vw;">
        <div class="curl-import-header" style="padding:10px 16px;">
          <span class="curl-import-title">⚡ Enable system mode on ${dbgEscapeHtml(orgLabel)}</span>
        </div>
        <div class="curl-import-body" style="padding:14px 16px;line-height:1.55;font-size:13px;">
          <p style="margin:0 0 10px;">Some managed-package data (for example <code>Apttus_Config2__TempObject__c</code> and its <code>Data__c</code> field) isn't readable by your connected user, so queries fail with <em>"sObject type not supported"</em> or <em>"No such column"</em> and the debugger can't see the real values.</p>
          <p style="margin:0 0 8px;">To read that data <strong>truthfully</strong> — without changing any permissions — Apex Debug Studio needs to deploy one small Apex helper class to this org:</p>
          <ul style="margin:0 0 10px 18px;padding:0;">
            <li><code>${dbgEscapeHtml(SYS_HELPER_CLASS)}</code> — a <code>without sharing</code> class that runs the <strong>read-only SELECT</strong> queries you trigger in <strong>system mode</strong> (bypasses object/field permissions).</li>
            <li>It <strong>never</strong> inserts, updates, or deletes anything. It's reusable across runs, and you can delete it from the org anytime.</li>
          </ul>
          <p style="margin:0;color:var(--text-secondary,#8a8a8a);font-size:12px;">Deploys to: ${dbgEscapeHtml(org?.org || '')}</p>
        </div>
        <div class="curl-import-footer" style="padding:10px 16px;">
          <button id="cc-syshelper-decline" class="curl-import-btn curl-import-cancel">Not now (use user mode)</button>
          <button id="cc-syshelper-deploy" class="curl-import-btn curl-import-apply">Deploy helper class</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const finish = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    overlay.querySelector('#cc-syshelper-deploy').addEventListener('click', () => finish(true));
    overlay.querySelector('#cc-syshelper-decline').addEventListener('click', () => finish(false));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('#cc-syshelper-deploy')?.focus(), 60);
  });
}

/**
 * Interactive "Fix SOQL & continue" dialog. Shown when a query the debugger runs fails
 * with a fixable structural error (bad field/relationship/type/malformed SOQL). Lets the
 * user edit the SOQL, run it live against the org, and continue with the results — so a
 * per-org schema difference doesn't dead-end the debug session. Read-only; never DML.
 * Resolves one of:
 *   { action:'continue', records, soql, remember }  // use the edited query's rows
 *   { action:'zero' }                               // continue with 0 rows
 *   { action:'abort' }                              // give up → the original error throws
 */
function showSoqlFixModal({ soql, error, resolvedSoql }) {
  return new Promise((resolve) => {
    const prev = document.getElementById('cc-soqlfix-overlay');
    if (prev) prev.remove();
    const startSoql = (resolvedSoql || soql || '').replace(/\s+/g, ' ').trim();
    const orgLabel = (getActiveOrg() || {}).org || 'the connected org';
    const overlay = document.createElement('div');
    overlay.id = 'cc-soqlfix-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'z-index:2000;';
    overlay.innerHTML = `
      <div class="curl-import-modal" style="width:700px;max-width:94vw;">
        <div class="curl-import-header" style="padding:10px 16px;">
          <span class="curl-import-title">🛠 Fix SOQL & continue</span>
        </div>
        <div class="curl-import-body" style="padding:14px 16px;line-height:1.5;font-size:13px;">
          <p style="margin:0 0 8px;">This query failed against <strong>${dbgEscapeHtml(orgLabel)}</strong>. Every org's schema differs, so edit the query to match THIS org and run it — then continue with the results. This only changes the read query the debugger runs; your org is never modified.</p>
          <div style="margin:0 0 10px;padding:8px 10px;background:var(--bg-tertiary,#161b22);border:1px solid var(--border-color,#30363d);border-left:3px solid #f85149;border-radius:4px;color:#ff7b72;font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;white-space:pre-wrap;max-height:120px;overflow:auto;">${dbgEscapeHtml(error || '')}</div>
          <label for="soqlfix-input" style="display:block;margin:0 0 4px;color:var(--text-secondary,#8a8a8a);font-size:12px;">SOQL (editable — press ⌘/Ctrl+Enter to run)</label>
          <textarea id="soqlfix-input" spellcheck="false" style="width:100%;height:150px;box-sizing:border-box;resize:vertical;font-family:var(--font-mono,ui-monospace,monospace);font-size:12.5px;line-height:1.45;padding:8px 10px;background:var(--bg-primary,#0d1117);color:var(--text-primary,#e6edf3);border:1px solid var(--border-color,#30363d);border-radius:4px;">${dbgEscapeHtml(startSoql)}</textarea>
          <div id="soqlfix-result" style="margin-top:8px;font-size:12px;min-height:18px;white-space:pre-wrap;"></div>
          <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--text-secondary,#8a8a8a);cursor:pointer;">
            <input type="checkbox" id="soqlfix-remember" checked style="margin:0;" />
            Remember this fix for this project (auto-apply to the same query next time, until the schema changes)
          </label>
        </div>
        <div class="curl-import-footer" style="padding:10px 16px;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
          <button id="soqlfix-abort" class="curl-import-btn curl-import-cancel">Abort (throw error)</button>
          <button id="soqlfix-zero" class="curl-import-btn curl-import-cancel">Continue with 0 rows</button>
          <button id="soqlfix-run" class="curl-import-btn">▶ Run test</button>
          <button id="soqlfix-use" class="curl-import-btn curl-import-apply" disabled style="opacity:.5;">Use results &amp; continue</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#soqlfix-input');
    const resultBox = overlay.querySelector('#soqlfix-result');
    const useBtn = overlay.querySelector('#soqlfix-use');
    const runBtn = overlay.querySelector('#soqlfix-run');
    const rememberBox = overlay.querySelector('#soqlfix-remember');
    let lastGood = null; // { records, soql } — set after a successful test run

    const cleanup = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const finish = (val) => { cleanup(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish({ action: 'abort' }); } };
    const setUseEnabled = (on) => { useBtn.disabled = !on; useBtn.style.opacity = on ? '1' : '.5'; };

    const doRun = async () => {
      const edited = input.value.trim();
      if (!edited) { resultBox.innerHTML = `<span style="color:#ff7b72;">Enter a query to run.</span>`; return; }
      runBtn.disabled = true; runBtn.textContent = '⏳ Running…';
      resultBox.innerHTML = `<span style="color:var(--text-secondary,#8a8a8a);">Running against the org…</span>`;
      setUseEnabled(false); lastGood = null;
      let res;
      try { res = await execSoql(edited, { noSavedFix: true }); }
      catch (e) { res = { error: e?.message || String(e) }; }
      runBtn.disabled = false; runBtn.textContent = '▶ Run test';
      if (res.error) {
        setUseEnabled(false);
        resultBox.innerHTML = `<span style="color:#ff7b72;">✗ ${dbgEscapeHtml(res.error)}</span>`;
      } else {
        const n = (res.records || []).length;
        lastGood = { records: res.records || [], soql: edited };
        setUseEnabled(true);
        const dropped = (res.droppedColumns && res.droppedColumns.length)
          ? ` (dropped column(s) absent in this org: ${dbgEscapeHtml(res.droppedColumns.join(', '))})` : '';
        resultBox.innerHTML = `<span style="color:#3fb950;">✓ ${n} row(s) returned${dropped}. Click “Use results & continue”.</span>`;
      }
    };

    runBtn.addEventListener('click', doRun);
    input.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doRun(); } });
    useBtn.addEventListener('click', () => {
      if (!lastGood) return;
      finish({ action: 'continue', records: lastGood.records, soql: lastGood.soql, remember: !!rememberBox.checked });
    });
    overlay.querySelector('#soqlfix-zero').addEventListener('click', () => finish({ action: 'zero' }));
    overlay.querySelector('#soqlfix-abort').addEventListener('click', () => finish({ action: 'abort' }));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish({ action: 'abort' }); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => input?.focus(), 60);
  });
}

/**
 * Ensure the system-mode helper is usable on the org. Returns 'ready',
 * 'declined', or 'unavailable'. Prompts for consent + deploys only when needed.
 * Caches per org (and dedupes concurrent callers via an in-flight promise).
 */
async function ensureSystemHelper(org) {
  if (!org || !org.org) return 'unavailable';
  const key = org.org;
  const cached = debugState.sysHelper.get(key);
  if (typeof cached === 'string') return cached;
  if (cached && typeof cached.then === 'function') return cached;

  const p = (async () => {
    const exists = await systemHelperExists(org);
    if (exists === true) return 'ready';
    if (exists === null) return 'unavailable'; // org not verifiable now → use user mode, don't prompt
    // Helper absent. If the connected user already has org-wide data access
    // (System Administrator / Modify All / View All Data), plain user mode reads
    // every field — so skip the deploy consent panel entirely for them.
    let fullAccess = null;
    try { fullAccess = await connectedUserHasFullAccess(org); } catch (_) { fullAccess = null; }
    if (fullAccess === true) return 'privileged';
    const ok = await showSystemHelperConsent(org);
    if (!ok) return 'declined';
    addConsoleEntry('info', `⏳ Deploying system-mode helper class ${SYS_HELPER_CLASS} to ${org.info?.alias || org.org}…`);
    renderConsolePanel();
    const res = await deploySystemHelper(org);
    if (res.ok) {
      addConsoleEntry('info', `✓ ${SYS_HELPER_CLASS} deployed — SOQL now runs in system mode (full read permissions, no data fabricated).`);
      renderConsolePanel();
      return 'ready';
    }
    addConsoleEntry('error', `Helper class deploy failed: ${res.error}. Falling back to user-mode queries (permission-limited).`);
    renderConsolePanel();
    return 'unavailable';
  })();

  debugState.sysHelper.set(key, p);
  const status = await p;
  debugState.sysHelper.set(key, status);
  return status;
}

/**
 * Called by the Salesforce module when the user connects/switches to an org.
 *
 * AUTO-RESUME: when the preference is 'auto' (the default), we do a cheap read-only check
 * for whether the read-only helper class is ALREADY deployed on this org. If it is, we turn
 * system mode ON for this org so FLS-hidden managed-package fields read truthfully again
 * (this is what stops the "null field → NullPointerException" seen in user mode). We NEVER
 * deploy here — an org without the helper simply stays in safe user mode and shows 🔒.
 *
 * An explicit user choice ('on'/'off' via the ⚡ toggle) always wins and is left untouched.
 */
async function onOrgConnectedCheckHelper(org) {
  // A (re)connect may be a different org/user — drop cached identity + access so
  // the next lookups re-evaluate against the org that's actually connected now.
  debugState._orgUserInfo = undefined;
  debugState._userFullAccess = undefined;
  // Explicit user choice wins — never auto-flip it.
  if (systemModePref() !== 'auto') { updateSystemModeUi(); return; }
  if (!org || !org.org || !liveOrgAvailable()) { setSystemModeAuto(false); return; }
  let exists = null;
  try { exists = await systemHelperExists(org); } catch (_) { exists = null; }
  if (exists === true) {
    // Prime the per-org status cache so the first read skips a second existence check.
    debugState.sysHelper.set(org.org, 'ready');
    if (!isSystemModeEnabled()) {
      addConsoleEntry('info', `⚡ System mode auto-resumed on ${org.info?.alias || org.org} — the read-only helper class ${SYS_HELPER_CLASS} is already deployed, so FLS-hidden managed-package fields are readable (nothing was deployed). Click the toggle for user mode.`);
      renderConsolePanel();
    }
    setSystemModeAuto(true);
  } else {
    // Helper absent, or org not verifiable right now → stay in safe user mode (🔒 for hidden data).
    setSystemModeAuto(false);
  }
}

/**
 * Single SOQL invocation (no caching, no namespace retry).
 *
 * DEFAULT is USER MODE via the REST Query API (`sf data query`) — it creates NO debug
 * log and deploys nothing, so it's the right choice for locked-down customer orgs. It
 * returns every field the connected user can see.
 *
 * SYSTEM MODE (deployed `without sharing` helper, `AccessLevel.SYSTEM_MODE`) is only
 * used when the user has explicitly enabled it via the ⚡ toggle AND the helper is
 * deployed. It bypasses the user's FLS/CRUD so hidden managed-package data is returned.
 *
 * Returns { records, error, soql, mode }.
 */
async function _runSoqlOnce(soql) {
  if (liveOrgAvailable() && isSystemModeEnabled()) {
    const org = getActiveOrg();
    let status = 'unavailable';
    try { status = await ensureSystemHelper(org); } catch (_) { /* fall through */ }
    if (status === 'ready') {
      const viaSystem = await _runSoqlViaApexSystem(soql);
      if (viaSystem && !viaSystem._apexUnavailable) return viaSystem;
    }
  }
  // USER MODE (default): REST Query API — no debug log created.
  const viaRest = await _runSoqlViaRest(soql);
  if (viaRest && !viaRest._restUnavailable) return viaRest;
  // REST itself couldn't run (CLI/auth failure). Anonymous Apex is the only remaining
  // option, but it needs FINEST logging; only fall back to it when system mode is on
  // (so user mode never silently starts generating debug logs).
  if (liveOrgAvailable() && isSystemModeEnabled()) {
    const viaApex = await _runSoqlViaApexUser(soql);
    if (viaApex && !viaApex._apexUnavailable) return viaApex;
  }
  return viaRest;
}

/** True when an error string looks like a CLI/auth/connection failure (not a real query error). */
function _looksLikeCliAuthError(txt) {
  return /No authorization information|not been authorized|Session expired|INVALID_SESSION|expired access\/refresh token|Could not.*refresh|No such (file|org)|command not found|ENOENT|Cannot read propert|Maximum call stack|timed out|ETIMEDOUT|self.signed|getaddrinfo|ECONNREFUSED/i.test(String(txt || ''));
}

/** USER-MODE fetch: a single `sf data query` invocation (REST Query API). Creates NO debug log. */
async function _runSoqlViaRest(soql) {
  const org = getActiveOrg();
  const folder = window.state?.folderPath;
  const escaped = soql.replace(/"/g, '\\"');
  const cmd = `sf data query --query "${escaped}" --json --target-org ${org.org}`;
  let result = { records: [], error: null, soql, mode: 'user' };
  try {
    const { stdout, stderr } = await window.apexStudio.sfExec(cmd, folder, 60000);
    const parsed = parseSfJson(stdout);
    if (parsed && parsed.status === 0 && parsed.result) {
      result.records = (parsed.result.records || []).map(cleanSObject);
    } else {
      result.error = sfErrorText(parsed, stderr, stdout, 'Query failed');
      // Distinguish a genuine query rejection (return it → namespace retry / 🔒 hint)
      // from the CLI being unable to run at all (signal a fallback to anonymous Apex).
      if (!parsed || _looksLikeCliAuthError(result.error)) result._restUnavailable = true;
    }
  } catch (e) {
    result.error = e?.message || String(e);
    result._restUnavailable = true;
  }
  return result;
}

/**
 * SYSTEM-MODE fetch: run the query through the deployed helper class
 * (`ApexDebugStudioSystemQuery.ccQuery`, which uses `Database.query(soql,
 * AccessLevel.SYSTEM_MODE)`), invoked from a thin anonymous Apex wrapper. Because
 * the query executes inside a compiled `without sharing` class, it bypasses the
 * connected user's object/field permissions — so managed-package data the user
 * can't otherwise read (e.g. Apttus_Config2__TempObject__c.Data__c) is returned
 * intact. Rows come back via chunked FINEST-log markers (results can be large).
 *
 * Returns { records, error, soql, mode:'system' }. A genuine query error is
 * surfaced as `error` so the caller's namespace-retry still fires. Returns
 * { _apexUnavailable: true } when the mechanism can't run (auth/CLI failure, no
 * debug log, or the helper class isn't callable) so the caller falls back to the
 * user-mode path. No data is fabricated.
 */
async function _runSoqlViaApexSystem(soql) {
  const org = getActiveOrg();
  if (!org) return { _apexUnavailable: true };
  // Anonymous Apex only yields our result markers when FINEST logging is on for the
  // running user. Warm it on demand (cached) so this works even if the proactive
  // warm-up didn't run (e.g. system mode was enabled mid-session).
  await ensureFinestLogging(org.org);
  debugState._generatedOrgLogs = true;
  // Escape for an Apex single-quoted literal. escapeApexString also converts raw
  // newlines to \n — critical because the source SOQL is often multi-line
  // (e.g. ConfigRequest.getRequestSO), and raw newlines make the wrapper fail to
  // compile, which would silently drop us to user mode and defeat system mode.
  const escaped = escapeApexString(soql);
  const apex = [
    `String ccOut = '[]';`,
    `String ccErr = '';`,
    `try {`,
    `    ccOut = ${SYS_HELPER_CLASS}.ccQuery('${escaped}');`,
    `} catch (Exception ccE) {`,
    `    ccErr = ccE.getTypeName() + ': ' + ccE.getMessage();`,
    `}`,
    `if (String.isBlank(ccOut)) ccOut = '[]';`,
    `Integer ccChunk = 3000;`,
    `for (Integer i = 0; i < ccOut.length(); i += ccChunk) { System.debug(LoggingLevel.ERROR, '__CC_SOQL__' + ccOut.substring(i, Math.min(i + ccChunk, ccOut.length()))); }`,
    `System.debug(LoggingLevel.ERROR, '__CC_SOQLEND__');`,
    `System.debug(LoggingLevel.ERROR, '__CC_SOQLERR__' + ccErr);`,
  ].join('\n');
  try {
    const paths = await window.apexStudio.getPaths?.();
    const dir = paths?.appDataDir || paths?.home || '.';
    const tmpFile = `${dir}/.cc_debug_soql_sys.apex`;
    await window.apexStudio.writeFile(tmpFile, apex);
    const cmd = `sf apex run --file "${tmpFile}" --json --target-org ${org.org}`;
    const { stdout, stderr } = await window.apexStudio.sfExec(cmd, window.state?.folderPath, 60000);
    const cli = parseSfJson(stdout);
    if (!cli) return { _apexUnavailable: true };
    const res = (cli.result || cli.data) || {};
    const log = res.logs || '';
    if (cli.status && cli.status !== 0 && !log) return { _apexUnavailable: true }; // auth/IP/CLI failure
    if (res.compiled === false) return { _apexUnavailable: true };                  // helper missing / wrapper didn't compile
    const chunks = [];
    let qErr = '', sawMarker = false;
    for (const line of log.split('\n')) {
      const pipe = line.split('|');
      const msg = pipe.length >= 5 ? pipe.slice(4).join('|') : '';
      if (msg.startsWith('__CC_SOQL__')) { chunks.push(msg.slice('__CC_SOQL__'.length)); sawMarker = true; }
      else if (msg.startsWith('__CC_SOQLEND__')) { sawMarker = true; }
      else if (msg.startsWith('__CC_SOQLERR__')) { qErr = msg.slice('__CC_SOQLERR__'.length); sawMarker = true; }
    }
    if (!sawMarker) return { _apexUnavailable: true }; // no markers (FINEST off) → fall back
    if (qErr) return { records: [], error: qErr, soql };
    let recs = [];
    try { recs = JSON.parse(chunks.join('')) || []; } catch { recs = []; }
    if (!Array.isArray(recs)) recs = recs ? [recs] : [];
    return { records: recs.map(cleanSObject), error: null, soql, mode: 'system' };
  } catch (e) {
    return { _apexUnavailable: true };
  }
}

/**
 * USER-MODE fetch: run the query inside anonymous Apex via `sf apex run` and pull
 * the serialized rows out of the FINEST debug log. Anonymous Apex executes as the
 * connected user and enforces their object/field permissions, so this is the
 * fallback used when the system-mode helper isn't available (declined / deploy
 * failed / older org). Rows blocked by permissions will error here, exactly as
 * they would for that user in the org.
 *
 * Returns { records, error, soql, mode:'user' }. A genuine query error is
 * surfaced as `error` so the caller's namespace-retry still fires. Returns
 * { _apexUnavailable: true } only when the Apex mechanism itself can't run
 * (auth/CLI failure, no debug log), signalling a fall back to the REST Query API.
 */
async function _runSoqlViaApexUser(soql) {
  const org = getActiveOrg();
  if (!org) return { _apexUnavailable: true };
  // Needs FINEST markers — warm on demand (cached) so it works without the proactive warm-up.
  await ensureFinestLogging(org.org);
  debugState._generatedOrgLogs = true;
  // Escape for embedding inside an Apex single-quoted string literal.
  // escapeApexString also converts raw newlines to \n so multi-line SOQL still
  // compiles inside the anonymous wrapper.
  const escaped = escapeApexString(soql);
  const apex = [
    `List<SObject> ccRows = new List<SObject>();`,
    `String ccErr = '';`,
    `try {`,
    `    ccRows = Database.query('${escaped}');`,
    `} catch (Exception ccE) {`,
    `    ccErr = ccE.getTypeName() + ': ' + ccE.getMessage();`,
    `}`,
    `String ccOut;`,
    `try { ccOut = JSON.serialize(ccRows); } catch (Exception ccSe) { ccOut = '[]'; }`,
    `System.debug(LoggingLevel.ERROR, '__CC_SOQL__' + ccOut);`,
    `System.debug(LoggingLevel.ERROR, '__CC_SOQLERR__' + ccErr);`,
  ].join('\n');
  try {
    const paths = await window.apexStudio.getPaths?.();
    const dir = paths?.appDataDir || paths?.home || '.';
    const tmpFile = `${dir}/.cc_debug_soql.apex`;
    await window.apexStudio.writeFile(tmpFile, apex);
    const cmd = `sf apex run --file "${tmpFile}" --json --target-org ${org.org}`;
    const { stdout, stderr } = await window.apexStudio.sfExec(cmd, window.state?.folderPath, 60000);
    const cli = parseSfJson(stdout);
    if (!cli) return { _apexUnavailable: true };
    const res = (cli.result || cli.data) || {};
    const log = res.logs || '';
    if (cli.status && cli.status !== 0 && !log) return { _apexUnavailable: true }; // auth/IP/CLI failure
    if (res.compiled === false) return { _apexUnavailable: true };                  // wrapper didn't compile
    let raw = null, qErr = '';
    for (const line of log.split('\n')) {
      const pipe = line.split('|');
      const msg = pipe.length >= 5 ? pipe.slice(4).join('|') : '';
      if (msg.startsWith('__CC_SOQL__')) raw = msg.slice('__CC_SOQL__'.length);
      else if (msg.startsWith('__CC_SOQLERR__')) qErr = msg.slice('__CC_SOQLERR__'.length);
    }
    if (raw == null && !qErr) return { _apexUnavailable: true }; // no markers (FINEST off) → fall back to REST
    if (qErr) return { records: [], error: qErr, soql };         // real query exception → let caller retry/report
    let recs = [];
    try { recs = JSON.parse(raw) || []; } catch { recs = []; }
    if (!Array.isArray(recs)) recs = recs ? [recs] : [];
    return { records: recs.map(cleanSObject), error: null, soql, mode: 'user' };
  } catch (e) {
    return { _apexUnavailable: true };
  }
}

/**
 * Describe an SObject via the REST/Tooling describe API (`sf sobject describe`).
 * Creates NO debug log and needs nothing deployed — the preferred path. Maps the
 * REST field metadata onto the exact shape the engine consumes (see
 * callDescribeFieldResultMethod in apexengine.js). Returns { fields, names, label,
 * prefix, plural, obj, error } or a `_restUnavailable` marker on CLI/auth failure.
 */
async function _runDescribeViaRest(sobjectName) {
  const org = getActiveOrg();
  if (!org) return { error: 'no org' };
  const folder = window.state?.folderPath;
  const cmd = `sf sobject describe --sobject ${sobjectName} --json --target-org ${org.org}`;
  try {
    const { stdout, stderr } = await window.apexStudio.sfExec(cmd, folder, 60000);
    const parsed = parseSfJson(stdout);
    if (!parsed || parsed.status !== 0 || !parsed.result) {
      const error = sfErrorText(parsed, stderr, stdout, 'Describe failed');
      return { error, _restUnavailable: (!parsed || _looksLikeCliAuthError(error)) };
    }
    const d = parsed.result;
    const fields = (Array.isArray(d.fields) ? d.fields : []).map(f => ({
      name: f.name, label: f.label, type: f.type,
      custom: !!f.custom, html: !!f.htmlFormatted, calc: !!f.calculated,
      precision: f.precision || 0, scale: f.scale || 0, length: f.length || 0,
      nillable: !!f.nillable, defaultValue: (f.defaultValue !== undefined ? f.defaultValue : null),
      referenceTo: Array.isArray(f.referenceTo) ? f.referenceTo.slice() : [],
      nameField: !!f.nameField, unique: !!f.unique, externalId: !!f.externalId,
      updateable: !!f.updateable, createable: !!f.createable, sortable: !!f.sortable,
      filterable: !!f.filterable, relationshipName: f.relationshipName || null,
      picklist: (Array.isArray(f.picklistValues) ? f.picklistValues : []).map(pe => ({
        label: pe.label, value: pe.value, active: !!pe.active, default: !!pe.defaultValue,
      })),
    }));
    const names = fields.map(f => f.name).filter(Boolean);
    const obj = {
      accessible: d.accessible !== false, createable: !!d.createable, updateable: !!d.updateable,
      deletable: !!d.deletable, queryable: d.queryable !== false, searchable: !!d.searchable,
      mergeable: !!d.mergeable, custom: !!d.custom, customSetting: !!d.customSetting,
      feedEnabled: !!d.feedEnabled, undeletable: !!d.undeletable,
    };
    return { fields, names, label: d.label || sobjectName, prefix: d.keyPrefix || '', plural: d.labelPlural || sobjectName, obj, error: names.length ? null : 'no fields' };
  } catch (e) {
    return { error: e?.message || String(e), _restUnavailable: true };
  }
}

/**
 * Describe an SObject in the connected org via anonymous Apex, returning REAL
 * field API names (+ label / key prefix). Uses the same FINEST-log marker
 * mechanism as the SOQL fetch. No fabrication: if the type can't be described,
 * returns an error and an empty field list. Fallback only — prefer _runDescribeViaRest
 * (no debug log). Used for FLS-hidden fields when system mode is on.
 */
async function _runDescribeViaApex(sobjectName) {
  const org = getActiveOrg();
  if (!org) return { error: 'no org' };
  // Needs FINEST markers — warm on demand (cached).
  await ensureFinestLogging(org.org);
  debugState._generatedOrgLogs = true;
  const esc = String(sobjectName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const apex = [
    `List<Map<String,Object>> ccFields = new List<Map<String,Object>>();`,
    `String ccErr = '', ccLabel = '', ccPrefix = '', ccPlural = '';`,
    `Map<String,Object> ccObj = new Map<String,Object>();`,
    `try {`,
    `    Schema.DescribeSObjectResult ccD = Schema.describeSObjects(new String[]{'${esc}'})[0];`,
    `    for (Schema.SObjectField ccF : ccD.fields.getMap().values()) {`,
    `        Schema.DescribeFieldResult d = ccF.getDescribe();`,
    `        List<String> ccRef = new List<String>();`,
    `        if (d.getType() == Schema.DisplayType.REFERENCE) { for (Schema.SObjectType rt : d.getReferenceTo()) ccRef.add(String.valueOf(rt)); }`,
    `        List<Map<String,Object>> ccPick = new List<Map<String,Object>>();`,
    `        if (d.getType() == Schema.DisplayType.PICKLIST || d.getType() == Schema.DisplayType.MULTIPICKLIST) {`,
    `            for (Schema.PicklistEntry pe : d.getPicklistValues()) ccPick.add(new Map<String,Object>{'label'=>pe.getLabel(),'value'=>pe.getValue(),'active'=>pe.isActive(),'default'=>pe.isDefaultValue()}); }`,
    `        ccFields.add(new Map<String,Object>{`,
    `            'name'=>d.getName(),'label'=>d.getLabel(),'type'=>String.valueOf(d.getType()),`,
    `            'custom'=>d.isCustom(),'html'=>d.isHtmlFormatted(),'calc'=>d.isCalculated(),`,
    `            'precision'=>d.getPrecision(),'scale'=>d.getScale(),'length'=>d.getLength(),`,
    `            'nillable'=>d.isNillable(),'defaultValue'=>d.getDefaultValue(),'referenceTo'=>ccRef,`,
    `            'nameField'=>d.isNameField(),'unique'=>d.isUnique(),'externalId'=>d.isExternalID(),`,
    `            'updateable'=>d.isUpdateable(),'createable'=>d.isCreateable(),'sortable'=>d.isSortable(),`,
    `            'filterable'=>d.isFilterable(),'relationshipName'=>d.getRelationshipName(),'picklist'=>ccPick });`,
    `    }`,
    `    ccLabel = ccD.getLabel();`,
    `    ccPlural = ccD.getLabelPlural();`,
    `    if (ccD.getKeyPrefix() != null) ccPrefix = ccD.getKeyPrefix();`,
    `    ccObj = new Map<String,Object>{'accessible'=>ccD.isAccessible(),'createable'=>ccD.isCreateable(),`,
    `        'updateable'=>ccD.isUpdateable(),'deletable'=>ccD.isDeletable(),'queryable'=>ccD.isQueryable(),`,
    `        'searchable'=>ccD.isSearchable(),'mergeable'=>ccD.isMergeable(),'custom'=>ccD.isCustom(),`,
    `        'customSetting'=>ccD.isCustomSetting(),'feedEnabled'=>ccD.isFeedEnabled(),'undeletable'=>ccD.isUndeletable()};`,
    `} catch (Exception ccE) { ccErr = ccE.getTypeName() + ': ' + ccE.getMessage(); }`,
    `String ccOut;`,
    `try { ccOut = JSON.serialize(new Map<String,Object>{'fields'=>ccFields,'label'=>ccLabel,'prefix'=>ccPrefix,'plural'=>ccPlural,'obj'=>ccObj}); } catch (Exception e) { ccOut = '{}'; }`,
    `Integer ccChunk = 3000;`,
    `for (Integer i = 0; i < ccOut.length(); i += ccChunk) { System.debug(LoggingLevel.ERROR, '__CC_DESC__' + ccOut.substring(i, Math.min(i + ccChunk, ccOut.length()))); }`,
    `System.debug(LoggingLevel.ERROR, '__CC_DESCERR__' + ccErr);`,
  ].join('\n');
  try {
    const paths = await window.apexStudio.getPaths?.();
    const dir = paths?.appDataDir || paths?.home || '.';
    const tmpFile = `${dir}/.cc_debug_desc.apex`;
    await window.apexStudio.writeFile(tmpFile, apex);
    const cmd = `sf apex run --file "${tmpFile}" --json --target-org ${org.org}`;
    const { stdout } = await window.apexStudio.sfExec(cmd, window.state?.folderPath, 60000);
    const cli = parseSfJson(stdout);
    if (!cli) return { error: 'CLI unavailable' };
    const res = (cli.result || cli.data) || {};
    const log = res.logs || '';
    let raw = '', dErr = '';
    for (const line of log.split('\n')) {
      const pipe = line.split('|');
      const msg = pipe.length >= 5 ? pipe.slice(4).join('|') : '';
      if (msg.startsWith('__CC_DESCERR__')) dErr = msg.slice('__CC_DESCERR__'.length);
      else if (msg.startsWith('__CC_DESC__')) raw += msg.slice('__CC_DESC__'.length);
    }
    if (dErr) return { error: dErr };
    if (!raw) return { error: 'no describe marker (FINEST logs off?)' };
    let obj = {};
    try { obj = JSON.parse(raw) || {}; } catch { obj = {}; }
    const fields = Array.isArray(obj.fields) ? obj.fields : [];
    const names = fields.map(f => f && f.name).filter(Boolean);
    return { fields, names, label: obj.label || sobjectName, prefix: obj.prefix || '', plural: obj.plural || sobjectName, obj: obj.obj || null, error: names.length ? null : 'no fields' };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/** Read the package namespace from the open folder's sfdx-project.json (cached). */
async function getPackageNamespace() {
  if (debugState._nsResolved) return debugState._namespace;
  debugState._nsResolved = true;
  debugState._namespace = null;
  try {
    const folder = window.state?.folderPath;
    if (folder && window.apexStudio?.readFile) {
      const txt = await window.apexStudio.readFile(`${folder}/sfdx-project.json`);
      const j = JSON.parse(txt);
      if (j && j.namespace) debugState._namespace = j.namespace;
    }
  } catch (_) { /* no namespace / not an sfdx project */ }
  return debugState._namespace;
}

/**
 * Fetch the connected user's info from the org once per app session (cached).
 * Returns { id, username, orgId, profileId, alias } or null on failure.
 * Caches null so a failed fetch is not retried on every SOQL/eval call.
 */
async function getOrgUserInfo() {
  if (debugState._orgUserInfo !== undefined) return debugState._orgUserInfo;
  const org = getActiveOrg();
  if (!org) { debugState._orgUserInfo = null; return null; }
  try {
    const folder = window.state?.folderPath;
    const { stdout } = await window.apexStudio.sfExec(
      `sf org display user --json --target-org ${org.org}`, folder, 60000);
    const parsed = parseSfJson(stdout);
    if (!parsed || parsed.status !== 0 || !parsed.result) {
      debugState._orgUserInfo = null;
      return null;
    }
    const r = parsed.result;
    const ui = {
      id: r.id,
      username: r.username,
      orgId: r.orgId,
      profileId: r.profileId,
      profileName: r.profileName,
      alias: r.alias,
    };
    debugState._orgUserInfo = ui;
    return ui;
  } catch (_) {
    debugState._orgUserInfo = null;
    return null;
  }
}

/**
 * Strip one column from the top-level SELECT clause of a SOQL string.
 * Returns the modified SOQL when the column was found and removed, or null
 * when the column is not present in the SELECT list (signals no retry).
 * Only operates on the outermost SELECT…FROM span (depth-0 with respect to
 * parentheses) so inner sub-selects are left untouched.
 */
function stripColumnFromSoql(soql, col) {
  if (!col || !soql) return null;
  const upper = soql.toUpperCase();

  // Locate the first SELECT keyword at paren-depth 0.
  let selectEnd = -1;
  let depth = 0;
  for (let i = 0; i < soql.length; i++) {
    const ch = soql[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && upper.slice(i, i + 6) === 'SELECT') {
      const before = i === 0 || /\s/.test(soql[i - 1]);
      const after = i + 6 >= soql.length || /[\s(]/.test(soql[i + 6]);
      if (before && after) { selectEnd = i + 6; break; }
    }
  }
  if (selectEnd < 0) return null;

  // Locate the first FROM keyword at paren-depth 0 after SELECT.
  let fromStart = -1;
  depth = 0;
  for (let i = selectEnd; i < soql.length; i++) {
    const ch = soql[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && upper.slice(i, i + 4) === 'FROM') {
      const before = /\s/.test(soql[i - 1] || ' ');
      const after = i + 4 >= soql.length || /\s/.test(soql[i + 4]);
      if (before && after) { fromStart = i; break; }
    }
  }
  if (fromStart < 0) return null;

  const selectClause = soql.slice(selectEnd, fromStart);
  const colEsc = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const colRe = new RegExp('(?<![\\w])' + colEsc + '(?![\\w])', 'i');
  if (!colRe.test(selectClause)) return null; // column not in SELECT list — bail out

  // Split on commas, filter out the matching field, rejoin.
  const parts = selectClause.split(',');
  const filtered = parts.filter(p => !colRe.test(p.trim()));
  if (filtered.length === parts.length) return null; // wasn't removed
  if (filtered.length === 0) return null;             // would leave an empty SELECT

  // Guarantee whitespace remains between the SELECT list and FROM. If the removed
  // column was the LAST item in the list, its trailing whitespace (e.g. the "\n "
  // before FROM) goes with it, which would fuse the previous column onto FROM
  // ("SELECT Id" + "FROM" = "SELECT IdFROM…", invalid SOQL). Re-add a single space.
  let newSelect = filtered.join(',');
  if (!/\s$/.test(newSelect)) newSelect += ' ';
  return soql.slice(0, selectEnd) + newSelect + soql.slice(fromStart);
}

/** Prefix unqualified custom (__c/__r/__mdt/…) API names in a SOQL string with the namespace. */
/**
 * Set of REAL API names (fields + relationship names, lowercased) for an object
 * in the connected org, used to decide whether a `__c`/`__r` token actually needs
 * the package namespace. Locally-added custom fields on a managed object carry NO
 * namespace (e.g. `RG_Rollup_Summary_Test__c` on `Apttus_Config2__ProductConfiguration__c`),
 * so they must never be prefixed. Returns null when the object can't be described
 * (caller then falls back to the blind prefix). Cached per org+object.
 */
async function getOrgFieldNameSet(objectName) {
  if (!objectName) return null;
  const org = getActiveOrg();
  if (!org || !org.org) return null;
  if (!debugState._fieldNameSets) debugState._fieldNameSets = new Map();
  const cacheKey = `${org.org}::${String(objectName).toLowerCase()}`;
  if (debugState._fieldNameSets.has(cacheKey)) return debugState._fieldNameSets.get(cacheKey);

  const collect = (r) => {
    if (!r || !Array.isArray(r.fields) || !r.fields.length) return null;
    const set = new Set();
    for (const f of r.fields) {
      if (f.name) set.add(String(f.name).toLowerCase());
      if (f.relationshipName) set.add(String(f.relationshipName).toLowerCase());
    }
    return set;
  };

  let set = collect(await _runDescribeViaRest(objectName));
  // The object name itself may need the package prefix to resolve (bare source name
  // against a managed-package org). Retry the describe with the namespace once.
  if (!set && String(objectName).split('__').length < 3) {
    const ns = await getPackageNamespace();
    if (ns) set = collect(await _runDescribeViaRest(`${ns}__${objectName}`));
  }
  debugState._fieldNameSets.set(cacheKey, set || null);
  return set || null;
}

/**
 * Apply the managed-package namespace to a SOQL query — but ONLY to tokens that
 * genuinely need it. A `__c`/`__r` token is left untouched when it is already
 * namespaced OR when it is a real (unprefixed) field/relationship on the queried
 * object per the org describe (i.e. a locally-added custom field). Only bare
 * tokens that do NOT exist unprefixed get the namespace — that's the managed-package
 * field case the retry is meant to fix. Falls back to the blind prefix only when the
 * object can't be described.
 */
async function applyNamespaceToSoql(soql, ns) {
  if (!ns) return soql;
  const nsPrefix = ns.toLowerCase() + '__';
  const fromM = String(soql).match(/\bFROM\s+([A-Za-z0-9_]+)/i);
  const fieldSet = fromM ? await getOrgFieldNameSet(fromM[1]) : null;
  return soql.replace(/\b(\w+?)__(c|r|mdt|e|b|x|share|history|kav)\b/gi, (full) => {
    const lower = full.toLowerCase();
    if (lower.startsWith(nsPrefix)) return full;      // already namespaced
    // Known real field/relationship on the object (e.g. a local custom field with
    // no namespace) — must NOT be prefixed.
    if (fieldSet && fieldSet.has(lower)) return full;
    // No describe available → fall back to the original blind prefix so we don't
    // regress bare-managed-name source queries when the org can't be described.
    if (!fieldSet) return ns + '__' + full;
    // Describe available and the bare name isn't a real field → it needs the
    // package namespace (a managed-package field written without its prefix).
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
    return { error: `Can't resolve bind variable(s): ${unresolved.join(', ')}. They're runtime collections/objects built inside the method — turn on the ⚡ Live Org toggle to run the method in the org, then step to this line so they're populated (or set a value in the Console, e.g. \`${unresolved[0]} = ['id1','id2']\`).`, soql: q, unresolved };
  }
  const res = await execSoql(q);
  return { ...res, unresolved: [] };
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
    // The connection pill shows ONLY the org connection state — never the
    // in-flight query/running text. That live progress is shown in ONE place
    // (the yellow "Querying the org…" banner + the in-editor in-progress band),
    // so it isn't duplicated here, and the pill's width stays stable so the
    // toolbar buttons never shift while a query is running.
    if (!connected) {
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
  // When orgFetching changes, update the executing-line decoration class so the
  // user can see "something is happening at this line" via the loading animation.
  _refreshExecDecoration();
  // Reflect busy state on the toolbar buttons (disabled while running/querying).
  setDebugBusyUI();
  // Drive the big, always-visible query loader overlay.
  updateQueryBanner();
}

/**
 * Show/hide the prominent Live-Org query loader overlaid on the editor. It's
 * driven purely by state (orgFetching / orgRunning) so it looks identical no
 * matter which file is open — fixing the "loader is tiny / inconsistent" issue.
 */
function updateQueryBanner() {
  const banner = _$('#dbg-query-banner');
  if (!banner) return;
  const titleEl = banner.querySelector('.dbg-query-banner-title');
  const detailEl = _$('#dbg-query-banner-detail');
  const show = debugState.active && (debugState.orgFetching || debugState.orgRunning);
  banner.classList.toggle('hidden', !show);
  if (!show) return;
  if (titleEl) titleEl.textContent = debugState.orgRunning ? 'Running in the org…' : 'Querying the org…';
  if (detailEl) detailEl.textContent = debugState.orgRunning
    ? 'Executing the method against the connected org (read-only, rolled back)'
    : (debugState.currentQueryText || 'Fetching real data from the connected org…');
}

/**
 * User clicked the yellow "querying / running" banner: jump the editor to WHERE
 * execution currently is, so they can watch it, drop a breakpoint, or stop there.
 * This is ALWAYS explicit (a click) — free-running execution never moves the
 * viewport on its own. Uses the live interpreter's current line (still valid
 * while it awaits an on-demand org query); during a whole-method org run (replay
 * build) where no single JS line exists, falls back to the entry method.
 */
async function revealCurrentExecution() {
  if (!debugState.active) return;
  let file = debugState._execCurrentFile || debugState.currentFile || null;
  let line = debugState._execCurrentLine || debugState.currentLine || 0;
  if (debugState.orgRunning && !debugState._execCurrentLine) {
    file = debugState.entryFile || file;
    line = debugState.entryLine || line;
  }
  if (!file || !line) {
    window.showToast?.('No execution line to jump to yet — the run is still starting.', 'info');
    return;
  }
  try {
    if (file !== debugState.currentFile) {
      debugState.currentFile = file;
      await navigateToFile(file, line);
      if (!debugState.paused) setTimeout(() => highlightExecutingLine(line, file), 60);
    } else {
      navigateToLine(line);
      if (!debugState.paused) highlightExecutingLine(line, file);
    }
  } catch (_) { /* keep whatever is open */ }
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
    // Re-running via the toggle is "a new run" — refresh all prior output first so
    // old Console/Org-Log lines never mix with the fresh execution.
    if (debugState.active && !debugState.orgRunning) resetRunOutput();
    addConsoleEntry('info', `⚡ Live Org ON — hovering/console now pull real values from "${getActiveOrg().org}" on demand.`);
    // Auto-run the entry method in the org so every line's real values are ready.
    // This is now the ONLY way to (re)run: there's no separate "Run in Org" button —
    // toggle Live Org OFF then ON (or press Restart ⟳) to run the method again.
    if (debugState.active && !debugState.orgRunning) {
      addConsoleEntry('info', '↻ Running the method in the org to capture real values for every line…');
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
      return { returnType: (m[3] || '').trim(), isStatic: !!m[2], params, signatureLine: i + 1 };
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
  if (!orgAlias) return false;
  const nowMs = Date.now();
  const SAFETY = 5 * 60 * 1000; // refresh a flag that is within 5 min of expiring
  const cached = debugState._finestWarm.get(orgAlias);
  // Reuse an in-flight or still-valid warm-up: an in-flight entry (expiresAt==null)
  // is shared so a background warm-up and the actual run never race to create two
  // trace flags; a resolved entry with comfortable time left skips the CLI dance
  // entirely (this is what makes 2nd+ runs in a session near-instant).
  if (cached && cached.promise && (cached.expiresAt == null || cached.expiresAt - nowMs > SAFETY)) {
    return cached.promise;
  }
  const entry = {
    promise: null,
    expiresAt: null,
    userId: cached?.userId || null,
    debugLevelId: cached?.debugLevelId || null,
  };
  entry.promise = (async () => {
    const ok = await _ensureFinestLoggingUncached(orgAlias, entry);
    // On failure drop the cache so a later run gets a clean retry (don't cache "false").
    if (!ok) debugState._finestWarm.delete(orgAlias);
    return ok;
  })();
  debugState._finestWarm.set(orgAlias, entry);
  return entry.promise;
}

/**
 * The real trace-flag setup (uncached). Parallelizes the two independent lookups
 * (running user's Id vs. our FINEST DebugLevel) and REUSES an existing non-expired
 * ApexDebugStudioFinest DEVELOPER_LOG trace flag instead of delete+recreating one every
 * time. Only touches debug metadata (DebugLevel / TraceFlag) — never business data.
 * `entry` is mutated with the resolved userId / debugLevelId / expiresAt for caching.
 */
async function _ensureFinestLoggingUncached(orgAlias, entry) {
  const folder = window.state?.folderPath;
  const run = (cmd) => window.apexStudio.sfExec(cmd, folder, 60000);
  const jparse = (s) => parseSfJson(s);
  try {
    // (a) Resolve the running user's Id and (b) find/create the FINEST DebugLevel in
    //     parallel — neither depends on the other, so this removes a full CLI
    //     cold-start from the critical path.
    const userIdP = (async () => {
      if (entry.userId) return entry.userId;
      const disp = jparse((await run(`sf org display --json --target-org ${orgAlias}`)).stdout);
      const username = disp?.result?.username;
      if (!username) return null;
      const uq = jparse((await run(`sf data query --json --target-org ${orgAlias} -q "SELECT Id FROM User WHERE Username = '${username}'"`)).stdout);
      return uq?.result?.records?.[0]?.Id || null;
    })();
    const dlIdP = (async () => {
      if (entry.debugLevelId) return entry.debugLevelId;
      // ApexCode=FINEST is what emits the STATEMENT_EXECUTE + VARIABLE_ASSIGNMENT
      // events the replay engine needs.
      const dlq = jparse((await run(`sf data query --use-tooling-api --json --target-org ${orgAlias} -q "SELECT Id FROM DebugLevel WHERE DeveloperName = 'ApexDebugStudioFinest'"`)).stdout);
      let id = dlq?.result?.records?.[0]?.Id;
      if (!id) {
        const created = jparse((await run(`sf data create record --use-tooling-api --sobject DebugLevel --target-org ${orgAlias} --json --values "DeveloperName=ApexDebugStudioFinest MasterLabel=ApexDebugStudioFinest ApexCode=FINEST ApexProfiling=NONE Callout=NONE Database=FINEST System=FINE Validation=NONE Visualforce=NONE Workflow=NONE"`)).stdout);
        id = created?.result?.id;
      } else {
        // Ensure a pre-existing level is really at FINEST (it may have been created
        // wrong in an earlier build), otherwise the log won't contain step detail.
        await run(`sf data update record --use-tooling-api --sobject DebugLevel --record-id ${id} --target-org ${orgAlias} --json --values "ApexCode=FINEST Database=FINEST System=FINE"`);
      }
      return id || null;
    })();

    const [userId, dlId] = await Promise.all([userIdP, dlIdP]);
    if (!userId || !dlId) return false;
    entry.userId = userId;
    entry.debugLevelId = dlId;

    // Inspect this user's developer-log trace flags. If a non-expired one already
    // points at our FINEST DebugLevel, REUSE it — skip the delete+recreate entirely.
    const tfq = jparse((await run(`sf data query --use-tooling-api --json --target-org ${orgAlias} -q "SELECT Id, DebugLevelId, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'DEVELOPER_LOG'"`)).stdout);
    const flags = tfq?.result?.records || [];
    const nowMs = Date.now();
    const SAFETY = 5 * 60 * 1000;
    const valid = flags.find(f =>
      f.DebugLevelId === dlId && f.ExpirationDate &&
      (new Date(f.ExpirationDate).getTime() - nowMs) > SAFETY);
    if (valid) {
      entry.expiresAt = new Date(valid.ExpirationDate).getTime();
      return true;
    }

    // No usable flag → clear stale ones and create a fresh SHORT-lived flag. We keep the
    // window small on purpose: a DEVELOPER_LOG trace flag makes the org capture a debug log
    // for EVERYTHING this user does until it expires, so a 1-hour flag was the main cause of
    // the "debug-log flood". System-mode reads warm this on demand and reuse it (see the
    // SAFETY window in ensureFinestLogging), so a short lifetime is enough for a read burst
    // while dramatically shrinking how much of the user's activity gets logged.
    for (const tf of flags) {
      await run(`sf data delete record --use-tooling-api --sobject TraceFlag --record-id ${tf.Id} --target-org ${orgAlias} --json`);
    }
    const now = new Date();
    const start = now.toISOString();
    const expMs = now.getTime() + 12 * 60 * 1000; // 12 min (was 60) — on-demand reads renew it as needed
    const exp = new Date(expMs).toISOString();
    const created = jparse((await run(`sf data create record --use-tooling-api --sobject TraceFlag --target-org ${orgAlias} --json --values "TracedEntityId=${userId} DebugLevelId=${dlId} LogType=DEVELOPER_LOG StartDate=${start} ExpirationDate=${exp}"`)).stdout);
    const ok = !!(created?.result?.id);
    if (ok) entry.expiresAt = expMs;
    return ok;
  } catch { return false; }
}

/**
 * Historically this proactively set a FINEST trace flag on every debug-session start so the
 * first org read was fast. That meant the org started logging ALL of the user's activity the
 * moment a session opened — a big contributor to the debug-log flood — even if no system-mode
 * read ever happened. It is now a deliberate NO-OP: trace setup happens strictly ON DEMAND,
 * only when a system-mode anonymous-Apex read actually runs (every such path calls
 * ensureFinestLogging itself). User-mode reads use the REST Query API and never trace at all.
 */
function warmUpLiveOrg() {
  /* intentionally empty — see doc comment above (on-demand tracing only) */
}

/**
 * Delete the connected user's Apex debug logs from the org — the noise this tool's
 * anonymous-Apex runs generate. Only ever touches ApexLog (debug logs), never business
 * data, and only the running user's own logs. Uses one anonymous-Apex delete so it's a
 * single fast call. Returns { ok, deleted?, error? }.
 */
async function clearMyDebugLogs(org) {
  org = org || getActiveOrg();
  if (!org || !org.org) return { ok: false, error: 'No org connected' };
  const folder = window.state?.folderPath;
  const apex = [
    `List<ApexLog> ccLogs = [SELECT Id FROM ApexLog WHERE LogUserId = :UserInfo.getUserId() LIMIT 10000];`,
    `Integer ccN = ccLogs.size();`,
    `String ccErr = '';`,
    `try { if (!ccLogs.isEmpty()) delete ccLogs; } catch (Exception e) { ccErr = e.getMessage(); }`,
    `System.debug(LoggingLevel.ERROR, '__CC_LOGDEL__' + ccN);`,
    `System.debug(LoggingLevel.ERROR, '__CC_LOGDEL_ERR__' + ccErr);`,
  ].join('\n');
  try {
    await ensureFinestLogging(org.org); // ensures our ERROR markers come back in the run log
    const paths = await window.apexStudio.getPaths?.();
    const dir = paths?.appDataDir || paths?.home || '.';
    const tmpFile = `${dir}/.cc_debug_logdel.apex`;
    await window.apexStudio.writeFile(tmpFile, apex);
    const { stdout, stderr } = await window.apexStudio.sfExec(`sf apex run --file "${tmpFile}" --json --target-org ${org.org}`, folder, 60000);
    const cli = parseSfJson(stdout);
    const log = ((cli && (cli.result || cli.data)) || {}).logs || '';
    let n = null, derr = '';
    for (const line of log.split('\n')) {
      const pipe = line.split('|');
      const msg = pipe.length >= 5 ? pipe.slice(4).join('|') : '';
      if (msg.startsWith('__CC_LOGDEL__')) n = parseInt(msg.slice('__CC_LOGDEL__'.length), 10);
      else if (msg.startsWith('__CC_LOGDEL_ERR__')) derr = msg.slice('__CC_LOGDEL_ERR__'.length);
    }
    if (derr) return { ok: false, error: derr };
    if (n == null || Number.isNaN(n)) return { ok: false, error: sfErrorText(cli, stderr, stdout, 'Could not clear debug logs') };
    debugState._generatedOrgLogs = false;
    return { ok: true, deleted: n };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** UI handler for the "🧹 Clear logs" button — clears the user's debug logs + reports. */
async function clearDebugLogsFromUi() {
  const org = getActiveOrg();
  if (!org || !org.org) { window.showToast?.('Connect an org first', 'warn'); return; }
  const btn = document.getElementById('sf-clearlogs');
  const prev = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Clearing…'; }
  addConsoleEntry('info', `🧹 Clearing this tool's Apex debug logs on ${org.info?.alias || org.org}…`);
  renderConsolePanel();
  const res = await clearMyDebugLogs(org);
  if (res.ok) {
    addConsoleEntry('info', `✓ Cleared ${res.deleted} debug log${res.deleted === 1 ? '' : 's'} from the org.`);
    window.showToast?.(`Cleared ${res.deleted} debug log${res.deleted === 1 ? '' : 's'}`, 'success');
  } else {
    addConsoleEntry('error', `Could not clear debug logs: ${res.error}`);
    window.showToast?.('Could not clear debug logs', 'error');
  }
  renderConsolePanel();
  if (btn) { btn.disabled = false; btn.textContent = prev || '🧹 Clear logs'; }
}

/** Fetch the most recent Apex debug log body from the org (used to get FINEST detail). */
async function fetchLatestApexLog(orgAlias) {
  const folder = window.state?.folderPath;
  const run = (cmd) => window.apexStudio.sfExec(cmd, folder, 60000);
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

/**
 * Fetch the newest ApexLog body as RAW TEXT (no --json). This deliberately avoids
 * the `--json` output path that overflows the stack in old Salesforce CLI builds on
 * very large logs — the CLI just streams the raw log, so it never serializes a huge
 * object. Used to recover the real execution after `sf apex run --json` crashes.
 */
async function fetchLatestApexLogRaw(orgAlias) {
  const folder = window.state?.folderPath;
  const run = (cmd) => window.apexStudio.sfExec(cmd, folder, 90000);
  try {
    let id = null;
    // The log LIST is metadata only (no bodies) so --json is small and safe here.
    const list = parseSfJson((await run(`sf apex log list --json --target-org ${orgAlias}`)).stdout);
    const recs = list?.result || [];
    if (recs.length) {
      recs.sort((a, b) => new Date(b.StartTime || 0) - new Date(a.StartTime || 0));
      id = recs[0].Id || recs[0].id;
    }
    if (!id) {
      const q = parseSfJson((await run(`sf data query --json --target-org ${orgAlias} -q "SELECT Id FROM ApexLog ORDER BY StartTime DESC LIMIT 1"`)).stdout);
      id = q?.result?.records?.[0]?.Id || null;
    }
    if (!id) return null;
    // Body WITHOUT --json → raw stream, so the CLI can't overflow serializing it.
    const { stdout } = await run(`sf apex log get --log-id ${id} --target-org ${orgAlias}`);
    return stdout || null;
  } catch { return null; }
}

/**
 * Recover a real-execution replay after the inline `sf apex run --json` crashed the
 * CLI. The method already RAN in the org (the crash is only in returning the result),
 * so we pull the FINEST log straight from the server as raw text and rebuild the
 * timeline from it. Returns true if it populated the Org panel / entered replay.
 */
async function recoverReplayFromServerLog(org, className, methodName) {
  try {
    const raw = await fetchLatestApexLogRaw(org.org);
    if (!raw || raw.length < 50) {
      addConsoleEntry('error', '⚠ Could not recover the log from the server (none found or empty). Updating the Salesforce CLI (npm i -g @salesforce/cli) will fix the root cause.');
      return false;
    }
    const parsed = parseApexLog(raw);
    parsed.org = org.org;
    parsed.entry = `${className}.${methodName}`;
    parsed.rawLog = raw;
    parsed.recovered = true;
    if (!parsed.error && parsed.exceptionMessage) parsed.error = parsed.exceptionMessage;
    debugState.orgActivity = parsed;
    addConsoleEntry('info', `↩ Recovered the run from the server log (${raw.length}b) despite the CLI crash. SOQL: ${parsed.soql.length}, DML: ${parsed.dml.length} (rolled back).`);
    const classIndex = await buildClassIndex();
    const timeline = buildReplayTimeline(raw, classIndex, { file: debugState.entryFile, line: debugState.entryDeclLine });
    if (timeline.steps.length && timeline.hasDetail) {
      addConsoleEntry('info', `🎬 Reconstructed ${timeline.steps.length} steps from the recovered log — stepping is ready.`);
      enterReplayMode(timeline);
    } else {
      addConsoleEntry('info', '⚠ Recovered the log but it lacked step detail (needs ApexCode=FINEST). The org activity above is real; enable FINEST or update the CLI, then Restart to step line-by-line.');
    }
    return true;
  } catch (e) {
    addConsoleEntry('error', `Recovery from server log failed: ${e?.message || e}`);
    return false;
  }
}

/**
 * Clear the previous run's user-facing output and replay bookkeeping so a fresh
 * run (or re-run via the Live Org toggle / Restart) starts clean — the user asked
 * that starting a new run "refresh everything". Breakpoints/logpoints are NOT
 * touched; they persist across runs like a normal debugger.
 */
function resetRunOutput() {
  debugState.consoleLog = [];
  debugState.orgLog = [];
  debugState.orgActivity = null;
  debugState.replayDebugHigh = -1;
  debugState._condNoted = new Set();
  debugState._unreachedReported = false;
  debugState._userPinnedTab = false; // new run — auto-open Org tab again until the user picks a tab
  renderConsolePanel();
  scheduleOrgActivityRender();
}

/** Execute the entry method against the connected org (read-only) and show activity. */
async function runEntryMethodInOrg() {
  if (!debugState.active) { window.showToast?.('Start a debug session first', 'warning'); return; }
  if (!liveOrgAvailable()) { window.showToast?.('Enable Live Org and connect an org first', 'warning'); return; }
  if (debugState.orgRunning) return;

  const filePath = debugState.entryFile;
  const methodName = debugState.entryMethod;
  const org = getActiveOrg();
  const source = await window.apexStudio.readFile(filePath);
  if (!source) { window.showToast?.('Could not read entry file', 'error'); return; }

  const sig = getEntrySignature(source, methodName);
  if (!sig) { window.showToast?.(`Could not parse signature for ${methodName}`, 'error'); return; }
  sig.__methodName = methodName;
  debugState.entryDeclLine = sig.signatureLine || 0;

  const className = filePath.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
  const argValues = (debugState.parsedRequest?.params) || [];

  // Warn if the method appears to make callouts (can't be rolled back)
  if (/\b(HttpRequest|Http\s*\(|\.send\s*\(|WebServiceCallout|Messaging\.sendEmail)\b/.test(source)) {
    addConsoleEntry('info', '⚠ Entry class references callouts/email — those side effects cannot be rolled back.');
  }

  const apex = buildEntryApex(className, sig, argValues);

  debugState.orgRunning = true;
  debugState._userPinnedTab = false; // fresh run — allow the one auto-open below
  updateLiveOrgIndicator();
  renderOrgActivityPanel();
  switchToOrgTab();
  addConsoleEntry('info', `▶ Running ${className}.${methodName}() in org "${org.org}" (savepoint + rollback)…`);

  // Ensure the org emits FINEST logs so replay can reconstruct real variable values.
  addConsoleEntry('info', '⚙ Enabling FINEST Apex logging (temporary 1h trace flag, debug-only)…');
  const finestOn = await ensureFinestLogging(org.org);
  if (!finestOn) addConsoleEntry('info', '⚠ Could not auto-enable FINEST logging (needs "View/Manage All Data" or Tooling access). Stepping may lack variable values.');

  try {
    const paths = await window.apexStudio.getPaths?.();
    const dir = paths?.appDataDir || paths?.home || '.';
    const tmpFile = `${dir}/.cc_debug_run.apex`;
    await window.apexStudio.writeFile(tmpFile, apex);

    const cmd = `sf apex run --file "${tmpFile}" --json --target-org ${org.org}`;
    const { stdout, stderr } = await window.apexStudio.sfExec(cmd, window.state?.folderPath, 180000);

    let cli = parseSfJson(stdout);
    if (!cli) {
      // The CLI returned no parseable JSON. If it CRASHED serializing a huge inline
      // payload (old-CLI RangeError), the method still RAN — recover by pulling the
      // FINEST log straight from the server as raw text and replay that instead of
      // dead-ending. Only falls back to the clean error if recovery can't help.
      const crashed = /Maximum call stack size exceeded|RangeError/i.test(`${stderr || ''}\n${stdout || ''}`);
      let recovered = false;
      if (crashed) {
        addConsoleEntry('info', '⚠ The Salesforce CLI crashed returning the inline result (old-CLI bug on very large logs). The method DID run in the org — recovering the FINEST log directly from the server…');
        recovered = await recoverReplayFromServerLog(org, className, methodName);
      }
      if (!recovered) {
        debugState.orgActivity = { error: describeOrgRunFailure(stderr, stdout) };
        addConsoleEntry('error', `sf CLI returned non-JSON. stdout(${(stdout||'').length}b): ${(stdout||'').slice(0,300)} | stderr: ${(stderr||'').slice(0,300)}`);
      }
    } else if (cli.truncated) {
      debugState.orgActivity = { error: cli.message };
      addConsoleEntry('error', `Org run failed: ${cli.message}`);
      return;
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
      // Prefer compileProblem field; extract from cli.message when missing.
      let cpText = res.compileProblem || (cli && cli.data && cli.data.compileProblem);
      if (!cpText && res.compiled === false) {
        const rawMsg = (cli.name === 'executeCompileFailure' ? cli.message : null) || cli.message || 'Compilation failed';
        const afterErr = rawMsg.match(/with the error:\s*([\s\S]+)/i);
        cpText = afterErr ? afterErr[1].trim() : rawMsg;
      }
      parsed.compileProblem = cpText ? String(cpText) : null;
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
          let timeline = buildReplayTimeline(logForReplay, classIndex, { file: filePath, line: sig.signatureLine });

          // The inline `sf apex run` log is frequently empty or truncated, so the
          // authoritative source is the full ApexLog recorded on the server. When
          // FINEST is on, always fetch it and use whichever reconstructs MORE steps.
          if (finestOn && (!timeline.hasDetail || !timeline.steps.length || (res.logs || '').length < 4000)) {
            addConsoleEntry('info', '⏳ Fetching the full recorded FINEST log from the org…');
            const full = await fetchLatestApexLog(org.org);
            if (full && full.length) {
              const fullTimeline = buildReplayTimeline(full, classIndex, { file: filePath, line: sig.signatureLine });
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
            addConsoleEntry('info', `⚠ The org log came back without step detail (${logForReplay.length}b). Replay needs STATEMENT_EXECUTE + VARIABLE_ASSIGNMENT (ApexCode=FINEST). Confirm the ApexDebugStudioFinest debug level is FINEST and Restart.`);
          } else {
            addConsoleEntry('info', '⚠ The org returned an empty log. If the method compiled, enable FINEST for the running user and Restart.');
          }
        } catch (re) {
          addConsoleEntry('error', `Replay build failed: ${re?.message || re}`);
        }
      }
    }
  } catch (e) {
    const msg = e?.message || String(e);
    debugState.orgActivity = { error: /Maximum call stack size exceeded/i.test(msg)
      ? `Processing the org response overflowed the stack (very large or deeply-nested data). The method DID run in the org (nothing was modified) — press Restart (⟳) to try again. Details: ${msg}`
      : msg };
    addConsoleEntry('error', `Run in Org failed: ${msg}`);
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

/**
 * While the method is free-running (NOT paused at a breakpoint), surface the Org
 * Activity tab so the developer watches real queries stream in live. We back off in
 * three cases so we never fight the user: when paused (they're inspecting Variables/
 * Watch and any query is one THEY triggered), when they've manually clicked a tab
 * this run (_userPinnedTab), or when the Org tab is already active.
 */
function maybeOpenOrgTabForLiveQuery() {
  if (!debugState.active || debugState.paused) return;
  if (debugState._userPinnedTab) return; // the user chose a tab — respect it
  const tab = _$('#debug-panel .dbg-panel-tab[data-tab="dbg-orgactivity"]');
  if (tab && !tab.classList.contains('active')) tab.click();
}

/** Render the Org Activity panel from debugState.orgActivity. */
function renderOrgActivityPanel() {
  const container = _$('#dbg-orgactivity-body');
  if (!container) return;

  // A persistent status banner so the user always sees the real state. While the
  // method is running we say "Connecting…/preparing" (buttons are still disabled),
  // and only switch to the steady green "Connected" once the run has finished and
  // the debugger is ready to step — so "Connected" never contradicts a spinner.
  const org = getActiveOrg();
  const connected = !!(org && org.connected && org.org);
  let connBanner;
  if (!connected) {
    connBanner = `<div class="dbg-org-conn disconnected">○ No org connected — connect one in the Salesforce panel</div>`;
  } else if (debugState.orgRunning) {
    connBanner = `<div class="dbg-org-conn connecting">⏳ Connecting to <b>${_esc(org.org)}</b>… preparing real data</div>`;
  } else {
    connBanner = `<div class="dbg-org-conn connected">⚡ Connected to <b>${_esc(org.org)}</b> — ready</div>`;
  }

  // Sticky "running query" banner: while a live org call is in flight, pin the exact
  // query at the top of the panel so the user ALWAYS sees the currently-executing
  // query without scrolling — no matter how long the activity log has grown. It stays
  // put (position:sticky) as the log scrolls beneath it.
  const runningBanner = (debugState.orgFetching && debugState.currentQueryText)
    ? `<div class="dbg-org-running" title="Running against the org right now — click to jump to the executing line">`
      + `<span class="dbg-org-running-spin"></span>`
      + `<span class="dbg-org-running-label">Running now</span>`
      + `<code class="dbg-org-running-q">${_esc(debugState.currentQueryText)}</code>`
      + `<span class="dbg-org-running-jump">↪ jump</span>`
      + `</div>`
    : '';
  const header = connBanner + runningBanner;

  if (debugState.orgRunning) {
    container.innerHTML = header + '<div class="dbg-org-loader"><span class="dbg-spinner"></span> Executing in org… fetching real data (this can take a moment).</div>';
    return;
  }

  const a = debugState.orgActivity;
  if (!a) {
    const hint = connected
      ? 'Turn on the ⚡ Live Org toggle to run the entry method against this org (read-only — changes are rolled back). Toggle it OFF then ON, or press Restart ⟳, to run again.'
      : 'Connect a Salesforce org, then turn on the ⚡ Live Org toggle to run the entry method against it (read-only — changes are rolled back).';
    container.innerHTML = header + `<div class="dbg-empty">${hint}</div>` + renderOrgLogSection();
    _scrollOrgLog(container);
    return;
  }
  if (a.error && !a.entry) {
    container.innerHTML = header + `<div class="dbg-org-error">✕ ${_esc(a.error)}</div>` + renderOrgLogSection();
    _scrollOrgLog(container);
    return;
  }

  let html = header;
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

  container.innerHTML = html + renderOrgLogSection();
  _scrollOrgLog(container);
}

/** Auto-scroll the activity log to the newest entry and wire up its interactions. */
function _scrollOrgLog(container) {
  if (!container) return;
  // Org & Log payloads are expandable/copyable just like the Console.
  _attachTreeToggles(container);
  _attachPayloadCopy(container);
  const ol = container.querySelector('.dbg-orglog');
  if (ol) ol.scrollTop = ol.scrollHeight;
  // Terminal-style "follow the tail": keep the newest activity (the running query and
  // its result) visible without the user scrolling. While a query/run is in flight we
  // always pin to the bottom; otherwise we only pin when the user was already near the
  // bottom, so scrolling up to read earlier history is never yanked back down.
  const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;
  if (debugState.orgFetching || debugState.orgRunning || nearBottom || container._dbgStickBottom) {
    container.scrollTop = container.scrollHeight;
  }
  if (!container._dbgScrollWired) {
    container._dbgScrollWired = true;
    container.addEventListener('scroll', () => {
      container._dbgStickBottom =
        (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;
    });
    container._dbgStickBottom = true;
    // Clicking the pinned "Running now" query jumps the editor to where execution
    // currently is — same behaviour as the yellow query banner, so the developer can
    // watch it, drop a breakpoint, or stop there. Delegated because the banner is
    // rebuilt on every render.
    container.addEventListener('click', (e) => {
      if (e.target.closest('.dbg-org-running')) revealCurrentExecution();
    });
  }
}

/**
 * Render the org/engine activity log (debugState.orgLog) — SOQL, DML, branch/loop
 * traces, status, warnings and errors that used to clutter the Console. Shown in
 * the ⚡ Org tab so the Console stays clean for user output only. Caps the visible
 * rows so a long run stays responsive.
 */
function renderOrgLogSection() {
  const log = debugState.orgLog;
  if (!log || !log.length) return '';
  const ICON = { soql: '🔎', dml: '✏️', info: '·', warn: '⚠', error: '✕', branch: '↳', loop: '↻', call: '→', var: '=', nav: '⇢', bp: '●', orgdebug: '🐞' };
  const CAP = 400;
  const start = Math.max(0, log.length - CAP);
  let rows = '';
  if (start > 0) rows += `<div class="dbg-orglog-row dbg-orglog-info"><span class="dbg-orglog-msg">… ${start} earlier entr${start === 1 ? 'y' : 'ies'}</span></div>`;
  for (let i = start; i < log.length; i++) {
    const e = log[i];
    const icon = ICON[e.type] || '·';
    rows += `<div class="dbg-orglog-row dbg-orglog-${e.type}">`
      + `<span class="dbg-orglog-icon">${icon}</span>`
      + (e.line ? `<span class="dbg-org-line">L${e.line}</span>` : '')
      + `<span class="dbg-orglog-msg">${renderEntryPayload(e, i, 'org')}</span></div>`;
  }
  return `<div class="dbg-org-section"><div class="dbg-org-title">Activity log (${log.length})</div><div class="dbg-orglog">${rows}</div></div>`;
}

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
function buildReplayTimeline(log, classIndex, entry) {
  const result = { steps: [], returnRaw: null, hasDetail: false, fatalError: null, skippedInit: 0 };
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
        if (msg.startsWith('__CC_')) {
          if (msg.startsWith('__CC_RET__')) result.returnRaw = msg.slice('__CC_RET__'.length);
          // other __CC_* markers are harness control tokens — ignore in replay
        } else if (result.steps.length) {
          // Real user System.debug output — attach to the statement that just ran
          // so replayGoto can stream it to the Console as the cursor reaches it.
          const step = result.steps[result.steps.length - 1];
          (step.debugs || (step.debugs = [])).push({ line: lineNo, raw: msg });
        }
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
  // Salesforce runs class static/instance initialization before the entry method's
  // body and attributes those implicit steps to the class-declaration line (and the
  // static-field lines) — all ABOVE the method the user chose to debug. Left as-is the
  // replay opens on e.g. `line 8: public class Foo {` and only reaches the method after
  // a step, which looks like the cursor "jumped to the top." Trim that leading init
  // prefix so replay starts on the entry method's first executed statement. Nothing is
  // hidden — every statement the method actually runs (and all nested calls) is kept,
  // and the full org activity + raw log remain available. Fully general: keyed off the
  // passed entry file + signature line, so it works for ANY entry method in ANY class.
  if (entry && entry.file && entry.line && result.steps.length) {
    const entryBase = String(entry.file).split(/[/\\]/).pop();
    let k = 0;
    while (k < result.steps.length) {
      const s = result.steps[k];
      if (s.file && String(s.file).split(/[/\\]/).pop() === entryBase && s.line >= entry.line) break;
      k++;
    }
    if (k > 0 && k < result.steps.length) { result.steps = result.steps.slice(k); result.skippedInit = k; }
  }
  return result;
}

/** Enter replay mode using a built timeline. */
function enterReplayMode(timeline) {
  if (!timeline.steps.length) return false;
  debugState.replayMode = true;
  debugState.replayTimeline = timeline.steps;
  // Start the cursor "before" step 0 so replayGoto(0) counts step 0 as a forward
  // advance and fires any logpoint sitting on the very first line.
  debugState.replayIndex = -1;
  debugState.replayDebugHigh = -1;
  debugState._condNoted = new Set();
  // Index the lines that ACTUALLY executed (per file) so we can later tell the
  // user, honestly, when a breakpoint/logpoint they set is on a line the real org
  // run never reached — instead of silently running to the end.
  debugState._replayLineIndex = new Map();
  for (const s of timeline.steps) {
    if (!s.file) continue;
    let set = debugState._replayLineIndex.get(s.file);
    if (!set) { set = new Set(); debugState._replayLineIndex.set(s.file, set); }
    set.add(s.line);
  }
  debugState._unreachedReported = false;
  debugState.replayFatalError = timeline.fatalError || null;
  debugState.active = true;
  debugState.paused = true;
  addConsoleEntry('info', `🎬 Replay mode — stepping ${timeline.steps.length} recorded statements with real org values. Use Step/Continue.`);
  if (timeline.skippedInit) {
    addConsoleEntry('info', `↧ Replay starts at ${debugState.entryMethod || 'the entry method'} — skipped ${timeline.skippedInit} class-initialization step(s) the org ran before it (real setup, still counted in Org Activity).`);
  }
  if (timeline.fatalError) {
    addConsoleEntry('error', `⚠ Execution ended with an uncatchable error: ${timeline.fatalError.split('\n')[0]}. You can still step through everything up to that point.`);
  }
  replayGoto(0);
  return true;
}

/**
 * Pure planner for what a replay cursor move must emit — the invariant that keeps
 * time-travel (step back / forward) TRUTHFUL:
 *   • Recorded org System.debug output is a SINGLE real execution: emit each step's
 *     recorded debug at most once, tracked by a high-water mark. Stepping back and
 *     then forward again must NOT duplicate it (that would fabricate output).
 *   • Logpoints are "print when execution passes this line": they re-fire on every
 *     FORWARD advance across the line (Chrome V8 behaviour), independent of the mark.
 * Returns { debugSteps:[idx…], logpointSteps:[idx…], debugHigh:newHighWater }.
 * Assumes prev/target are already clamped to valid indices. Pure → unit-testable.
 */
function planReplayEmit(prevIndex, targetIndex, debugHigh) {
  const debugSteps = [];
  if (targetIndex > debugHigh) {
    for (let j = debugHigh + 1; j <= targetIndex; j++) debugSteps.push(j);
    debugHigh = targetIndex;
  }
  const logpointSteps = [];
  if (targetIndex > prevIndex) {
    for (let j = prevIndex + 1; j <= targetIndex; j++) logpointSteps.push(j);
  }
  return { debugSteps, logpointSteps, debugHigh };
}

/** Move the replay cursor to a specific step and refresh the UI. */
async function replayGoto(index) {
  const steps = debugState.replayTimeline;
  if (!steps.length) return;
  index = Math.max(0, Math.min(index, steps.length - 1));
  const prevIndex = debugState.replayIndex;
  // Recorded org System.debug (emit once via high-water mark) + logpoints (re-fire
  // on every forward advance). Centralised in planReplayEmit so stepping back then
  // forward never duplicates recorded output — see planReplayEmit for the invariant.
  const plan = planReplayEmit(prevIndex, index, debugState.replayDebugHigh);
  for (const j of plan.debugSteps) emitReplayRecordedDebug(steps[j]);
  debugState.replayDebugHigh = plan.debugHigh;
  for (const j of plan.logpointSteps) fireReplayLogpoint(steps[j]);
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
  updateReplayPositionUI();
}

/**
 * Route a replay step's recorded (real org) System.debug output to the ⚡ Org &
 * Log tab — NOT the Console. In Live-Org replay this is the DEPLOYED code's debug
 * log (framework + app System.debug at every level), which is org activity and
 * mostly noise; the Console is reserved for errors + the user's own logpoints.
 */
function emitReplayRecordedDebug(step) {
  if (!step || !step.debugs) return;
  for (const d of step.debugs) {
    const parsed = parseApexDebugValue(d.raw);
    if (parsed !== null && typeof parsed === 'object') {
      addConsoleEntry('orgdebug', d.raw, d.line, parsed);
    } else {
      addConsoleEntry('orgdebug', typeof parsed === 'string' ? parsed : String(parsed), d.line);
    }
  }
}

/**
 * The text a step's logpoint would print, or null when there is no logpoint or a
 * conditional logpoint's condition is false. Pure (no UI) so it is unit-testable.
 */
function replayLogpointText(step) {
  const p = _bpLogPayload(stepLogpoint(step), step);
  return p ? p.text : null;
}

/** {text, value}|null for the logpoint (if any) attached to a replay step. */
function replayLogpointPayload(step) {
  return _bpLogPayload(stepLogpoint(step), step);
}

/** Back-compat string accessor (tests): the logpoint's printed text, or null. */
function _bpLogText(bp, step) {
  const p = _bpLogPayload(bp, step);
  return p ? p.text : null;
}

/**
 * Pure: given a logpoint bp (may be null) + step, produce {text, value}|null.
 * Chrome-style semantics: the log message is an EXPRESSION, not just literal text.
 *  - a bare message (`logger`) or a sole `{logger}` → evaluate it and print the
 *    VALUE (an object/list becomes an expandable tree via `value`);
 *  - a mixed template (`count={count} of {total}`) → interpolate placeholders into
 *    a string;
 *  - a conditional logpoint whose condition is false → null (gated off).
 */
function _bpLogPayload(bp, step) {
  if (!bp || !bp.logMessage) return null;
  if (bp.condition) {
    const r = evalReplayCondition(bp.condition, step);
    if (r.evaluated && !r.value) return null; // conditional logpoint gated off
  }
  const raw = String(bp.logMessage);
  const scope = replayStepScope(step);
  const soleBrace = raw.match(/^\s*\{([^{}]+)\}\s*$/);
  if (soleBrace) return _logExpressionPayload(soleBrace[1], scope);   // {logger}
  if (raw.indexOf('{') === -1) return _logExpressionPayload(raw, scope); // logger
  return { text: evalReplayLogTemplate(raw, step), value: undefined };  // mixed template
}

/**
 * Evaluate a bare logpoint expression against captured org state and build a
 * printable payload — the Chrome DevTools behaviour where a logpoint of `logger`
 * prints the logger object (expandable), not the literal word "logger".
 *  - object/list → {text:'expr =', value} so the Console renders an expandable tree;
 *  - scalar      → {text:'expr = <value>'};
 *  - a plain identifier/path we can't resolve from the log → an honest "not
 *    captured" note (never fabricate);
 *  - free-form prose that isn't an expression → printed verbatim.
 */
function _logExpressionPayload(expr, scope) {
  const trimmed = String(expr).trim();
  let v;
  try { v = evaluateExpression(trimmed, scope); } catch (_) { v = undefined; }
  if (v !== undefined) {
    if (v !== null && typeof v === 'object') return { text: `${trimmed} =`, value: v };
    if (typeof v === 'string') return { text: `${trimmed} = ${v}`, value: undefined };
    return { text: `${trimmed} = ${formatValue(v)}`, value: undefined };
  }
  if (/^[A-Za-z_][\w.]*$/.test(trimmed)) {
    return { text: `${trimmed} — ‹not captured in the org log at this line›`, value: undefined };
  }
  return { text: expr, value: undefined }; // free-form text → print verbatim
}

/** Fire a logpoint attached to a replay step (Chrome-style: print, never pause). */
function fireReplayLogpoint(step) {
  const p = replayLogpointPayload(step);
  if (p) addConsoleEntry('debug', p.text, step.line, p.value);
}

/** The logpoint (if any) attached to a replay step's file+line. */
function stepLogpoint(step) {
  if (!step || !step.file) return null;
  const bp = activeBreakpoint(step.file, step.line);
  return bp && bp.logMessage ? bp : null;
}

/** Substitute {expr} placeholders in a replay logpoint from the step's captured variables. */
function evalReplayLogTemplate(template, step) {
  const vars = replayStepScope(step);
  return String(template).replace(/\{([^{}]+)\}/g, (m, expr) => {
    const v = lookupVarPath(vars, expr.trim());
    return v === undefined ? m : (typeof v === 'string' ? v : formatValue(v));
  });
}

/** Flatten a replay step's frames into a plain {name: value} scope (top frame wins). */
function replayStepScope(step) {
  const top = step && step.frames && step.frames[step.frames.length - 1];
  return top ? { ...(top.classFields || {}), ...(top.variables || {}) } : {};
}

/**
 * Evaluate a breakpoint/logpoint CONDITION against a replay step's real captured
 * org variables. Returns {evaluated, value}: evaluated=false means the expression
 * couldn't be resolved from the captured state (unknown var, unsupported syntax),
 * so callers can degrade honestly rather than guess. Never throws.
 *
 * We pre-scan for root variable references that aren't present in the captured
 * scope. Without this, `evaluateExpression` coerces an unresolved operand
 * (`undefined > 3` → false, `undefined == 1` → false), which would silently
 * fabricate a concrete answer and make a conditional breakpoint quietly never
 * fire. An unknown variable ⇒ unknown result ⇒ the caller pauses to be safe.
 */
function evalReplayCondition(condition, step) {
  try {
    const scope = replayStepScope(step);
    const missing = _unresolvedConditionRoots(condition, scope);
    if (missing.length) return { evaluated: false, value: false, error: `unknown variable ${missing[0]}` };
    const v = evaluateExpression(condition, scope);
    if (v === undefined) return { evaluated: false, value: false };
    return { evaluated: true, value: v };
  } catch (e) {
    return { evaluated: false, value: false, error: e && e.message };
  }
}

/**
 * Root variable identifiers referenced by a condition that are NOT present in the
 * captured scope. Conservative: skips string-literal contents, keywords, numeric
 * literals, function/method-call names (`foo(`), and static type calls
 * (`String.isBlank(x)`, `Math.max(...)`). A dotted reference (`acct.Name`) is
 * judged only by its root (`acct`) — an absent nested field is a resolved-but-null
 * comparison, not an unresolved reference. Returning a non-empty list means
 * "can't honestly evaluate — degrade."
 */
function _unresolvedConditionRoots(condition, scope) {
  const KEYWORDS = new Set(['true', 'false', 'null', 'new', 'instanceof', 'and', 'or', 'not']);
  const noStr = String(condition)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const missing = [];
  const seen = new Set();
  const re = /(^|[^\w.])([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(noStr))) {
    const name = m[2];
    if (KEYWORDS.has(name) || seen.has(name)) continue;
    const after = noStr.slice(m.index + m[0].length);
    if (/^\s*\(/.test(after)) continue;                          // function/method call name
    if (/^[A-Z]/.test(name) && /^\s*\.\s*[A-Za-z_]\w*\s*\(/.test(after)) continue; // Type.method(...) static call
    seen.add(name);
    if (!Object.prototype.hasOwnProperty.call(scope, name)) missing.push(name);
  }
  return missing;
}

/** Note (once per line) that a replay condition couldn't be evaluated. */
function _noteReplayCondFallback(step, condition, err) {
  debugState._condNoted = debugState._condNoted || new Set();
  const key = step.file + ':' + step.line;
  if (debugState._condNoted.has(key)) return;
  debugState._condNoted.add(key);
  addConsoleEntry('info', `⚠ Conditional breakpoint at line ${step.line}: couldn't evaluate "${condition}" from captured org state${err ? ' (' + err + ')' : ''} — pausing to be safe.`);
}

/** Resolve a dotted path (a.b.c) against a plain variables object. */
function lookupVarPath(vars, path) {
  let cur = vars;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Best-effort parse of an Apex debug-log value string into structured JS so the
 * Console can render it as an expandable tree. Handles JSON, SObject toString
 * (Type:{k=v,…}), lists ((a, b, c)), maps/sets ({k=v} / {a, b}). Falls back to
 * the raw string when the shape isn't cleanly structural. Never throws.
 */
function parseApexDebugValue(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return '';
  if ((s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '[' && s[s.length - 1] === ']')) {
    try { return JSON.parse(s); } catch (_) { /* not JSON — try Apex shapes */ }
  }
  try {
    const structured = parseApexToString(s);
    if (structured !== undefined) return structured;
  } catch (_) { /* fall through */ }
  return s;
}

function parseApexToString(s) {
  s = s.trim();
  const typed = s.match(/^([A-Za-z_][\w.]*)\s*:\s*\{([\s\S]*)\}$/);
  if (typed) {
    const obj = parseApexKvBody(typed[2]);
    return obj === undefined ? undefined : obj;
  }
  if (s[0] === '{' && s[s.length - 1] === '}') {
    const body = s.slice(1, -1);
    if (body.trim() === '') return {};
    const obj = parseApexKvBody(body);
    if (obj !== undefined) return obj;
    return splitTopLevel(body).map(parseApexScalarOrNested);
  }
  if (s[0] === '(' && s[s.length - 1] === ')') {
    const body = s.slice(1, -1);
    if (body.trim() === '') return [];
    return splitTopLevel(body).map(parseApexScalarOrNested);
  }
  return undefined;
}

function parseApexKvBody(body) {
  const parts = splitTopLevel(body);
  const obj = {};
  let any = false;
  for (const p of parts) {
    const eq = findTopLevelEquals(p);
    if (eq < 0) return undefined; // not k=v → treat as a set, not an object
    const k = p.slice(0, eq).trim();
    if (!k) return undefined;
    obj[k] = parseApexScalarOrNested(p.slice(eq + 1).trim());
    any = true;
  }
  return any ? obj : undefined;
}

function parseApexScalarOrNested(v) {
  v = v.trim();
  const nested = parseApexToString(v);
  if (nested !== undefined) return nested;
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

/** Split on top-level commas (not nested in (), {}, []). */
function splitTopLevel(s) {
  const out = [];
  let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out.map(x => x.trim()).filter(x => x !== '');
}

/** Index of the first top-level single '=' (skips == and =>). */
function findTopLevelEquals(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === '=' && depth === 0) {
      if (s[i + 1] === '=' || s[i - 1] === '<' || s[i - 1] === '>' || s[i - 1] === '!') { continue; }
      return i;
    }
  }
  return -1;
}

/**
 * Whether the replay cursor should PAUSE at this step's line. Mirrors Chrome V8:
 *  - a LOGPOINT never pauses (it prints and execution continues);
 *  - a CONDITIONAL breakpoint pauses only when its condition is true, evaluated
 *    against the step's real captured org variables;
 *  - a PLAIN breakpoint always pauses.
 * If a condition can't be evaluated from the captured state we pause to be safe
 * (better to stop than silently skip a breakpoint) and note it once.
 */
function replayStepPauses(step) {
  if (!step || !step.file) return false;
  const bp = activeBreakpoint(step.file, step.line);
  const d = _bpPauseDecision(bp, step);
  if (d.unresolved) _noteReplayCondFallback(step, bp.condition, d.error);
  return d.pause;
}

/**
 * Pure pause decision for a breakpoint object at a step. Returns
 * {pause, unresolved?, error?}. logpoint→never pause; conditional→pause when the
 * condition is true; unresolved condition→pause to be safe; plain→always pause.
 */
function _bpPauseDecision(bp, step) {
  if (!bp) return { pause: false };
  if (bp.logMessage) return { pause: false };            // logpoint (incl. conditional): print-only
  if (!bp.condition) return { pause: true };              // plain breakpoint
  const r = evalReplayCondition(bp.condition, step);
  if (!r.evaluated) return { pause: true, unresolved: true, error: r.error };
  return { pause: !!r.value };
}

/** Advance the replay cursor forward to the first step matching a predicate. */
async function replayAdvance(predicate, stopAtBreakpoints) {
  const steps = debugState.replayTimeline;
  let i = debugState.replayIndex + 1;
  for (; i < steps.length; i++) {
    if (stopAtBreakpoints && replayStepPauses(steps[i])) break;
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
    // Be honest about breakpoints/logpoints that never fired because their line
    // did not run in the real org execution (a common surprise — e.g. a return or
    // fatal error before them, or a branch that wasn't taken).
    _reportUnreachedBreakpoints();
    return;
  }
  await replayGoto(i);
}

/**
 * After a Continue/step reaches the end of the recorded run, tell the user —
 * truthfully — about any breakpoint or logpoint they set on a line that the real
 * org execution never reached, so a breakpoint that "didn't stop" is explained
 * rather than silently ignored. Only considers files that took part in this run
 * (unrelated breakpoints elsewhere stay quiet) and reports once per run.
 */
function _reportUnreachedBreakpoints() {
  if (debugState._unreachedReported) return;
  const notes = _unreachedBreakpointNotes(debugState.breakpoints, debugState._replayLineIndex)
    .map(n => `${n.kind} at ${(n.file || '').split(/[/\\]/).pop()}:${n.line}`);
  if (!notes.length) return;
  debugState._unreachedReported = true;
  const last = debugState.replayTimeline[debugState.replayTimeline.length - 1];
  const endedAt = last ? `${(last.file || '').split(/[/\\]/).pop()}:${last.line}` : 'the end';
  const why = debugState.replayFatalError
    ? `execution ended early at ${endedAt} — ${debugState.replayFatalError.split('\n')[0]}`
    : `those lines did not run in this execution (a branch that wasn't taken, a method that wasn't called, or a return before them). Execution ended at ${endedAt}`;
  addConsoleEntry('info', `⚠ ${notes.join(', ')} ${notes.length > 1 ? 'were' : 'was'} never reached — ${why}. The debugger skipped nothing; this reflects the real org run. Tip: to see a value at a line that DID run, put a logpoint there.`);
}

/**
 * Pure: given the breakpoint map (Map<file, Map<line, bp>>) and the executed-line
 * index (Map<file, Set<line>>) from the replay, return one note per breakpoint/
 * logpoint whose line did NOT execute — but only for files that participated in
 * the run (so unrelated breakpoints in other files stay silent). Unit-testable.
 */
function _unreachedBreakpointNotes(breakpoints, lineIndex) {
  const notes = [];
  if (!lineIndex || !breakpoints || !breakpoints.size) return notes;
  for (const [file, bps] of breakpoints) {
    const execLines = lineIndex.get(file);
    if (!execLines) continue; // this file didn't participate in the run — stay silent
    for (const [line, bp] of bps) {
      if (execLines.has(line)) continue; // the line really executed
      notes.push({ kind: bp && bp.logMessage ? 'Logpoint' : 'Breakpoint', file, line });
    }
  }
  return notes;
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
 * Reverse step — move the replay cursor one recorded statement BACK. This is the
 * time-travel control: because the whole run is a recorded timeline of REAL org
 * values, going back is truthful (we re-show the exact state that was recorded at
 * that step, never re-fabricated). replayGoto's high-water mark ensures recorded
 * System.debug output is NOT duplicated on the way back; logpoints re-fire only
 * when you step forward across them again (Chrome-style). Lets the developer walk
 * backward to find where a value first diverged, then step forward again.
 */
async function replayStepBack() {
  if (debugState.replayIndex <= 0) {
    window.showToast?.('Already at the first recorded step.', 'info');
    return;
  }
  if (!debugState._steppedBackNoted) {
    debugState._steppedBackNoted = true;
    addConsoleEntry('info', '⏪ Stepping back through the recorded timeline — real values at each earlier step. Step forward (F10/F11) to replay again and spot where a value first changed.');
  }
  await replayGoto(debugState.replayIndex - 1);
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

  // Check breakpoint (disabled ones are skipped but kept for later re-enable)
  const bpInfo = activeBreakpoint(debugState.currentFile, nextStmt.line);
  if (bpInfo) {
    if (bpInfo.condition) {
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
    const source = await window.apexStudio.readFile(filePath);
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
    const clsName = filePath.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
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
  if (debugState.engineMode) { engineForwardViaHistory('continue'); engineStep('continue'); return; }
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
  if (debugState.engineMode) { if (engineForwardViaHistory('over')) return; engineStep('over'); return; }
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
  if (debugState.engineMode) { if (engineForwardViaHistory('into')) return; engineStep('into'); return; }
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
  if (debugState.engineMode) { if (engineForwardViaHistory('out')) return; engineStep('out'); return; }
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

/**
 * Step Back (reverse). Only meaningful in replay mode, where the run is a recorded
 * timeline that can be re-walked truthfully. In the live interpreter / engine modes
 * there is no recorded history to reverse into (reversing live execution would mean
 * un-doing real side effects), so we say so honestly instead of pretending.
 */
async function debugStepBack() {
  if (!debugState.active) return;
  // Engine history first: if the live interpreter is driving (as it is in "Debug with
  // Request", even with Live Org on), Step Back walks the captured per-line snapshots.
  const hasEngineHist = debugState.engineMode
    && Array.isArray(debugState.engineHistory) && debugState.engineHistory.length > 0;
  if (hasEngineHist) {
    await engineStepBack();
    return;
  }
  if (debugState.replayMode) {
    if (debugState.orgFetching || debugState.orgRunning) return;
    await replayStepBack();
    return;
  }
  window.showToast?.('Step Back needs a paused run — use ▶ Debug with Request, or turn on ⚡ Live Org for a recorded replay.', 'info');
}

/**
 * Reflect the replay cursor position in the toolbar: show "Step N / total" and
 * enable Step Back only when there is an earlier recorded step to go to. Hidden
 * entirely outside replay mode (no recorded timeline to scrub).
 */
function updateReplayPositionUI() {
  const back = _$('#dbg-btn-step-back');
  if (!back) return;
  // Engine history takes PRECEDENCE over the replay timeline. When the live interpreter
  // is driving (onEnginePause is capturing real per-line snapshots), Step Back walks
  // THAT — even when Live Org is on and a replay timeline also exists (which it may,
  // empty, when the org log came back without step detail). Only a pure replay run with
  // no engine session falls back to the replay cursor.
  const hasEngineHist = debugState.active && debugState.engineMode
    && Array.isArray(debugState.engineHistory) && debugState.engineHistory.length > 0;
  const inReplay = debugState.active && debugState.replayMode && !hasEngineHist
    && Array.isArray(debugState.replayTimeline);
  let canBack = false;
  if (hasEngineHist) {
    // View-only redisplay of a captured snapshot — safe whenever the engine is PAUSED.
    // Background org activity (a parallel Live-Org run/fetch) must NOT block looking back.
    canBack = debugState.engineHistoryIndex > 0 && !debugState.engineRunning;
  } else if (inReplay) {
    const busy = debugState.active && (debugState.orgFetching || debugState.orgRunning);
    canBack = debugState.replayIndex > 0 && !busy;
  }
  back.disabled = !canBack;
  back.classList.toggle('dbg-busy-disabled', debugState.engineRunning || debugState.orgFetching || debugState.orgRunning);
  back.title = (hasEngineHist || inReplay)
    ? 'Step Back (⇧F10) — return to the previous step with the real values captured there'
    : 'Step Back (⇧F10) — available once a run has paused, so there is an earlier step to return to';
}

/* ================================================================
   8. BREAKPOINT MANAGEMENT
   ================================================================ */

function toggleBreakpoint(filePath, lineNumber, condition, logMessage) {
  if (!debugState.breakpoints.has(filePath)) {
    debugState.breakpoints.set(filePath, new Map());
  }
  const bps = debugState.breakpoints.get(filePath);
  // A bare toggle (no condition/logpoint args) removes an existing breakpoint.
  if (bps.has(lineNumber) && condition === undefined && logMessage === undefined) {
    bps.delete(lineNumber);
  } else {
    const existing = bps.get(lineNumber) || {};
    bps.set(lineNumber, {
      condition: condition || null,
      logMessage: logMessage || null,
      // Preserve the enable/disable state across edits; new breakpoints start enabled.
      enabled: existing.enabled === false ? false : true,
      // Remember the source line so the panel shows WHAT the breakpoint sits on.
      snippet: existing.snippet || _lineSnippet(filePath, lineNumber),
    });
  }
  renderBreakpointDecorations(filePath);
  updateBreakpointsPanel();
  saveBreakpoints();
}

/** Remove any breakpoint/logpoint/condition on a line. */
function removeBreakpoint(filePath, lineNumber) {
  const bps = debugState.breakpoints.get(filePath);
  if (bps && bps.has(lineNumber)) {
    bps.delete(lineNumber);
    renderBreakpointDecorations(filePath);
    updateBreakpointsPanel();
    saveBreakpoints();
  }
}

/** The breakpoint at file:line, but ONLY if it is enabled. Disabled breakpoints
 *  stay stored and visible (so the user can re-enable them, even days later), but
 *  they never pause, never log, and never affect execution. Used at every
 *  execution decision site (live engine + replay + local sim). */
function activeBreakpoint(file, line) {
  const bps = debugState.breakpoints.get(file);
  const bp = bps && bps.get(line);
  return bp && bp.enabled !== false ? bp : null;
}

/** Best-effort trimmed source text for a line, captured when the file is open so
 *  the Breakpoints panel can show a code snippet next to each breakpoint. */
function _lineSnippet(filePath, line) {
  try {
    const editor = window.state?.editor;
    const model = editor && editor.getModel();
    if (model) {
      const uri = model.uri;
      if ((uri.fsPath || uri.path) === filePath || monaco.Uri.file(filePath).toString() === uri.toString()) {
        return (model.getLineContent(line) || '').trim().slice(0, 140);
      }
    }
  } catch (_) {}
  return '';
}

const DBG_BREAKPOINTS_KEY = 'apexstudio.debug.breakpoints.v1';

/** Persist all breakpoints (condition, logpoint, enabled state, snippet) so they
 *  survive app restarts — the user keeps their breakpoints across days until they
 *  explicitly remove them. */
function saveBreakpoints() {
  try {
    const out = {};
    for (const [file, bpMap] of debugState.breakpoints) {
      if (!bpMap || !bpMap.size) continue;
      const lines = {};
      for (const [line, info] of bpMap) {
        lines[line] = {
          condition: info.condition || null,
          logMessage: info.logMessage || null,
          enabled: info.enabled === false ? false : true,
          snippet: info.snippet || '',
        };
      }
      out[file] = lines;
    }
    localStorage.setItem(DBG_BREAKPOINTS_KEY, JSON.stringify(out));
  } catch (_) { /* storage full / unavailable — non-fatal */ }
}

/** Restore persisted breakpoints on startup, then paint gutter glyphs + panel. */
function loadBreakpoints() {
  let data;
  try { data = JSON.parse(localStorage.getItem(DBG_BREAKPOINTS_KEY) || '{}'); }
  catch (_) { data = {}; }
  if (!data || typeof data !== 'object') return;
  for (const file of Object.keys(data)) {
    const lines = data[file];
    if (!lines || typeof lines !== 'object') continue;
    let bpMap = debugState.breakpoints.get(file);
    if (!bpMap) { bpMap = new Map(); debugState.breakpoints.set(file, bpMap); }
    for (const lineStr of Object.keys(lines)) {
      const line = parseInt(lineStr, 10);
      if (!Number.isFinite(line)) continue;
      const info = lines[lineStr] || {};
      bpMap.set(line, {
        condition: info.condition || null,
        logMessage: info.logMessage || null,
        enabled: info.enabled === false ? false : true,
        snippet: info.snippet || '',
      });
    }
  }
  renderAllBreakpointDecorations();
  updateBreakpointsPanel();
}

// A minimal, always-available prompt. Electron disables window.prompt() (it
// silently returns undefined and shows nothing), which is why the old
// logpoint/condition entry never appeared — so we use the app's in-DOM modal.
function _askInput(title, message, initial) {
  if (typeof window !== 'undefined' && typeof window.showInputDialog === 'function') {
    return window.showInputDialog(title, message, initial || '');
  }
  return Promise.resolve(null);
}

/**
 * Add or edit a CONDITIONAL breakpoint on a line (Chrome-style). The debugger
 * pauses here only when the Apex expression is true, evaluated against the real
 * captured org variables at that line. Empty input clears the condition (keeps a
 * plain breakpoint / any logpoint). Cancel leaves everything unchanged.
 */
async function editConditionalBreakpoint(filePath, line) {
  const cur = debugState.breakpoints.get(filePath)?.get(line) || null;
  const c = await _askInput(
    'Conditional Breakpoint',
    "Pause here only when this Apex expression is true — e.g.  quantity > 5  or  acct.Name == 'Acme'. Leave empty to clear the condition.",
    cur?.condition || ''
  );
  if (c === null) return; // cancelled
  const cond = c.trim() || null;
  if (!cond && !cur?.logMessage) {
    // No condition and no logpoint → fall back to a plain breakpoint so the line
    // still stops (never silently drop the user's breakpoint).
    if (cur) toggleBreakpoint(filePath, line, null, null);
    else toggleBreakpoint(filePath, line);
    return;
  }
  toggleBreakpoint(filePath, line, cond, cur?.logMessage || null);
}

/**
 * Add or edit a LOGPOINT on a line (Chrome-style). A logpoint PRINTS a message
 * and never pauses. Wrap variables in { } to interpolate real captured values,
 * e.g.  startTime={startTime}  or  cart id={cart.Id}. Empty input removes the
 * logpoint (keeping a plain/conditional breakpoint if one exists).
 */
async function editLogpoint(filePath, line) {
  const cur = debugState.breakpoints.get(filePath)?.get(line) || null;
  const m = await _askInput(
    'Logpoint',
    'Expression or message to log (Chrome-style). A variable name like  logger  or  cart.Id  prints its VALUE (objects expand). Inside a sentence, wrap variables in { }, e.g.  count={count}. Leave empty to remove.',
    cur?.logMessage || ''
  );
  if (m === null) return; // cancelled
  if (m.trim() === '') {
    if (cur?.condition) toggleBreakpoint(filePath, line, cur.condition, null); // keep conditional bp
    else removeBreakpoint(filePath, line);
    return;
  }
  toggleBreakpoint(filePath, line, cur?.condition || null, m);
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
      const isLog = !!(bpInfo && bpInfo.logMessage);
      const isCond = !!(bpInfo && bpInfo.condition);
      const disabled = bpInfo && bpInfo.enabled === false;
      let cls = isLog ? 'debug-logpoint' : isCond ? 'debug-breakpoint-conditional' : 'debug-breakpoint';
      if (disabled) cls += ' debug-breakpoint-disabled';
      const kind = isLog ? 'Logpoint' : isCond ? 'Conditional breakpoint' : 'Breakpoint';
      const detail = isLog
        ? `Logpoint: ${bpInfo.logMessage}${isCond ? ` (when ${bpInfo.condition})` : ''}`
        : isCond ? `Conditional breakpoint: ${bpInfo.condition}` : 'Breakpoint';
      const hover = disabled ? `${kind} (disabled) — ${detail}` : detail;
      newDecos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: cls,
          glyphMarginHoverMessage: { value: hover },
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
  clearExecutingLineHighlight();
}

/**
 * Mark the EXACT line an exception was thrown on (and every frame of the failing
 * call chain that lives in the file currently on screen) so the user can see —
 * right on the code — which file/line threw and why. The throw site gets a red
 * band, a 💥 glyph, and inline end-of-line text with the exception message; other
 * frames of the chain get a subtler amber marker. Reapplied after each navigation.
 */
function paintExceptionMarkers() {
  const editor = window.state?.editor;
  clearExceptionMarkers();
  if (!editor || !debugState.active || !debugState.exceptionInfo) return;
  const model = editor.getModel && editor.getModel();
  const info = debugState.exceptionInfo;
  const openFile = debugState.currentFile;
  if (!openFile || !info.stack || !info.stack.length) return;
  const label = `${info.type || 'Exception'}: ${info.message || ''}`.trim();
  const throwSite = info.stack[0] || {};
  const throwName = (throwSite.file || '').split(/[/\\]/).pop() || throwSite.file || '';
  const decos = [];
  const seen = new Set();
  info.stack.forEach((f, idx) => {
    if (!f.file || !f.line || f.file !== openFile) return;
    if (seen.has(f.line)) return;
    seen.add(f.line);
    const isThrow = idx === 0;
    const hover = isThrow
      ? `**💥 ${label}**\n\nThrown here — \`${f.className}.${f.methodName}\`, line ${f.line}.`
      : `**↳ In the failing call chain**\n\nThis call led to **${label}**, thrown at \`${throwName}:${throwSite.line}\`.`;
    // 1) Whole-line band + glyph + hover.
    decos.push({
      range: new monaco.Range(f.line, 1, f.line, 1),
      options: {
        isWholeLine: true,
        className: isThrow ? 'debug-exception-line' : 'debug-exception-chain-line',
        glyphMarginClassName: isThrow ? 'debug-exception-glyph' : 'debug-exception-chain-glyph',
        glyphMarginHoverMessage: { value: hover },
        hoverMessage: { value: hover },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    });
    // 2) End-of-line inline message (error-lens style) — rendered AFTER the last
    //    column so it never shifts the actual code.
    const endCol = model ? model.getLineMaxColumn(f.line) : 1;
    decos.push({
      range: new monaco.Range(f.line, endCol, f.line, endCol),
      options: {
        after: {
          content: isThrow ? `    💥 ${label}` : `    ↳ threw at ${throwName}:${throwSite.line}`,
          inlineClassName: isThrow ? 'debug-exception-inline' : 'debug-exception-chain-inline',
        },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    });
  });
  if (decos.length) debugState.exceptionDecoration = editor.deltaDecorations([], decos);
}

function clearExceptionMarkers() {
  const editor = window.state?.editor;
  if (editor && debugState.exceptionDecoration && debugState.exceptionDecoration.length) {
    editor.deltaDecorations(debugState.exceptionDecoration, []);
  }
  debugState.exceptionDecoration = [];
}

/**
 * Follow the interpreter as it executes, so the user can SEE where execution
 * currently is — even when it steps into another class file. We open the
 * executing file (if different from the one on screen), reveal the line, and
 * paint the animated "executing" decoration. Throttled (~140ms) so a fast run
 * doesn't thrash the editor: we act on the leading edge, then again on the
 * trailing edge if execution has advanced. Slow lines (awaiting the org) and
 * tight loops both become clearly visible.
 */
function followExecutingLine(info) {
  if (!info || !debugState.active) return;
  debugState._execPending = info;
  // Persist "where execution is right now" so the clickable query banner can jump
  // there even while the engine is blocked awaiting an on-demand org query (no new
  // onExecLine fires until the query returns). Cleared only on stop/full reset —
  // NOT in clearExecutingLineHighlight — so it survives across pauses/queries.
  debugState._execCurrentFile = info.file || debugState._execCurrentFile;
  debugState._execCurrentLine = info.line || debugState._execCurrentLine;
  if (debugState._execThrottled) return;
  flushExecFollow();
  debugState._execThrottled = true;
  debugState._execTimer = setTimeout(() => {
    debugState._execThrottled = false;
    const p = debugState._execPending;
    if (p && (p.line !== debugState._execShownLine || p.file !== debugState._execShownFile)) {
      followExecutingLine(p);
    }
  }, 140);
}

async function flushExecFollow() {
  const i = debugState._execPending;
  if (!i || !debugState.active || debugState.paused) return;
  debugState._execShownLine = i.line;
  debugState._execShownFile = i.file;
  await revealExecutingLocation(i.line, i.file, i.stack);
}

/**
 * Reveal the file+line the interpreter is currently executing.
 * KEY BEHAVIOR CHANGE: never auto-opens a file during free-running execution.
 * If execution has moved to a file that's not the active editor, show a status
 * indicator instead. Only a PAUSE (breakpoint, step, exception) may open files
 * (that's handled by onEnginePause, not here).
 */
async function revealExecutingLocation(line, file, stack) {
  const editor = window.state?.editor;
  if (!editor || !debugState.active || debugState.paused || !line) return;

  // Execution is "here, on screen" only when the TOP frame's line is in the file
  // the user has open AND actually visible in the viewport. Otherwise execution
  // has descended into a call — a DIFFERENT file, OR the SAME file scrolled away
  // (e.g. stepping into getConfigRequest() whose body lives elsewhere in this
  // very file). In both cases we keep the nearest VISIBLE ancestor call-site lit
  // as "in progress" so the parent line (e.g. line 3138) blinks while its child
  // call runs, instead of the highlight silently vanishing off-screen.
  const onScreen = file === debugState.currentFile && _lineIsVisible(editor, line);
  if (onScreen) {
    _stopInProgressTimer();
    // Progress/query text lives ONLY in the yellow banner + the in-editor band —
    // never echoed onto the toolbar exec-status pill (avoids the duplicate the
    // user flagged and keeps the toolbar width stable).
    _updateExecStatus(null);
    if (!debugState.active || debugState.paused) return;
    highlightExecutingLine(line, file);
    // Intentionally NO scroll here: free-running execution must never move the
    // user's viewport. Only an explicit PAUSE may reveal an off-screen line.
    return;
  }

  const shortName = (file || '').split(/[/\\]/).pop() || file || '';
  // Do NOT mirror "Running… file:line" / "waiting for org…" onto the toolbar pill.
  // The nearest VISIBLE ancestor line already shows the live in-progress band
  // (elapsed timer + what it's waiting on), and org fetches show the yellow banner.
  _updateExecStatus(null);
  const anc = _findVisibleAncestor(editor, stack);
  if (anc) {
    _paintInProgressLine(anc.line, shortName, line);
  } else if (!debugState._inProgCtx) {
    // No visible ancestor AND no parent loader already up → clear any stale band.
    // If a loader IS up, keep it frozen (a transient hop with no visible ancestor,
    // e.g. a System.*/Label resolution, must not make it flicker — reads as a jump).
    _clearExecBandOnly();
  }
}

/** True when `line` is currently within the editor's visible viewport. Falls
 *  back to true if the range can't be determined (safe default = normal paint). */
function _lineIsVisible(editor, line) {
  try {
    const ranges = editor.getVisibleRanges ? editor.getVisibleRanges() : null;
    if (!ranges || !ranges.length) return true;
    for (const r of ranges) {
      if (line >= r.startLineNumber && line <= r.endLineNumber) return true;
    }
    return false;
  } catch (_) { return true; }
}

/** Walk the engine's live stack (bottom-first {file,line} frames) from the TOP
 *  (nearest execution) down, and return the first frame that is in the file on
 *  screen AND whose call-site line is currently VISIBLE — i.e. the closest parent
 *  call-site the user can actually see while execution runs deeper (in this file
 *  or another). Returns null if no such visible ancestor exists. */
function _findVisibleAncestor(editor, stack) {
  if (!Array.isArray(stack) || !debugState.currentFile) return null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    if (f && f.file === debugState.currentFile && f.line && _lineIsVisible(editor, f.line)) return f;
  }
  return null;
}

/** Paint an ancestor call-site line as "in progress": amber loading band +
 *  gutter progress dot + an end-of-line elapsed timer showing how long the
 *  descended call has been running and what it's waiting on. A ~400ms interval
 *  keeps the elapsed time ticking until execution returns to this file. */
function _paintInProgressLine(ancLine, offFile, offLine) {
  if (debugState._inProgLine !== ancLine) {
    debugState._inProgStart = Date.now();
    debugState._inProgLine = ancLine;
  }
  debugState._inProgCtx = { ancLine, offFile, offLine };
  _renderInProgress();
  if (!debugState._inProgTimer) {
    debugState._inProgTimer = setInterval(() => {
      if (!debugState.active || debugState.paused || !debugState._inProgCtx) { _stopInProgressTimer(); return; }
      _renderInProgress();
    }, 150);
  }
}

function _renderInProgress() {
  const editor = window.state?.editor;
  const ctx = debugState._inProgCtx;
  if (!editor || !ctx || !debugState.active || debugState.paused) return;
  const model = editor.getModel ? editor.getModel() : null;
  const elapsedMs = Date.now() - (debugState._inProgStart || Date.now());
  const secs = (elapsedMs / 1000).toFixed(1);
  let detail;
  if (debugState.orgFetching && debugState.currentQueryText) {
    const q = debugState.currentQueryText.length > 54 ? debugState.currentQueryText.slice(0, 54) + '…' : debugState.currentQueryText;
    detail = `waiting on org · ${q}`;
  } else {
    detail = `↓ inside ${ctx.offFile}:${ctx.offLine}`;
  }
  // Indeterminate moving progress bar (we don't know the total, so a sweeping
  // cursor communicates "working" without faking a percentage).
  const slots = 12;
  const pos = Math.floor(elapsedMs / 120) % slots;
  let bar = '';
  for (let k = 0; k < slots; k++) bar += (k === pos || k === (pos + 1) % slots) ? '█' : '░';
  const endCol = model ? model.getLineMaxColumn(ctx.ancLine) : 1;
  const decos = [
    {
      range: new monaco.Range(ctx.ancLine, 1, ctx.ancLine, 1),
      options: {
        isWholeLine: true,
        className: 'debug-inprogress-band',
        glyphMarginClassName: 'debug-inprogress-glyph',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    },
    {
      range: new monaco.Range(ctx.ancLine, endCol, ctx.ancLine, endCol),
      options: {
        after: { content: `   ⏳ ${bar}  ${secs}s · ${detail}`, inlineClassName: 'debug-inprogress-inline' },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    },
  ];
  debugState.execLineDecoration = editor.deltaDecorations(debugState.execLineDecoration || [], decos);
}

function _stopInProgressTimer() {
  if (debugState._inProgTimer) { clearInterval(debugState._inProgTimer); debugState._inProgTimer = null; }
  debugState._inProgLine = null;
  debugState._inProgStart = null;
  debugState._inProgCtx = null;
}

/** Remove just the executing-line band/decoration (keep the status pill + any
 *  pending/throttle state) and stop the in-progress timer. */
function _clearExecBandOnly() {
  const editor = window.state?.editor;
  _stopInProgressTimer();
  if (editor && debugState.execLineDecoration && debugState.execLineDecoration.length > 0) {
    editor.deltaDecorations(debugState.execLineDecoration, []);
    debugState.execLineDecoration = [];
  }
}

/** Update the exec-status span in the debug toolbar. Pass null to hide it.
 *  Optional onClick makes the pill a clickable link (e.g. "open paused file").
 *  isError renders it as a red error pill (used for exception pauses). */
function _updateExecStatus(text, onClick, isError) {
  const el = _$('#dbg-exec-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? '' : 'none';
  el._onClick = (text && typeof onClick === 'function') ? onClick : null;
  el.classList.toggle('clickable', !!el._onClick);
  el.classList.toggle('error', !!(text && isError));
}

/**
 * Enable/disable the stepping controls based on whether the engine is busy.
 * While running or querying the org, Continue / Step Over / Step Into / Step Out /
 * Restart are disabled so the user can SEE that work is in progress and can't
 * queue conflicting commands. Stop stays enabled so a hang can always be aborted.
 */
function setDebugBusyUI() {
  const busy = debugState.active && (debugState.engineRunning || debugState.orgFetching || debugState.orgRunning);
  for (const id of ['dbg-btn-continue', 'dbg-btn-step-over', 'dbg-btn-step-into', 'dbg-btn-step-out', 'dbg-btn-restart']) {
    const b = _$('#' + id);
    if (b) { b.disabled = busy; b.classList.toggle('dbg-busy-disabled', busy); }
  }
  const stop = _$('#dbg-btn-stop');
  if (stop) stop.disabled = !debugState.active;
  const bar = _$('#debug-toolbar') || _$('.dbg-toolbar');
  if (bar) bar.classList.toggle('dbg-busy', busy);
  updateReplayPositionUI();
}

/* ----------------------------------------------------------------
   Draggable, position-persistent debug toolbar.
   The bar is LEFT-anchored (not centre-anchored) so that when its status text
   grows or shrinks the extra width extends to the RIGHT — the step buttons on
   the left never move, so the user can't accidentally click the wrong one. The
   user can also drag it anywhere by the "⠿ DEBUGGING" grip, and the position is
   remembered across sessions.
   ---------------------------------------------------------------- */
const DBG_TOOLBAR_POS_KEY = 'apexstudio.dbgToolbarPos';

function _clampToolbarPos(left, top, el) {
  const w = el.offsetWidth || 320;
  const h = el.offsetHeight || 36;
  const maxLeft = Math.max(4, window.innerWidth - w - 4);
  const maxTop = Math.max(4, window.innerHeight - h - 4);
  return {
    left: Math.min(Math.max(4, left), maxLeft),
    top: Math.min(Math.max(4, top), maxTop),
  };
}

/** Place the toolbar: honour the saved (dragged) position if present, otherwise
 *  centre it once horizontally and then LEFT-anchor it in px so it never
 *  re-centres and shifts the buttons when its content width changes. */
function positionDebugToolbar() {
  const bar = _$('#debug-toolbar');
  if (!bar || bar.classList.contains('hidden')) return;
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(DBG_TOOLBAR_POS_KEY) || 'null'); } catch (_) {}
  if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') {
    const w = bar.offsetWidth || 320;
    pos = { left: Math.round((window.innerWidth - w) / 2), top: 36 };
  }
  pos = _clampToolbarPos(pos.left, pos.top, bar);
  bar.style.left = pos.left + 'px';
  bar.style.top = pos.top + 'px';
  bar.style.transform = 'none';
}

function initDebugToolbarDrag() {
  const bar = _$('#debug-toolbar');
  const handle = _$('#dbg-drag-handle');
  if (!bar || !handle || bar._dragWired) return;
  bar._dragWired = true;
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

  const onMove = (e) => {
    if (!dragging) return;
    const p = _clampToolbarPos(startLeft + (e.clientX - startX), startTop + (e.clientY - startY), bar);
    bar.style.left = p.left + 'px';
    bar.style.top = p.top + 'px';
    bar.style.transform = 'none';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    try {
      localStorage.setItem(DBG_TOOLBAR_POS_KEY, JSON.stringify({
        left: parseInt(bar.style.left, 10) || 0,
        top: parseInt(bar.style.top, 10) || 0,
      }));
    } catch (_) {}
  };
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    // Anchor in px from the current on-screen rect before dragging so the first
    // move doesn't jump (the CSS default uses a centre transform).
    const rect = bar.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    bar.style.left = startLeft + 'px';
    bar.style.top = startTop + 'px';
    bar.style.transform = 'none';
    startX = e.clientX; startY = e.clientY;
    dragging = true;
    bar.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Double-click the grip to reset back to the default centred position.
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault();
    try { localStorage.removeItem(DBG_TOOLBAR_POS_KEY); } catch (_) {}
    positionDebugToolbar();
  });

  // Keep it on-screen if the window is resized.
  window.addEventListener('resize', () => {
    if (bar.classList.contains('hidden')) return;
    const p = _clampToolbarPos(parseInt(bar.style.left, 10) || 0, parseInt(bar.style.top, 10) || 36, bar);
    bar.style.left = p.left + 'px';
    bar.style.top = p.top + 'px';
  });
}

/**
 * Re-apply the executing-line decoration with the correct loading class when
 * orgFetching state changes (called from updateLiveOrgIndicator).
 */
function _refreshExecDecoration() {
  const editor = window.state?.editor;
  if (!editor || !debugState.active || debugState.paused) return;
  // If a parent call-site "in progress" band is up (execution descended off the
  // viewport), that renderer OWNS the exec decoration — just refresh it (so the
  // org-query text updates) instead of repainting at the off-screen child line.
  if (debugState._inProgCtx) { _renderInProgress(); return; }
  if (!debugState.execLineDecoration || !debugState.execLineDecoration.length) return;
  const line = debugState._execShownLine || debugState.currentLine;
  const file = debugState._execShownFile || debugState.currentFile;
  if (!line) return;
  if (file && debugState.currentFile && file !== debugState.currentFile) return;
  const cls = debugState.orgFetching
    ? 'debug-executing-line debug-executing-line-loading'
    : 'debug-executing-line';
  const glyph = debugState.orgFetching
    ? 'debug-executing-arrow debug-executing-arrow-loading'
    : 'debug-executing-arrow';
  debugState.execLineDecoration = editor.deltaDecorations(debugState.execLineDecoration, [{
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      className: cls,
      glyphMarginClassName: glyph,
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    }
  }]);
}

/**
 * Paint the animated "currently executing" decoration on a line — distinct from
 * the amber paused-line highlight. Only decorates the file that's on screen.
 * Uses the loading variant when an org fetch is in progress at this line.
 */
function highlightExecutingLine(line, file) {
  const editor = window.state?.editor;
  if (!editor || !debugState.active || debugState.paused || !line) return;
  if (file && debugState.currentFile && file !== debugState.currentFile) return;
  clearExecutingLineHighlight();
  const cls = debugState.orgFetching
    ? 'debug-executing-line debug-executing-line-loading'
    : 'debug-executing-line';
  const glyph = debugState.orgFetching
    ? 'debug-executing-arrow debug-executing-arrow-loading'
    : 'debug-executing-arrow';
  debugState.execLineDecoration = editor.deltaDecorations([], [
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: cls,
        glyphMarginClassName: glyph,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    }
  ]);
}

function clearExecutingLineHighlight() {
  const editor = window.state?.editor;
  if (debugState._execTimer) { clearTimeout(debugState._execTimer); debugState._execTimer = null; }
  debugState._execThrottled = false;
  debugState._execPending = null;
  debugState._execShownLine = null;
  debugState._execShownFile = null;
  _stopInProgressTimer(); // issue 3: kill the parent call-site elapsed timer
  _updateExecStatus(null); // also clear the "running elsewhere" status text
  if (!editor) return;
  if (debugState.execLineDecoration && debugState.execLineDecoration.length > 0) {
    editor.deltaDecorations(debugState.execLineDecoration, []);
    debugState.execLineDecoration = [];
  }
}

function navigateToLine(line) {
  const editor = window.state?.editor;
  if (!editor || !line) return;
  // Only scroll if the target line is off-screen, so same-method stepping
  // (e.g. 12 → 13 → 14, all visible) never jumps the viewport around.
  try { editor.revealLineInCenterIfOutsideViewport(line); } catch (_) { editor.revealLineInCenter(line); }
}

// Reveal + highlight the paused line, correctly handling a just-switched file.
// When Step Into/Over/Out crosses into another file, window.openFile() sets a NEW
// Monaco model synchronously, but the editor still needs a layout pass before
// revealLineInCenter() takes effect — a reveal fired in the same tick is silently
// dropped and the file stays scrolled to the TOP (the exact bug: stepping into a
// method opened the file but never scrolled to the yellow line; only clicking the
// call-stack frame — which defers via navigateToFile — landed on it). So on a file
// switch we defer to the next frames and FORCE-center; same-file stepping stays
// synchronous and only scrolls when the line is off-screen.
function revealPauseLocation(line, switchedFile) {
  const editor = window.state?.editor;
  if (!editor || !line) return;
  const paint = () => {
    highlightCurrentLine();
    paintExceptionMarkers();
    try { renderBreakpointDecorations(debugState.currentFile); } catch (_) { /* decorations are best-effort */ }
  };
  if (!switchedFile) {
    paint();
    navigateToLine(line);
    return;
  }
  // New model → wait for layout. Two rAFs guarantee a full layout cycle across
  // machines/refresh rates; a setTimeout fallback covers a backgrounded window
  // where rAF is throttled. Force-center because the whole viewport changed.
  let done = false;
  const reveal = () => {
    if (done) return;
    done = true;
    paint();
    try { editor.revealLineInCenter(line); }
    catch (_) { try { editor.revealLineInCenterIfOutsideViewport(line); } catch (_) { /* editor gone */ } }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(reveal));
  }
  setTimeout(reveal, 60);
}

async function navigateToFile(filePath, line) {
  const content = await window.apexStudio.readFile(filePath);
  await window.openFile(filePath, content);
  // Wait for model to be set, then apply decorations
  setTimeout(() => {
    renderBreakpointDecorations(filePath);
    highlightCurrentLine();
    paintExceptionMarkers();
    navigateToLine(line);
  }, 50);
}

/* ================================================================
   10. CONSOLE LOG
   ================================================================ */

// Console holds USER-FACING output only (Chrome-style): real errors, the user's
// own System.debug prints (local-sim), logpoint output, console evals, and the
// method's return value. EVERYTHING else — SOQL, DML, describes, branch/loop
// traces, status/info, warnings, and the org's captured debug log (deployed +
// framework System.debug, which is noise) — is org/engine activity routed to
// debugState.orgLog and shown in the ⚡ Org & Log tab, so the Console stays clean
// until there's an error or the user explicitly asks for output.
const CONSOLE_ENTRY_TYPES = new Set(['debug', 'result', 'result-json', 'eval', 'error']);

function addConsoleEntry(type, message, line, value) {
  const rec = { type, message, line, value, time: new Date() };
  // Mirror to the DevTools console so the main process can capture the debugger's
  // output — including failures — to a log file (no manual copy-paste needed).
  try {
    const fn = type === 'error' ? 'error' : type === 'warn' ? 'warn' : type === 'info' ? 'info' : 'log';
    console[fn](`[CCDBG:${type}]`, typeof message === 'string' ? message : formatValue(message));
  } catch (_) { /* console mirror must never break the debugger */ }
  if (CONSOLE_ENTRY_TYPES.has(type)) {
    debugState.consoleLog.push(rec);
    renderConsolePanel();
  } else {
    debugState.orgLog.push(rec);
    scheduleOrgActivityRender();
  }
}

// Coalesce Org-tab re-renders so a burst of activity log lines (a live run can
// emit dozens) repaints once per frame instead of rebuilding the panel per line.
let _orgRenderScheduled = false;
function scheduleOrgActivityRender() {
  if (_orgRenderScheduled) return;
  _orgRenderScheduled = true;
  const run = () => { _orgRenderScheduled = false; renderOrgActivityPanel(); };
  if (typeof window !== 'undefined' && window.requestAnimationFrame) window.requestAnimationFrame(run);
  else setTimeout(run, 16);
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
  // The panel is on screen now — hide the status-bar "reopen" affordance.
  _$('#status-reopen-debug')?.classList.add('hidden');
  // Make the toolbar draggable and restore its remembered (or centred) position.
  initDebugToolbarDrag();
  positionDebugToolbar();
  requestAnimationFrame(positionDebugToolbar);
  // Enable glyphMargin
  window.state?.editor?.updateOptions({ glyphMargin: true });
  // Trigger layout so editor shrinks above the panel
  setTimeout(() => window.state?.editor?.layout(), 50);
}

function hideDebugUI() {
  debugState.debugPanelVisible = false;
  _$('#debug-toolbar')?.classList.add('hidden');
  _$('#debug-panel')?.classList.add('hidden');
  // Surface a one-click way to bring the panel back (the close button is the only
  // way to get here, so the user explicitly hid it — don't strand its output).
  _$('#status-reopen-debug')?.classList.remove('hidden');
  clearCurrentLineHighlight();
  // Restore editor layout
  setTimeout(() => window.state?.editor?.layout(), 50);
}

function updateDebugPanels() {
  applyUserOverridesToStack();
  renderVariablesPanel();
  renderWatchPanel();
  renderDataFlowPanel();
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
  const sel = selectedFrameIndex();
  const frame = scopeType === 'closure'
    ? debugState.callStack[sel - 1]
    : debugState.callStack[sel];
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
  const sel = selectedFrameIndex();
  const frame = scopeType === 'closure'
    ? debugState.callStack[sel - 1]
    : debugState.callStack[sel];
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

  const selIdx = selectedFrameIndex();
  const topIdx = debugState.callStack.length - 1;
  const frame = debugState.callStack[selIdx];
  if (!frame) {
    container.innerHTML = '<div class="dbg-empty">No active frame</div>';
    return;
  }

  let html = '';

  // When viewing a CALLER frame (not the executing one), say so and offer a jump
  // back — so the scope on screen is never mistaken for the live execution point.
  if (selIdx !== topIdx) {
    html += `<div class="dbg-frame-banner">`
      + `Viewing caller <b>${_esc(frame.className || '')}${frame.methodName ? '.' + _esc(frame.methodName) : ''}()</b> — not the current line`
      + `<button class="dbg-frame-return" onclick="window._dbgSelectFrame(${topIdx})">↩ back to current</button>`
      + `</div>`;
  }

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

  // --- Closure / Parent Scope section (the frame that called this one) ---
  if (selIdx > 0) {
    const parentFrame = debugState.callStack[selIdx - 1];
    html += '<div class="dbg-scope-section collapsed">';
    html += `<div class="dbg-scope-header" onclick="this.parentElement.classList.toggle('collapsed')">▶ Closure (${_esc(parentFrame.className)}.${_esc(parentFrame.methodName)})</div>`;
    for (const key of Object.keys(parentFrame.variables)) {
      html += renderVarEntry(key, parentFrame.variables[key], 'closure');
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

/* ================================================================
   WATCH BY IDENTITY · WATCH-WITH-HISTORY · DATA FLOW
   ----------------------------------------------------------------
   Pin a live engine object/field from the hover value-tree and follow it BY
   REFERENCE (not by position) for the rest of the run — so a value buried inside
   a huge collection stays tracked even as the collection churns. Record a
   delta-only history of its field changes and a deduped data-flow of which
   methods read vs modify it. Every value is a real engine capture — nothing here
   is fabricated. Fed by the engine's field observer (host.onFieldWrite/Read).
   ================================================================ */

function _watchE() { return window.ApexEngine; }
// The engine's current top frame (the pin's bind scope), or null when not running.
function _watchTopFrame() {
  const eng = debugState.engineSession;
  return eng && eng.topFrame ? eng.topFrame() : null;
}

// Compact, IMMUTABLE snapshot of a value for a history row, so later mutations of
// the live object never rewrite what the timeline already showed. Primitives are
// kept as-is; objects/containers collapse to a short type label.
function _watchDispSnapshot(v) {
  const E = _watchE();
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (Array.isArray(v)) return `List(${v.length})`;
  if (E) {
    if (v instanceof E.ApexObject) {
      const cls = v.classInfo && (v.classInfo.name || v.classInfo.qualifiedName);
      return `${cls || 'Object'} {${v.fields ? v.fields.size : 0}}`;
    }
    if (v instanceof E.ApexMap) return `Map (${v.m ? v.m.size : 0})`;
    if (v instanceof E.ApexSet) return `Set (${v.items ? v.items().length : 0})`;
  }
  try { return String(E && E.toApexString ? E.toApexString(v) : v); } catch (_) { return '‹value›'; }
}

// Did the value REALLY change? Apex equality for values, reference identity for
// objects/containers — so re-assigning the same object is not a "delta".
function _watchSameValue(a, b) {
  if (a === b) return true;
  if (a && typeof a === 'object') return false;  // objects: identity only
  const E = _watchE();
  if (E && E.apexEquals) { try { return E.apexEquals(a, b) === true; } catch (_) {} }
  return false;
}

function _watchMethodKey(ev) { return `${ev.className || '?'}.${ev.methodName || '?'}`; }

// Human type label for a pin. Prefer the real Apex class/container name for engine
// values (ApexObject/Map/Set); fall back to the generic hover type namer otherwise.
function _watchTypeName(v) {
  const E = _watchE();
  if (E && v && typeof v === 'object') {
    if (v instanceof E.ApexObject) return (v.classInfo && (v.classInfo.name || v.classInfo.qualifiedName)) || 'Object';
    if (v instanceof E.ApexMap) return `Map (${v.m ? v.m.size : 0})`;
    if (v instanceof E.ApexSet) return `Set (${v.items ? v.items().length : 0})`;
  }
  try { return getValueTypeName(v, null); } catch (_) { return 'value'; }
}

/* ---- capture (host.onFieldWrite / onFieldRead) ---- */
function recordFieldWrite(ev) {
  if (ev == null || ev.watchId == null || !debugState.trackedObjects.has(ev.watchId)) return;
  // Watch WITH HISTORY — delta-only: record only genuine value changes.
  if (!_watchSameValue(ev.oldValue, ev.newValue)) {
    const arr = debugState.watchHistory.get(ev.watchId) || [];
    arr.push({
      seq: arr.length, field: ev.field,
      oldDisp: _watchDispSnapshot(ev.oldValue), newDisp: _watchDispSnapshot(ev.newValue),
      step: ev.step, line: ev.line, file: ev.file, className: ev.className, methodName: ev.methodName,
    });
    if (arr.length > debugState._watchHistoryCap) arr.shift();
    debugState.watchHistory.set(ev.watchId, arr);
  }
  _recordDataFlow(ev, 'write');
  _scheduleWatchRefresh();
}

function recordFieldRead(ev) {
  if (ev == null || ev.watchId == null || !debugState.trackedObjects.has(ev.watchId)) return;
  _recordDataFlow(ev, 'read');
}

// Deduped per (method|object|access); repeat accesses just bump the count so the
// event stream stays O(methods × tracked objects) no matter how hot the code is.
function _recordDataFlow(ev, access) {
  const df = debugState.dataFlow;
  const mkey = _watchMethodKey(ev);
  const dedup = `${mkey}|${ev.watchId}|${access}`;
  const idx = df.seen.get(dedup);
  if (idx != null) { df.events[idx].count++; return; }
  df.seen.set(dedup, df.events.length);
  df.events.push({
    watchId: ev.watchId, methodKey: mkey, className: ev.className, methodName: ev.methodName,
    file: ev.file, line: ev.line, access, count: 1, firstStep: ev.step,
  });
}

/* ---- registration (hover pin / watch tab) ---- */
// Ensure a LIVE object is tracked by identity; returns its watchId (reused if
// already tracked, assigned on first sight). Enforces the tracked-object cap.
function _watchEnsureTracked(obj) {
  const E = _watchE();
  if (!obj || typeof obj !== 'object') return null;
  if (obj.__watchId != null && debugState.trackedObjects.has(obj.__watchId)) return obj.__watchId;
  if (debugState.trackedObjects.size >= debugState._watchTrackedCap) {
    window.showToast?.(`Watch limit reached (${debugState._watchTrackedCap}). Remove one to pin another.`);
    return null;
  }
  const watchId = debugState.watchNextObjId++;
  if (E && E.trackObject) E.trackObject(obj, watchId); else { obj.__tracked = true; obj.__watchId = watchId; }
  debugState.trackedObjects.set(watchId, { obj });
  return watchId;
}

// Add a watch pin. kind 'object' follows the whole object; kind 'field' focuses a
// single field of it (its timeline is filtered to that field). Several field pins
// can share one tracked object identity. Returns the pin (or an existing duplicate).
function watchAddPin(obj, meta) {
  const watchId = _watchEnsureTracked(obj);
  if (watchId == null) return null;
  const kind = (meta && meta.kind) || 'object';
  const field = (meta && meta.field) != null ? meta.field : null;
  const dup = debugState.watchPins.find(p => p.watchId === watchId && p.kind === kind && (p.field || null) === field);
  if (dup) return dup;
  const pin = {
    id: debugState.watchNextId++, watchId, kind, field,
    label: (meta && meta.label) || 'value', typeName: meta && meta.typeName,
    path: (meta && meta.path) || null, bindExpr: (meta && meta.bindExpr) || null, _bound: true,
    watchChain: [watchId], replacements: [], _bindFrame: null, _cleared: false,
  };
  debugState.watchPins.push(pin);
  saveWatchDefs();
  return pin;
}

function watchUnpin(pinId) {
  const i = debugState.watchPins.findIndex(p => p.id === pinId);
  if (i < 0) return;
  const pin = debugState.watchPins[i];
  debugState.watchPins.splice(i, 1);
  // Drop the tracked object + its history only if no other pin still references it.
  if (pin.watchId != null && !debugState.watchPins.some(p => p.watchId === pin.watchId)) {
    const tr = debugState.trackedObjects.get(pin.watchId);
    if (tr && tr.obj) { const E = _watchE(); if (E && E.untrackObject) E.untrackObject(tr.obj); }
    debugState.trackedObjects.delete(pin.watchId);
    debugState.watchHistory.delete(pin.watchId);
    if (debugState.dataFlow.focusWatchId === pin.watchId) debugState.dataFlow.focusWatchId = null;
  }
  saveWatchDefs();
  updateDebugPanels();
}

// Is a live reference already pinned?
function watchIsTracked(obj) {
  return !!(obj && typeof obj === 'object' && obj.__watchId != null && debugState.trackedObjects.has(obj.__watchId));
}

/* ---- per-run reset (keeps persisted definitions) ---- */
function resetWatchRuntime() {
  debugState.trackedObjects = new Map();
  debugState.watchHistory = new Map();
  debugState.dataFlow = { events: [], seen: new Map(), focusWatchId: null };
  // Unbind identity pins — the previous run's object refs are gone. The pin
  // DEFINITIONS (path/label/kind) survive so they can re-bind by path this run.
  for (const p of debugState.watchPins) {
    p.watchId = null; p._bound = false; p._cleared = false;
    p.watchChain = []; p.replacements = []; p._bindFrame = null;
  }
}

/* ---- throttled repaint (field writes can stream fast during a free run) ---- */
let _watchRefreshTimer = null;
function _scheduleWatchRefresh() {
  if (_watchRefreshTimer) return;
  _watchRefreshTimer = setTimeout(() => {
    _watchRefreshTimer = null;
    try { renderWatchPanel(); } catch (_) {}
    try { renderDataFlowPanel(); } catch (_) {}
  }, 120);
}

/* ---- persistence of watch DEFINITIONS (expressions + pin re-bind exprs) ----
   We persist only DEFINITIONS, never live object refs or per-run history/watchIds.
   On a new run each pin re-binds by evaluating its expression at a pause. */
function saveWatchDefs() {
  try {
    const defs = {
      exprs: debugState.watchExpressions.map(w => w.expr),
      pins: debugState.watchPins
        .filter(p => p.bindExpr)
        .map(p => ({ kind: p.kind, field: p.field, label: p.label, typeName: p.typeName, bindExpr: p.bindExpr })),
    };
    localStorage.setItem('apexstudio.watchDefs', JSON.stringify(defs));
  } catch (_) { /* storage is best-effort */ }
}

function loadWatchDefs() {
  let defs;
  try { defs = JSON.parse(localStorage.getItem('apexstudio.watchDefs') || 'null'); } catch (_) { defs = null; }
  if (!defs) return;
  if (Array.isArray(defs.exprs) && !debugState.watchExpressions.length) {
    for (const expr of defs.exprs) debugState.watchExpressions.push({ id: debugState.watchNextId++, expr });
  }
  if (Array.isArray(defs.pins) && !debugState.watchPins.length) {
    for (const d of defs.pins) {
      if (!d || !d.bindExpr) continue;
      // Restored as UNBOUND definitions — they attach to a live object the first
      // time their expression resolves at a pause this run (syncWatchPins).
      debugState.watchPins.push({
        id: debugState.watchNextId++, watchId: null, kind: d.kind || 'object',
        field: d.field != null ? d.field : null, label: d.label || d.bindExpr,
        typeName: d.typeName, path: null, bindExpr: d.bindExpr, _bound: false,
        watchChain: [], replacements: [], _bindFrame: null, _cleared: false,
      });
    }
  }
}

// Is this bind expression a STABLE binding — a bare variable or a dotted member
// path (request, this.cart, ctx.request)? Only stable bindings are followed across
// REASSIGNMENT. Positional/element paths (request.lineItems[0]) or calls are NOT
// stable, so those pins stay locked to their instance by identity (position-proof).
function _isStableBinding(expr) {
  return typeof expr === 'string' && /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(expr.trim());
}

// Build the synthetic timeline marker recorded when a watched binding is REASSIGNED
// to a different object (e.g. `request` becomes a structurally different server
// response) or cleared to null. It captures WHERE the swap was seen and the old→new
// type/summary, so the developer can pinpoint where the structure changed.
function _watchMakeReplaceMarker(eng, oldObj, newObj, cleared) {
  const top = (eng.topFrame && eng.topFrame()) || null;
  return {
    __marker: 'replaced', cleared: !!cleared,
    oldType: oldObj != null ? _watchTypeName(oldObj) : null,
    oldDisp: oldObj != null ? _watchDispSnapshot(oldObj) : null,
    newType: cleared ? 'null' : (newObj != null ? _watchTypeName(newObj) : null),
    newDisp: cleared ? null : (newObj != null ? _watchDispSnapshot(newObj) : null),
    file: eng.currentFile || (top && top.file) || null,
    line: eng.currentLine != null ? eng.currentLine : (top ? top.line : null),
    step: eng._steps || 0,
    className: top ? top.className : null, methodName: top ? top.methodName : null,
  };
}

// At each pause: (1) bind any unbound pin by evaluating its expression; (2) for an
// already-bound pin whose STABLE binding now resolves to a DIFFERENT object, record
// a replacement marker and follow the new object so the timeline stays CONTINUOUS
// across request→response style transforms. Reassignment-following is restricted to
// the frame the pin was bound in, so a same-named variable in another method is
// never mistaken for a reassignment of ours. Sandbox eval → the observer stays
// silent, so syncing never pollutes history/data-flow. Cheap: pins only, at pause.
async function syncWatchPins() {
  if (!debugState.watchPins.length) return;
  const eng = debugState.engineSession;
  if (!eng || !debugState.paused) return;
  const top = eng.topFrame && eng.topFrame();
  if (!top) return;

  for (const pin of debugState.watchPins) {
    if (!pin.bindExpr) continue;

    // (1) initial (re-)bind of an unbound pin — attach wherever the path resolves.
    if (!pin._bound) {
      let ref;
      try { ref = await eng.evalExpressionSandboxed(pin.bindExpr, top, false); } catch (_) { ref = undefined; }
      if (ref && typeof ref === 'object') {
        const wid = _watchEnsureTracked(ref);
        if (wid != null) {
          pin.watchId = wid; pin._bound = true; pin._cleared = false;
          pin.watchChain = [wid]; pin.replacements = pin.replacements || [];
          pin._bindFrame = top;
        }
      }
      continue;
    }

    // (2) reassignment follow — stable bindings only, and only while paused in the
    // SAME frame the pin was bound in (identity-safe against same-named variables).
    if (!_isStableBinding(pin.bindExpr) || pin._bindFrame !== top) continue;
    let ref;
    try { ref = await eng.evalExpressionSandboxed(pin.bindExpr, top, false); } catch (_) { ref = undefined; }
    if (ref === undefined) continue;                 // out of scope / unresolved — leave as-is
    const tr = pin.watchId != null ? debugState.trackedObjects.get(pin.watchId) : null;
    const cur = tr && tr.obj;

    if (ref === null) {                              // binding was cleared to null
      if (!pin._cleared && cur) {
        pin.replacements = pin.replacements || [];
        pin.replacements.push(_watchMakeReplaceMarker(eng, cur, null, true));
        pin._cleared = true;
      }
      continue;
    }
    if (typeof ref !== 'object' || ref === cur) continue;  // primitive or same object — nothing to follow

    // Genuine reassignment to a different object → mark it and follow the new one.
    const wid = _watchEnsureTracked(ref);
    if (wid == null) continue;
    pin.replacements = pin.replacements || [];
    pin.replacements.push(_watchMakeReplaceMarker(eng, cur, ref, false));
    if (!(pin.watchChain && pin.watchChain.length)) pin.watchChain = pin.watchId != null ? [pin.watchId] : [];
    pin.watchChain.push(wid);
    pin.watchId = wid; pin._cleared = false;
    // Attribute the swap to the current method in the Data Flow view.
    try {
      _recordDataFlow({ watchId: wid, className: top.className, methodName: top.methodName,
        file: eng.currentFile || top.file, line: eng.currentLine != null ? eng.currentLine : top.line,
        step: eng._steps }, 'write');
    } catch (_) {}
  }
}

/* ---- Watch tab display helpers (read raw — never through getField, so painting
   the panel during a free run can't pollute the data-flow with UI reads) ---- */
function _watchLiveRaw(pin) {
  // A binding that was reassigned to null reads as null (its history is preserved).
  if (pin._cleared) return { present: true, value: null };
  const tr = pin.watchId != null ? debugState.trackedObjects.get(pin.watchId) : null;
  if (!tr || !tr.obj) return { present: false, value: undefined };
  if (pin.kind === 'field') {
    const obj = tr.obj;
    let value;
    if (obj.fields && obj.fields.get) { const e = obj.fields.get(String(pin.field).toLowerCase()); value = e ? e.value : undefined; }
    return { present: true, value };
  }
  return { present: true, value: tr.obj };
}

function _watchValHtml(v) {
  if (v === undefined) return '<span class="dbg-watch-muted">—</span>';
  if (v === null) return '<span class="cv-null">null</span>';
  const t = typeof v;
  if (t === 'string') return `<span class="cv-str">"${_esc(v.length > 60 ? v.slice(0, 60) + '…' : v)}"</span>`;
  if (t === 'number') return `<span class="cv-num">${_esc(String(v))}</span>`;
  if (t === 'boolean') return `<span class="cv-bool">${v}</span>`;
  return `<span class="dbg-watch-objsum">${_esc(_watchDispSnapshot(v))}</span>`;
}

function _watchDeltaHtml(d) {
  if (d === undefined) return '<span class="dbg-watch-muted">undefined</span>';
  if (d === null) return '<span class="cv-null">null</span>';
  const t = typeof d;
  if (t === 'number') return `<span class="cv-num">${_esc(String(d))}</span>`;
  if (t === 'boolean') return `<span class="cv-bool">${d}</span>`;
  const s = String(d);
  return `<span class="cv-str">${_esc(s.length > 44 ? s.slice(0, 44) + '…' : s)}</span>`;
}

// Merge a pin's timeline across its full chain of tracked identities (it may have
// followed one or more reassignments), interleaving replacement markers by step so
// the developer sees a single continuous history even when the object was swapped.
function _watchPinHistory(pin) {
  const chain = (pin.watchChain && pin.watchChain.length) ? pin.watchChain
    : (pin.watchId != null ? [pin.watchId] : []);
  let rows = [];
  const seen = new Set();
  for (const wid of chain) {
    if (seen.has(wid)) continue; seen.add(wid);
    let deltas = debugState.watchHistory.get(wid) || [];
    if (pin.kind === 'field') deltas = deltas.filter(h => (h.field || null) === (pin.field || null));
    rows = rows.concat(deltas);
  }
  if (pin.replacements && pin.replacements.length) rows = rows.concat(pin.replacements);
  rows.sort((a, b) => (a.step || 0) - (b.step || 0));
  return rows;
}

function renderWatchPanel() {
  const container = _$('#dbg-watch-body');
  if (!container) return;

  const hasExprs = debugState.watchExpressions.length > 0;
  const hasPins = debugState.watchPins.length > 0;
  if (!hasExprs && !hasPins) {
    container.innerHTML = '<div class="dbg-empty">No watches yet. Add an expression below, or hover a value while paused and click 📌 to follow it by identity (live value · history · data flow).</div>';
    return;
  }

  const frame = debugState.callStack[selectedFrameIndex()];
  const watchScope = frame ? { ...(frame.classFields || {}), ...frame.variables } : {};

  let html = '';

  // --- Pinned identity watches (live value + delta history) ---
  if (hasPins) {
    html += `<div class="dbg-watch-section">📌 Pinned <span class="dbg-watch-section-hint">⟳ binding follows a variable across reassignment · ⦿ instance follows one object · ${debugState.trackedObjects.size}/${debugState._watchTrackedCap}</span></div>`;
    for (const pin of debugState.watchPins) {
      const { present, value } = _watchLiveRaw(pin);
      const hist = _watchPinHistory(pin);
      const typeLabel = pin.typeName ? _esc(pin.typeName) : (pin.kind === 'field' ? 'field' : 'object');
      const follows = pin.bindExpr && _isStableBinding(pin.bindExpr);
      const modeBadge = follows
        ? `<span class="dbg-watch-pin-mode follows" title="Follows this variable across reassignment — if it becomes a different object (e.g. request → a server response), the swap is marked in the timeline and watching continues on the new object.">⟳ binding</span>`
        : `<span class="dbg-watch-pin-mode" title="Locked to this specific object instance and follows it by identity regardless of its position.">⦿ instance</span>`;
      html += `<div class="dbg-watch-pin${present ? '' : ' unbound'}" data-pin-id="${pin.id}">`;
      html += `<div class="dbg-watch-pin-row">`;
      html += `<span class="dbg-watch-pin-icon">${present ? '📍' : '📌'}</span>`;
      html += `<span class="dbg-watch-pin-label" title="${_esc(pin.label)}">${_esc(pin.label)}</span>`;
      html += `<span class="dbg-watch-pin-type">${typeLabel}</span>`;
      html += modeBadge;
      html += `<span class="dbg-watch-pin-val">${present ? _watchValHtml(value) : '<span class="dbg-watch-muted" title="This object belongs to a previous run — it re-binds when its path is next seen while paused.">waiting for this run</span>'}</span>`;
      html += `<span class="dbg-watch-pin-hist${hist.length ? '' : ' empty'}" title="Value changes recorded this run — click to see the timeline">🕘 ${hist.length}</span>`;
      html += `<button class="dbg-watch-pin-flow" title="Show this object in the Data Flow tab">⤳</button>`;
      html += `<button class="dbg-watch-pin-remove" title="Stop watching">✕</button>`;
      html += `</div>`;
      // Inline delta timeline (newest first) — each row jumps to where it changed.
      html += `<div class="dbg-watch-pin-timeline hidden">`;
      if (!hist.length) {
        html += `<div class="dbg-watch-delta-empty">No changes recorded yet${present ? '' : ' (not bound this run)'}.</div>`;
      } else {
        for (let i = hist.length - 1; i >= 0; i--) {
          const h = hist[i];
          const loc = `${_esc((h.className || '?').split('.').pop())}.${_esc(h.methodName || '?')}:${h.line != null ? h.line : '?'}`;
          if (h.__marker) {
            // Reassignment / replacement divider — where the watched object changed.
            const arrowTo = h.cleared
              ? '<span class="cv-null">null</span>'
              : `<span class="dbg-watch-repl-new">${_esc(h.newType || 'object')}</span>`;
            html += `<div class="dbg-watch-replace" data-file="${_esc(h.file || '')}" data-line="${h.line != null ? h.line : ''}" title="The watched binding was ${h.cleared ? 'cleared to null' : 'reassigned to a different object'} here — click to jump">`;
            html += `<span class="dbg-watch-repl-icon">⟳</span>`;
            html += `<span class="dbg-watch-repl-old">${_esc(h.oldType || 'object')}</span>`;
            html += `<span class="dbg-watch-delta-arrow">→</span>`;
            html += arrowTo;
            html += `<span class="dbg-watch-repl-tag">${h.cleared ? 'cleared' : 'replaced'}</span>`;
            html += `<span class="dbg-watch-delta-loc">${loc}</span>`;
            html += `</div>`;
            continue;
          }
          html += `<div class="dbg-watch-delta" data-file="${_esc(h.file || '')}" data-line="${h.line != null ? h.line : ''}" title="Jump to where this changed">`;
          html += `<span class="dbg-watch-delta-field">${_esc(h.field || '')}</span>`;
          html += `<span class="dbg-watch-delta-old">${_watchDeltaHtml(h.oldDisp)}</span>`;
          html += `<span class="dbg-watch-delta-arrow">→</span>`;
          html += `<span class="dbg-watch-delta-new">${_watchDeltaHtml(h.newDisp)}</span>`;
          html += `<span class="dbg-watch-delta-loc">${loc}</span>`;
          html += `</div>`;
        }
      }
      html += `</div></div>`;
    }
  }

  // --- Expression watches (existing) ---
  if (hasExprs) {
    if (hasPins) html += `<div class="dbg-watch-section">🔎 Expressions</div>`;
    for (const watch of debugState.watchExpressions) {
      let value;
      let error = null;
      try {
        if (frame) {
          value = resolveProperty(watchScope, watch.expr);
          if (value === undefined) value = evaluateExpression(watch.expr, watchScope);
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
  }

  container.innerHTML = html;

  // Expression rows: click-to-expand the value tree.
  container.querySelectorAll('.dbg-watch-entry').forEach(entry => {
    const row = entry.querySelector('.dbg-watch-row');
    const expand = entry.querySelector('.dbg-watch-expand');
    if (row && expand) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => { expand.classList.toggle('hidden'); });
    }
  });

  // Pinned rows: history toggle, jump-to-change, data-flow focus, remove.
  container.querySelectorAll('.dbg-watch-pin').forEach(el => {
    const pinId = parseInt(el.getAttribute('data-pin-id'), 10);
    const timeline = el.querySelector('.dbg-watch-pin-timeline');
    const histBtn = el.querySelector('.dbg-watch-pin-hist');
    if (histBtn && timeline) {
      histBtn.style.cursor = 'pointer';
      histBtn.addEventListener('click', (e) => { e.stopPropagation(); timeline.classList.toggle('hidden'); });
    }
    el.querySelector('.dbg-watch-pin-remove')?.addEventListener('click', (e) => { e.stopPropagation(); watchUnpin(pinId); });
    el.querySelector('.dbg-watch-pin-flow')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const pin = debugState.watchPins.find(p => p.id === pinId);
      if (pin) { debugState.dataFlow.focusWatchId = pin.watchId; switchToDebugTab('dbg-dataflow'); try { renderDataFlowPanel(); } catch (_) {} }
    });
    el.querySelectorAll('.dbg-watch-delta, .dbg-watch-replace').forEach(row => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const file = row.getAttribute('data-file'); const line = parseInt(row.getAttribute('data-line'), 10);
        if (file && Number.isFinite(line)) navigateToFile(file, line);
      });
    });
  });
}

window._dbgRemoveWatch = function(watchId) {
  debugState.watchExpressions = debugState.watchExpressions.filter(w => w.id !== watchId);
  saveWatchDefs();
  renderWatchPanel();
};


/* ================================================================
   DATA FLOW PANEL — how tracked objects move through methods
   ----------------------------------------------------------------
   Overview: per method, which pinned objects it READ vs MODIFIED (deduped, with
   counts). Focus one object (chip) to see its ordered method flow. Every row
   jumps to the method/line. Purely from real engine field access — no guesses.
   ================================================================ */
function _watchLabelFor(watchId) {
  const pin = debugState.watchPins.find(p => p.watchId === watchId);
  if (pin) return pin.label;
  const tr = debugState.trackedObjects.get(watchId);
  if (tr && tr.obj && tr.obj.classInfo) return tr.obj.classInfo.name || 'object';
  return `object#${watchId}`;
}

function _dfObjChip(ev) {
  const label = _esc(_watchLabelFor(ev.watchId));
  const cnt = ev.count > 1 ? ` ×${ev.count}` : '';
  return `<span class="dbg-df-obj ${ev.access === 'write' ? 'write' : 'read'}">${label}${cnt}</span>`;
}

function _dfShortMethod(ev) {
  return `${_esc((ev.className || '?').split('.').pop())}.${_esc(ev.methodName || '?')}`;
}

function _dataFlowChipsHtml(df) {
  const ids = [...new Set(debugState.watchPins.map(p => p.watchId).filter(x => x != null))];
  let h = '<div class="dbg-df-chips">';
  h += `<span class="dbg-df-chip${df.focusWatchId == null ? ' active' : ''}" data-focus="">All objects</span>`;
  for (const id of ids) h += `<span class="dbg-df-chip${df.focusWatchId === id ? ' active' : ''}" data-focus="${id}">${_esc(_watchLabelFor(id))}</span>`;
  h += '</div>';
  return h;
}

function _dataFlowOverviewHtml(df) {
  const methods = [];
  const byKey = new Map();
  for (const ev of df.events) {
    let m = byKey.get(ev.methodKey);
    if (!m) { m = { key: ev.methodKey, className: ev.className, methodName: ev.methodName, file: ev.file, line: ev.line, reads: [], writes: [] }; byKey.set(ev.methodKey, m); methods.push(m); }
    (ev.access === 'write' ? m.writes : m.reads).push(ev);
  }
  if (!methods.length) return '<div class="dbg-empty">No data flow captured yet. Resume the run — reads and writes on pinned objects appear here per method.</div>';
  let h = '<div class="dbg-df-table"><div class="dbg-df-head"><span>Method</span><span>Reads</span><span>Modifies</span></div>';
  for (const m of methods) {
    h += `<div class="dbg-df-mrow" data-file="${_esc(m.file || '')}" data-line="${m.line != null ? m.line : ''}">`;
    h += `<span class="dbg-df-method" title="Jump to ${_esc(m.key)}">${_esc((m.className || '?').split('.').pop())}.${_esc(m.methodName || '?')}</span>`;
    h += `<span class="dbg-df-cell">${m.reads.map(_dfObjChip).join('') || '<span class="dbg-watch-muted">—</span>'}</span>`;
    h += `<span class="dbg-df-cell">${m.writes.map(_dfObjChip).join('') || '<span class="dbg-watch-muted">—</span>'}</span>`;
    h += `</div>`;
  }
  h += '</div>';
  return h;
}

function _dataFlowFocusHtml(df, watchId) {
  const evs = df.events.filter(e => e.watchId === watchId).slice().sort((a, b) => (a.firstStep || 0) - (b.firstStep || 0));
  if (!evs.length) return '<div class="dbg-empty">No reads or writes recorded for this object yet.</div>';
  let h = `<div class="dbg-df-flow-head">Method flow for <b>${_esc(_watchLabelFor(watchId))}</b> — in execution order:</div><div class="dbg-df-flow">`;
  for (const ev of evs) {
    h += `<div class="dbg-df-frow" data-file="${_esc(ev.file || '')}" data-line="${ev.line != null ? ev.line : ''}" title="Jump to this method">`;
    h += `<span class="dbg-df-badge ${ev.access === 'write' ? 'write' : 'read'}">${ev.access === 'write' ? 'MODIFIED' : 'READ'}</span>`;
    h += `<span class="dbg-df-method">${_dfShortMethod(ev)}<span class="dbg-df-line">:${ev.line != null ? ev.line : '?'}</span></span>`;
    h += `<span class="dbg-df-count">${ev.count > 1 ? '×' + ev.count : ''}</span>`;
    h += `</div>`;
  }
  h += `</div>`;
  return h;
}

function renderDataFlowPanel() {
  const container = _$('#dbg-dataflow-body');
  if (!container) return;
  const df = debugState.dataFlow;
  if (!debugState.watchPins.length) {
    container.innerHTML = '<div class="dbg-empty">No tracked objects. While paused, hover a value and click 📌 to follow it — this tab then shows which methods read it and which modify it.</div>';
    return;
  }
  // A focus target that no longer exists falls back to the overview.
  if (df.focusWatchId != null && !debugState.watchPins.some(p => p.watchId === df.focusWatchId)) df.focusWatchId = null;

  let html = _dataFlowChipsHtml(df);
  html += df.focusWatchId != null ? _dataFlowFocusHtml(df, df.focusWatchId) : _dataFlowOverviewHtml(df);
  container.innerHTML = html;

  container.querySelectorAll('.dbg-df-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const raw = chip.getAttribute('data-focus');
      df.focusWatchId = raw === '' ? null : parseInt(raw, 10);
      renderDataFlowPanel();
    });
  });
  const jump = (el) => {
    const file = el.getAttribute('data-file'); const line = parseInt(el.getAttribute('data-line'), 10);
    if (file && Number.isFinite(line)) navigateToFile(file, line);
  };
  container.querySelectorAll('.dbg-df-mrow, .dbg-df-frow').forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => jump(row));
  });
}


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

/** A signature for the current execution stop. Frame selection (clicking a caller
 *  in the Call Stack) persists only while this stays the same; as soon as execution
 *  moves (step / replay-goto / new pause) the selection auto-resets to the top
 *  (currently-executing) frame, exactly like Chrome DevTools. */
function _execSig() {
  return [
    debugState.replayMode ? debugState.replayIndex : -1,
    debugState.currentLine,
    debugState.callStack.length,
  ].join(':');
}

/** The index of the frame the panels should show: the user-selected frame while it
 *  is still valid for this stop, otherwise the top (executing) frame. */
function selectedFrameIndex() {
  const top = debugState.callStack.length - 1;
  if (top < 0) return -1;
  if (debugState.currentFrame == null) return top;
  if (debugState._frameSelSig !== _execSig()) { debugState.currentFrame = null; return top; }
  const i = debugState.currentFrame;
  return (i >= 0 && i <= top) ? i : top;
}

function renderCallStackPanel() {
  const container = _$('#dbg-callstack-body');
  if (!container) return;

  const stack = debugState.callStack;
  if (!stack || stack.length === 0) {
    container.innerHTML = '<div class="dbg-empty">No active call stack — start a debug run to see the execution path.</div>';
    return;
  }

  const topIdx = stack.length - 1;
  const selIdx = selectedFrameIndex();

  // Header: how deep the call chain is right now (answers "how many levels").
  let html = `<div class="dbg-stack-head">`
    + `<span class="dbg-stack-head-title">Call stack</span>`
    + `<span class="dbg-stack-head-count">${stack.length} ${stack.length === 1 ? 'level' : 'levels'} deep</span>`
    + `</div>`;
  if (stack.length > 1) {
    html += '<div class="dbg-stack-hint">Click a frame to open its file and inspect its variables · ⇧F11 steps out to the caller</div>';
  }

  // Top-first (current execution at the top, its callers below) — Chrome order.
  for (let i = topIdx; i >= 0; i--) {
    const frame = stack[i];
    const currentStmt = frame.statements && frame.statements[frame.pc];
    const line = currentStmt ? currentStmt.line : frame.line;
    const isTop = i === topIdx;
    const isSel = i === selIdx;
    const level = i + 1; // 1 = entry (bottom), topIdx+1 = current (top)
    const fileName = frame.file ? String(frame.file).split(/[/\\]/).pop() : '(source unavailable)';
    const method = `${_esc(frame.className || '')}${frame.methodName ? '.' + _esc(frame.methodName) : ''}` || '(anonymous)';
    const cls = ['dbg-stack-frame'];
    if (isTop) cls.push('current');
    if (isSel) cls.push('selected');
    if (!frame.file) cls.push('no-src');
    const marker = isTop ? '▶' : '·';
    const badge = isTop ? 'current' : `L${level}`;
    const clickable = frame.file ? ` onclick="window._dbgSelectFrame(${i})"` : '';
    html += `<div class="${cls.join(' ')}"${clickable} title="${frame.file ? 'Jump to ' + _esc(fileName) + ':' + line : 'No source available for this frame'}">`;
    html += `<span class="dbg-stack-marker">${marker}</span>`;
    html += `<div class="dbg-stack-frame-body">`;
    html += `<div class="dbg-stack-row1"><span class="dbg-stack-method">${method}<span class="dbg-stack-parens">()</span></span><span class="dbg-stack-badge">${badge}</span></div>`;
    html += `<div class="dbg-stack-src">${_esc(fileName)}<span class="dbg-stack-lineno">:${line}</span></div>`;
    html += `</div></div>`;
  }
  container.innerHTML = html;
}

window._dbgSelectFrame = async function(frameIdx) {
  const frame = debugState.callStack[frameIdx];
  if (!frame || !frame.file) return;
  // Remember the selection (tied to this exact stop) so the Variables/Watch panels
  // follow the chosen frame until execution next moves.
  debugState.currentFrame = frameIdx;
  debugState._frameSelSig = _execSig();
  debugState.currentFile = frame.file;   // so exception markers match the opened file
  const line = (frame.statements && frame.statements[frame.pc]?.line) || frame.line;
  await navigateToFile(frame.file, line);
  // Re-render every panel so the Call Stack highlight moves and Variables/Watch show
  // the selected frame's scope consistently (no bespoke one-off rendering).
  updateDebugPanels();
};

// Character budget beyond which a plain string payload is collapsed to a one-line
// preview (native <details>) instead of being dumped in full.
const PAYLOAD_PREVIEW_MAX = 160;

/**
 * Render a console/org entry's payload the Chrome-DevTools way:
 *  - objects/arrays  → an expandable value tree (renderConsoleTreeValue) + copy;
 *  - big/multi-line strings (e.g. a 2 KB SOQL) → a ONE-LINE preview that expands
 *    to the full text on click (native <details>) + copy — so the user never has
 *    to scroll a wall of text;
 *  - short scalars   → inline.
 * `idx`+`store` ('console'|'org') let the copy button fetch the exact value.
 */
function renderEntryPayload(entry, idx, store) {
  const hasTree = entry.value !== null && entry.value !== undefined && typeof entry.value === 'object';
  const copyBtn = `<button class="dbg-tree-copy" data-store="${store}" data-idx="${idx}" title="Copy value">📋</button>`;
  if (hasTree) {
    // Show a short label (e.g. a logpoint's "logger =") in front of the tree so the
    // value has context; suppress long/multi-line prefixes so the tree stays clean.
    const msg = entry.message == null ? '' : String(entry.message);
    const label = (msg && msg.indexOf('\n') === -1 && msg.length <= 48)
      ? `<span class="dbg-tree-label">${_esc(msg)}</span> `
      : '';
    return copyBtn + label + `<div class="dbg-tree-root">${renderConsoleTreeValue(entry.value, 0)}</div>`;
  }
  const msg = typeof entry.message === 'string' ? entry.message : formatValue(entry.message);
  if (msg.length > PAYLOAD_PREVIEW_MAX || msg.indexOf('\n') >= 0) {
    const preview = _esc(msg.replace(/\s+/g, ' ').trim().slice(0, PAYLOAD_PREVIEW_MAX)) + (msg.length > PAYLOAD_PREVIEW_MAX ? ' …' : '');
    return copyBtn
      + `<details class="dbg-expand"><summary class="dbg-expand-sum">${preview}</summary>`
      + `<pre class="dbg-expand-full">${_esc(msg)}</pre></details>`;
  }
  return `<span class="dbg-console-msg">${_esc(msg)}</span>`;
}

/** Wire up Chrome-style nested-tree expand/collapse toggles inside a container. */
function _attachTreeToggles(container) {
  container.querySelectorAll('.cv-toggle').forEach(tog => {
    tog.onclick = () => {
      const node = tog.closest('.cv-node');
      if (!node) return;
      const kids = node.querySelector(':scope > .cv-children');
      const arrow = tog.querySelector('.cv-arrow');
      if (!kids) return;
      const collapsed = kids.classList.toggle('collapsed');
      if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
    };
  });
}

/** Wire up the 📋 copy buttons for entry payloads (objects → JSON, else text). */
function _attachPayloadCopy(container) {
  container.querySelectorAll('.dbg-tree-copy').forEach(btn => {
    btn.onclick = () => {
      const store = btn.dataset.store === 'org' ? debugState.orgLog : debugState.consoleLog;
      const e = store[parseInt(btn.dataset.idx)];
      if (!e) return;
      let text;
      if (e.value !== null && e.value !== undefined && typeof e.value === 'object') {
        try { text = JSON.stringify(e.value, null, 2); } catch (_) { text = String(e.value); }
      } else {
        text = typeof e.message === 'string' ? e.message : formatValue(e.message);
      }
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      });
    };
  });
}

function renderConsolePanel() {
  const container = _$('#dbg-console-body');
  if (!container) return;

  if (debugState.consoleLog.length === 0) {
    container.innerHTML = '<div class="dbg-empty">Console — your System.debug() output appears here as the code runs.</div>';
    return;
  }

  let html = '';
  for (let ei = 0; ei < debugState.consoleLog.length; ei++) {
    const entry = debugState.consoleLog[ei];
    const typeClass = `dbg-console-${entry.type}`;

    if (entry.type === 'result-json') {
      // Collapsible pretty-printed JSON tree with copy button.
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
      // Everything else (errors, System.debug prints, logpoints, evals): small
      // scalars inline, objects as a tree, big/multi-line strings collapsed.
      html += `<div class="dbg-console-entry ${typeClass}">`;
      if (entry.line) html += `<span class="dbg-console-line">L${entry.line}</span>`;
      html += renderEntryPayload(entry, ei, 'console');
      html += `</div>`;
    }
  }
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;

  // result-json expand/collapse
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

  _attachTreeToggles(container);
  _attachPayloadCopy(container);
}

/**
 * Salesforce debug logs render nested objects/collections as heap addresses
 * (e.g. "0x638da0ab", sometimes stored as "→ 0x638da0ab"). When one couldn't be
 * resolved back to real contents — the log didn't capture that heap object — we
 * must show an HONEST note instead of a cryptic hex, and never a fabricated
 * value. Returns a friendly label for a bare heap-address string, else null.
 */
function _heapRefLabel(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(?:→\s*)?(0x[0-9a-fA-F]{3,})$/);
  return m ? `‹unresolved reference ${m[1]} — the object's contents were not captured in the org log›` : null;
}

/**
 * Render a plain-JS value as an interactive Chrome-DevTools-style tree.
 * Primitives render inline (colored); objects/arrays render as expandable nodes
 * with a disclosure arrow. Top-level nodes start expanded; nested ones collapsed.
 * Large collections are capped with a "… N more" marker so huge values stay fast.
 */
function renderConsoleTreeValue(v, depth, opts) {
  depth = depth || 0;
  // opts (hover tree only): { editable:true, path:[...] } → tag primitive leaves so a
  // double-click can edit them and write the change back into the LIVE engine object.
  // Absent/false → byte-for-byte the original read-only markup (console + tests rely on it).
  const editable = !!(opts && opts.editable);
  const watch = !!(opts && opts.watch);
  const path = (opts && opts.path) || [];
  // 📌 pin affordance (hover-tree watch mode only). Emitted ONLY when opts.watch is
  // set, so the console/test default markup stays byte-identical. Live/active state
  // is painted by _attachHoverPins after render.
  const pinFor = (p) => watch ? `<span class="cv-pin" data-wp="${_esc(JSON.stringify(p))}">📌</span>` : '';
  const leaf = (cls, inner, etype) => {
    const core = editable
      ? `<span class="${cls} cv-editable" data-ep="${_esc(JSON.stringify(path))}" data-et="${etype}" title="Double-click to edit (debugger override)">${inner}</span>`
      : `<span class="${cls}">${inner}</span>`;
    return core + pinFor(path);
  };
  if (v === null) return leaf('cv-null', 'null', 'null');
  if (v === undefined) return '<span class="cv-undef">undefined</span>';
  const t = typeof v;
  if (t === 'string') {
    const ref = _heapRefLabel(v);
    if (ref) return `<span class="cv-ref" title="Salesforce heap address from the debug log. The object's real contents weren't captured, so there is nothing to expand — shown honestly rather than as a fabricated value.">${_esc(ref)}</span>`;
    return leaf('cv-str', `"${_esc(v)}"`, 'string');
  }
  if (t === 'number') return leaf('cv-num', _esc(String(v)), 'number');
  if (t === 'boolean') return leaf('cv-bool', String(v), 'boolean');
  if (t !== 'object') return `<span class="cv-str">${_esc(String(v))}</span>`;

  const isArr = Array.isArray(v);
  const keys = isArr ? null : Object.keys(v);
  if (isArr && v.length === 0) return '<span class="cv-empty">[]</span>' + pinFor(path);
  if (!isArr && keys.length === 0) return '<span class="cv-empty">{}</span>' + pinFor(path);

  const preview = isArr
    ? `Array(${v.length})`
    : `{${keys.slice(0, 5).map(_esc).join(', ')}${keys.length > 5 ? ', …' : ''}}`;

  const childOpts = (key) => (editable || watch) ? { editable, watch, path: path.concat(key) } : undefined;
  const open = depth === 0;
  let kids = '';
  if (isArr) {
    const cap = Math.min(v.length, 1000);
    for (let i = 0; i < cap; i++) {
      kids += `<div class="cv-prop"><span class="cv-key">${i}</span>: ${renderConsoleTreeValue(v[i], depth + 1, childOpts(i))}</div>`;
    }
    if (v.length > cap) kids += `<div class="cv-prop cv-more">… ${v.length - cap} more</div>`;
  } else {
    for (const k of keys) {
      kids += `<div class="cv-prop"><span class="cv-key">${_esc(k)}</span>: ${renderConsoleTreeValue(v[k], depth + 1, childOpts(k))}</div>`;
    }
  }

  return `<div class="cv-node">`
    + `<span class="cv-toggle"><span class="cv-arrow">${open ? '▼' : '▶'}</span>`
    + `<span class="cv-preview">${_esc(preview)}</span></span>`
    + pinFor(path)
    + `<div class="cv-children${open ? '' : ' collapsed'}">${kids}</div>`
    + `</div>`;
}

/* ================================================================
   EDITABLE HOVER VALUES (Chrome-style "edit value" while paused)
   ----------------------------------------------------------------
   Double-clicking a primitive leaf in the floating hover tree lets the user
   override that value in the LIVE engine object graph, so the rest of the run
   sees the new value (exactly like editing a variable in Chrome DevTools). It is
   an in-memory DEBUGGER OVERRIDE only — the connected org is never modified, and
   we say so in a Console note. It only writes through the engine's own real
   containers (ApexObject.setField / ApexMap.put / List index), so it can never
   fabricate a field or silently change a value's type: number stays number,
   boolean stays boolean, string stays string; a currently-null leaf infers its
   type from what the user types.
   ================================================================ */

// Strip the top-level engine-internal (__) keys, matching the read-only hover path,
// so overrides render against the same shape the user sees.
function _cleanHoverValue(value) {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return value;
  const o = {};
  for (const k of Object.keys(value).filter(k => !k.startsWith('__'))) o[k] = value[k];
  return o;
}

// Find the live ApexMap entry whose display key (built exactly like engineValToPlain)
// equals seg, so we edit the SAME entry the user is looking at and keep key identity.
function _hoverMapEntry(map, seg, E) {
  for (const e of map.m.values()) {
    const sk = (typeof e.k === 'string') ? e.k : (E && E.toApexString ? E.toApexString(e.k) : String(e.k));
    if (sk === String(seg)) return e;
  }
  return null;
}

// Descend one level into a LIVE engine container by the display key/index.
function _hoverChildVal(parent, seg, E) {
  if (parent == null) return undefined;
  if (Array.isArray(parent)) return parent[Number(seg)];
  if (E && parent instanceof E.ApexMap) { const e = _hoverMapEntry(parent, seg, E); return e ? e.v : undefined; }
  if (E && parent instanceof E.ApexSet) return parent.items()[Number(seg)];
  if (E && parent instanceof E.ApexObject) return parent.getField(seg);
  if (typeof parent === 'object') return parent[seg];
  return undefined;
}

// Walk root along path[0..n-2]; return { parent, key } addressing the leaf path[n-1].
function _hoverResolveParent(root, path, E) {
  if (!Array.isArray(path) || path.length === 0) return null;
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    cur = _hoverChildVal(cur, path[i], E);
    if (cur == null) return null;
  }
  return { parent: cur, key: path[path.length - 1] };
}

// Set a leaf on a LIVE engine container using its native setter. Returns true on
// success. Never creates a new field/key — only overrides an existing one.
function _hoverSetLeaf(parent, seg, value, E) {
  if (parent == null) return false;
  if (Array.isArray(parent)) {
    const i = Number(seg);
    if (Number.isInteger(i) && i >= 0 && i < parent.length) { parent[i] = value; return true; }
    return false;
  }
  if (E && parent instanceof E.ApexMap) {
    const e = _hoverMapEntry(parent, seg, E);
    if (e) { parent.put(e.k, value); return true; }
    return false;
  }
  if (E && parent instanceof E.ApexObject) {
    if (parent.hasField && parent.hasField(seg)) { parent.setField(seg, value); return true; }
    if (parent.getField && parent.getField(seg) !== undefined) { parent.setField(seg, value); return true; }
    return false;
  }
  if (E && parent instanceof E.ApexSet) return false; // set elements aren't addressable to mutate
  if (typeof parent === 'object') {
    if (Object.prototype.hasOwnProperty.call(parent, seg)) { parent[seg] = value; return true; }
    return false;
  }
  return false;
}

/* ================================================================
   HOVER → WATCH PINNING (follow a live value BY IDENTITY)
   ----------------------------------------------------------------
   Clicking the 📌 on a node/leaf in the hover tree pins that exact live engine
   object (or the object owning a pinned field) so the Watch tab and Data Flow
   follow it by reference — even when it is buried inside a huge collection and
   its position later changes. We resolve the SAME live ref the edit-in-place path
   uses (sandbox-eval the root expression, then descend by path), so the observer
   sees the very object the user pointed at.
   ================================================================ */

// A value we can follow by identity: an engine object/collection (not a primitive).
function _isTrackable(v, E) {
  return !!(v && typeof v === 'object' && (Array.isArray(v)
    || (E && (v instanceof E.ApexObject || v instanceof E.ApexMap || v instanceof E.ApexSet))));
}

// Resolve { target, parent, key } for a hover path against a live root. path=[]
// addresses the root itself (no parent).
function _resolveWatchTarget(root, path, E) {
  if (!Array.isArray(path) || path.length === 0) return { target: root, parent: null, key: null };
  const pr = _hoverResolveParent(root, path, E);
  if (!pr) return { target: undefined, parent: undefined, key: undefined };
  return { target: _hoverChildVal(pr.parent, pr.key, E), parent: pr.parent, key: pr.key };
}

// Toggle a watch pin for the node at `path` under the live `root`. Object nodes are
// pinned by identity; primitive leaves pin the OWNING object with a field focus.
function _toggleWatchPin(root, path, rootPath, E) {
  const { target, parent, key } = _resolveWatchTarget(root, path, E);
  const label = rootPath + (Array.isArray(path) && path.length ? _pathToText(path) : '');
  if (_isTrackable(target, E)) {
    if (watchIsTracked(target)) {
      debugState.watchPins.filter(p => p.watchId === target.__watchId && p.kind === 'object')
        .forEach(p => watchUnpin(p.id));
      window.showToast?.(`Unpinned ${label}`);
    } else {
      // Full path to the object itself — used to re-bind by identity on a new run.
      const bindExpr = rootPath + (Array.isArray(path) && path.length ? _pathToText(path) : '');
      const pin = watchAddPin(target, { kind: 'object', label, typeName: _watchTypeName(target), path, bindExpr });
      if (pin) { pin._bindFrame = _watchTopFrame(); window.showToast?.(`👁 Watching ${label}`); switchToDebugTab('dbg-watch'); }
    }
  } else {
    // Primitive leaf → follow the OWNING object, focused on this field.
    if (!(E && parent instanceof E.ApexObject)) {
      window.showToast?.('Pin an object, or a field directly on an object, to watch it.');
      return;
    }
    const existing = debugState.watchPins.find(p => p.kind === 'field' && (p.field || null) === key
      && (debugState.trackedObjects.get(p.watchId) || {}).obj === parent);
    if (existing) { watchUnpin(existing.id); window.showToast?.(`Unpinned ${label}`); return; }
    // Re-bind expression targets the PARENT object; the field is tracked separately.
    const parentPath = Array.isArray(path) ? path.slice(0, -1) : [];
    const bindExpr = rootPath + (parentPath.length ? _pathToText(parentPath) : '');
    const pin = watchAddPin(parent, { kind: 'field', field: key, label, typeName: _watchTypeName(parent), path, bindExpr });
    if (pin) { pin._bindFrame = _watchTopFrame(); window.showToast?.(`👁 Watching ${label}`); switchToDebugTab('dbg-watch'); }
  }
  try { renderWatchPanel(); } catch (_) {}
  try { renderDataFlowPanel(); } catch (_) {}
}

// Wire the 📌 pins in a freshly-rendered hover body. One async root resolve, then
// cheap in-memory descents for each pin's live/active state and click handling.
async function _attachHoverPins(panel, body, rootPath) {
  const E = (typeof window !== 'undefined') ? window.ApexEngine : null;
  const eng = debugState.engineSession;
  if (!eng) return;
  const frame = eng.topFrame && eng.topFrame();
  const resolveRoot = async () => {
    try { return await eng.evalExpressionSandboxed(rootPath, frame, false); } catch (_) { return undefined; }
  };
  let root = await resolveRoot();
  const pins = Array.from(body.querySelectorAll('[data-wp]'));
  const paint = () => {
    for (const icon of pins) {
      let p; try { p = JSON.parse(icon.getAttribute('data-wp')); } catch (_) { continue; }
      const { target, parent, key } = _resolveWatchTarget(root, p, E);
      let on = false;
      if (_isTrackable(target, E)) on = watchIsTracked(target);
      else on = debugState.watchPins.some(pin => pin.kind === 'field' && (pin.field || null) === key
        && (debugState.trackedObjects.get(pin.watchId) || {}).obj === parent);
      icon.classList.toggle('active', on);
      icon.textContent = on ? '📍' : '📌';
      icon.title = on ? 'Stop watching this value' : 'Watch this value (live · history · data flow)';
    }
  };
  paint();
  for (const icon of pins) {
    icon.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      let p; try { p = JSON.parse(icon.getAttribute('data-wp')); } catch (_) { return; }
      root = await resolveRoot();               // refresh in case state advanced
      _toggleWatchPin(root, p, rootPath, E);
      paint();
    });
  }
}

// Programmatically activate a bottom debug tab (used when pinning a watch).
function switchToDebugTab(target) {
  const tab = document.querySelector(`#debug-panel .dbg-panel-tab[data-tab="${target}"]`);
  if (!tab) return;
  document.querySelectorAll('#debug-panel .dbg-panel-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  document.querySelectorAll('#debug-panel .dbg-tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(target)?.classList.add('active');
}

function _stripQuotes(s) {
  const str = String(s);
  if (str.length >= 2) {
    const a = str[0], b = str[str.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return str.slice(1, -1);
  }
  return str;
}

// Parse edited text into a JS value, PRESERVING the leaf's original Apex type so an
// override can't accidentally change a field's type. A currently-null leaf has no
// known type, so its type is inferred from the input syntax.
function _parseEditedValue(text, origType) {
  const raw = String(text);
  const trimmed = raw.trim();
  if (origType === 'boolean') {
    if (/^true$/i.test(trimmed)) return { ok: true, value: true };
    if (/^false$/i.test(trimmed)) return { ok: true, value: false };
    return { ok: false, error: 'Enter true or false' };
  }
  if (origType === 'number') {
    if (trimmed === '') return { ok: false, error: 'Enter a number' };
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { ok: false, error: 'Not a valid number' };
    return { ok: true, value: n };
  }
  if (origType === 'null') {
    if (trimmed === '' || /^null$/i.test(trimmed)) return { ok: true, value: null };
    if (/^true$/i.test(trimmed)) return { ok: true, value: true };
    if (/^false$/i.test(trimmed)) return { ok: true, value: false };
    if (Number.isFinite(Number(trimmed))) return { ok: true, value: Number(trimmed) };
    return { ok: true, value: _stripQuotes(raw) };
  }
  // string (default): stays a string; `null` clears it.
  if (/^null$/i.test(trimmed)) return { ok: true, value: null };
  return { ok: true, value: _stripQuotes(raw) };
}

function _pathToText(path) {
  return (path || []).map(seg => (typeof seg === 'number' ? `[${seg}]` : `.${seg}`)).join('');
}
function _fmtEdit(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v}'`;
  return String(v);
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

  // Gather + sort: group by file, lines ascending within each file, files A→Z.
  const groups = [];
  let count = 0;
  for (const [filePath, bpMap] of debugState.breakpoints) {
    const lines = [...bpMap.keys()].sort((a, b) => a - b);
    if (!lines.length) continue;
    groups.push([filePath, lines, bpMap]);
    count += lines.length;
  }
  groups.sort((a, b) => (a[0].split(/[/\\]/).pop() || '').localeCompare(b[0].split(/[/\\]/).pop() || ''));

  // Reflect the total on the tab so the user can always see how many are set.
  const tabBtn = document.querySelector('.dbg-panel-tab[data-tab="dbg-breakpoints"]');
  if (tabBtn) tabBtn.textContent = count ? `Breakpoints (${count})` : 'Breakpoints';

  if (!count) {
    container.innerHTML = '<div class="dbg-empty">No breakpoints set. Click in the gutter margin (or right-click a line) to add a breakpoint, conditional breakpoint, or logpoint.</div>';
    return;
  }

  let html = '';
  for (const [filePath, lines, bpMap] of groups) {
    const filename = filePath.split(/[/\\]/).pop();
    html += `<div class="dbg-bp-group">`;
    html += `<div class="dbg-bp-group-head" title="${_esc(filePath)}">`
      + `<span class="dbg-bp-group-name">${_esc(filename)}</span>`
      + `<span class="dbg-bp-group-count">${lines.length}</span>`
      + `<button class="dbg-bp-group-clear" onclick="event.stopPropagation(); window._dbgClearFileBreakpoints('${_esc(filePath)}')" title="Remove all breakpoints in this file">Clear</button>`
      + `</div>`;
    for (const line of lines) {
      const bpInfo = bpMap.get(line);
      const isLog = !!bpInfo.logMessage;
      const isCond = !!bpInfo.condition;
      const enabled = bpInfo.enabled !== false;
      const dot = isLog ? '◉' : isCond ? '◆' : '●';
      const kindClass = (isLog ? ' logpoint' : isCond ? ' conditional' : '') + (enabled ? '' : ' disabled');
      const kindTitle = isLog ? 'Logpoint' : isCond ? 'Conditional breakpoint' : 'Breakpoint';
      html += `<div class="dbg-bp-entry${kindClass}" onclick="window._dbgGoToBreakpoint('${_esc(filePath)}', ${line})" title="Go to ${_esc(filename)}:${line}">`;
      html += `<input type="checkbox" class="dbg-bp-check" ${enabled ? 'checked' : ''} onclick="event.stopPropagation(); window._dbgToggleBreakpointEnabled('${_esc(filePath)}', ${line}, this.checked)" title="${enabled ? 'Disable' : 'Enable'} this breakpoint" />`;
      html += `<span class="dbg-bp-dot" title="${kindTitle}${enabled ? '' : ' (disabled)'}">${dot}</span>`;
      html += `<span class="dbg-bp-line">:${line}</span>`;
      if (bpInfo.snippet) html += `<span class="dbg-bp-snippet" title="${_esc(bpInfo.snippet)}">${_esc(bpInfo.snippet)}</span>`;
      if (isLog) html += `<span class="dbg-bp-cond">“${_esc(bpInfo.logMessage)}”${isCond ? ` when ${_esc(bpInfo.condition)}` : ''}</span>`;
      else if (isCond) html += `<span class="dbg-bp-cond">[${_esc(bpInfo.condition)}]</span>`;
      html += `<button class="dbg-bp-edit" onclick="event.stopPropagation(); window._dbgEditBreakpoint('${_esc(filePath)}', ${line})" title="Edit">✎</button>`;
      html += `<button class="dbg-bp-remove" onclick="event.stopPropagation(); window._dbgRemoveBreakpoint('${_esc(filePath)}', ${line})" title="Remove">✕</button>`;
      html += `</div>`;
    }
    html += `</div>`;
  }
  html += `<button class="dbg-bp-clear-all" onclick="window._dbgClearAllBreakpoints()">Remove all (${count})</button>`;
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
  // A logpoint edits its message; anything else edits its condition. Both use the
  // in-app modal (window.prompt is disabled in Electron).
  if (current?.logMessage) editLogpoint(filePath, line);
  else editConditionalBreakpoint(filePath, line);
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
  saveBreakpoints();
};

window._dbgClearFileBreakpoints = function(filePath) {
  const bps = debugState.breakpoints.get(filePath);
  if (!bps) return;
  // Remove line-by-line through the canonical path so gutter glyphs are cleared
  // exactly like the per-breakpoint ✕ button (which already works correctly).
  for (const line of [...bps.keys()]) toggleBreakpoint(filePath, line);
  updateBreakpointsPanel();
  saveBreakpoints();
};

/** Enable/disable a single breakpoint (checkbox). Keeps it stored + visible so
 *  the user can re-enable it later; a disabled breakpoint never fires. */
window._dbgToggleBreakpointEnabled = function(filePath, line, enabled) {
  const bp = debugState.breakpoints.get(filePath)?.get(line);
  if (!bp) return;
  bp.enabled = !!enabled;
  renderBreakpointDecorations(filePath);
  updateBreakpointsPanel();
  saveBreakpoints();
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
    const className = filePath.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
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

  // Render the request history so the user can re-pick a previous payload
  // instead of re-pasting it each time.
  renderRequestHistory(filePath, methodName);
}

const DBG_REQ_HISTORY_KEY = 'apexstudio.debugRequestHistory';

function loadRequestHistory() {
  try {
    const raw = localStorage.getItem(DBG_REQ_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function saveRequestHistoryEntry(filePath, methodName, jsonText) {
  const text = (jsonText || '').trim();
  if (!text) return;
  // Skip the default placeholder / empty payloads (strip // comments + whitespace).
  const stripped = text.replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
  if (!stripped || stripped === '{}') return;
  const className = (filePath || '').split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
  const hist = loadRequestHistory().filter(e => !(e.json === text && e.method === methodName && e.className === className));
  hist.unshift({ json: text, method: methodName, className, filePath, ts: Date.now() });
  try { localStorage.setItem(DBG_REQ_HISTORY_KEY, JSON.stringify(hist.slice(0, 25))); } catch (_) {}
}

function renderRequestHistory(filePath, methodName) {
  const wrap = _$('#dbg-request-history-wrap');
  const list = _$('#dbg-request-history');
  if (!wrap || !list) return;
  const all = loadRequestHistory();
  // Prefer entries for THIS method first, then everything else.
  const forMethod = all.filter(e => e.method === methodName);
  const others = all.filter(e => e.method !== methodName);
  const ordered = [...forMethod, ...others];
  if (!ordered.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  list.innerHTML = '';
  ordered.forEach((entry, idx) => {
    const flat = entry.json.replace(/\s+/g, ' ').trim();
    const preview = flat.length > 90 ? flat.slice(0, 87) + '…' : flat;
    const when = timeAgo(entry.ts);
    const row = document.createElement('div');
    row.className = 'dbg-history-item';
    row.innerHTML =
      `<div class="dbg-history-main">` +
      `<span class="dbg-history-method">${_esc(entry.className)}.${_esc(entry.method)}</span>` +
      `<span class="dbg-history-when">${_esc(when)}</span>` +
      `</div>` +
      `<div class="dbg-history-preview">${_esc(preview)}</div>` +
      `<div class="dbg-history-actions">` +
      `<button class="dbg-history-load" title="Load into editor">Use</button>` +
      `<button class="dbg-history-copy" title="Copy JSON">Copy</button>` +
      `</div>`;
    row.querySelector('.dbg-history-load')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (debugState.miniEditorInstance) debugState.miniEditorInstance.setValue(entry.json);
    });
    row.querySelector('.dbg-history-copy')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      try { navigator.clipboard.writeText(entry.json); window.showToast?.('Request copied', 'success'); } catch (_) {}
    });
    // Clicking the row body also loads it.
    row.querySelector('.dbg-history-preview')?.addEventListener('click', () => {
      if (debugState.miniEditorInstance) debugState.miniEditorInstance.setValue(entry.json);
    });
    list.appendChild(row);
  });
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return `${d}d ago`;
}

function clearRequestHistory() {
  try { localStorage.removeItem(DBG_REQ_HISTORY_KEY); } catch (_) {}
  const wrap = _$('#dbg-request-history-wrap');
  if (wrap) wrap.classList.add('hidden');
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
  saveRequestHistoryEntry(filePath, methodName, jsonText);
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

  const CMD_ID = 'apexstudio.debugMethod';

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
          const fileName = uri.path.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
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
 * Render an object/array as a COMPACT first-level JSON view: primitive fields are
 * shown as-is, but nested objects/arrays collapse to a `{ N fields }` / `[ N items ]`
 * summary (Chrome-style) instead of the full deep dump. Used by the static markdown
 * hover (free-run / split editor) so a big object never floods the tooltip.
 */
function _compactFirstLevelJson(val) {
  const fmtPrim = (v) => {
    const ref = _heapRefLabel(v); if (ref) return ref;
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
  };
  const summary = (v) => {
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) return `[ ${v.length} item${v.length === 1 ? '' : 's'} ]`;
      const n = Object.keys(v).filter(k => !k.startsWith('__')).length;
      return `{ ${n} field${n === 1 ? '' : 's'} }`;
    }
    return fmtPrim(v);
  };
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    const cap = Math.min(val.length, 50);
    const lines = [];
    for (let i = 0; i < cap; i++) lines.push('  ' + summary(val[i]) + (i < cap - 1 || val.length > cap ? ',' : ''));
    if (val.length > cap) lines.push(`  … ${val.length - cap} more`);
    return '[\n' + lines.join('\n') + '\n]';
  }
  const keys = Object.keys(val).filter(k => !k.startsWith('__'));
  if (keys.length === 0) return '{}';
  const cap = Math.min(keys.length, 60);
  const lines = [];
  for (let i = 0; i < cap; i++) {
    const k = keys[i];
    lines.push(`  ${JSON.stringify(k)}: ${summary(val[k])}${i < cap - 1 || keys.length > cap ? ',' : ''}`);
  }
  if (keys.length > cap) lines.push(`  … ${keys.length - cap} more`);
  return '{\n' + lines.join('\n') + '\n}';
}

/* ---- Interactive expandable hover (Chrome DevTools style) -------------------
 * Monaco's built-in hover renders static markdown, so it can't host click-to-
 * expand. For object/array values while paused or in replay we instead show our
 * OWN floating panel (a body-level <div>, positioned at the token): the top level
 * is expanded, nested nodes are collapsed and expand on click, and the whole thing
 * is copyable — exactly like Chrome. It stays open while the pointer is inside it.
 * We deliberately AVOID Monaco content widgets here: their layout lifecycle can
 * throw during a hover computation, which would break ALL hovers. A plain fixed-
 * position div driven by editor coordinates is bullet-proof by comparison. */
let _dbgHoverTreeEl = null;      // the floating panel element (in document.body)
let _dbgHoverTreeRange = null;   // the token range it's anchored to
let _dbgHoverTreeKey = null;     // path currently shown (so re-hover keeps expand state)
let _dbgHoverTreeHideTimer = null;
let _dbgHoverTreeWired = false;

function _scheduleHoverTreeHide() {
  if (_dbgHoverEditing) return;   // never dismiss the panel mid-edit
  if (_dbgHoverTreeHideTimer) clearTimeout(_dbgHoverTreeHideTimer);
  _dbgHoverTreeHideTimer = setTimeout(_hideHoverTree, 240);
}
function _cancelHoverTreeHide() {
  if (_dbgHoverTreeHideTimer) { clearTimeout(_dbgHoverTreeHideTimer); _dbgHoverTreeHideTimer = null; }
}
function _hideHoverTree() {
  if (_dbgHoverEditing) return;   // keep open while an inline editor is active
  _cancelHoverTreeHide();
  if (_dbgHoverTreeEl) _dbgHoverTreeEl.style.display = 'none';
  _dbgHoverTreeRange = null;
  _dbgHoverTreeKey = null;
}

function _ensureHoverTreeEl() {
  if (_dbgHoverTreeEl) return _dbgHoverTreeEl;
  const el = document.createElement('div');
  el.className = 'dbg-hover-tree';
  el.style.display = 'none';
  // Keep it open while the pointer is inside so the user can expand nodes / copy.
  el.addEventListener('mouseenter', _cancelHoverTreeHide);
  el.addEventListener('mouseleave', _scheduleHoverTreeHide);
  document.body.appendChild(el);
  _dbgHoverTreeEl = el;
  return el;
}

function _wireHoverTreeDismiss(editor) {
  if (_dbgHoverTreeWired) return;
  _dbgHoverTreeWired = true;
  // Hide when the pointer leaves the anchored token (unless it moved into the panel,
  // whose mouseenter cancels the pending hide). Scroll invalidates the anchor.
  editor.onMouseMove((e) => {
    if (!_dbgHoverTreeRange || !_dbgHoverTreeEl || _dbgHoverTreeEl.style.display === 'none') return;
    const pos = e.target && e.target.position;
    if (pos && _dbgHoverTreeRange.containsPosition(pos)) _cancelHoverTreeHide();
    else _scheduleHoverTreeHide();
  });
  editor.onMouseLeave(() => _scheduleHoverTreeHide());
  editor.onDidScrollChange(() => _hideHoverTree());
}

function _showHoverTree(editor, range, path, typeName, value) {
  const key = `${range.startLineNumber}:${range.startColumn}:${path}`;
  // Same token already shown → keep it (preserve the user's expand state).
  if (_dbgHoverTreeKey === key && _dbgHoverTreeEl && _dbgHoverTreeEl.style.display === 'block') {
    _cancelHoverTreeHide();
    return;
  }
  const el = _ensureHoverTreeEl();
  _wireHoverTreeDismiss(editor);
  _dbgHoverTreeRange = range;
  _dbgHoverTreeKey = key;
  // Strip engine-internal (__) keys the same way the markdown path does.
  const clean = _cleanHoverValue(value);
  // Values are editable only while genuinely paused in a live engine session at the
  // live edge (not while viewing recorded history, and not during a free run) — an
  // override must land in the state the code is about to use next. Watch-pinning is
  // available under the same condition, because it needs a live object reference.
  const editable = !!(debugState.engineMode && debugState.engineSession && debugState.paused
    && !debugState.engineViewingHistory);
  const watchable = editable;
  el.innerHTML =
    `<div class="dbg-hover-tree-head">` +
      `<span class="dbg-hover-tree-path">${_esc(path)}</span>` +
      `<span class="dbg-hover-tree-type">${_esc(typeName || '')}</span>` +
      (editable ? `<span class="dbg-hover-tree-edithint" title="Double-click any value to override it in the live object (in-memory only; the org is never modified). Click 📌 to watch a value across the run.">✎ editable · 📌 watch</span>` : '') +
      `<button class="dbg-hover-tree-copy" title="Copy full JSON">📋</button>` +
    `</div>` +
    `<div class="dbg-hover-tree-body"></div>`;
  _renderHoverBodyInto(el, clean, editable, path, watchable);
  const copyBtn = el.querySelector('.dbg-hover-tree-copy');
  if (copyBtn) copyBtn.onclick = () => {
    let text; try { text = JSON.stringify(clean, null, 2); } catch { text = String(clean); }
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
    }).catch(() => {});
  };
  // Anchor to the token: editor-content coords → viewport coords for position:fixed.
  el.style.display = 'block';
  el.style.visibility = 'hidden';
  try {
    const vp = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: range.startColumn });
    const dom = editor.getDomNode();
    if (vp && dom) {
      const rect = dom.getBoundingClientRect();
      let left = rect.left + vp.left;
      let top = rect.top + vp.top + vp.height + 2;
      // Clamp inside the viewport; flip above the line if it would overflow the bottom.
      const pr = el.getBoundingClientRect();
      if (left + pr.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pr.width - 8);
      if (top + pr.height > window.innerHeight - 8) top = Math.max(8, rect.top + vp.top - pr.height - 2);
      el.style.left = Math.round(left) + 'px';
      el.style.top = Math.round(top) + 'px';
    }
  } catch (_) { /* positioning is best-effort; the panel still shows top-left-anchored */ }
  el.style.visibility = 'visible';
  _cancelHoverTreeHide();
}

// Render the hover tree body + wire toggles and (when editable) the double-click
// editors. Shared by the initial show and by the re-render after a committed edit,
// so an override immediately re-materialises the panel from fresh live values.
function _renderHoverBodyInto(el, clean, editable, rootPath, watchable) {
  const body = el.querySelector('.dbg-hover-tree-body');
  if (!body) return;
  const opts = (editable || watchable) ? { editable, watch: !!watchable, path: [] } : undefined;
  body.innerHTML = renderConsoleTreeValue(clean, 0, opts);
  _attachTreeToggles(body);
  if (editable) _attachHoverEditors(el, body, rootPath);
  if (watchable) _attachHoverPins(el, body, rootPath);
}

// Wire double-click-to-edit on every tagged primitive leaf in the hover tree.
function _attachHoverEditors(panel, body, rootPath) {
  body.querySelectorAll('[data-ep]').forEach(span => {
    span.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (span._dbgEditing) return;
      let path; try { path = JSON.parse(span.getAttribute('data-ep')); } catch { return; }
      const etype = span.getAttribute('data-et') || 'string';
      _beginHoverEdit(panel, span, path, etype, rootPath);
    });
  });
}

// True while an inline edit input is focused, so the dismiss timers keep the panel open.
let _dbgHoverEditing = false;

function _beginHoverEdit(panel, span, path, origType, rootPath) {
  _cancelHoverTreeHide();
  _dbgHoverEditing = true;
  span._dbgEditing = true;
  const originalHTML = span.innerHTML;
  const originalCls = span.className;
  // Prefill with the raw value (strings without their surrounding quotes).
  let prefill = span.textContent;
  if (origType === 'string') prefill = _stripQuotes(prefill);
  else if (origType === 'null') prefill = '';
  const input = document.createElement('input');
  input.className = 'cv-edit-input';
  input.type = 'text';
  input.spellcheck = false;
  input.value = prefill;
  span.classList.remove('cv-editable');
  span.textContent = '';
  span.appendChild(input);
  input.focus();
  input.select();

  let settled = false;
  const restore = () => { span.className = originalCls; span.innerHTML = originalHTML; };
  const finish = () => { _dbgHoverEditing = false; span._dbgEditing = false; };
  const cancel = () => { if (settled) return; settled = true; finish(); restore(); };
  const commit = async () => {
    if (settled) return; settled = true; finish();
    const parsed = _parseEditedValue(input.value, origType);
    if (!parsed.ok) { window.showToast?.(parsed.error || 'Invalid value'); restore(); return; }
    const ok = await _applyHoverEdit(panel, rootPath, path, parsed.value);
    if (!ok) restore(); // failure already toasted; success re-renders the whole body
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => { if (!settled) commit(); });
  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('dblclick', e => e.stopPropagation());
}

// Commit an override into the LIVE engine object graph, then reflect it everywhere.
async function _applyHoverEdit(panel, rootPath, path, value) {
  const E = (typeof window !== 'undefined') ? window.ApexEngine : null;
  const eng = debugState.engineSession;
  if (!eng || !debugState.paused || debugState.engineViewingHistory) {
    window.showToast?.('Values can only be edited while paused in the live engine.');
    return false;
  }
  const frame = eng.topFrame && eng.topFrame();
  if (!frame) { window.showToast?.('No active engine frame to edit.'); return false; }
  if (!Array.isArray(path) || path.length === 0) {
    window.showToast?.('Edit a field inside the object.');
    return false;
  }
  let root;
  try { root = await eng.evalExpressionSandboxed(rootPath, frame, false); }
  catch (_) { root = undefined; }
  if (root == null) {
    window.showToast?.(`Can only edit values in the current frame — “${rootPath}” isn’t resolvable here.`);
    return false;
  }
  const target = _hoverResolveParent(root, path, E);
  if (!target || target.parent == null) {
    window.showToast?.('Could not locate that value in the live object.');
    return false;
  }
  let ok = false;
  try { ok = _hoverSetLeaf(target.parent, target.key, value, E); }
  catch (_) { ok = false; }
  if (!ok) { window.showToast?.('That value can’t be edited (unsupported container, e.g. a Set).'); return false; }

  // Reflect into the mirrored stack + all panels, note it honestly, and re-render the
  // hover body from the fresh live value so the change shows and further edits work.
  try { mirrorEngineStack(eng.getCallStack()); } catch (_) {}
  try { updateDebugPanels(); } catch (_) {}
  addConsoleEntry('info', `✏ Debugger override: set ${rootPath}${_pathToText(path)} = ${_fmtEdit(value)} (in-memory only; the org is not modified).`);
  window.showToast?.(`Set ${_pathToText(path).replace(/^\./, '') || rootPath} = ${_fmtEdit(value)}`);
  try {
    const fresh = _cleanHoverValue(engineValToPlain(root));
    _renderHoverBodyInto(panel, fresh, true, rootPath, true);
  } catch (_) { /* re-render is best-effort; the edit itself already applied */ }
  return true;
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
      if (!debugState.active) return null;
      // While the engine is FREE-RUNNING (active but not paused) we still let the
      // user inspect values: snapshot the live engine stack so locals/fields
      // resolve to their CURRENT value. This is READ-ONLY — the interactive
      // org-eval / SOQL / engine-eval fallbacks below are gated to `!liveRun`, so
      // hovering can never perturb a run that's in progress.
      const liveRun = !debugState.paused;
      if (liveRun) {
        const eng = debugState.engineSession;
        if (!eng || typeof eng.getCallStack !== 'function') return null;
        try { mirrorEngineStack(eng.getCallStack()); } catch (_) { return null; }
      }

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

      // Do NOT scan right past the hovered word. The tooltip must describe exactly
      // the token under the cursor: hovering `request` shows the `request` object,
      // NOT `request.applyInclusionFilterPriLines`. The left-scan above still keeps
      // the receiver, so hovering the trailing `foo` in `request.foo` yields
      // `request.foo` — the dotted path ends at the hovered token, never beyond it.
      const exprEnd = wordEnd;

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
        const tag = opts.realOrg ? ' · _real org value_' : (opts.engine ? ' · _live engine_' : '');
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
          // Show only the FIRST LEVEL (nested objects/arrays collapse to a size
          // summary) so a big object never floods the tooltip. Heap-address leaves
          // still degrade to an honest note. The interactive expandable tree is
          // shown separately (custom widget) while paused/in replay.
          const compact = _compactFirstLevelJson(cleanValue);
          const typeLabel = Array.isArray(val) ? `List (${val.length} items)` : `Object (${Object.keys(cleanValue).length} fields)`;
          contents.push({ value: `\`${typeLabel}\`\n\n` + '```json\n' + compact + '\n```' + '\n\n_First level only — expand nested values in the Variables panel._' });
        } else {
          contents.push({ value: '```\n' + (_heapRefLabel(val) || String(val)) + '\n```' });
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
        // For object/array values during ANY active debug session — paused, replay,
        // OR while the engine is live-running — render the Chrome-style INTERACTIVE
        // expandable tree (first level open, nested collapsed, click to drill in,
        // copyable) as our own hover widget and suppress Monaco's static markdown
        // hover (return null) so there's exactly one tooltip. The tree is read-only
        // during a live run and becomes editable only when paused (gated inside
        // _showHoverTree). Primitives and the split-editor case fall through to the
        // compact markdown hover.
        if (typeof value === 'object' && (debugState.active || debugState.replayMode)) {
          const ed = window.state?.editor;
          if (ed && ed.getModel() === model) {
            try {
              const hdrPath = resolvedPath || fullPath;
              const typeName = getValueTypeName(value, lookupVarType(hdrPath));
              const range = (resolvedPath === word.word)
                ? wordRange
                : new monaco.Range(position.lineNumber, rangeStart, position.lineNumber, rangeEnd);
              _showHoverTree(ed, range, hdrPath, typeName, value);
              return null;
            } catch (_) {
              // The interactive panel must NEVER break hovering — fall back to the
              // compact markdown hover below if anything goes wrong.
            }
          }
        }
        return makeHover(resolvedPath || fullPath, value);
      }

      // During a live run we only surface already-resolved values (read-only) and
      // never fire the SOQL / org-eval / engine-eval round-trips below — those are
      // interactive and could disturb the interpreter mid-execution. Show a local
      // null if that's what we have; otherwise no hover until the user pauses.
      if (liveRun) {
        return value === null ? makeHover(resolvedPath || fullPath, null) : null;
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
            if (r.records.length) addConsoleEntry('result-json', JSON.stringify(preview, null, 2), null, preview);
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
              // Fix 3a: "Variable does not exist: X" where X is a local/field in the
              // current frame → X is a runtime object that can't be serialised into
              // anonymous Apex. Show the same friendly message as the unresolved path.
              const varM = r.error.match(/Variable does not exist: (\w+)/i);
              if (varM) {
                const badVar = varM[1];
                const frameScope = topFrame
                  ? { ...(topFrame.classFields || {}), ...topFrame.variables }
                  : {};
                if (badVar in frameScope) {
                  const friendly = `Can't evaluate: \`${badVar}\` is a runtime object built inside the method, and anonymous Apex can't call methods on it or rebuild it (private helpers/state aren't reachable). Turn on the ⚡ Live Org toggle to replay the whole method in the org, then hover the variable itself for its real value — or set a value in the Console (e.g. \`${badVar} = …\`).`;
                  addConsoleEntry('info', `${orgExpr} → (org eval) ${friendly}`);
                  return errHover(orgExpr, friendly);
                }
              }
              // Fix 3b: "Method does not exist or incorrect signature: …" for an
              // unqualified call (no dot before the method name in the hovered expr).
              // These are private/instance methods that anonymous Apex can't reach.
              const methM = r.error.match(/Method does not exist or incorrect signature:/i);
              if (methM) {
                const beforeParen = orgExpr.slice(0, orgExpr.indexOf('('));
                if (beforeParen && !beforeParen.includes('.')) {
                  const methName = beforeParen.trim();
                  const friendly = `Can't evaluate: \`${methName}()\` isn't visible to anonymous Apex (private/instance method). Step into it instead, or hover its arguments.`;
                  addConsoleEntry('info', `${orgExpr} → (org eval) ${friendly}`);
                  return errHover(orgExpr, friendly);
                }
              }
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

      // 3) Live-interpreter mode: resolve method calls / dotted expressions in the
      //    ENGINE first. It holds the real runtime object graph and now supports
      //    Type.newInstance(), getSObjectType(), etc., so values come from actual
      //    execution state rather than a separate org round-trip. Fall back to org
      //    eval only when the engine can't resolve the expression.
      if (debugState.engineMode && debugState.engineSession && !debugState.engineViewingHistory && (callExpr || fullPath.includes('.'))) {
        const engExpr = callExpr || fullPath;
        const cacheKey = engExpr + '\x00' + (debugState.currentLine || '');
        if (!debugState._hoverCache) debugState._hoverCache = new Map();
        if (debugState._hoverCache.has(cacheKey)) {
          const cached = debugState._hoverCache.get(cacheKey);
          if (cached !== undefined) return makeHover(engExpr, cached, { range: wordRange, engine: true });
          return orgEvalHover();
        }
        const eng = debugState.engineSession;
        const fr = eng.topFrame && eng.topFrame();
        if (fr) {
          // Pre-flight scope check: extract root identifiers (the first token of each
          // member chain) and verify they're in scope in the paused frame. This prevents
          // evaluating expressions like `request.cartId` when `request` is not defined
          // in the current frame, which would degrade out-of-scope vars to null and
          // potentially corrupt the session via pause-on-exception side effects.
          const BUILTIN_ID_RE = /^(System|Math|String|JSON|Database|Schema|Type|Date|Datetime|Integer|Long|Double|Decimal|Boolean|Id|List|Map|Set|SObject|Limits|UserInfo|Test|Trigger|URL|Blob|Exception|true|false|null|this|super)$/i;
          const roots = [];
          const rootRe = /(?<![.\w])([A-Za-z_]\w*)/g;
          let rm;
          while ((rm = rootRe.exec(engExpr)) !== null) roots.push(rm[1]);
          const scopeOk = roots.every(root => {
            if (BUILTIN_ID_RE.test(root)) return true;
            if (eng.registry && eng.registry.get(root)) return true;          // known class
            if (fr.env && fr.env.lookupEntry(root)) return true;              // local variable
            if (fr.thisRef && fr.thisRef.hasField && fr.thisRef.hasField(root)) return true; // instance field
            if (fr.classInfo) {
              if (fr.classInfo.staticEnv && fr.classInfo.staticEnv.has(root)) return true;  // static field
              if (fr.classInfo.findMethods && fr.classInfo.findMethods(root).length > 0) return true; // method
            }
            return false;
          });
          if (!scopeOk) {
            debugState._hoverCache.set(cacheKey, undefined);
            return orgEvalHover();
          }
          return Promise.resolve()
            .then(() => eng.evalExpressionSandboxed(engExpr, fr))
            .then((val) => {
              const plain = engineValToPlain(val);
              if (plain === undefined) {
                debugState._hoverCache.set(cacheKey, undefined);
                return orgEvalHover();
              }
              debugState._hoverCache.set(cacheKey, plain);
              return makeHover(engExpr, plain, { range: wordRange, engine: true });
            })
            .catch(() => { debugState._hoverCache.set(cacheKey, undefined); return orgEvalHover(); });
        }
      }

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
  const T = monaco.editor.MouseTargetType;

  editor.onMouseDown((e) => {
    const t = e.target?.type;
    // Accept the glyph margin AND the line-number gutter — the glyph strip is
    // only a few px wide, so many "nothing happened" right-clicks were actually
    // landing on the line numbers. Both now open the breakpoint menu.
    const inGlyph = t === T.GUTTER_GLYPH_MARGIN;
    const inLineNum = t === T.GUTTER_LINE_NUMBERS;
    if (!inGlyph && !inLineNum) return;
    const line = e.target.position?.lineNumber;
    if (!line) return;
    const model = editor.getModel();
    if (!model) return;
    const uri = model.uri;
    const filePath = uri.fsPath || uri.path;
    // Only allow breakpoints on .cls and .trigger files
    if (!filePath.endsWith('.cls') && !filePath.endsWith('.trigger')) return;

    if (e.event.rightButton) {
      // Right-click: Chrome-style menu — Breakpoint / Conditional / Logpoint.
      e.event.preventDefault();
      const be = e.event.browserEvent || e.event;
      const px = be.clientX != null ? be.clientX : (e.event.posx || 0);
      const py = be.clientY != null ? be.clientY : (e.event.posy || 0);
      showGutterBreakpointMenu(filePath, line, px, py);
    } else if (inGlyph) {
      // Left-click the glyph margin toggles a plain breakpoint. Left-clicking the
      // line number is left to Monaco (line selection).
      toggleBreakpoint(filePath, line);
    }
  });

  registerBreakpointEditorActions(editor);
}

/**
 * Register right-click editor-context-menu actions (Monaco's own menu, which
 * always works) so logpoints/conditional breakpoints are reachable even if the
 * thin gutter is awkward to hit. These act on the line under the cursor.
 */
function registerBreakpointEditorActions(editor) {
  if (editor.__ccBpActions) return;
  editor.__ccBpActions = true;
  const fileOf = () => {
    const m = editor.getModel();
    if (!m) return null;
    const fp = m.uri.fsPath || m.uri.path;
    return (fp.endsWith('.cls') || fp.endsWith('.trigger')) ? fp : null;
  };
  try {
    editor.addAction({
      id: 'apexstudio.toggleBreakpoint',
      label: 'Apex Debug Studio: Toggle Breakpoint',
      contextMenuGroupId: 'debug', contextMenuOrder: 1.0,
      run: (ed) => { const fp = fileOf(); if (fp) toggleBreakpoint(fp, ed.getPosition().lineNumber); },
    });
    editor.addAction({
      id: 'apexstudio.conditionalBreakpoint',
      label: 'Apex Debug Studio: Add / Edit Conditional Breakpoint…',
      contextMenuGroupId: 'debug', contextMenuOrder: 1.1,
      run: (ed) => { const fp = fileOf(); if (fp) editConditionalBreakpoint(fp, ed.getPosition().lineNumber); },
    });
    editor.addAction({
      id: 'apexstudio.logpoint',
      label: 'Apex Debug Studio: Add / Edit Logpoint…',
      contextMenuGroupId: 'debug', contextMenuOrder: 1.2,
      run: (ed) => { const fp = fileOf(); if (fp) editLogpoint(fp, ed.getPosition().lineNumber); },
    });
  } catch (err) { console.error('addAction failed', err); }
}

/**
 * A small DevTools-style context menu for a gutter line: toggle a plain
 * breakpoint, add/edit a conditional breakpoint, add/edit a logpoint (prints
 * without pausing), or remove. Entry uses the in-app modal (Electron blocks
 * window.prompt(), which is why the old menu appeared to do nothing).
 */
function showGutterBreakpointMenu(filePath, line, x, y) {
  document.querySelectorAll('.dbg-gutter-menu').forEach(m => m.remove());
  const bps = debugState.breakpoints.get(filePath);
  const current = bps?.get(line) || null;
  const menu = document.createElement('div');
  menu.className = 'dbg-gutter-menu';
  menu.style.left = (x || 0) + 'px';
  menu.style.top = (y || 0) + 'px';

  const items = [];
  if (current) items.push({ label: 'Remove breakpoint', act: () => removeBreakpoint(filePath, line) });
  else items.push({ label: 'Add breakpoint', act: () => toggleBreakpoint(filePath, line) });
  items.push({ label: current?.condition ? 'Edit condition…' : 'Add conditional breakpoint…', act: () => editConditionalBreakpoint(filePath, line) });
  items.push({ label: current?.logMessage ? 'Edit logpoint…' : 'Add logpoint…', act: () => editLogpoint(filePath, line) });

  let close;
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'dbg-gutter-menu-item';
    el.textContent = it.label;
    el.onclick = () => {
      menu.remove();
      if (close) document.removeEventListener('mousedown', close, true);
      Promise.resolve().then(it.act).catch(err => console.error(err));
    };
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  // Keep the menu on-screen.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = Math.max(0, window.innerWidth - r.width - 4) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(0, window.innerHeight - r.height - 4) + 'px';
  close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close, true); } };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

/* ================================================================
   16. DEBUG PANEL TAB SWITCHING
   ================================================================ */

function initDebugPanelTabs() {
  const tabs = _$$('#debug-panel .dbg-panel-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      // A REAL user click (isTrusted) means the developer is choosing where to look.
      // From here on, stop auto-switching to the Org tab for the rest of this run so
      // we never yank them off Console/Call Stack/etc. Programmatic .click() calls
      // (the default auto-open at run start) are isTrusted=false and don't pin.
      if (e.isTrusted && debugState.active) debugState._userPinnedTab = true;
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
  loadSystemModePref();
  updateSystemModeUi();
  registerDebugProviders();
  registerDebugHoverProvider();

  // Need to wait for editor to be ready
  const checkEditor = setInterval(() => {
    if (window.state?.editor) {
      clearInterval(checkEditor);
      registerGutterClickHandler();

      // Enable glyphMargin for breakpoint gutter
      window.state.editor.updateOptions({ glyphMargin: true });

      // Restore breakpoints saved in a previous session so they persist across
      // app restarts (paints gutter glyphs for the open file + fills the panel).
      loadBreakpoints();

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
        id: 'apexstudio.debugMethod',
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
  _$('#dbg-btn-step-back')?.addEventListener('click', debugStepBack);
  _$('#dbg-btn-step-over')?.addEventListener('click', debugStepOver);
  _$('#dbg-btn-step-into')?.addEventListener('click', debugStepInto);
  _$('#dbg-btn-step-out')?.addEventListener('click', debugStepOut);
  _$('#dbg-btn-stop')?.addEventListener('click', stopDebugSession);
  _$('#dbg-btn-restart')?.addEventListener('click', debugRestart);
  // Clicking the exec-status pill opens the file when we paused elsewhere.
  _$('#dbg-exec-status')?.addEventListener('click', () => {
    const el = _$('#dbg-exec-status');
    if (el && typeof el._onClick === 'function') el._onClick();
  });

  // Clicking the yellow "querying / running" banner jumps to the executing line
  // so the user can see where the run is and act there (stop, breakpoint, etc.).
  _$('#dbg-query-banner')?.addEventListener('click', revealCurrentExecution);

  // Live Org toggle — toggling ON runs the method in the org (there is no separate
  // "Run in Org" button; toggle OFF→ON or press Restart ⟳ to re-run).
  _$('#dbg-liveorg-checkbox')?.addEventListener('change', toggleLiveOrgMode);

  // Wire up request modal
  _$('#dbg-modal-start')?.addEventListener('click', startDebugFromModal);
  _$('#dbg-modal-close')?.addEventListener('click', hideRequestModal);
  _$('#dbg-modal-cancel')?.addEventListener('click', hideRequestModal);
  _$('#dbg-history-clear')?.addEventListener('click', clearRequestHistory);

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

  // System-mode on/off toggle + debug-log cleanup in the ⚡ Org & Log tab. Turning system
  // mode ON runs the consent+deploy flow (uploads the read-only helper class if the org
  // doesn't already have it); turning it OFF is instant and keeps everything in user mode.
  _$('#dbg-systemmode-toggle')?.addEventListener('click', () => { toggleSystemMode(); });
  _$('#dbg-clearlogs')?.addEventListener('click', () => { clearDebugLogsFromUi(); });
  updateSystemModeUi();

  // Close the debug panel (hides Console / Org & Log). Available any time — the
  // panel also stays visible after a session ends so output can be read first.
  _$('#dbg-panel-close')?.addEventListener('click', () => {
    hideDebugUI();
  });

  // Reopen the debug panel from the status bar after it was closed. Restores the
  // panels (with their retained output) whether or not a session is still active.
  _$('#status-reopen-debug')?.addEventListener('click', () => {
    showDebugUI();
    updateDebugPanels();
  });

  // Global keyboard handler for CodeLens command
  document.addEventListener('apexstudio-debug-method', (e) => {
    const { filePath, methodName, line } = e.detail;
    showRequestModal(filePath, methodName, line);
  });

  // Breakpoint toggle from keyboard (F9 via app.js)
  document.addEventListener('apexstudio-toggle-breakpoint', (e) => {
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

  // Restore persisted watch definitions (expressions + pin re-bind exprs) once.
  try { loadWatchDefs(); renderWatchPanel(); } catch (_) {}

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const expr = input.value.trim();
      if (!expr) return;
      debugState.watchExpressions.push({ expr, id: debugState.watchNextId++ });
      input.value = '';
      saveWatchDefs();
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
    `if (ccEvVal == null) { ccEvOut = 'null'; }`,
    `else {`,
    `    try { ccEvOut = JSON.serialize(ccEvVal); }`,
    `    catch (Exception ccEvSe) {`,
    `        // Non-serializable Apex types (Schema.SObjectType, System.Type,`,
    `        // Schema.DescribeSObjectResult, …) throw on JSON.serialize. Show their`,
    `        // real String.valueOf form (e.g. the API name) instead of a placeholder.`,
    `        try { ccEvOut = JSON.serialize(String.valueOf(ccEvVal)); }`,
    `        catch (Exception ccEvSe2) { ccEvOut = '"<unserializable>"'; }`,
    `    }`,
    `}`,
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

/**
 * Namespace-prefix a leading token in an Apex expression for a managed package.
 * SObject / custom-setting / custom-metadata tokens (Foo__c, Foo__mdt) use the
 * `ns__Foo__c` form; a plain leading class token uses the `ns.Class` form.
 */
function nsPrefixApexExpr(expr, ns) {
  if (!ns) return expr;
  const mObj = expr.match(/^([A-Za-z]\w*?)(__c|__mdt)\b/i);
  if (mObj) {
    const base = mObj[1];
    if (base.includes('__') || base.toLowerCase() === ns.toLowerCase()) return expr;
    return ns + '__' + expr;
  }
  return applyNamespaceToApex(expr, ns);
}

/** Run one anonymous-Apex evaluation of a resolved expression. Returns { value?, error?, compileFailed?, resolvedExpr }. */
async function _runEvalApex(resolvedExpr) {
  const org = getActiveOrg();
  const apex = buildEvalApex(resolvedExpr);
  try {
    // Anonymous-Apex eval reads its result from the FINEST debug log, so warm logging
    // on demand (cached). This is the one org read with no REST equivalent; it's rare
    // (only for statics/custom settings the engine can't resolve locally).
    if (org?.org) { await ensureFinestLogging(org.org); debugState._generatedOrgLogs = true; }
    const paths = await window.apexStudio.getPaths?.();
    const dir = paths?.appDataDir || paths?.home || '.';
    const tmpFile = `${dir}/.cc_debug_eval.apex`;
    await window.apexStudio.writeFile(tmpFile, apex);
    const cmd = `sf apex run --file "${tmpFile}" --json --target-org ${org.org}`;
    const { stdout, stderr } = await window.apexStudio.sfExec(cmd, window.state?.folderPath, 60000);
    const cli = parseSfJson(stdout);
    const res = (cli && (cli.result || cli.data)) || {};
    const log = res.logs || '';
    // Auth / CLI-level failure (e.g. IP restriction) → surface the real message.
    if (cli && cli.status && cli.status !== 0 && !res.logs) {
      return { error: sfErrorText(cli, stderr, stdout, 'Org command failed'), resolvedExpr };
    }
    // Prefer compileProblem field — it's the actual error text ("Invalid type: Foo").
    // Fall back to extracting from cli.message which the CLI embeds after a newline
    // ("Compilation failed at Line 5 column 85 with the error:\nActual error here").
    let compileProblem = res.compileProblem || (cli && cli.data && cli.data.compileProblem);
    if (!compileProblem && res.compiled === false) {
      const rawMsg = (cli && cli.message) || '';
      const afterErr = rawMsg.match(/with the error:\s*([\s\S]+)/i);
      compileProblem = afterErr ? afterErr[1].trim() : (rawMsg || null);
    }
    if (res.compiled === false || compileProblem) {
      if (compileProblem) {
        const loc = res.line ? ` at line ${res.line}${res.column ? ' col ' + res.column : ''}` : '';
        return { error: `Compile failed${loc}: ${compileProblem}`, compileFailed: true, resolvedExpr };
      }
      return { error: 'Compile failed: unknown', compileFailed: true, resolvedExpr };
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
    return { error: `Can't evaluate: ${names} ${unresolved.length > 1 ? 'are' : 'is'} a runtime object built inside the method, and anonymous Apex can't call methods on it or rebuild it (private helpers/state aren't reachable). Turn on the ⚡ Live Org toggle to replay the whole method in the org, then hover the variable itself for its real value — or set a value in the Console (e.g. \`${unresolved[0]} = …\`).`, resolvedExpr };
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
      addConsoleEntry('result-json', JSON.stringify(r.value, null, 2), null, r.value);
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

  if (!debugState.active) {
    addConsoleEntry('error', 'No active debug session');
    return;
  }

  // Free-running (active but not paused): refresh the live stack and do a
  // READ-ONLY lookup of the expression against the current scope, so the user
  // can inspect values mid-run without re-entering (and possibly corrupting) the
  // running interpreter. Deep evaluation / method calls still require a pause.
  if (!debugState.paused) {
    const eng = debugState.engineSession;
    if (eng && typeof eng.getCallStack === 'function') {
      try { mirrorEngineStack(eng.getCallStack()); } catch (_) {}
    }
    if (!debugState.callStack.length) { addConsoleEntry('error', 'No active frame'); return; }
    let v;
    for (let fi = debugState.callStack.length - 1; fi >= 0; fi--) {
      const f = debugState.callStack[fi];
      const sc = { ...(f.classFields || {}), ...f.variables };
      const r = resolveProperty(sc, expr);
      if (r !== undefined) { v = r; break; }
    }
    if (v === undefined) {
      addConsoleEntry('info', 'Running… only a plain variable name shows its live value right now. Pause (breakpoint / step) to evaluate expressions or call methods.');
    } else if (v !== null && typeof v === 'object') {
      addConsoleEntry('result-json', JSON.stringify(v, null, 2));
    } else {
      addConsoleEntry('result', formatValue(v));
    }
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
window.debugStepBack = debugStepBack;
window.debugStop = stopDebugSession;
window.debugRestart = debugRestart;
window.showRequestModal = showRequestModal;
window.startDebugFromModal = startDebugFromModal;
window.debugState = debugState;
// Proactive system-mode helper check — called by the Salesforce module when the
// user connects/switches to an org (now only refreshes the toggle UI; never deploys).
window.apexDebuggerCheckSystemHelper = onOrgConnectedCheckHelper;
// System-mode opt-in toggle + debug-log cleanup, driven from the org bar.
window.apexDebuggerToggleSystemMode = toggleSystemMode;
window.apexDebuggerIsSystemMode = isSystemModeEnabled;
window.apexDebuggerUpdateSystemModeUi = updateSystemModeUi;
window.apexDebuggerClearDebugLogs = clearDebugLogsFromUi;

// Node-only test hook: expose the pure log/replay helpers for regression testing
// (guarded so it is a no-op in the browser/renderer). Mirrors apexengine.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildReplayTimeline, getEntrySignature, parseApexLog, parseApexDebugValue, evalReplayLogTemplate, renderConsoleTreeValue, _compactFirstLevelJson, replayStepPauses, evalReplayCondition, replayLogpointText, replayLogpointPayload, replayStepScope, planReplayEmit, selectedFrameIndex, _execSig, _bpPauseDecision, _bpLogText, _bpLogPayload, _logExpressionPayload, _unreachedBreakpointNotes, _heapRefLabel, activeBreakpoint, saveBreakpoints, loadBreakpoints, debugState, applyNamespaceToSoql, stripColumnFromSoql, captureEngineHistory, planEngineForward, updateReplayPositionUI, _parseEditedValue, _hoverResolveParent, _hoverSetLeaf, _hoverChildVal, _cleanHoverValue, _pathToText, ensureFinestLogging, _ensureFinestLoggingUncached, warmUpLiveOrg, recordFieldWrite, recordFieldRead, resetWatchRuntime, watchAddPin, watchUnpin, watchIsTracked, _watchSameValue, _watchDispSnapshot, _watchMethodKey, _watchPinHistory, syncWatchPins, _isStableBinding, _watchEnsureTracked, isSystemModeEnabled, setSystemMode, loadSystemModePref, toggleSystemMode, updateSystemModeUi, _looksLikeCliAuthError, soqlPermissionHint, clearMyDebugLogs, systemModePref, setSystemModeAuto, onOrgConnectedCheckHelper };
}

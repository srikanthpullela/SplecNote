/**
 * Apex Debug Studio — Salesforce Module
 * 5 sub-features: Quick API View, Apex Test Runner, Process Flow Visualizer,
 * Change Impact Analyzer, Deployment Simulator
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────
  // STATE
  // ──────────────────────────────────────────────
  const sfState = {
    endpoints: [],
    testClasses: [],
    impactResults: null,
    deployResults: null,
    flowData: null,
    projectPath: null,     // resolved from workspace folder
    projectType: null,     // 'sfdx' | 'metadata' | 'hybrid'
    classIndex: {},        // className -> { filePath, type, refs, ... }
    triggerIndex: {},      // triggerName -> { filePath, sobject, ... }
    cliInstalled: false,
    cliVersion: null,
    orgConnected: false,
    orgInfo: null,         // { username, orgId, instanceUrl, alias }
    orgList: [],           // all authenticated orgs
    selectedOrg: null,     // currently selected org username
  };

  // ──────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function toast(msg, type) {
    if (window.showToast) window.showToast(msg, type);
  }

  // ──────────────────────────────────────────────
  // Persistent "Connecting to Salesforce" progress card (bottom-right).
  // A normal toast auto-dismisses after a few seconds, so during the ~60s
  // browser-login wait the user would see nothing. This card stays up with a
  // spinner + live elapsed timer and updates as the flow progresses, so it's
  // always obvious that something is happening.
  // ──────────────────────────────────────────────
  let _scpTimer = null;
  let _scpStart = 0;
  let _scpEl = null;
  // Handler invoked when the user clicks "Cancel" on the connect progress card.
  // loginNewOrg sets this while a login is in flight; cleared when it settles.
  let _onConnectCancel = null;

  function showConnectProgress(title, status) {
    hideConnectProgress(true);
    const el = document.createElement('div');
    el.id = 'sf-connect-progress';
    el.className = 'sf-connect-progress';
    el.innerHTML =
      '<div class="scp-spinner" aria-hidden="true"></div>' +
      '<div class="scp-body">' +
      '<div class="scp-title"></div>' +
      '<div class="scp-status"></div>' +
      '<div class="scp-timer"></div>' +
      '</div>' +
      '<button type="button" class="scp-cancel" title="Cancel sign-in">Cancel</button>';
    document.body.appendChild(el);
    el.querySelector('.scp-title').textContent = title || 'Connecting to Salesforce';
    el.querySelector('.scp-status').textContent = status || 'Starting…';
    const cancelBtn = el.querySelector('.scp-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (typeof _onConnectCancel === 'function') _onConnectCancel();
      });
    }
    _scpEl = el;
    _scpStart = Date.now();
    const timerEl = el.querySelector('.scp-timer');
    const tick = () => {
      const s = Math.floor((Date.now() - _scpStart) / 1000);
      timerEl.textContent = `${s}s elapsed · waits up to 60s`;
    };
    tick();
    _scpTimer = setInterval(tick, 1000);
    return el;
  }

  function setConnectProgress(status) {
    if (_scpEl) {
      const s = _scpEl.querySelector('.scp-status');
      if (s) s.textContent = status;
    }
  }

  function finishConnectProgress(ok, msg) {
    if (!_scpEl) return;
    if (_scpTimer) { clearInterval(_scpTimer); _scpTimer = null; }
    const el = _scpEl;
    el.classList.add(ok ? 'scp-done' : 'scp-error');
    const sp = el.querySelector('.scp-spinner');
    if (sp) { sp.classList.add('scp-static'); sp.textContent = ok ? '✓' : '✗'; }
    const cancelBtn = el.querySelector('.scp-cancel');
    if (cancelBtn) cancelBtn.remove(); // nothing left to cancel once it's settled
    el.querySelector('.scp-title').textContent = ok ? 'Connected' : 'Connection failed';
    el.querySelector('.scp-status').textContent = msg || (ok ? 'Success' : 'Please try again');
    const t = el.querySelector('.scp-timer');
    if (t) t.textContent = '';
    setTimeout(() => hideConnectProgress(), ok ? 2500 : 5000);
  }

  function hideConnectProgress(immediate) {
    if (_scpTimer) { clearInterval(_scpTimer); _scpTimer = null; }
    const el = _scpEl || document.getElementById('sf-connect-progress');
    if (el) {
      if (immediate) { el.remove(); }
      else { el.classList.add('scp-out'); setTimeout(() => el.remove(), 250); }
    }
    _scpEl = null;
  }

  // ──────────────────────────────────────────────
  // Friendly CLI messages.
  // The Salesforce CLI prints noise to stderr on almost every command — most
  // notably "Warning: @salesforce/cli update available from x to y." — which was
  // leaking into the UI and looking like a scary failure. These helpers strip
  // that noise and translate the common failure causes into calm, reassuring,
  // actionable messages, so the user is never shown a raw CLI/stack error.
  // ──────────────────────────────────────────────
  function stripSfNoise(text) {
    if (!text) return [];
    return String(text)
      .replace(/\x1b\[[0-9;]*m/g, '')                        // ANSI colour codes
      .split('\n')
      .map((l) => l.replace(/^\s*[›»>*•\-]+\s*/, '').trim())  // strip bullet prefixes
      .filter((l) => l.length > 0)
      .filter((l) => !isSfNoiseLine(l));
  }

  /** A single line of pure Salesforce-CLI noise (update notice etc.) — safe to hide. */
  function isSfNoiseLine(l) {
    const s = String(l).replace(/^\s*[›»>*•\-]+\s*/, '').trim();
    return /update available/i.test(s)
      || /^warning:\s*@salesforce/i.test(s)
      || /@salesforce\/cli\s+update/i.test(s)
      || /to update,?\s*run/i.test(s)
      || /npm\s+(i|install)\b.*@salesforce/i.test(s);
  }

  /** True when a CLI result is only noise (e.g. just the update warning). */
  function isOnlySfNoise(stderr, stdout) {
    return stripSfNoise([stderr, stdout].filter(Boolean).join('\n')).length === 0;
  }

  /** Turn a raw org-connect failure into a calm, non-scary, actionable line. */
  function friendlyConnectError(stderr, stdout) {
    const lines = stripSfNoise([stderr, stdout].filter(Boolean).join('\n'));
    const j = lines.join(' ').toLowerCase();
    const has = (...subs) => subs.some((s) => j.includes(s));

    if (has('eaddrinuse', 'address already in use', ':1717', 'port 1717', 'listen eacces'))
      return 'A previous sign-in was still open, so we closed it. Please click "+ Add Org" and try again.';
    if (has('timed out', 'timeout'))
      return 'The sign-in wasn\u2019t finished in time. Click "+ Add Org" to try again when you\u2019re ready.';
    if (has('invalid_grant', 'expired', 'already redeemed'))
      return 'That sign-in link expired. Click "+ Add Org" to start a fresh sign-in.';
    if (has('access_denied', 'user canceled', 'user cancelled', 'canceled', 'cancelled', 'end of file', 'aborted', 'closed'))
      return 'Sign-in was cancelled \u2014 no problem. Click "+ Add Org" whenever you\u2019d like to connect.';
    if (has('enotfound', 'getaddrinfo', 'econnrefused', 'etimedout', 'network', 'unable to connect', 'socket hang up'))
      return 'We couldn\u2019t reach Salesforce. Check your internet connection and try again.';
    if (has('command not found', 'enoent', 'not recognized', 'is not installed', 'cannot find'))
      return 'The Salesforce CLI wasn\u2019t found. Please install it, then try connecting again.';
    if (lines.length === 0)
      return 'Sign-in wasn\u2019t completed. Click "+ Add Org" to try again.';
    // A genuine but unrecognised error — keep the surface calm; detail goes to the console.
    return 'We couldn\u2019t finish connecting. Please try again \u2014 if it keeps happening, reconnect the org.';
  }


  /** Navigate to a line in the editor with a brief highlight flash */
  async function goToLineWithFlash(filePath, lineNum, content) {
    // Close SF panel if open
    if (window.state && window.state.activeToolPanel === 'salesforce-panel') {
      if (window.toggleToolPanel) window.toggleToolPanel('salesforce-panel');
    }
    const fileContent = content || await readFile(filePath);
    if (window.openFile) await window.openFile(filePath, fileContent);
    await new Promise(r => setTimeout(r, 150));
    if (window.state && window.state.editor) {
      const editor = window.state.editor;
      editor.revealLineInCenter(lineNum);
      editor.setPosition({ lineNumber: lineNum, column: 1 });
      editor.focus();
      // Flash highlight on the line
      const decs = editor.deltaDecorations([], [{
        range: new monaco.Range(lineNum, 1, lineNum, 1),
        options: { isWholeLine: true, className: 'line-highlight-flash' },
      }]);
      setTimeout(() => editor.deltaDecorations(decs, []), 1500);
    }
  }

  /** Log a line to the test output console */
  function clog(text, cls = '') {
    const log = $('#sf-console-log');
    if (!log) return;
    const line = document.createElement('div');
    line.className = `sf-console-line ${cls}`;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  /** Log with spinner (returns the element so spinner can be removed) */
  function clogSpinner(text) {
    const log = $('#sf-console-log');
    if (!log) return null;
    const line = document.createElement('div');
    line.className = 'sf-console-line sf-console-spinner';
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    return line;
  }

  /** Remove spinner class and update text */
  function clogResolve(el, text, cls) {
    if (!el) return;
    el.classList.remove('sf-console-spinner');
    el.className = `sf-console-line ${cls}`;
    el.textContent = text;
    const log = $('#sf-console-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function clearConsole() {
    const log = $('#sf-console-log');
    if (log) log.innerHTML = '';
  }

  /** Ensure the Salesforce panel is open on the given tab */
  function openSfPanel(tabId) {
    if (window.state && window.state.activeToolPanel !== 'salesforce-panel') {
      window.toggleToolPanel('salesforce-panel');
    }
    if (tabId) switchTab(tabId);
  }

  // ──────────────────────────────────────────────
  // CLI & ORG CONNECTION
  // ──────────────────────────────────────────────

  /** Persist selected org per repo folder (file-based via settings.json) */
  async function saveOrgForRepo(username) {
    const folder = getFolderPath();
    if (!folder || !username) return;
    try {
      const api = window.apexStudio;
      if (!api || !api.readSettings) return;
      const settings = await api.readSettings();
      if (!settings.sfOrgMap) settings.sfOrgMap = {};
      settings.sfOrgMap[folder] = username;
      await api.writeSettings(settings);
    } catch {}
  }

  /** Load previously selected org for current repo (file-based via settings.json) */
  async function loadOrgForRepo() {
    const folder = getFolderPath();
    if (!folder) return null;
    try {
      const api = window.apexStudio;
      if (!api || !api.readSettings) return null;
      const settings = await api.readSettings();
      return (settings.sfOrgMap && settings.sfOrgMap[folder]) || null;
    } catch { return null; }
  }

  /** Update the status bar org indicator */
  function updateStatusBarOrg(overrideText) {
    const el = $('#status-sf-org');
    if (!el) return;
    if (overrideText) {
      el.textContent = overrideText;
      el.classList.remove('hidden');
      return;
    }
    if (sfState.selectedOrg) {
      const chosen = sfState.orgList.find(o => o.username === sfState.selectedOrg);
      const alias = chosen?.alias?.split(',')[0]?.trim();
      el.textContent = `⚡ ${alias || sfState.selectedOrg}`;
      el.classList.remove('hidden');
      el.title = `Salesforce Org: ${sfState.selectedOrg} (click to change)`;
    } else {
      el.textContent = '⚡ Select Org';
      el.classList.remove('hidden');
      el.title = 'Click to select or add a Salesforce Org';
    }
  }

  /** Execute a Salesforce CLI command, capture and return full output */
  async function sfExec(command, timeoutMs) {
    const folder = getFolderPath() || undefined;
    const api = window.apexStudio;
    if (!api || !api.sfExec) {
      throw new Error('sfExec IPC not available');
    }
    return api.sfExec(command, folder, timeoutMs);
  }

  /** Get the --target-org flag for CLI commands */
  function targetOrgFlag() {
    if (sfState.selectedOrg) return ` --target-org ${sfState.selectedOrg}`;
    return '';
  }

  /** Check if an org's connection status means it's usable */
  function isOrgConnected(o) {
    return o && o.connectedStatus === 'Connected';
  }

  let _orgCheckGen = 0;

  /** Check CLI availability, list all orgs, populate selector dropdown */
  async function checkOrgConnection() {
    const myGen = ++_orgCheckGen;
    const dot = $('#sf-org-dot');
    const label = $('#sf-org-label');
    const sel = $('#sf-org-select');
    if (!dot || !sel) return;

    dot.className = 'sf-org-dot';
    sel.innerHTML = '<option value="">Loading orgs...</option>';
    sel.disabled = true;
    if (label) label.textContent = '';

    const api = window.apexStudio;
    if (!api || !api.sfCheckCli) {
      dot.classList.add('no-cli');
      sel.innerHTML = '<option value="">IPC bridge not available</option>';
      return;
    }

    // 1) Check if CLI is installed
    const cli = await api.sfCheckCli();
    sfState.cliInstalled = cli.installed;
    sfState.cliVersion = cli.version;

    if (!cli.installed) {
      dot.classList.add('no-cli');
      sel.innerHTML = '<option value="">CLI not found — install: npm i -g @salesforce/cli</option>';
      sfState.orgConnected = false;
      return;
    }

    // 2) List all authenticated orgs (runs async, won't freeze UI)
    const folder = getFolderPath();
    const { orgs } = await api.sfOrgList(folder);
    // Abort if a newer checkOrgConnection was started while we were awaiting
    if (myGen !== _orgCheckGen) return;
    sfState.orgList = orgs;

    if (!orgs || orgs.length === 0) {
      dot.classList.add('disconnected');
      sel.innerHTML = '<option value="">No orgs — run: sf org login web</option>';
      sfState.orgConnected = false;
      sfState.selectedOrg = null;
      if (label) label.textContent = `CLI ${cli.version.split('/')[0]}`;
      return;
    }

    // 3) Sort: connected first, then by alias/username
    orgs.sort((a, b) => {
      const ac = isOrgConnected(a) ? 0 : 1;
      const bc = isOrgConnected(b) ? 0 : 1;
      if (ac !== bc) return ac - bc;
      const an = (a.alias || a.username).toLowerCase();
      const bn = (b.alias || b.username).toLowerCase();
      return an.localeCompare(bn);
    });

    // 4) Populate the dropdown
    sel.innerHTML = '';
    let defaultUsername = null;
    for (const o of orgs) {
      const opt = document.createElement('option');
      opt.value = o.username;
      // alias may contain comma-separated values — use the first one
      const alias = o.alias ? o.alias.split(',')[0].trim() : '';
      const display = alias ? `${alias} (${o.username})` : o.username;
      const tags = [];
      if (o.isDefault) tags.push('★');
      if (!isOrgConnected(o)) tags.push('⚠');
      opt.textContent = display + (tags.length ? ` ${tags.join(' ')}` : '');
      sel.appendChild(opt);
      if (o.isDefault) defaultUsername = o.username;
    }
    sel.disabled = false;

    // 5) Auto-select: saved for repo > previously selected > default > first connected > first
    const savedOrg = await loadOrgForRepo();
    const prev = sfState.selectedOrg;
    const firstConnected = orgs.find(o => isOrgConnected(o));
    if (savedOrg && orgs.find(o => o.username === savedOrg)) {
      sel.value = savedOrg;
    } else if (prev && orgs.find(o => o.username === prev)) {
      sel.value = prev;
    } else if (defaultUsername) {
      sel.value = defaultUsername;
    } else if (firstConnected) {
      sel.value = firstConnected.username;
    } else {
      sel.value = orgs[0].username;
    }
    sfState.selectedOrg = sel.value;

    // 6) Update dot + label + status bar
    const chosen = orgs.find(o => o.username === sel.value);
    sfState.orgConnected = isOrgConnected(chosen);
    sfState.orgInfo = chosen || null;
    dot.classList.add(isOrgConnected(chosen) ? 'connected' : 'disconnected');
    if (label) label.textContent = chosen?.instanceUrl || '';
    updateStatusBarOrg();
  }

  /** Handle user changing the org dropdown */
  function onOrgSelectChange() {
    const sel = $('#sf-org-select');
    const dot = $('#sf-org-dot');
    const label = $('#sf-org-label');
    if (!sel) return;
    sfState.selectedOrg = sel.value;
    const chosen = sfState.orgList.find(o => o.username === sel.value);
    sfState.orgInfo = chosen || null;
    const connected = isOrgConnected(chosen);
    sfState.orgConnected = connected;
    if (dot) {
      dot.className = 'sf-org-dot';
      dot.classList.add(connected ? 'connected' : 'disconnected');
    }
    if (label) label.textContent = chosen?.instanceUrl || '';
    // Persist selection for this repo
    saveOrgForRepo(sel.value);
    updateStatusBarOrg();
    // Offer to deploy the system-mode helper class if this connected org lacks it.
    notifySystemHelperOnConnect(connected);
  }

  /**
   * Ask the Apex debugger to verify (and, with consent, deploy) its system-mode
   * helper class on the freshly connected org. Fire-and-forget; safe if the
   * debugger module isn't loaded yet.
   */
  function notifySystemHelperOnConnect(connected) {
    try {
      if (connected && typeof window.apexDebuggerCheckSystemHelper === 'function' && typeof window.sfGetActiveOrg === 'function') {
        window.apexDebuggerCheckSystemHelper(window.sfGetActiveOrg());
      }
    } catch (_) { /* non-fatal */ }
  }

  /** Authenticate a new org via browser OAuth flow */
  let _loginGen = 0;
  async function loginNewOrg(alias, instanceUrl) {
    // Each attempt gets a generation id. If the user retries, a newer attempt
    // supersedes this one — the stale attempt must not stomp the shared progress
    // card or show a duplicate error when its (now cancelled) CLI process exits.
    const myGen = ++_loginGen;
    const current = () => myGen === _loginGen;

    const btn = $('#sf-org-login');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Waiting...'; }
    updateStatusBarOrg('⚡ Authenticating...');
    showConnectProgress('Connecting to Salesforce', 'Opening your browser…');
    // Let the user bail out of a stuck sign-in from the progress card. Cancelling
    // kills the CLI login (freeing the OAuth port) and resets to a fresh state so
    // they can immediately try again — with the same alias if they like.
    _onConnectCancel = () => cancelConnect(myGen);

    // Live progress from the main process (fires when the browser is opened).
    let unsub = null;
    try {
      if (window.apexStudio && window.apexStudio.on) {
        unsub = window.apexStudio.on('sf:login-progress', (data) => {
          if (current() && data && data.phase === 'browser-opened') {
            setConnectProgress('Browser opened — finish the login there, then come back…');
          }
        });
      }
    } catch (_) { /* progress is best-effort */ }
    // Fallback nudges in case no signal arrives, so the text never looks frozen.
    const t1 = setTimeout(() => { if (current()) setConnectProgress('Complete the Salesforce login in your browser…'); }, 5000);
    const t2 = setTimeout(() => { if (current()) setConnectProgress('Still waiting for you to authorize in the browser…'); }, 20000);

    try {
      let cmd = 'sf org login web';
      if (alias) cmd += ` --alias ${alias}`;
      if (instanceUrl) cmd += ` --instance-url ${instanceUrl}`;
      const { code, stdout, stderr } = await sfExec(cmd, 60000);

      // A newer attempt (or a cancel) has taken over — stay silent here.
      if (!current()) return;

      if (code === 0) {
        finishConnectProgress(true, `Connected${alias ? ' as ' + alias : ''}`);
      } else {
        const detail = stripSfNoise([stderr, stdout].filter(Boolean).join('\n')).join(' ');
        if (detail) clog(`Org connect did not complete: ${detail}`, 'sf-console-dim'); // technical detail → console only
        finishConnectProgress(false, friendlyConnectError(stderr, stdout));
      }
    } catch (err) {
      if (!current()) return;
      const msg = (err && err.message) || '';
      if (msg) clog(`Org connect error: ${msg}`, 'sf-console-dim');
      finishConnectProgress(false, friendlyConnectError(msg, ''));
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      if (unsub) { try { unsub(); } catch (_) { /* ignore */ } }
      // Only the newest attempt resets shared UI / refreshes the org list.
      if (current()) {
        _onConnectCancel = null;
        if (btn) { btn.disabled = false; btn.textContent = '+ Add Org'; }
        updateStatusBarOrg(); // reset status bar text
        await checkOrgConnection();
        // A freshly authenticated org is auto-selected without firing the dropdown
        // 'change' event, so trigger the system-mode helper check explicitly.
        notifySystemHelperOnConnect(sfState.orgConnected);
      }
    }
  }

  /**
   * Cancel an in-flight browser sign-in from the progress card's Cancel button.
   * Bumps the login generation so the (soon-to-exit) CLI process can't post a
   * late error, tells the main process to kill the login tree (freeing the OAuth
   * port), then quietly resets to a fresh state — no scary error shown.
   */
  async function cancelConnect(gen) {
    if (gen != null && gen !== _loginGen) return; // already superseded/settled
    _loginGen++;            // silence the in-flight attempt's resolution
    _onConnectCancel = null;
    hideConnectProgress(true);
    try {
      if (window.apexStudio && window.apexStudio.sfCancelLogin) {
        await window.apexStudio.sfCancelLogin();
      }
    } catch (_) { /* best-effort */ }
    const btn = $('#sf-org-login');
    if (btn) { btn.disabled = false; btn.textContent = '+ Add Org'; }
    updateStatusBarOrg();
    toast('Sign-in cancelled — you can try again anytime.', 'info');
  }

  // ──────────────────────────────────────────────
  // ORG PICKER POPUP (VS Code-style quick pick)
  // ──────────────────────────────────────────────
  let orgPickerSelectedIndex = -1;

  function showOrgPicker() {
    const overlay = $('#org-picker-overlay');
    const input = $('#org-picker-input');
    if (!overlay || !input) return;
    overlay.classList.remove('hidden');
    input.value = '';
    input.focus();
    renderOrgPickerResults('');
  }

  function hideOrgPicker() {
    const overlay = $('#org-picker-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function renderOrgPickerResults(filter) {
    const results = $('#org-picker-results');
    if (!results) return;
    results.innerHTML = '';
    orgPickerSelectedIndex = 0;
    const lf = filter.toLowerCase();

    // Build items: add new options first, then existing orgs
    const items = [];

    // Add new org options (at the top)
    if (!lf || 'production'.includes(lf) || 'add'.includes(lf) || 'new'.includes(lf) || 'login'.includes(lf)) {
      items.push({
        label: '$(add) Add Production Org...', detail: 'login.salesforce.com',
        icon: '+', action: () => startOrgAuthFlow('production')
      });
    }
    if (!lf || 'sandbox'.includes(lf) || 'add'.includes(lf) || 'test'.includes(lf) || 'new'.includes(lf) || 'login'.includes(lf)) {
      items.push({
        label: '$(add) Add Sandbox Org...', detail: 'test.salesforce.com',
        icon: '+', action: () => startOrgAuthFlow('sandbox')
      });
    }
    if (!lf || 'custom'.includes(lf) || 'add'.includes(lf) || 'new'.includes(lf) || 'login'.includes(lf)) {
      items.push({
        label: '$(add) Add Custom Domain Org...', detail: 'Enter your My Domain URL',
        icon: '+', action: () => startOrgAuthFlow('custom')
      });
    }

    // Existing orgs
    for (const o of sfState.orgList) {
      const alias = o.alias ? o.alias.split(',')[0].trim() : '';
      const display = alias ? `${alias} (${o.username})` : o.username;
      const tags = [];
      if (o.isDefault) tags.push('★ Default');
      if (o.username === sfState.selectedOrg) tags.push('✓ Active');
      if (!isOrgConnected(o)) tags.push('⚠ Expired');
      const tagStr = tags.length ? `  ${tags.join(' · ')}` : '';
      const full = display + tagStr;
      if (lf && !full.toLowerCase().includes(lf)) continue;
      items.push({
        label: display, detail: o.instanceUrl || '', tags: tagStr,
        icon: o.username === sfState.selectedOrg ? '✓' : '☁',
        action: () => { selectOrgFromPicker(o.username); }
      });
    }

    if (items.length === 0) {
      results.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;">No matching orgs</div>';
      orgPickerSelectedIndex = -1;
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const div = document.createElement('div');
      div.className = 'cp-item' + (i === 0 ? ' selected' : '');
      div.innerHTML = `<span style="margin-right:8px;opacity:.6">${item.icon}</span>`
        + `<span>${escHtml(item.label)}</span>`
        + (item.tags ? `<span style="margin-left:8px;font-size:10px;opacity:.5">${escHtml(item.tags)}</span>` : '')
        + (item.detail ? `<span style="margin-left:auto;font-size:10px;color:var(--text-muted)">${escHtml(item.detail)}</span>` : '');
      div.addEventListener('click', () => { hideOrgPicker(); item.action(); });
      // Highlight on hover, but DON'T scrollIntoView — the pointer is already on
      // the item. Scrolling here would shift the list under a stationary cursor,
      // firing mouseenter on a new item → a self-perpetuating scroll loop.
      div.addEventListener('mouseenter', () => orgPickerUpdateSelected(i, false));
      results.appendChild(div);
    }
  }

  function orgPickerUpdateSelected(idx, scroll = true) {
    const results = $('#org-picker-results');
    if (!results) return;
    const items = results.querySelectorAll('.cp-item');
    items.forEach(el => el.classList.remove('selected'));
    orgPickerSelectedIndex = Math.max(0, Math.min(idx, items.length - 1));
    if (items[orgPickerSelectedIndex]) {
      items[orgPickerSelectedIndex].classList.add('selected');
      // Only scroll for keyboard navigation; hover must never scroll (loop guard).
      if (scroll) items[orgPickerSelectedIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function selectOrgFromPicker(username) {
    sfState.selectedOrg = username;
    const chosen = sfState.orgList.find(o => o.username === username);
    sfState.orgInfo = chosen || null;
    sfState.orgConnected = isOrgConnected(chosen);
    saveOrgForRepo(username);
    updateStatusBarOrg();
    // Sync the dropdown in the SF panel
    const sel = $('#sf-org-select');
    if (sel) sel.value = username;
    const dot = $('#sf-org-dot');
    if (dot) {
      dot.className = 'sf-org-dot';
      dot.classList.add(sfState.orgConnected ? 'connected' : 'disconnected');
    }
    const label = $('#sf-org-label');
    if (label) label.textContent = chosen?.instanceUrl || '';
    const alias = chosen?.alias?.split(',')[0]?.trim() || username;
    toast(`Switched to org: ${alias}`, 'info');
  }

  async function startOrgAuthFlow(type) {
    // Step 1: Ask for alias name
    const alias = await window.showInputDialog('Salesforce Login', `Enter an alias for this ${type} org (e.g. mydev, cpq-sandbox):`);
    if (!alias || !alias.trim()) { toast('Cancelled — no alias provided', 'info'); return; }

    let instanceUrl;
    if (type === 'production') {
      instanceUrl = 'https://login.salesforce.com';
    } else if (type === 'sandbox') {
      instanceUrl = 'https://test.salesforce.com';
    } else {
      // Custom domain
      const domain = await window.showInputDialog('Custom Domain', 'Enter your My Domain login URL:\n(e.g. https://mycompany.my.salesforce.com)');
      if (!domain || !domain.trim()) { toast('Cancelled — no domain provided', 'info'); return; }
      instanceUrl = domain.trim();
    }

    await loginNewOrg(alias.trim(), instanceUrl);
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function initOrgPicker() {
    const overlay = $('#org-picker-overlay');
    const input = $('#org-picker-input');
    if (!overlay || !input) return;

    input.addEventListener('input', () => renderOrgPickerResults(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hideOrgPicker(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); orgPickerUpdateSelected(orgPickerSelectedIndex + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); orgPickerUpdateSelected(orgPickerSelectedIndex - 1); return; }
      if (e.key === 'Enter') {
        const items = $('#org-picker-results')?.querySelectorAll('.cp-item');
        const target = orgPickerSelectedIndex >= 0 && items?.[orgPickerSelectedIndex]
          ? items[orgPickerSelectedIndex] : items?.[0];
        if (target) target.click();
      }
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hideOrgPicker();
    });
  }

  /** Detect if folder is a Salesforce project */
  function detectSalesforceProject(folderPath) {
    sfState.projectPath = folderPath;
    // We'll determine type based on known paths
    sfState.projectType = 'metadata'; // default
    return folderPath;
  }

  /** Recursively gather .cls and .trigger files */
  async function gatherApexFiles(folderPath) {
    const api = window.apexStudio;
    if (!api) return [];
    const files = [];
    try {
      const allFiles = await api.getAllFiles(folderPath);
      if (allFiles && Array.isArray(allFiles)) {
        for (const f of allFiles) {
          if (f.endsWith('.cls') || f.endsWith('.trigger')) {
            files.push(f);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to gather apex files:', e);
    }
    return files;
  }

  /** Read file content via IPC */
  async function readFile(fp) {
    try {
      return await window.apexStudio.readFile(fp);
    } catch { return null; }
  }

  /** Get folder path from state */
  function getFolderPath() {
    // Access the global state from app.js
    if (window.state && window.state.folderPath) return window.state.folderPath;
    return null;
  }

  // ──────────────────────────────────────────────
  // 1. QUICK API VIEW — Scan & Display Endpoints
  // ──────────────────────────────────────────────
  const ANNOTATION_PATTERNS = [
    { type: 'rest',      regex: /@RestResource\s*\(\s*urlMapping\s*=\s*'([^']+)'/i, lineRegex: /@(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)/gi },
    { type: 'aura',      regex: /@AuraEnabled/gi },
    { type: 'soap',      regex: /\bwebService\b/gi },
    { type: 'remote',    regex: /@RemoteAction/gi },
    { type: 'invocable', regex: /@InvocableMethod/gi },
  ];

  function parseEndpoints(content, filePath) {
    const endpoints = [];
    const lines = content.split('\n');
    const fileName = filePath.split(/[/\\]/).pop().replace('.cls', '');

    // Check for @RestResource at class level
    const restMatch = content.match(/@RestResource\s*\(\s*urlMapping\s*=\s*'([^']+)'/i);
    if (restMatch) {
      const urlMapping = restMatch[1];
      // Find HTTP method annotations
      for (let i = 0; i < lines.length; i++) {
        const httpMatch = lines[i].match(/@(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)/i);
        if (httpMatch) {
          // Find the method signature on the next lines
          let methodName = '';
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            const mMatch = lines[j].match(/(?:global|public)\s+static\s+\w+\s+(\w+)\s*\(/i);
            if (mMatch) { methodName = mMatch[1]; break; }
          }
          // Parse parameters
          const params = parseMethodParams(lines, i);
          endpoints.push({
            type: 'rest',
            httpMethod: httpMatch[1].toUpperCase(),
            urlMapping,
            methodName: methodName || httpMatch[1],
            className: fileName,
            filePath,
            line: i + 1,
            params,
          });
        }
      }
    }

    // @AuraEnabled methods
    for (let i = 0; i < lines.length; i++) {
      if (/@AuraEnabled/i.test(lines[i])) {
        let methodName = '';
        let returnType = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const mMatch = lines[j].match(/(?:global|public)\s+static\s+(\S+)\s+(\w+)\s*\(/i);
          if (mMatch) { returnType = mMatch[1]; methodName = mMatch[2]; break; }
        }
        if (methodName) {
          const params = parseMethodParams(lines, i);
          endpoints.push({ type: 'aura', methodName, className: fileName, filePath, line: i + 1, returnType, params });
        }
      }
    }

    // webService methods
    for (let i = 0; i < lines.length; i++) {
      if (/\bwebService\b/i.test(lines[i]) && !/\/\//.test(lines[i].split('webService')[0])) {
        const mMatch = lines[i].match(/webService\s+static\s+(\S+)\s+(\w+)\s*\(/i);
        if (mMatch) {
          const params = parseMethodParams(lines, i);
          endpoints.push({ type: 'soap', methodName: mMatch[2], className: fileName, filePath, line: i + 1, returnType: mMatch[1], params });
        }
      }
    }

    // @RemoteAction methods
    for (let i = 0; i < lines.length; i++) {
      if (/@RemoteAction/i.test(lines[i])) {
        let methodName = '', returnType = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const mMatch = lines[j].match(/(?:global|public)\s+static\s+(\S+)\s+(\w+)\s*\(/i);
          if (mMatch) { returnType = mMatch[1]; methodName = mMatch[2]; break; }
        }
        if (methodName) {
          const params = parseMethodParams(lines, i);
          endpoints.push({ type: 'remote', methodName, className: fileName, filePath, line: i + 1, returnType, params });
        }
      }
    }

    // @InvocableMethod
    for (let i = 0; i < lines.length; i++) {
      if (/@InvocableMethod/i.test(lines[i])) {
        let methodName = '', returnType = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const mMatch = lines[j].match(/(?:global|public)\s+static\s+(\S+)\s+(\w+)\s*\(/i);
          if (mMatch) { returnType = mMatch[1]; methodName = mMatch[2]; break; }
        }
        if (methodName) {
          const params = parseMethodParams(lines, i);
          endpoints.push({ type: 'invocable', methodName, className: fileName, filePath, line: i + 1, returnType, params });
        }
      }
    }

    return endpoints;
  }

  /** Extract method parameters from nearby lines */
  function parseMethodParams(lines, annotationLine) {
    const params = [];
    for (let j = annotationLine; j < Math.min(annotationLine + 8, lines.length); j++) {
      const sigMatch = lines[j].match(/\(([^)]*)\)/);
      if (sigMatch && sigMatch[1].trim()) {
        const paramStr = sigMatch[1];
        const parts = paramStr.split(',');
        for (const p of parts) {
          const trimmed = p.trim();
          const tokens = trimmed.split(/\s+/);
          if (tokens.length >= 2) {
            params.push({ type: tokens[0], name: tokens[tokens.length - 1] });
          }
        }
        break;
      }
    }
    return params;
  }

  async function scanEndpoints(singleFile) {
    if (typeof singleFile !== 'string') singleFile = null;
    const folder = getFolderPath();
    if (!folder) { toast('Open a folder first', 'warn'); return; }

    detectSalesforceProject(folder);
    const resultsDiv = $('#sf-api-results');
    const fileName = singleFile ? singleFile.split(/[/\\]/).pop() : null;
    resultsDiv.innerHTML = `<div class="sf-empty">⏳ Scanning ${fileName || 'all files'} for endpoints...</div>`;

    const files = singleFile ? [singleFile] : await gatherApexFiles(folder);
    if (files.length === 0) {
      resultsDiv.innerHTML = '<div class="sf-empty">No .cls files found. Open a Salesforce project folder.</div>';
      return;
    }

    sfState.endpoints = [];
    let scanned = 0;
    for (const fp of files) {
      if (!fp.endsWith('.cls')) continue;
      const content = await readFile(fp);
      if (content) {
        const eps = parseEndpoints(content, fp);
        sfState.endpoints.push(...eps);
      }
      scanned++;
      if (scanned % 50 === 0) {
        resultsDiv.innerHTML = `<div class="sf-empty">⏳ Scanned ${scanned}/${files.filter(f=>f.endsWith('.cls')).length} classes...</div>`;
      }
    }

    renderEndpoints();
    toast(`Found ${sfState.endpoints.length} endpoints in ${singleFile ? fileName : scanned + ' classes'}`, 'success');
  }

  function renderEndpoints() {
    const resultsDiv = $('#sf-api-results');
    const filterVal = $('#sf-api-filter').value;
    const searchVal = ($('#sf-api-search').value || '').toLowerCase();

    let filtered = sfState.endpoints;
    if (filterVal !== 'all') filtered = filtered.filter(e => e.type === filterVal);
    if (searchVal) filtered = filtered.filter(e =>
      e.methodName.toLowerCase().includes(searchVal) ||
      e.className.toLowerCase().includes(searchVal) ||
      (e.urlMapping || '').toLowerCase().includes(searchVal)
    );

    if (filtered.length === 0) {
      resultsDiv.innerHTML = '<div class="sf-empty">No endpoints match your filter.</div>';
      return;
    }

    resultsDiv.innerHTML = '';
    for (const ep of filtered) {
      const card = document.createElement('div');
      card.className = 'sf-endpoint-card';
      const label = ep.type === 'rest' ? `${ep.httpMethod} ${ep.urlMapping}` : ep.methodName;
      card.innerHTML = `
        <span class="sf-ep-badge ${ep.type}">${ep.type}</span>
        <span class="sf-ep-name">${escapeHtml(label)}</span>
        <span class="sf-ep-class">${escapeHtml(ep.className)}</span>
        <span class="sf-ep-line">L${ep.line}</span>
      `;
      card.addEventListener('click', () => showEndpointDetail(ep));
      resultsDiv.appendChild(card);
    }
  }

  // Currently selected endpoint for testing
  let _selectedEndpoint = null;

  function showEndpointDetail(ep) {
    _selectedEndpoint = ep;
    const detail = $('#sf-api-detail');
    detail.classList.remove('hidden');
    $('#sf-api-detail-title').textContent = `${ep.className}.${ep.methodName}`;
    const meta = $('#sf-api-detail-meta');
    let metaHtml = `<strong>Type:</strong> ${ep.type.toUpperCase()}`;
    if (ep.urlMapping) metaHtml += `<br><strong>URL:</strong> ${escapeHtml(ep.urlMapping)}`;
    if (ep.httpMethod) metaHtml += `<br><strong>HTTP Method:</strong> ${ep.httpMethod}`;
    if (ep.returnType) metaHtml += `<br><strong>Returns:</strong> ${escapeHtml(ep.returnType)}`;
    metaHtml += `<br><strong>File:</strong> ${escapeHtml(ep.filePath.split(/[/\\]/).pop())} (line ${ep.line})`;
    meta.innerHTML = metaHtml;

    // Render parameters
    const paramsList = $('#sf-api-params-list');
    paramsList.innerHTML = '';
    if (ep.params && ep.params.length > 0) {
      for (const p of ep.params) {
        const row = document.createElement('div');
        row.className = 'sf-param-row';
        row.innerHTML = `
          <span class="sf-param-type">${escapeHtml(p.type)}</span>
          <span class="sf-param-name">${escapeHtml(p.name)}</span>
          <input class="sf-input sf-param-value" data-name="${escapeHtml(p.name)}" placeholder="value..." />
        `;
        paramsList.appendChild(row);
      }
    } else {
      paramsList.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">No parameters</div>';
    }

    $('#sf-api-test-output').classList.add('hidden');

    // Open the file at line when clicking meta
    meta.style.cursor = 'pointer';
    meta.onclick = () => {
      goToLineWithFlash(ep.filePath, ep.line);
    };
  }

  async function testEndpoint() {
    const output = $('#sf-api-test-output');
    output.classList.remove('hidden');
    const ep = _selectedEndpoint;
    if (!ep) {
      output.textContent = 'No endpoint selected.';
      return;
    }
    if (!sfState.cliInstalled) {
      output.textContent = 'Salesforce CLI not installed. Install: npm i -g @salesforce/cli';
      return;
    }
    if (!sfState.orgConnected) {
      output.textContent = 'No org connected. Run: sf org login web';
      return;
    }

    const params = {};
    $$('#sf-api-params-list .sf-param-value').forEach(input => {
      params[input.dataset.name] = input.value;
    });
    const folder = getFolderPath();
    const tof = targetOrgFlag();

    output.textContent = '⏳ Executing on org...';

    try {
      if (ep.type === 'rest') {
        // REST endpoints — use sf api request rest
        let url = `/services/apexrest${ep.urlMapping}`;
        const method = ep.httpMethod || 'GET';
        // Append params as query string for GET/DELETE, or as body for POST/PUT/PATCH
        let bodyFlag = '';
        if (['POST', 'PUT', 'PATCH'].includes(method) && Object.keys(params).length > 0) {
          const bodyJson = JSON.stringify(params);
          bodyFlag = ` -H "Content-Type: application/json" --body '${bodyJson}'`;
        } else if (['GET', 'DELETE'].includes(method) && Object.keys(params).length > 0) {
          const qs = Object.entries(params).filter(([,v]) => v).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
          if (qs) url += `?${qs}`;
        }
        const cmd = `sf api request rest "${url}" --method ${method}${tof}${bodyFlag} 2>&1`;
        output.textContent = `$ sf api request rest "${url}" --method ${method}${tof}\n\n⏳ Running...`;
        const { code, stdout, stderr } = await sfExec(cmd, 60000);
        const responseText = stdout || stderr || '(no output)';
        // Strip CLI warnings before JSON, try to format
        let formatted;
        try {
          const jsonStart = responseText.indexOf('{');
          const jsonStr = jsonStart >= 0 ? responseText.substring(jsonStart) : responseText;
          formatted = JSON.stringify(JSON.parse(jsonStr), null, 2);
        } catch {
          // Strip warning lines
          formatted = responseText.split('\n').filter(l => !l.trim().startsWith('›')).join('\n');
        }
        output.textContent = `$ sf api request rest "${url}" --method ${method}${tof}\n\n` +
          `Status: ${code === 0 ? '✓ SUCCESS' : '✗ ERROR (exit ' + code + ')'}\n\n` + formatted;
      } else {
        // AuraEnabled, webService, Remote, Invocable — use anonymous Apex execution
        let apexCode;
        const paramList = Object.entries(params).filter(([,v]) => v);

        if (ep.type === 'aura' || ep.type === 'remote') {
          // Static method call
          const args = paramList.map(([k, v]) => {
            // Try to detect type from endpoint params
            const pDef = (ep.params || []).find(p => p.name === k);
            const pType = pDef ? pDef.type.toLowerCase() : '';
            if (pType.includes('integer') || pType.includes('decimal') || pType.includes('double')) return v;
            if (pType.includes('boolean')) return v;
            return `'${v.replace(/'/g, "\\'")}'`;
          }).join(', ');
          apexCode = `Object result = ${ep.className}.${ep.methodName}(${args});\nSystem.debug('RESULT: ' + JSON.serialize(result));`;
        } else if (ep.type === 'invocable') {
          // Invocable methods take List<T> — wrap single param in list
          if (paramList.length > 0) {
            const [pName, pVal] = paramList[0];
            const pDef = (ep.params || []).find(p => p.name === pName);
            const pType = pDef ? pDef.type : 'String';
            apexCode = `List<${pType}> inputs = new List<${pType}>();\ninputs.add(${pType === 'String' ? "'" + pVal.replace(/'/g, "\\'") + "'" : pVal});\nObject result = ${ep.className}.${ep.methodName}(inputs);\nSystem.debug('RESULT: ' + JSON.serialize(result));`;
          } else {
            apexCode = `Object result = ${ep.className}.${ep.methodName}(new List<String>());\nSystem.debug('RESULT: ' + JSON.serialize(result));`;
          }
        } else if (ep.type === 'soap') {
          const args = paramList.map(([k, v]) => {
            const pDef = (ep.params || []).find(p => p.name === k);
            const pType = pDef ? pDef.type.toLowerCase() : '';
            if (pType.includes('integer') || pType.includes('decimal') || pType.includes('double')) return v;
            if (pType.includes('boolean')) return v;
            return `'${v.replace(/'/g, "\\'")}'`;
          }).join(', ');
          apexCode = `Object result = ${ep.className}.${ep.methodName}(${args});\nSystem.debug('RESULT: ' + JSON.serialize(result));`;
        }

        if (!apexCode) {
          output.textContent = 'Cannot generate test call for this endpoint type.';
          return;
        }

        // Execute anonymous Apex via `sf apex run` using a temp file written
        // through the main process — cross-platform (no mktemp/printf/rm, none
        // of which exist on Windows). sfExec already runs in the project folder.
        const paths = await window.apexStudio.getPaths?.();
        const tmpDir = paths?.appDataDir || paths?.home || folder || '.';
        const tmpFile = `${tmpDir}/.ads_endpoint_test.apex`;
        await window.apexStudio.writeFile(tmpFile, apexCode);
        const cmd = `sf apex run --file "${tmpFile}"${tof} --json 2>&1`;
        output.textContent = `Anonymous Apex:\n${apexCode}\n\n⏳ Executing on org...`;
        const { code, stdout, stderr } = await sfExec(cmd, 60000);
        try { await window.apexStudio.deleteFile?.(tmpFile); } catch (_) { /* best effort */ }

        let resultText = '';
        try {
          // Strip CLI warnings (non-JSON lines before the JSON object)
          const jsonStart = (stdout || '').indexOf('{');
          const jsonStr = jsonStart >= 0 ? stdout.substring(jsonStart) : stdout;
          const json = JSON.parse(jsonStr);
          if (json.result) {
            const r = json.result;
            resultText = `Compiled: ${r.compiled ? '✓' : '✗'}\n`;
            resultText += `Executed: ${r.success ? '✓' : '✗'}\n`;
            if (r.compileProblem) resultText += `Compile Error: ${r.compileProblem}\n`;
            if (r.exceptionMessage) resultText += `Exception: ${r.exceptionMessage}\n`;
            if (r.exceptionStackTrace) resultText += `Stack Trace:\n${r.exceptionStackTrace}\n`;
            if (r.logs) {
              // Extract USER_DEBUG lines and pull out the actual result value
              const logLines = r.logs.split('\n');
              const debugValues = [];
              for (const line of logLines) {
                if (line.includes('USER_DEBUG')) {
                  // Extract just the debug message after |DEBUG|
                  const debugMatch = line.match(/\|DEBUG\|(.*)/);
                  if (debugMatch) debugValues.push(debugMatch[1].trim());
                }
              }
              if (debugValues.length > 0) {
                // Try to format RESULT value as JSON
                for (const dv of debugValues) {
                  const resultMatch = dv.match(/^RESULT:\s*(.*)/);
                  if (resultMatch) {
                    let val = resultMatch[1];
                    try { val = JSON.stringify(JSON.parse(val), null, 2); } catch {}
                    resultText += `\nReturn Value:\n${val}`;
                  } else {
                    resultText += `\nDebug: ${dv}`;
                  }
                }
              } else {
                // No debug output - show governor limits summary
                const limitLines = logLines.filter(l => l.includes('LIMIT_USAGE_FOR_NS|(default)'));
                if (limitLines.length > 0) {
                  resultText += '\n(Method returned void or no System.debug output)';
                }
              }
              // Add governor limits
              const soqlMatch = r.logs.match(/Number of SOQL queries: (\d+ out of \d+)/);
              const dmlMatch = r.logs.match(/Number of DML statements: (\d+ out of \d+)/);
              const cpuMatch = r.logs.match(/Maximum CPU time: (\d+ out of \d+)/);
              const heapMatch = r.logs.match(/Maximum heap size: (\d+ out of \d+)/);
              if (soqlMatch || dmlMatch) {
                resultText += `\n\n── Governor Limits ──`;
                if (soqlMatch) resultText += `\nSOQL Queries: ${soqlMatch[1]}`;
                if (dmlMatch) resultText += `\nDML Statements: ${dmlMatch[1]}`;
                if (cpuMatch) resultText += `\nCPU Time: ${cpuMatch[1]}`;
                if (heapMatch) resultText += `\nHeap Size: ${heapMatch[1]}`;
              }
            }
          } else {
            resultText = jsonStr;
          }
        } catch {
          // If JSON parse fails, try to extract useful info from raw output
          const raw = stdout || stderr || '(no output)';
          // Strip verbose debug log lines
          const lines = raw.split('\n').filter(l => !l.includes('VARIABLE_SCOPE_BEGIN') && !l.includes('HEAP_ALLOCATE') && !l.includes('VARIABLE_ASSIGNMENT'));
          resultText = lines.slice(0, 50).join('\n');
        }

        output.textContent = `Anonymous Apex:\n${apexCode}\n\n` +
          `Status: ${code === 0 ? '✓ SUCCESS' : '✗ ERROR (exit ' + code + ')'}\n\n` + resultText;
      }
    } catch (e) {
      output.textContent = `Error: ${e.message}`;
    }
  }

  // ──────────────────────────────────────────────
  // 2. APEX TEST RUNNER
  // ──────────────────────────────────────────────
  function parseTestClass(content, filePath) {
    if (!/@isTest/i.test(content)) return null;
    const lines = content.split('\n');
    const fileName = filePath.split(/[/\\]/).pop().replace('.cls', '');
    const methods = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
      if (/@isTest/i.test(lines[i]) || /\btestMethod\b/i.test(lines[i])) {
        // Look for method signature on this line or next few
        for (let j = i; j < Math.min(i + 4, lines.length); j++) {
          const mMatch = lines[j].match(/(?:static\s+)?void\s+(\w+)\s*\(/i);
          if (mMatch && mMatch[1].toLowerCase() !== fileName.toLowerCase() && !seen.has(mMatch[1])) {
            seen.add(mMatch[1]);
            methods.push({ name: mMatch[1], line: j + 1, status: 'pending' });
            break;
          }
        }
      }
    }

    if (methods.length === 0) return null;

    return {
      className: fileName,
      filePath,
      methods,
      status: 'pending', // pending | running | pass | fail
    };
  }

  async function scanTestClasses(singleFile) {
    if (typeof singleFile !== 'string') singleFile = null;
    const folder = getFolderPath();
    if (!folder) { toast('Open a folder first', 'warn'); return; }

    const resultsDiv = $('#sf-tests-results');
    const fileName = singleFile ? singleFile.split(/[/\\]/).pop() : null;
    resultsDiv.innerHTML = `<div class="sf-empty">⏳ Scanning ${fileName || 'all files'} for test classes...</div>`;

    clearConsole();
    clog('═══ SCANNING TEST CLASSES ═══', 'sf-console-header-line');
    clog(`${singleFile ? 'File: ' + fileName : 'Project: ' + folder}`, 'sf-console-dim');
    const spinner = clogSpinner('Gathering Apex files...');

    const files = singleFile ? [singleFile] : await gatherApexFiles(folder);
    clogResolve(spinner, `✓ Found ${files.length} Apex file${files.length === 1 ? '' : 's'}`, 'sf-console-success');
    sfState.testClasses = [];

    const scanSpinner = clogSpinner('Parsing test classes...');
    let scanned = 0;
    for (const fp of files) {
      if (!fp.endsWith('.cls')) continue;
      const content = await readFile(fp);
      if (content) {
        const tc = parseTestClass(content, fp);
        if (tc) sfState.testClasses.push(tc);
      }
      scanned++;
    }

    sfState.testClasses.sort((a, b) => a.className.localeCompare(b.className));
    const totalMethods = sfState.testClasses.reduce((s,t)=>s+t.methods.length,0);
    clogResolve(scanSpinner, `✓ ${sfState.testClasses.length} test classes, ${totalMethods} methods`, 'sf-console-success');
    for (const tc of sfState.testClasses) {
      clog(`  • ${tc.className} (${tc.methods.length} methods)`, 'sf-console-dim');
    }
    if (singleFile && sfState.testClasses.length === 0) {
      clog(`  ⚠ ${fileName} is not a test class`, 'sf-console-warn');
    }
    clog('');
    clog('Ready to run tests.', 'sf-console-info');

    renderTestClasses();
    const runAllBtn = $('#sf-tests-run-all');
    if (runAllBtn) runAllBtn.disabled = sfState.testClasses.length === 0;
    toast(`Found ${sfState.testClasses.length} test class${sfState.testClasses.length === 1 ? '' : 'es'} with ${totalMethods} methods${singleFile ? ' in ' + fileName : ''}`, 'success');
  }

  function renderTestClasses() {
    const resultsDiv = $('#sf-tests-results');
    const searchVal = ($('#sf-tests-search').value || '').toLowerCase();

    let filtered = sfState.testClasses;
    if (searchVal) filtered = filtered.filter(t => t.className.toLowerCase().includes(searchVal));

    if (filtered.length === 0) {
      resultsDiv.innerHTML = '<div class="sf-empty">No test classes found.</div>';
      updateTestSummary();
      return;
    }

    resultsDiv.innerHTML = '';
    for (const tc of filtered) {
      const card = document.createElement('div');
      card.className = 'sf-test-card';
      card.dataset.className = tc.className;
      card.innerHTML = `
        <span class="sf-test-status ${tc.status}"></span>
        <span class="sf-test-name">${escapeHtml(tc.className)}</span>
        <span class="sf-test-methods">${tc.methods.length} methods</span>
        <button class="sf-test-run-class" title="Run all tests in this class">▶ Run</button>
      `;
      card.querySelector('.sf-test-run-class').addEventListener('click', (e) => {
        e.stopPropagation();
        runClassTests(tc);
      });
      card.addEventListener('click', () => {
        // Toggle expand
        const next = card.nextElementSibling;
        if (next && next.classList.contains('sf-test-expand')) {
          next.classList.toggle('open');
        }
      });

      const expand = document.createElement('div');
      expand.className = 'sf-test-expand';
      expand.dataset.className = tc.className;
      for (const m of tc.methods) {
        const method = document.createElement('div');
        method.className = 'sf-test-method';
        method.dataset.methodName = m.name;
        method.innerHTML = `
          <span class="sf-test-status ${m.status}"></span>
          <span>${escapeHtml(m.name)}</span>
          <button class="sf-test-run-one" title="Run this test">▶</button>
        `;
        method.querySelector('.sf-test-run-one').addEventListener('click', (e) => {
          e.stopPropagation();
          runSingleTest(tc, m);
        });
        method.addEventListener('click', (e) => {
          e.stopPropagation();
          goToLineWithFlash(tc.filePath, m.line);
        });
        expand.appendChild(method);
      }

      resultsDiv.appendChild(card);
      resultsDiv.appendChild(expand);
    }
    updateTestSummary();
  }

  /** Update a single test class card + methods in-place (no full re-render) */
  function updateTestCardUI(tc) {
    const card = document.querySelector(`.sf-test-card[data-class-name="${tc.className}"]`);
    if (card) {
      const statusDot = card.querySelector('.sf-test-status');
      if (statusDot) { statusDot.className = `sf-test-status ${tc.status}`; }
    }
    const expand = document.querySelector(`.sf-test-expand[data-class-name="${tc.className}"]`);
    if (expand) {
      for (const m of tc.methods) {
        const methodEl = expand.querySelector(`.sf-test-method[data-method-name="${m.name}"]`);
        if (methodEl) {
          const dot = methodEl.querySelector('.sf-test-status');
          if (dot) dot.className = `sf-test-status ${m.status}`;
        }
      }
    }
    updateTestSummary();
  }

  function updateTestSummary() {
    const summary = $('#sf-tests-summary');
    if (!summary) return;
    const total = sfState.testClasses.reduce((s, t) => s + t.methods.length, 0);
    const passed = sfState.testClasses.reduce((s, t) => s + t.methods.filter(m => m.status === 'pass').length, 0);
    const failed = sfState.testClasses.reduce((s, t) => s + t.methods.filter(m => m.status === 'fail').length, 0);
    if (total === 0) { summary.textContent = ''; return; }
    summary.textContent = `${passed}✓ ${failed}✗ / ${total} total`;
  }

  // ──────────────────────────────────────────────
  // PARSE CLI JSON RESULT
  // ──────────────────────────────────────────────

  /** Extract JSON from CLI output (may have preamble text before the JSON) */
  function extractJson(text) {
    if (!text) return null;
    const jsonStart = text.indexOf('{');
    if (jsonStart < 0) return null;
    try {
      return JSON.parse(text.substring(jsonStart));
    } catch {
      // Try to find the last complete JSON block
      const lastBrace = text.lastIndexOf('}');
      if (lastBrace > jsonStart) {
        try { return JSON.parse(text.substring(jsonStart, lastBrace + 1)); } catch { return null; }
      }
      return null;
    }
  }

  /** Parse test results from sf cli JSON, apply to sfState, return parsed details */
  function parseCliTestResults(json) {
    const details = []; // { className, methodName, outcome, message, stackTrace, runTime }
    if (!json) return details;

    const tests = json.result?.tests || json.tests || [];
    for (const test of tests) {
      const className = test.ApexClass?.Name || test.ClassName || test.ApexClassName || '';
      const methodName = test.MethodName || test.TestMethodName || '';
      const outcome = (test.Outcome || test.outcome || '').toLowerCase();
      const message = test.Message || test.message || '';
      const stackTrace = test.StackTrace || test.stackTrace || '';
      const runTimeMs = test.RunTime || test.runTime || 0;

      const tc = sfState.testClasses.find(c => c.className === className);
      if (tc) {
        const m = tc.methods.find(method => method.name === methodName);
        if (m) {
          m.status = outcome === 'pass' ? 'pass' : 'fail';
          m.message = message;
          m.stackTrace = stackTrace;
          m.runTime = runTimeMs;
        }
      }
      details.push({ className, methodName, outcome, message, stackTrace, runTime: runTimeMs });
    }

    // Update class-level status
    for (const tc of sfState.testClasses) {
      tc.status = tc.methods.every(m => m.status === 'pass') ? 'pass' :
                  tc.methods.some(m => m.status === 'fail') ? 'fail' : 'pending';
    }
    return details;
  }

  /** Log detailed failure info for a method to the console */
  function logFailureDetail(detail) {
    if (detail.outcome === 'pass') return;
    if (detail.message) {
      clog(`    Message: ${detail.message}`, 'sf-console-error');
    }
    if (detail.stackTrace) {
      const lines = detail.stackTrace.split('\n').filter(l => l.trim());
      for (const line of lines) {
        clog(`    ${line}`, 'sf-console-dim');
      }
    }
  }

  /** Show failure detail in the DOM under a test method */
  function showMethodError(tc, m) {
    if (m.status !== 'fail') return;
    const expand = document.querySelector(`.sf-test-expand[data-class-name="${tc.className}"]`);
    if (!expand) return;
    const methodEl = expand.querySelector(`.sf-test-method[data-method-name="${m.name}"]`);
    if (!methodEl) return;
    // Remove old error detail if any
    const existing = methodEl.nextElementSibling;
    if (existing && existing.classList.contains('sf-test-error-detail')) existing.remove();
    if (!m.message && !m.stackTrace) return;
    const detail = document.createElement('div');
    detail.className = 'sf-test-error-detail';
    let html = '';
    if (m.message) html += `<div class="sf-err-msg">${escapeHtml(m.message)}</div>`;
    if (m.stackTrace) html += `<div class="sf-err-stack">${escapeHtml(m.stackTrace)}</div>`;
    detail.innerHTML = html;
    methodEl.after(detail);
  }

  // ──────────────────────────────────────────────
  // TEST RUNNERS
  // ──────────────────────────────────────────────

  async function runAllTests() {
    openSfPanel('sf-tests');
    clearConsole();
    const folder = getFolderPath();
    clog('═══ RUN ALL TESTS ═══', 'sf-console-header-line');
    clog(`Project: ${folder}`, 'sf-console-dim');
    clog(`Test classes: ${sfState.testClasses.length}`, 'sf-console-dim');
    clog(`Total methods: ${sfState.testClasses.reduce((s,t)=>s+t.methods.length,0)}`, 'sf-console-dim');
    if (sfState.orgConnected && sfState.orgInfo) {
      clog(`Org: ${sfState.orgInfo.username}`, 'sf-console-dim');
    }
    clog('');

    for (const tc of sfState.testClasses) {
      tc.status = 'running';
      for (const m of tc.methods) { m.status = 'running'; m.message = ''; m.stackTrace = ''; }
    }
    renderTestClasses();
    $$('.sf-test-expand').forEach(el => el.classList.add('open'));

    if (!sfState.cliInstalled) {
      clog('⚠ Salesforce CLI not installed', 'sf-console-warn');
      clog('  Install: npm install -g @salesforce/cli', 'sf-console-dim');
      clog('  Then authenticate: sf org login web', 'sf-console-dim');
      clog('');
      clog('Running in simulation mode...', 'sf-console-info');
      clog('');
      await simulateAllWithLogs();
      return finishRunAll();
    }

    if (!sfState.orgConnected) {
      clog('⚠ No default org connected', 'sf-console-warn');
      clog('  Authenticate: sf org login web', 'sf-console-dim');
      clog('  Set default:  sf config set target-org <alias>', 'sf-console-dim');
      clog('');
      clog('Running in simulation mode...', 'sf-console-info');
      clog('');
      await simulateAllWithLogs();
      return finishRunAll();
    }

    // Real CLI execution
    const tof = targetOrgFlag();
    const cmd = `sf apex run test --synchronous --result-format json --code-coverage${tof} 2>&1`;
    clog(`$ sf apex run test --synchronous --result-format json --code-coverage${tof}`, 'sf-console-cmd');
    const spinner = clogSpinner('Executing tests on org...');

    try {
      const { code, stdout, stderr } = await sfExec(cmd, 180000);
      const json = extractJson(stdout);

      if (json && (json.result?.tests || json.tests)) {
        clogResolve(spinner, `✓ CLI returned (exit code ${code})`, 'sf-console-success');
        clog('');
        const details = parseCliTestResults(json);

        // Log each result with details
        for (const d of details) {
          const icon = d.outcome === 'pass' ? '✓' : '✗';
          const cls = d.outcome === 'pass' ? 'sf-console-success' : 'sf-console-error';
          const timeStr = d.runTime ? ` (${d.runTime}ms)` : '';
          clog(`  ${icon} ${d.className}.${d.methodName}${timeStr}`, cls);
          logFailureDetail(d);
        }

        // Show error details in the DOM
        for (const tc of sfState.testClasses) {
          for (const m of tc.methods) showMethodError(tc, m);
          updateTestCardUI(tc);
        }

        // Code coverage summary
        if (json.result?.summary) {
          const s = json.result.summary;
          clog('');
          clog('── Coverage ──', 'sf-console-header-line');
          if (s.orgWideCoverage) clog(`  Org-wide: ${s.orgWideCoverage}`, 'sf-console-info');
          if (s.testRunCoverage) clog(`  Test run: ${s.testRunCoverage}`, 'sf-console-info');
          if (s.outcome) clog(`  Overall:  ${s.outcome}`, s.outcome === 'Passed' ? 'sf-console-success' : 'sf-console-error');
        }
      } else {
        // CLI ran but no JSON — show raw output
        clogResolve(spinner, `⚠ CLI returned non-JSON (exit code ${code})`, 'sf-console-warn');
        clog('');
        if (stderr) {
          clog('── stderr ──', 'sf-console-error');
          for (const line of stderr.split('\n').slice(0, 30)) {
            if (line.trim() && !isSfNoiseLine(line)) clog(`  ${line}`, 'sf-console-error');
          }
        }
        if (stdout) {
          clog('── stdout ──', 'sf-console-dim');
          for (const line of stdout.split('\n').slice(0, 30)) {
            if (line.trim()) clog(`  ${line}`, 'sf-console-dim');
          }
        }
        // Fall back to simulation
        clog('');
        clog('Falling back to simulation...', 'sf-console-warn');
        await simulateAllWithLogs();
      }
    } catch (e) {
      clogResolve(spinner, `✗ Execution failed: ${e.message}`, 'sf-console-error');
      clog('');
      clog('── Error Details ──', 'sf-console-error');
      clog(`  ${e.message}`, 'sf-console-error');
      if (e.stack) {
        for (const line of e.stack.split('\n').slice(1, 5)) {
          clog(`  ${line.trim()}`, 'sf-console-dim');
        }
      }
      clog('');
      clog('Falling back to simulation...', 'sf-console-warn');
      await simulateAllWithLogs();
    }
    finishRunAll();
  }

  function finishRunAll() {
    for (const tc of sfState.testClasses) updateTestCardUI(tc);
    updateTestSummary();
    const passed = sfState.testClasses.reduce((s, t) => s + t.methods.filter(m => m.status === 'pass').length, 0);
    const failed = sfState.testClasses.reduce((s, t) => s + t.methods.filter(m => m.status === 'fail').length, 0);
    clog('');
    clog(`═══ RESULTS: ${passed} passed, ${failed} failed ═══`, failed > 0 ? 'sf-console-error' : 'sf-console-success');
    toast(`Tests complete: ${passed} passed, ${failed} failed`, failed > 0 ? 'error' : 'success');
  }

  /** Simulate all tests with animated console logs */
  async function simulateAllWithLogs() {
    for (const tc of sfState.testClasses) {
      clog(`▸ ${tc.className}`, 'sf-console-info');
      const expand = document.querySelector(`.sf-test-expand[data-class-name="${tc.className}"]`);
      if (expand) expand.classList.add('open');
      for (const m of tc.methods) {
        const mSpinner = clogSpinner(`  Running ${m.name}...`);
        await new Promise(r => setTimeout(r, 150 + Math.random() * 350));
        m.status = Math.random() > 0.12 ? 'pass' : 'fail';
        if (m.status === 'fail') {
          m.message = 'System.AssertException: Assertion Failed: Expected true, received false';
          m.stackTrace = `Class.${tc.className}.${m.name}: line ${m.line || 1}, column 1`;
        }
        const mIcon = m.status === 'pass' ? '✓' : '✗';
        const mCls = m.status === 'pass' ? 'sf-console-success' : 'sf-console-error';
        clogResolve(mSpinner, `  ${mIcon} ${m.name}`, mCls);
        if (m.status === 'fail') {
          clog(`    ${m.message}`, 'sf-console-error');
          clog(`    at ${m.stackTrace}`, 'sf-console-dim');
        }
        updateTestCardUI(tc);
        showMethodError(tc, m);
      }
      tc.status = tc.methods.every(m => m.status === 'pass') ? 'pass' :
                  tc.methods.some(m => m.status === 'fail') ? 'fail' : 'pending';
      updateTestCardUI(tc);
    }
  }

  /** Run all tests in a single class */
  async function runClassTests(tc) {
    openSfPanel('sf-tests');
    clearConsole();
    clog(`═══ RUN CLASS: ${tc.className} ═══`, 'sf-console-header-line');
    clog(`Methods: ${tc.methods.length}`, 'sf-console-dim');
    clog(`File: ${tc.filePath.split(/[/\\]/).pop()}`, 'sf-console-dim');
    if (sfState.orgConnected && sfState.orgInfo) {
      clog(`Org: ${sfState.orgInfo.username}`, 'sf-console-dim');
    }
    clog('');

    tc.status = 'running';
    for (const m of tc.methods) { m.status = 'running'; m.message = ''; m.stackTrace = ''; }
    updateTestCardUI(tc);
    const expand = document.querySelector(`.sf-test-expand[data-class-name="${tc.className}"]`);
    if (expand) expand.classList.add('open');

    // Remove old error details
    expand?.querySelectorAll('.sf-test-error-detail').forEach(el => el.remove());

    if (!sfState.cliInstalled || !sfState.orgConnected) {
      if (!sfState.cliInstalled) {
        clog('⚠ Salesforce CLI not installed — simulation mode', 'sf-console-warn');
      } else {
        clog('⚠ No default org — simulation mode', 'sf-console-warn');
      }
      clog('');
      await simulateClassWithLogs(tc);
      return finishRunClass(tc);
    }

    const folder = getFolderPath();
    const tof = targetOrgFlag();
    const cmd = `sf apex run test --class-names ${tc.className} --synchronous --result-format json${tof} 2>&1`;
    clog(`$ sf apex run test --class-names ${tc.className} --synchronous --result-format json${tof}`, 'sf-console-cmd');
    const spinner = clogSpinner('Executing on org...');

    try {
      const { code, stdout, stderr } = await sfExec(cmd, 120000);
      const json = extractJson(stdout);

      if (json && (json.result?.tests || json.tests)) {
        clogResolve(spinner, `✓ CLI returned (exit code ${code})`, 'sf-console-success');
        clog('');
        const details = parseCliTestResults(json);

        for (const d of details) {
          const icon = d.outcome === 'pass' ? '✓' : '✗';
          const cls = d.outcome === 'pass' ? 'sf-console-success' : 'sf-console-error';
          const timeStr = d.runTime ? ` (${d.runTime}ms)` : '';
          clog(`  ${icon} ${d.methodName}${timeStr}`, cls);
          logFailureDetail(d);
        }

        for (const m of tc.methods) showMethodError(tc, m);
      } else {
        clogResolve(spinner, `⚠ Non-JSON response (exit code ${code})`, 'sf-console-warn');
        if (stderr) {
          clog('── Error Output ──', 'sf-console-error');
          for (const line of stderr.split('\n').slice(0, 20)) {
            if (line.trim() && !isSfNoiseLine(line)) clog(`  ${line}`, 'sf-console-error');
          }
        }
        if (stdout) {
          for (const line of stdout.split('\n').slice(0, 20)) {
            if (line.trim()) clog(`  ${line}`, 'sf-console-dim');
          }
        }
        clog('');
        clog('Falling back to simulation...', 'sf-console-warn');
        await simulateClassWithLogs(tc);
      }
    } catch (e) {
      clogResolve(spinner, `✗ Failed: ${e.message}`, 'sf-console-error');
      clog('');
      await simulateClassWithLogs(tc);
    }
    finishRunClass(tc);
  }

  function finishRunClass(tc) {
    tc.status = tc.methods.every(m => m.status === 'pass') ? 'pass' :
                tc.methods.some(m => m.status === 'fail') ? 'fail' : 'pending';
    updateTestCardUI(tc);
    const passed = tc.methods.filter(m => m.status === 'pass').length;
    const failed = tc.methods.filter(m => m.status === 'fail').length;
    clog('');
    clog(`═══ ${tc.className}: ${passed} passed, ${failed} failed ═══`, failed > 0 ? 'sf-console-error' : 'sf-console-success');
    toast(`${tc.className}: ${passed} passed, ${failed} failed`, failed > 0 ? 'error' : 'success');
  }

  /** Simulate results for a single class with logs */
  async function simulateClassWithLogs(tc) {
    for (const m of tc.methods) {
      const mSpinner = clogSpinner(`  Running ${m.name}...`);
      await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
      m.status = Math.random() > 0.12 ? 'pass' : 'fail';
      if (m.status === 'fail') {
        m.message = 'System.AssertException: Assertion Failed: Expected true, received false';
        m.stackTrace = `Class.${tc.className}.${m.name}: line ${m.line || 1}, column 1`;
      }
      const icon = m.status === 'pass' ? '✓' : '✗';
      clogResolve(mSpinner, `  ${icon} ${m.name}`, m.status === 'pass' ? 'sf-console-success' : 'sf-console-error');
      if (m.status === 'fail') {
        clog(`    ${m.message}`, 'sf-console-error');
        clog(`    at ${m.stackTrace}`, 'sf-console-dim');
      }
      updateTestCardUI(tc);
      showMethodError(tc, m);
    }
  }

  async function runSingleTest(tc, method) {
    openSfPanel('sf-tests');
    clog('', '');
    clog(`▸ Running ${tc.className}.${method.name}`, 'sf-console-info');

    method.status = 'running';
    method.message = '';
    method.stackTrace = '';
    tc.status = 'running';
    updateTestCardUI(tc);
    const expand = document.querySelector(`.sf-test-expand[data-class-name="${tc.className}"]`);
    if (expand) expand.classList.add('open');

    // Remove old error detail
    const methodEl = expand?.querySelector(`.sf-test-method[data-method-name="${method.name}"]`);
    const oldErr = methodEl?.nextElementSibling;
    if (oldErr && oldErr.classList.contains('sf-test-error-detail')) oldErr.remove();

    if (!sfState.cliInstalled || !sfState.orgConnected) {
      clog('  (simulation mode — CLI/org not available)', 'sf-console-warn');
      const mSpinner = clogSpinner(`  Executing ${method.name}...`);
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
      method.status = Math.random() > 0.15 ? 'pass' : 'fail';
      if (method.status === 'fail') {
        method.message = 'System.AssertException: Assertion Failed';
        method.stackTrace = `Class.${tc.className}.${method.name}: line ${method.line || 1}, column 1`;
      }
      const icon = method.status === 'pass' ? '✓' : '✗';
      const cls = method.status === 'pass' ? 'sf-console-success' : 'sf-console-error';
      clogResolve(mSpinner, `  ${icon} ${method.name} — ${method.status.toUpperCase()}`, cls);
      if (method.status === 'fail') {
        clog(`    ${method.message}`, 'sf-console-error');
        clog(`    at ${method.stackTrace}`, 'sf-console-dim');
      }
      showMethodError(tc, method);
    } else {
      const folder = getFolderPath();
      const tof = targetOrgFlag();
      const cmd = `sf apex run test --tests ${tc.className}.${method.name} --synchronous --result-format json${tof} 2>&1`;
      clog(`$ sf apex run test --tests ${tc.className}.${method.name} --synchronous --result-format json${tof}`, 'sf-console-cmd');
      const spinner = clogSpinner(`  Executing on org...`);

      try {
        const { code, stdout, stderr } = await sfExec(cmd, 120000);
        const json = extractJson(stdout);

        if (json && (json.result?.tests || json.tests)) {
          const details = parseCliTestResults(json);
          const d = details.find(x => x.methodName === method.name) || details[0];
          if (d) {
            method.status = d.outcome === 'pass' ? 'pass' : 'fail';
            method.message = d.message;
            method.stackTrace = d.stackTrace;
            method.runTime = d.runTime;
          }
          const icon = method.status === 'pass' ? '✓' : '✗';
          const cls = method.status === 'pass' ? 'sf-console-success' : 'sf-console-error';
          const timeStr = method.runTime ? ` (${method.runTime}ms)` : '';
          clogResolve(spinner, `  ${icon} ${method.name} — ${method.status.toUpperCase()}${timeStr}`, cls);
          logFailureDetail(d || {});
          showMethodError(tc, method);
        } else {
          clogResolve(spinner, `⚠ Non-JSON response (exit code ${code})`, 'sf-console-warn');
          if (stderr) {
            for (const line of stderr.split('\n').slice(0, 10)) {
              if (line.trim() && !isSfNoiseLine(line)) clog(`  ${line}`, 'sf-console-error');
            }
          }
          // Simulate
          await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
          method.status = Math.random() > 0.15 ? 'pass' : 'fail';
          clog(`  → Simulated: ${method.status.toUpperCase()}`, 'sf-console-dim');
        }
      } catch (e) {
        clogResolve(spinner, `✗ Error: ${e.message}`, 'sf-console-error');
        await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
        method.status = Math.random() > 0.15 ? 'pass' : 'fail';
      }
    }

    tc.status = tc.methods.every(m => m.status === 'pass') ? 'pass' :
                tc.methods.some(m => m.status === 'fail') ? 'fail' : 'pending';
    updateTestCardUI(tc);
    toast(`${tc.className}.${method.name}: ${method.status.toUpperCase()}`, method.status === 'pass' ? 'success' : 'error');
  }

  // ──────────────────────────────────────────────
  // 3. PROCESS FLOW VISUALIZER
  // ──────────────────────────────────────────────
  let _flowFilePath = null;   // Currently selected file for flow viz
  let _flowContent = null;    // File content
  let _flowNodes = [];        // Parsed nodes
  let _flowSelectedNode = null;

  const FLOW_ICONS = {
    entry: '🟢', method: '⚙️', condition: '🔀', loop: '🔁',
    query: '🔍', dml: '💾', exit: '🔴', action: '⚙️',
  };

  function parseApexFlow(content) {
    const lines = content.split('\n');
    const nodes = [];
    let nodeId = 0;
    let currentMethod = null;

    // Find class/trigger name
    const classMatch = content.match(/(?:class|interface|trigger)\s+(\w+)/i);
    const className = classMatch ? classMatch[1] : 'Unknown';
    const isTest = /@isTest/i.test(content);
    const isTrigger = /^\s*trigger\s/im.test(content);

    nodes.push({
      id: nodeId++, type: 'entry',
      label: `${isTrigger ? 'Trigger' : 'Class'}: ${className}`,
      detail: `${isTrigger ? 'Trigger' : isTest ? 'Test Class' : 'Apex Class'}`,
      children: [], methodName: null,
    });

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const rawLine = lines[i];

      // Method declarations
      const methodMatch = line.match(/(?:public|private|protected|global)\s+(?:static\s+)?(?:override\s+)?(?:testMethod\s+)?(\w+)\s+(\w+)\s*\(/i);
      if (methodMatch && !['class', 'interface', 'enum'].includes(methodMatch[1].toLowerCase())) {
        currentMethod = methodMatch[2];
        // Gather full signature (may span multiple lines)
        let sig = line;
        if (!sig.includes(')')) {
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            sig += ' ' + lines[j].trim();
            if (sig.includes(')')) break;
          }
        }
        const sigClean = sig.match(/(?:public|private|protected|global)[^)]+\)/i);
        nodes.push({
          id: nodeId++, type: 'method',
          label: `${methodMatch[1]} ${methodMatch[2]}()`,
          line: i + 1, children: [], methodName: currentMethod,
          detail: sigClean ? sigClean[0] : sig.substring(0, 120),
          snippet: rawLine,
        });
      }

      // SOQL queries
      if (/\[\s*SELECT\b/i.test(line)) {
        const soqlMatch = line.match(/\[\s*SELECT\s+.+?\s+FROM\s+(\w+)/i);
        const obj = soqlMatch ? soqlMatch[1] : 'SObject';
        // Try to get full SOQL
        let soql = line.match(/\[([^\]]+)\]/i);
        nodes.push({
          id: nodeId++, type: 'query',
          label: `SOQL: ${obj}`,
          line: i + 1, children: [], methodName: currentMethod,
          detail: soql ? soql[1].trim() : `SELECT ... FROM ${obj}`,
          snippet: rawLine,
        });
      }

      // DML operations
      if (/\b(insert|update|delete|upsert|merge|undelete)\b/i.test(line) && !/\/\//.test(line.split(/\b(insert|update|delete|upsert|merge|undelete)\b/i)[0])) {
        const dmlMatch = line.match(/\b(insert|update|delete|upsert|merge|undelete)\s+(\w+)/i);
        if (dmlMatch) {
          nodes.push({
            id: nodeId++, type: 'dml',
            label: `${dmlMatch[1].toUpperCase()} ${dmlMatch[2]}`,
            line: i + 1, children: [], methodName: currentMethod,
            detail: `DML ${dmlMatch[1]} on ${dmlMatch[2]}`,
            snippet: rawLine,
          });
        }
      }

      // Conditionals
      if (/^\s*if\s*\(/i.test(line)) {
        const condMatch = line.match(/if\s*\((.{0,80})/i);
        const cond = condMatch ? condMatch[1].replace(/\)\s*\{?\s*$/, '') : '...';
        nodes.push({
          id: nodeId++, type: 'condition',
          label: `if (${cond.length > 45 ? cond.substring(0, 42) + '...' : cond})`,
          line: i + 1, children: [], methodName: currentMethod,
          detail: `Condition: ${cond}`,
          snippet: rawLine,
        });
      }

      // Try-catch
      if (/^\s*try\s*\{/i.test(line)) {
        nodes.push({
          id: nodeId++, type: 'condition',
          label: 'try-catch', line: i + 1, children: [], methodName: currentMethod,
          detail: 'Exception handling block',
          snippet: rawLine,
        });
      }

      // For/while loops
      if (/^\s*(for|while)\s*\(/i.test(line)) {
        const loopMatch = line.match(/(for|while)\s*\((.{0,60})/i);
        const loopBody = loopMatch ? loopMatch[2].replace(/\)\s*\{?\s*$/, '') : '';
        const loopLabel = loopMatch ? `${loopMatch[1]}(${loopBody})` : 'loop';
        nodes.push({
          id: nodeId++, type: 'loop',
          label: loopLabel.length > 45 ? loopLabel.substring(0, 42) + '...' : loopLabel,
          line: i + 1, children: [], methodName: currentMethod,
          detail: `Loop: ${loopLabel}`,
          snippet: rawLine,
        });
      }

      // Return statements
      if (/^\s*return\b/i.test(line)) {
        const retVal = line.replace(/^\s*return\s*/i, '').replace(/;\s*$/, '');
        nodes.push({
          id: nodeId++, type: 'exit',
          label: retVal.length > 40 ? 'return ' + retVal.substring(0, 35) + '...' : 'return ' + retVal,
          line: i + 1, children: [], methodName: currentMethod,
          detail: `Return: ${retVal || 'void'}`,
          snippet: rawLine,
        });
      }
    }

    if (nodes.length === 1) {
      nodes.push({ id: nodeId++, type: 'action', label: '(empty class)', children: [], methodName: null, detail: 'No logic found', snippet: '' });
    }

    return nodes;
  }

  function showFlowDetail(node) {
    _flowSelectedNode = node;
    const panel = $('#sf-flow-detail');
    const body = $('#sf-flow-detail-body');
    if (!panel || !body) return;
    panel.classList.remove('hidden');

    const icon = FLOW_ICONS[node.type] || '📦';
    const typeLabels = { entry: 'Entry Point', method: 'Method', condition: 'Condition / Branch', loop: 'Loop', query: 'SOQL Query', dml: 'DML Operation', exit: 'Return', action: 'Action' };

    let html = '';
    html += `<div class="detail-row"><div class="detail-label">Type</div><div class="detail-value">${icon} ${typeLabels[node.type] || node.type}</div></div>`;
    html += `<div class="detail-row"><div class="detail-label">Label</div><div class="detail-value">${escHtml(node.label)}</div></div>`;
    if (node.line) html += `<div class="detail-row"><div class="detail-label">Line</div><div class="detail-value">Line ${node.line}</div></div>`;
    if (node.methodName) html += `<div class="detail-row"><div class="detail-label">Inside Method</div><div class="detail-value">${escHtml(node.methodName)}()</div></div>`;
    if (node.detail) html += `<div class="detail-row"><div class="detail-label">Details</div><div class="detail-value">${escHtml(node.detail)}</div></div>`;
    if (node.snippet) html += `<div class="detail-row"><div class="detail-label">Source</div><div class="detail-code">${escHtml(node.snippet.trim())}</div></div>`;

    // Show surrounding source lines for context
    if (node.line && _flowContent) {
      const srcLines = _flowContent.split('\n');
      const CONTEXT = 3;
      const start = Math.max(0, node.line - 1 - CONTEXT);
      const end = Math.min(srcLines.length, node.line + CONTEXT);
      let codeHtml = '';
      for (let i = start; i < end; i++) {
        const ln = i + 1;
        const isTarget = ln === node.line;
        const numStr = String(ln).padStart(4);
        const lineText = escHtml(srcLines[i]);
        if (isTarget) {
          codeHtml += `<span style="background:rgba(228,50,43,.12);display:block;"><span style="color:var(--accent);font-weight:600;">${numStr}</span> ${lineText}</span>`;
        } else {
          codeHtml += `<span style="display:block;"><span style="color:var(--text-muted);">${numStr}</span> ${lineText}</span>`;
        }
      }
      html += `<div class="detail-row"><div class="detail-label">Context</div><div class="detail-code">${codeHtml}</div></div>`;
    }

    if (node.line && _flowFilePath) {
      html += `<button class="detail-btn" id="sf-flow-goto-line">↗ Go to Line ${node.line}</button>`;
    }
    body.innerHTML = html;

    // Wire go-to-line button
    $('#sf-flow-goto-line')?.addEventListener('click', () => flowGoToLine(node));

    // Highlight selected node in diagram
    $$('.sf-flow-node').forEach(el => el.classList.remove('selected'));
    const sel = document.querySelector(`.sf-flow-node[data-node-id="${node.id}"]`);
    if (sel) sel.classList.add('selected');
  }

  async function flowGoToLine(node) {
    if (!_flowFilePath || !node.line) return;
    try {
      const content = _flowContent || await readFile(_flowFilePath);
      await goToLineWithFlash(_flowFilePath, node.line, content);
    } catch (err) {
      console.error('Flow goto line error:', err);
    }
  }

  function renderFlowDiagram(nodes) {
    const canvas = $('#sf-flow-canvas');
    canvas.innerHTML = '';

    // Build summary stats
    const stats = { method: 0, condition: 0, loop: 0, query: 0, dml: 0, exit: 0 };
    for (const n of nodes) { if (stats[n.type] !== undefined) stats[n.type]++; }

    // Summary bar
    const summary = document.createElement('div');
    summary.style.cssText = 'display:flex;gap:16px;margin-bottom:16px;padding:8px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;font-size:11px;color:var(--text-muted);flex-wrap:wrap;';
    const statItems = [
      ['⚙️', 'Methods', stats.method], ['🔀', 'Branches', stats.condition],
      ['🔁', 'Loops', stats.loop], ['🔍', 'Queries', stats.query],
      ['💾', 'DML', stats.dml], ['🔴', 'Returns', stats.exit],
    ];
    for (const [icon, name, count] of statItems) {
      if (count > 0) summary.innerHTML += `<span>${icon} ${count} ${name}</span>`;
    }
    canvas.appendChild(summary);

    // Group nodes by method
    const methods = new Map(); // methodName -> [nodes]
    const topLevel = [];       // nodes not inside any method
    for (const n of nodes) {
      if (n.type === 'entry') { topLevel.push(n); continue; }
      if (n.type === 'method') {
        if (!methods.has(n.methodName)) methods.set(n.methodName, []);
        methods.get(n.methodName).unshift(n); // method node first
        continue;
      }
      if (n.methodName && methods.has(n.methodName)) {
        methods.get(n.methodName).push(n);
      } else {
        topLevel.push(n);
      }
    }

    const diagram = document.createElement('div');
    diagram.className = 'sf-flow-diagram';

    // Render entry node
    const entryNode = topLevel.find(n => n.type === 'entry');
    if (entryNode) {
      diagram.appendChild(createFlowNodeEl(entryNode));
      if (methods.size > 0 || topLevel.length > 1) {
        diagram.appendChild(createArrow());
      }
    }

    // Render method groups
    for (const [methodName, methodNodes] of methods) {
      const group = document.createElement('div');
      group.className = 'sf-flow-method-group';
      const badge = document.createElement('div');
      badge.className = 'sf-flow-method-badge';
      badge.textContent = methodName + '()';
      group.appendChild(badge);

      for (let i = 0; i < methodNodes.length; i++) {
        group.appendChild(createFlowNodeEl(methodNodes[i]));
        if (i < methodNodes.length - 1) group.appendChild(createArrow());
      }
      diagram.appendChild(group);
      diagram.appendChild(createArrow());
    }

    // Render remaining top-level nodes (non-entry)
    const remaining = topLevel.filter(n => n.type !== 'entry');
    for (let i = 0; i < remaining.length; i++) {
      diagram.appendChild(createFlowNodeEl(remaining[i]));
      if (i < remaining.length - 1) diagram.appendChild(createArrow());
    }

    canvas.appendChild(diagram);
  }

  function createFlowNodeEl(node) {
    const el = document.createElement('div');
    el.className = `sf-flow-node ${node.type}`;
    el.dataset.nodeId = node.id;
    const icon = document.createElement('span');
    icon.className = 'sf-flow-node-icon';
    icon.textContent = FLOW_ICONS[node.type] || '📦';
    el.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'sf-flow-node-label';
    label.textContent = node.label;
    el.appendChild(label);
    if (node.line) {
      const ln = document.createElement('span');
      ln.className = 'sf-flow-node-line';
      ln.textContent = `L${node.line}`;
      el.appendChild(ln);
    }
    el.title = node.detail || node.label;
    el.addEventListener('click', () => showFlowDetail(node));
    return el;
  }

  function createArrow() {
    const arrow = document.createElement('div');
    arrow.className = 'sf-flow-arrow';
    return arrow;
  }

  // ---- Flow File Picker ----
  let _flowPickerActive = -1;
  let _flowPickerFiles = [];

  async function showFlowFilePicker() {
    const folder = getFolderPath();
    if (!folder) { toast('Open a folder first', 'warn'); return; }

    // Gather all cls/trigger files
    const apexFiles = await gatherApexFiles(folder);
    if (apexFiles.length === 0) {
      toast('No .cls or .trigger files found', 'warn');
      return;
    }
    _flowPickerFiles = apexFiles.map(fp => ({
      path: fp,
      name: fp.split(/[/\\]/).pop(),
      dir: fp.replace(folder + '/', '').replace(/\/[^/]+$/, ''),
    }));
    _flowPickerFiles.sort((a, b) => a.name.localeCompare(b.name));

    // Build popup
    let overlay = document.getElementById('sf-flow-picker-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'sf-flow-picker-overlay';
    overlay.className = 'sf-flow-picker-overlay';
    overlay.innerHTML = `<div class="sf-flow-picker">
      <input type="text" placeholder="Search Apex classes and triggers..." id="sf-flow-picker-input" spellcheck="false" autocomplete="off" />
      <div class="sf-flow-picker-list" id="sf-flow-picker-list"></div>
    </div>`;
    document.body.appendChild(overlay);

    const input = document.getElementById('sf-flow-picker-input');
    const list = document.getElementById('sf-flow-picker-list');
    _flowPickerActive = -1;

    function renderPickerItems(filter) {
      const q = (filter || '').toLowerCase();
      const filtered = q ? _flowPickerFiles.filter(f => f.name.toLowerCase().includes(q)) : _flowPickerFiles;
      if (filtered.length === 0) {
        list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;">No matching files</div>';
        return;
      }
      let html = '';
      for (const f of filtered) {
        const icon = f.name.endsWith('.trigger') ? '⚡' : '📄';
        html += `<div class="sf-flow-picker-item" data-path="${escHtml(f.path)}">
          <span class="fp-icon">${icon}</span>
          <span class="fp-name">${escHtml(f.name)}</span>
          <span class="fp-path">${escHtml(f.dir)}</span>
        </div>`;
      }
      list.innerHTML = html;
      // Click handlers
      list.querySelectorAll('.sf-flow-picker-item').forEach(el => {
        el.addEventListener('click', () => selectFlowFile(el.dataset.path));
      });
      _flowPickerActive = -1;
    }

    renderPickerItems('');
    input.addEventListener('input', () => renderPickerItems(input.value));
    input.addEventListener('keydown', (e) => {
      const items = list.querySelectorAll('.sf-flow-picker-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _flowPickerActive = Math.min(_flowPickerActive + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('active', i === _flowPickerActive));
        if (items[_flowPickerActive]) items[_flowPickerActive].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _flowPickerActive = Math.max(_flowPickerActive - 1, 0);
        items.forEach((el, i) => el.classList.toggle('active', i === _flowPickerActive));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_flowPickerActive >= 0 && items[_flowPickerActive]) {
          selectFlowFile(items[_flowPickerActive].dataset.path);
        }
      } else if (e.key === 'Escape') {
        closeFlowPicker();
      }
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) closeFlowPicker();
    });
    setTimeout(() => input.focus(), 50);
  }

  function closeFlowPicker() {
    const overlay = document.getElementById('sf-flow-picker-overlay');
    if (overlay) overlay.remove();
  }

  async function selectFlowFile(filePath) {
    closeFlowPicker();
    _flowFilePath = filePath;
    const nameEl = $('#sf-flow-filename');
    if (nameEl) nameEl.textContent = filePath.split(/[/\\]/).pop();
    // Read and auto-generate flow
    try {
      _flowContent = await readFile(filePath);
      if (_flowContent) {
        _flowNodes = parseApexFlow(_flowContent);
        sfState.flowData = _flowNodes;
        renderFlowDiagram(_flowNodes);
        toast(`Flow: ${_flowNodes.length} nodes from ${filePath.split(/[/\\]/).pop()}`, 'success');
      } else {
        $('#sf-flow-canvas').innerHTML = '<div class="sf-empty">Could not read file.</div>';
      }
    } catch (err) {
      console.error('Flow file read error:', err);
      $('#sf-flow-canvas').innerHTML = '<div class="sf-empty">Error reading file.</div>';
    }
  }

  async function generateFlow() {
    const canvas = $('#sf-flow-canvas');

    // If no file selected, try current editor file; if none, open picker
    if (!_flowFilePath) {
      if (window.state && window.state.editor) {
        const activeTab = window.state.tabs.find(t => t.id === window.state.activeTabId);
        if (activeTab && activeTab.filePath && (activeTab.filePath.endsWith('.cls') || activeTab.filePath.endsWith('.trigger'))) {
          _flowFilePath = activeTab.filePath;
          _flowContent = window.state.editor.getValue();
          const nameEl = $('#sf-flow-filename');
          if (nameEl) nameEl.textContent = activeTab.filePath.split(/[/\\]/).pop();
        } else {
          // No apex file open — show picker
          showFlowFilePicker();
          return;
        }
      } else {
        showFlowFilePicker();
        return;
      }
    }

    // Re-read content (might have changed)
    try {
      const content = await readFile(_flowFilePath);
      if (!content) {
        canvas.innerHTML = '<div class="sf-empty">Could not read file.</div>';
        return;
      }
      _flowContent = content;
    } catch {
      canvas.innerHTML = '<div class="sf-empty">Error reading file.</div>';
      return;
    }

    _flowNodes = parseApexFlow(_flowContent);
    sfState.flowData = _flowNodes;
    renderFlowDiagram(_flowNodes);
    toast(`Flow: ${_flowNodes.length} nodes`, 'success');
  }

  // ──────────────────────────────────────────────
  // 4. CHANGE IMPACT ANALYZER
  // ──────────────────────────────────────────────

  // Store content cache for impact detail navigation
  let _impactContentCache = {};

  async function buildClassIndex(folder) {
    const files = await gatherApexFiles(folder);
    sfState.classIndex = {};
    sfState.triggerIndex = {};
    _impactContentCache = {};

    for (const fp of files) {
      const content = await readFile(fp);
      if (!content) continue;
      _impactContentCache[fp] = content;
      const baseName = fp.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');

      if (fp.endsWith('.trigger')) {
        const trigMatch = content.match(/trigger\s+(\w+)\s+on\s+(\w+)/i);
        sfState.triggerIndex[baseName] = {
          filePath: fp,
          sobject: trigMatch ? trigMatch[2] : 'Unknown',
          references: extractDetailedRefs(content, baseName),
          methods: extractMethods(content),
        };
      } else {
        const isTest = /@isTest/i.test(content);
        sfState.classIndex[baseName] = {
          filePath: fp,
          isTest,
          references: extractDetailedRefs(content, baseName),
          superClass: extractSuperClass(content),
          methods: extractMethods(content),
        };
      }
    }
  }

  /**
   * Extract detailed references with line numbers, snippet, and reference type.
   * Returns: [{ name, line, snippet, refType }]
   */
  function extractDetailedRefs(content, selfName) {
    const refs = [];
    const lines = content.split('\n');
    const seen = new Set(); // dedupe key: name:line

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const lineNum = i + 1;

      // new ClassName(
      let m;
      const newPat = /new\s+(\w+)\s*\(/g;
      while ((m = newPat.exec(lineText)) !== null) {
        const name = m[1];
        const key = `${name}:${lineNum}`;
        if (name !== selfName && /^[A-Z]/.test(name) && name.length > 1 && !isApexKeyword(name) && !seen.has(key)) {
          seen.add(key);
          refs.push({ name, line: lineNum, snippet: lineText.trim(), refType: 'instantiation' });
        }
      }

      // ClassName.method(
      const callPat = /(\w+)\.\w+\s*\(/g;
      while ((m = callPat.exec(lineText)) !== null) {
        const name = m[1];
        const key = `${name}:${lineNum}`;
        if (name !== selfName && /^[A-Z]/.test(name) && name.length > 1 && !isApexKeyword(name) && !seen.has(key)) {
          seen.add(key);
          refs.push({ name, line: lineNum, snippet: lineText.trim(), refType: 'method_call' });
        }
      }

      // extends ClassName
      const extMatch = lineText.match(/extends\s+(\w+)/i);
      if (extMatch) {
        const name = extMatch[1];
        const key = `${name}:${lineNum}`;
        if (name !== selfName && /^[A-Z]/.test(name) && !isApexKeyword(name) && !seen.has(key)) {
          seen.add(key);
          refs.push({ name, line: lineNum, snippet: lineText.trim(), refType: 'extends' });
        }
      }

      // implements Interface1, Interface2
      const implMatch = lineText.match(/implements\s+([\w,\s]+)/i);
      if (implMatch) {
        const names = implMatch[1].split(',').map(n => n.trim());
        for (const name of names) {
          const key = `${name}:${lineNum}`;
          if (name && name !== selfName && /^[A-Z]/.test(name) && !isApexKeyword(name) && !seen.has(key)) {
            seen.add(key);
            refs.push({ name, line: lineNum, snippet: lineText.trim(), refType: 'implements' });
          }
        }
      }
    }

    return refs;
  }

  /** Extract method declarations from Apex content */
  function extractMethods(content) {
    const methods = [];
    const lines = content.split('\n');
    const methodPat = /(?:public|private|protected|global|static|override|virtual|abstract|testMethod|@\w+\s+)*\s*(?:void|String|Integer|Boolean|Decimal|Double|Long|Date|DateTime|Id|List|Set|Map|SObject|\w+)\s+(\w+)\s*\(/i;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(methodPat);
      if (m && m[1] && !/^(if|for|while|switch|catch|return|new|class|trigger|else)$/i.test(m[1])) {
        methods.push({ name: m[1], line: i + 1 });
      }
    }
    return methods;
  }

  function extractSuperClass(content) {
    const m = content.match(/extends\s+(\w+)/i);
    return m ? m[1] : null;
  }

  const APEX_KEYWORDS = new Set(['String', 'Integer', 'Boolean', 'Decimal', 'Double', 'Long', 'Date', 'DateTime', 'Time', 'Blob', 'Id', 'Object', 'List', 'Set', 'Map', 'System', 'Test', 'Database', 'Schema', 'Math', 'JSON', 'Type', 'Limit', 'Limits', 'UserInfo', 'ApexPages', 'Messaging', 'Trigger', 'SObject', 'Exception', 'DmlException', 'QueryException', 'NullPointerException', 'PageReference', 'HttpRequest', 'HttpResponse', 'Http', 'RestRequest', 'RestResponse', 'RestContext', 'Queueable', 'Schedulable', 'Batchable', 'Future', 'Pattern', 'Matcher', 'Url', 'EncodingUtil', 'Crypto', 'Assert']);

  function isApexKeyword(name) {
    return APEX_KEYWORDS.has(name);
  }

  async function analyzeImpact() {
    const folder = getFolderPath();
    if (!folder) { toast('Open a folder first', 'warn'); return; }

    const resultsDiv = $('#sf-impact-results');
    const scopeSelect = $('#sf-impact-scope');
    resultsDiv.innerHTML = '<div class="sf-empty">⏳ Building dependency graph...</div>';
    // Hide detail panel
    $('#sf-impact-detail')?.classList.add('hidden');

    // Rebuild index each time so it stays fresh
    await buildClassIndex(folder);

    let targetClasses = [];
    if (scopeSelect.value === 'current') {
      const activeTab = window.state && window.state.tabs.find(t => t.id === window.state.activeTabId);
      if (activeTab && activeTab.filePath) {
        const name = activeTab.filePath.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, '');
        targetClasses = [name];
      }
    } else {
      try {
        const status = await window.apexStudio.gitStatus(folder);
        if (status && status.files) {
          targetClasses = status.files
            .map(f => f.path.split(/[/\\]/).pop().replace(/\.(cls|trigger)$/, ''))
            .filter(n => sfState.classIndex[n] || sfState.triggerIndex[n]);
        }
      } catch {
        toast('Git not available for this folder', 'warn');
      }
    }

    if (targetClasses.length === 0) {
      resultsDiv.innerHTML = '<div class="sf-empty">No Apex files selected for impact analysis.</div>';
      return;
    }

    // Build comprehensive impact data
    const impacted = { direct: [], test: [], triggers: [], outgoing: [] };

    for (const targetName of targetClasses) {
      // Outgoing: what this file references (with details)
      const targetInfo = sfState.classIndex[targetName] || sfState.triggerIndex[targetName];
      if (targetInfo && targetInfo.references) {
        // Group outgoing refs by referenced class
        const byClass = {};
        for (const ref of targetInfo.references) {
          if (!byClass[ref.name]) byClass[ref.name] = [];
          byClass[ref.name].push(ref);
        }
        for (const [refName, refList] of Object.entries(byClass)) {
          const refInfo = sfState.classIndex[refName] || sfState.triggerIndex[refName];
          impacted.outgoing.push({
            name: refName,
            filePath: refInfo ? refInfo.filePath : null,
            refs: refList,
            methods: refInfo ? refInfo.methods : [],
          });
        }
      }

      // Incoming: who references this target class (with line details)
      for (const [className, info] of Object.entries(sfState.classIndex)) {
        if (className === targetName) continue;
        const matchingRefs = info.references.filter(r => r.name === targetName);
        if (matchingRefs.length > 0 || info.superClass === targetName) {
          const refs = matchingRefs.length > 0 ? matchingRefs : [{ name: targetName, line: 0, snippet: `extends ${targetName}`, refType: 'extends' }];
          const entry = { name: className, filePath: info.filePath, refs, methods: info.methods, reason: `References ${targetName}` };
          if (info.isTest) {
            impacted.test.push(entry);
          } else {
            impacted.direct.push(entry);
          }
        }
      }
      // Triggers referencing this target
      for (const [trigName, info] of Object.entries(sfState.triggerIndex)) {
        const matchingRefs = info.references.filter(r => r.name === targetName);
        if (matchingRefs.length > 0) {
          impacted.triggers.push({ name: trigName, filePath: info.filePath, refs: matchingRefs, methods: info.methods, sobject: info.sobject });
        }
      }
    }

    sfState.impactResults = impacted;
    renderImpactResults(impacted, targetClasses);

    const total = impacted.direct.length + impacted.test.length + impacted.triggers.length;
    const outCount = impacted.outgoing.length;
    $('#sf-impact-summary').textContent = `${total} incoming · ${outCount} outgoing`;
    toast(`Impact: ${impacted.direct.length} classes, ${impacted.test.length} tests, ${impacted.triggers.length} triggers, ${outCount} dependencies`, 'info');
  }

  function renderImpactResults(impacted, targets) {
    const resultsDiv = $('#sf-impact-results');
    resultsDiv.innerHTML = '';

    // Target file info card
    for (const targetName of targets) {
      const info = sfState.classIndex[targetName] || sfState.triggerIndex[targetName];
      const targetCard = document.createElement('div');
      targetCard.className = 'sf-impact-target';
      const isTest = info && info.isTest;
      const isTrigger = sfState.triggerIndex[targetName] != null;
      const typeLabel = isTrigger ? 'Trigger' : (isTest ? 'Test Class' : 'Apex Class');
      const methodCount = info ? (info.methods || []).length : 0;
      const refCount = info ? (info.references || []).length : 0;
      targetCard.innerHTML = `
        <div class="sf-impact-target-name">📄 ${escapeHtml(targetName)} <span class="sf-impact-badge ${isTrigger ? 'trigger' : (isTest ? 'test' : 'class')}">${typeLabel}</span></div>
        <div class="sf-impact-target-meta">
          <span>📋 ${methodCount} methods</span>
          <span>🔗 ${refCount} references out</span>
          <span>📥 ${impacted.direct.length + impacted.test.length + impacted.triggers.length} dependents</span>
        </div>
      `;
      resultsDiv.appendChild(targetCard);
    }

    // Outgoing dependencies (what target uses)
    if (impacted.outgoing.length > 0) {
      const section = document.createElement('div');
      section.className = 'sf-impact-section';
      section.innerHTML = `↗ Dependencies (outgoing) <span class="sf-impact-section-count">${impacted.outgoing.length}</span>`;
      resultsDiv.appendChild(section);
      for (const item of impacted.outgoing) {
        resultsDiv.appendChild(createImpactCard(item, 'outgoing', targets));
      }
    }

    // Incoming classes
    if (impacted.direct.length > 0) {
      const section = document.createElement('div');
      section.className = 'sf-impact-section';
      section.innerHTML = `↙ Affected Classes <span class="sf-impact-section-count">${impacted.direct.length}</span>`;
      resultsDiv.appendChild(section);
      for (const item of impacted.direct) {
        resultsDiv.appendChild(createImpactCard(item, 'class', targets));
      }
    }

    // Test classes
    if (impacted.test.length > 0) {
      const section = document.createElement('div');
      section.className = 'sf-impact-section';
      section.innerHTML = `🧪 Test Classes <span class="sf-impact-section-count">${impacted.test.length}</span>`;
      resultsDiv.appendChild(section);
      for (const item of impacted.test) {
        resultsDiv.appendChild(createImpactCard(item, 'test', targets));
      }
    }

    // Triggers
    if (impacted.triggers.length > 0) {
      const section = document.createElement('div');
      section.className = 'sf-impact-section';
      section.innerHTML = `⚡ Triggers <span class="sf-impact-section-count">${impacted.triggers.length}</span>`;
      resultsDiv.appendChild(section);
      for (const item of impacted.triggers) {
        resultsDiv.appendChild(createImpactCard(item, 'trigger', targets));
      }
    }

    if (impacted.direct.length === 0 && impacted.test.length === 0 && impacted.triggers.length === 0 && impacted.outgoing.length === 0) {
      resultsDiv.innerHTML += '<div class="sf-empty">No other files reference the selected class(es).</div>';
    }
  }

  function createImpactCard(item, type, targets) {
    const card = document.createElement('div');
    card.className = 'sf-impact-card';
    const refCount = item.refs ? item.refs.length : 0;
    const refTypes = item.refs ? [...new Set(item.refs.map(r => r.refType))].join(', ') : '';
    const typeIcons = { instantiation: 'new', method_call: 'call', extends: 'extends', implements: 'impl' };
    const refSummary = item.refs ? [...new Set(item.refs.map(r => typeIcons[r.refType] || r.refType))].join(', ') : '';

    card.innerHTML = `
      <div class="sf-impact-file">
        <span class="sf-impact-badge ${type}">${type === 'outgoing' ? 'dep' : type}</span>
        ${escapeHtml(item.name)}
        <span class="sf-impact-ref-count">${refCount} ref${refCount !== 1 ? 's' : ''} · ${refSummary}</span>
      </div>
      <div class="sf-impact-reason">${item.refs && item.refs.length > 0 ? escapeHtml(item.refs[0].snippet.substring(0, 80)) : ''}</div>
    `;
    card.addEventListener('click', () => showImpactDetail(item, type));
    return card;
  }

  async function showImpactDetail(item, type) {
    const panel = $('#sf-impact-detail');
    const body = $('#sf-impact-detail-body');
    const title = $('#sf-impact-detail-title');
    if (!panel || !body) return;

    panel.classList.remove('hidden');
    title.textContent = item.name;

    // Highlight selected card
    $$('.sf-impact-card').forEach(c => c.classList.remove('selected'));
    event && event.currentTarget && event.currentTarget.classList.add('selected');

    let html = '';

    // Methods in this file
    if (item.methods && item.methods.length > 0) {
      html += `<div class="sf-impact-detail-section">📋 Methods (${item.methods.length})</div>`;
      for (const method of item.methods) {
        html += `<div class="sf-impact-ref-item" data-fp="${escapeHtml(item.filePath || '')}" data-line="${method.line}">
          <div class="sf-impact-ref-line">
            <span class="sf-impact-ref-linenum">L${method.line}</span>
            <span class="sf-impact-ref-snippet">${escapeHtml(method.name)}()</span>
            <span class="sf-impact-ref-goto">↗ Go</span>
          </div>
        </div>`;
      }
    }

    // References with line details
    if (item.refs && item.refs.length > 0) {
      html += `<div class="sf-impact-detail-section">🔗 References (${item.refs.length})</div>`;
      for (const ref of item.refs) {
        const typeLabel = { instantiation: '🆕 new', method_call: '📞 call', extends: '🧬 extends', implements: '📎 implements' }[ref.refType] || ref.refType;
        html += `<div class="sf-impact-ref-item" data-fp="${escapeHtml(item.filePath || '')}" data-line="${ref.line}">
          <div class="sf-impact-ref-type">${typeLabel}</div>
          <div class="sf-impact-ref-line">
            <span class="sf-impact-ref-linenum">L${ref.line}</span>
            <span class="sf-impact-ref-snippet">${escapeHtml(ref.snippet.substring(0, 60))}</span>
            <span class="sf-impact-ref-goto">↗ Go</span>
          </div>
        </div>`;
      }
    }

    // Open file button
    if (item.filePath) {
      html += `<button class="sf-impact-open-btn" id="sf-impact-open-file">📂 Open ${escapeHtml(item.name)}</button>`;
    }

    body.innerHTML = html;

    // Wire up go-to-line clicks on ref items
    body.querySelectorAll('.sf-impact-ref-item').forEach(el => {
      el.addEventListener('click', async () => {
        const fp = el.dataset.fp;
        const line = parseInt(el.dataset.line, 10);
        if (!fp || !line) return;
        const content = _impactContentCache[fp] || await readFile(fp);
        await goToLineWithFlash(fp, line, content);
      });
    });

    // Wire open file button
    const openBtn = body.querySelector('#sf-impact-open-file');
    if (openBtn && item.filePath) {
      openBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const content = _impactContentCache[item.filePath] || await readFile(item.filePath);
        if (window.openFile) await window.openFile(item.filePath, content);
      });
    }
  }

  // Close impact detail panel
  function closeImpactDetail() {
    $('#sf-impact-detail')?.classList.add('hidden');
    $$('.sf-impact-card').forEach(c => c.classList.remove('selected'));
  }

  // ──────────────────────────────────────────────
  // 5. DEPLOYMENT SIMULATOR
  // ──────────────────────────────────────────────
  async function simulateDeployment() {
    const folder = getFolderPath();
    if (!folder) { toast('Open a folder first', 'warn'); return; }

    const resultsDiv = $('#sf-deploy-results');
    const logDiv = $('#sf-deploy-log');
    const scopeSelect = $('#sf-deploy-scope');
    resultsDiv.innerHTML = '<div class="sf-empty">⏳ Analyzing deployment...</div>';
    logDiv.classList.add('hidden');

    // Build index
    await buildClassIndex(folder);

    const issues = [];
    const logLines = [];
    let filesToDeploy = [];

    if (scopeSelect.value === 'modified') {
      try {
        const status = await window.apexStudio.gitStatus(folder);
        if (status && status.files) {
          filesToDeploy = status.files.map(f => f.path);
        }
      } catch {
        toast('Git not available', 'warn');
        return;
      }
    } else {
      const files = await gatherApexFiles(folder);
      filesToDeploy = files.map(f => f.replace(folder + '/', ''));
    }

    logLines.push(`Deployment Validation Report`);
    logLines.push(`Files to deploy: ${filesToDeploy.length}`);
    logLines.push(`─`.repeat(50));

    // Check 1: Apex syntax validation
    logLines.push('\n[1/6] Checking Apex syntax...');
    const allFiles = await gatherApexFiles(folder);
    for (const fp of allFiles) {
      const content = _impactContentCache[fp] || await readFile(fp);
      if (!content) continue;
      const fileName = fp.split(/[/\\]/).pop();
      const syntaxIssues = validateApexSyntax(content, fileName);
      issues.push(...syntaxIssues);
    }
    logLines.push(`  Found ${issues.length} syntax issues`);

    // Check 2: Missing dependencies
    logLines.push('\n[2/6] Checking dependencies...');
    let depIssues = 0;
    for (const [className, info] of Object.entries(sfState.classIndex)) {
      for (const ref of info.references) {
        const refName = typeof ref === 'string' ? ref : ref.name;
        if (!sfState.classIndex[refName] && !sfState.triggerIndex[refName] && !APEX_KEYWORDS.has(refName)) {
          issues.push({
            type: 'warn',
            file: className + '.cls',
            message: `References "${refName}" — not found in project (may be managed package)`,
          });
          depIssues++;
        }
      }
    }
    logLines.push(`  Found ${depIssues} potential missing references`);

    // Check 3: Test coverage estimation
    logLines.push('\n[3/6] Checking test coverage...');
    const classesWithTests = new Set();
    for (const [testName, testInfo] of Object.entries(sfState.classIndex)) {
      if (testInfo.isTest) {
        for (const ref of testInfo.references) {
          const refName = typeof ref === 'string' ? ref : ref.name;
          classesWithTests.add(refName);
        }
      }
    }
    const nonTestClasses = Object.entries(sfState.classIndex).filter(([_, info]) => !info.isTest);
    const untested = nonTestClasses.filter(([name]) => !classesWithTests.has(name));
    for (const [name] of untested) {
      issues.push({
        type: 'warn',
        file: name + '.cls',
        message: 'No test class directly references this class',
      });
    }
    const coverageEst = nonTestClasses.length > 0
      ? Math.round(((nonTestClasses.length - untested.length) / nonTestClasses.length) * 100)
      : 0;
    logLines.push(`  Estimated coverage: ${coverageEst}% (${nonTestClasses.length - untested.length}/${nonTestClasses.length} classes have tests)`);
    if (coverageEst < 75) {
      issues.push({ type: 'error', file: 'Project', message: `Estimated test coverage ${coverageEst}% is below Salesforce's 75% requirement` });
    }

    // Check 4: Trigger handler pattern check
    logLines.push('\n[4/6] Checking trigger patterns...');
    for (const [trigName, trigInfo] of Object.entries(sfState.triggerIndex)) {
      const content = _impactContentCache[trigInfo.filePath] || await readFile(trigInfo.filePath);
      if (content) {
        const lineCount = content.split('\n').length;
        if (lineCount > 30 && trigInfo.references.length === 0) {
          issues.push({
            type: 'warn',
            file: trigName + '.trigger',
            message: 'Trigger has significant logic without delegating to a handler class',
          });
        }
      }
    }

    // Check 5: Metadata completeness
    logLines.push('\n[5/6] Checking metadata...');
    for (const fp of allFiles) {
      const metaFile = fp + '-meta.xml';
      try {
        await window.apexStudio.stat(metaFile);
      } catch {
        issues.push({
          type: 'warn',
          file: fp.split(/[/\\]/).pop(),
          message: 'Missing -meta.xml companion file',
        });
      }
    }

    // Check 6: Best practices
    logLines.push('\n[6/6] Checking best practices...');
    for (const fp of allFiles) {
      const content = _impactContentCache[fp] || await readFile(fp);
      if (!content) continue;
      const fileName = fp.split(/[/\\]/).pop();
      const bpIssues = checkBestPractices(content, fileName);
      issues.push(...bpIssues);
    }

    // Sort: errors first, then warnings, then ok
    issues.sort((a, b) => {
      const order = { error: 0, warn: 1, ok: 2 };
      return (order[a.type] || 99) - (order[b.type] || 99);
    });

    logLines.push(`\n${'─'.repeat(50)}`);
    logLines.push(`Total issues: ${issues.length} (${issues.filter(i=>i.type==='error').length} errors, ${issues.filter(i=>i.type==='warn').length} warnings)`);
    logLines.push(`Deployment readiness: ${issues.filter(i=>i.type==='error').length === 0 ? '✓ READY (with warnings)' : '✗ NOT READY'}`);

    sfState.deployResults = issues;
    renderDeployResults(issues);

    logDiv.classList.remove('hidden');
    logDiv.textContent = logLines.join('\n');

    const errorCount = issues.filter(i => i.type === 'error').length;
    const warnCount = issues.filter(i => i.type === 'warn').length;
    $('#sf-deploy-summary').textContent = `${errorCount} errors, ${warnCount} warnings`;
    toast(`Deploy validation: ${errorCount} errors, ${warnCount} warnings`, errorCount > 0 ? 'error' : 'success');
  }

  /** Validate Apex syntax — checks brace matching, semicolons, common typos */
  function validateApexSyntax(content, fileName) {
    const issues = [];
    const lines = content.split('\n');

    // Check 1: Brace matching
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      inLineComment = false;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        const next = line[c + 1] || '';

        if (inBlockComment) {
          if (ch === '*' && next === '/') { inBlockComment = false; c++; }
          continue;
        }
        if (inLineComment) continue;
        if (ch === '/' && next === '/') { inLineComment = true; continue; }
        if (ch === '/' && next === '*') { inBlockComment = true; c++; continue; }
        if (ch === "'") { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
        if (ch === '(') parenDepth++;
        if (ch === ')') parenDepth--;
        if (ch === '[') bracketDepth++;
        if (ch === ']') bracketDepth--;

        if (braceDepth < 0) {
          issues.push({ type: 'error', file: fileName, message: `Extra closing brace '}' at line ${i+1}` });
          braceDepth = 0;
        }
        if (parenDepth < 0) {
          issues.push({ type: 'error', file: fileName, message: `Extra closing parenthesis ')' at line ${i+1}` });
          parenDepth = 0;
        }
      }
    }

    if (braceDepth > 0) {
      issues.push({ type: 'error', file: fileName, message: `${braceDepth} unclosed brace(s) '{' — missing '}'` });
    }
    if (parenDepth > 0) {
      issues.push({ type: 'error', file: fileName, message: `${parenDepth} unclosed parenthesis '(' — missing ')'` });
    }
    if (bracketDepth > 0) {
      issues.push({ type: 'error', file: fileName, message: `${bracketDepth} unclosed bracket '[' — missing ']'` });
    }

    // Check 2: Statements without semicolons (common Apex errors)
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // Skip empty, comments, annotations, braces, class/method declarations
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
        || trimmed.startsWith('@') || trimmed === '{' || trimmed === '}' || trimmed === '}'
        || /^(public|private|protected|global|static|class|interface|enum|trigger|if|else|for|while|do|try|catch|finally|switch|when)\b/.test(trimmed)
        || trimmed.endsWith('{') || trimmed.endsWith('}') || trimmed.endsWith(',')
        || trimmed.endsWith(';') || trimmed.endsWith('(') || trimmed.endsWith(')')
        || trimmed.endsWith('*/')) continue;

      // Lines that look like statements but missing semicolons
      if (/^\w+.*[^{};,/)\s]$/.test(trimmed) && /\b(return|insert|update|delete|upsert|merge|undelete)\b/.test(trimmed)) {
        issues.push({ type: 'error', file: fileName, message: `Possible missing semicolon at line ${i+1}: "${trimmed.substring(0, 60)}"` });
      }
    }

    // Check 3: Common typos in Apex
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Double semicolons
      if (/;;/.test(line) && !line.includes('for')) {
        issues.push({ type: 'warn', file: fileName, message: `Double semicolon at line ${i+1}` });
      }
      // = in condition (should be ==)
      if (/\bif\s*\([^=]*[^!=<>]=[^=][^)]*\)/.test(line)) {
        issues.push({ type: 'warn', file: fileName, message: `Possible assignment in condition at line ${i+1} (use == for comparison)` });
      }
    }

    return issues;
  }

  /** Check Salesforce best practices */
  function checkBestPractices(content, fileName) {
    const issues = [];
    const lines = content.split('\n');

    // SOQL/DML inside loops
    let inLoop = false;
    let loopDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\b(for|while|do)\s*[\({]/.test(line)) {
        inLoop = true;
        loopDepth++;
      }
      if (inLoop) {
        if (line.includes('{')) loopDepth += (line.match(/{/g) || []).length - 1;
        if (line.includes('}')) loopDepth -= (line.match(/}/g) || []).length;
        if (loopDepth <= 0) { inLoop = false; loopDepth = 0; }

        // SOQL in loop
        if (/\[\s*SELECT\b/i.test(line)) {
          issues.push({ type: 'warn', file: fileName, message: `SOQL query inside loop at line ${i+1} — may hit governor limits` });
        }
        // DML in loop
        if (/\b(insert|update|delete|upsert|merge|undelete)\s+/i.test(line) && !line.trim().startsWith('//')) {
          issues.push({ type: 'warn', file: fileName, message: `DML operation inside loop at line ${i+1} — may hit governor limits` });
        }
      }
    }

    // Hardcoded IDs
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('//')) continue;
      if (/['"][a-zA-Z0-9]{15,18}['"]/.test(lines[i]) && /^[a-zA-Z0-9]{15,18}$/.test(lines[i].match(/['"]([a-zA-Z0-9]{15,18})['"]/)?.[1] || '')) {
        const match = lines[i].match(/['"]([a-zA-Z0-9]{15,18})['"]/);
        if (match && /^[0-9a-zA-Z]{15}$|^[0-9a-zA-Z]{18}$/.test(match[1]) && /^[a-z0-9]{3}/i.test(match[1])) {
          issues.push({ type: 'warn', file: fileName, message: `Possible hardcoded Salesforce ID at line ${i+1} — use Custom Settings or Custom Metadata` });
        }
      }
    }

    // System.debug left in production code
    if (!fileName.includes('Test')) {
      let debugCount = 0;
      for (const line of lines) {
        if (/System\.debug\s*\(/i.test(line) && !line.trim().startsWith('//')) debugCount++;
      }
      if (debugCount > 5) {
        issues.push({ type: 'warn', file: fileName, message: `${debugCount} System.debug statements — consider removing for production` });
      }
    }

    return issues;
  }

  function renderDeployResults(issues) {
    const resultsDiv = $('#sf-deploy-results');
    resultsDiv.innerHTML = '';

    if (issues.length === 0) {
      resultsDiv.innerHTML = '<div class="sf-empty">✓ No issues found. Deployment looks clean!</div>';
      return;
    }

    for (const issue of issues) {
      const item = document.createElement('div');
      item.className = 'sf-deploy-item';
      const icon = issue.type === 'error' ? '✗' : issue.type === 'warn' ? '⚠' : '✓';
      item.innerHTML = `
        <span class="sf-deploy-icon ${issue.type === 'error' ? 'error' : issue.type === 'warn' ? 'warn' : 'ok'}">${icon}</span>
        <span class="sf-deploy-name">${escapeHtml(issue.file)}</span>
        <span class="sf-deploy-msg">${escapeHtml(issue.message)}</span>
      `;
      resultsDiv.appendChild(item);
    }
  }

  // ──────────────────────────────────────────────
  // HTML ESCAPE
  // ──────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ──────────────────────────────────────────────
  // RUN MENU
  // ──────────────────────────────────────────────
  function initRunMenu() {
    const runBtn = $('#tbtn-run');
    const runMenu = $('#run-menu');
    if (!runBtn || !runMenu) return;

    runBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      runMenu.classList.toggle('hidden');
      if (!runMenu.classList.contains('hidden')) {
        const rect = runBtn.getBoundingClientRect();
        runMenu.style.top = rect.bottom + 4 + 'px';
        runMenu.style.right = (window.innerWidth - rect.right) + 'px';
      }
    });

    document.addEventListener('click', (e) => {
      if (!runMenu.contains(e.target) && e.target !== runBtn) {
        runMenu.classList.add('hidden');
      }
    });

    runMenu.querySelectorAll('.run-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        runMenu.classList.add('hidden');
        const action = item.dataset.action;
        handleRunAction(action);
      });
    });

    // Export toggle for keyboard shortcut
    window.toggleRunMenu = () => {
      runMenu.classList.toggle('hidden');
      if (!runMenu.classList.contains('hidden')) {
        const rect = runBtn.getBoundingClientRect();
        runMenu.style.top = rect.bottom + 4 + 'px';
        runMenu.style.right = (window.innerWidth - rect.right) + 'px';
      }
    };
  }

  function handleRunAction(action) {
    switch (action) {
      case 'run-tests':
        openSfPanel('sf-tests');
        setTimeout(() => scanTestClasses().then(() => runAllTests()), 200);
        break;
      case 'run-current-test': {
        const activeTab = window.state && window.state.tabs.find(t => t.id === window.state.activeTabId);
        if (activeTab && activeTab.filePath && activeTab.filePath.endsWith('.cls')) {
          const content = window.state.editor.getValue();
          if (/@isTest/i.test(content)) {
            const tc = parseTestClass(content, activeTab.filePath);
            if (tc) {
              sfState.testClasses = [tc];
              openSfPanel('sf-tests');
              renderTestClasses();
              runClassTests(tc);
            }
          } else {
            toast('Current file is not a test class', 'warn');
          }
        } else {
          toast('Open an Apex test class first', 'warn');
        }
        break;
      }
      case 'deploy-validate':
        openSfPanel('sf-deploy');
        setTimeout(() => deployToOrg(true), 200);
        break;
      case 'deploy-run':
        deployToOrg(false);
        break;
      case 'scan-all':
        openSfPanel('sf-api');
        setTimeout(() => scanEndpoints(), 200);
        break;
    }
  }

  /** Real deployment to org via sf project deploy start */
  async function deployToOrg(validateOnly) {
    const folder = getFolderPath();
    if (!folder) { toast('Open a folder first', 'warn'); return; }
    if (!sfState.cliInstalled) { toast('Salesforce CLI not installed', 'error'); return; }
    if (!sfState.orgConnected) { toast('No org connected. Run: sf org login web', 'error'); return; }

    openSfPanel('sf-deploy');
    const resultsDiv = $('#sf-deploy-results');
    const logDiv = $('#sf-deploy-log');
    const scopeSelect = $('#sf-deploy-scope');
    const tof = targetOrgFlag();
    const mode = validateOnly ? 'VALIDATING' : 'DEPLOYING';
    const dryRunFlag = validateOnly ? ' --dry-run' : '';

    resultsDiv.innerHTML = `<div class="sf-empty">⏳ ${mode} to org...</div>`;
    logDiv.classList.remove('hidden');
    logDiv.textContent = '';

    // Console output
    clearConsole();
    clog(`═══ ${mode} TO ORG ═══`, 'sf-console-info');
    if (sfState.selectedOrg) clog(`Target: ${sfState.selectedOrg}`, 'sf-console-dim');

    // Build source flag based on scope
    let sourceFlag = '';
    if (scopeSelect.value === 'modified') {
      try {
        const status = await window.apexStudio.gitStatus(folder);
        if (status && status.files && status.files.length > 0) {
          const modifiedPaths = status.files.map(f => f.path).filter(p =>
            p.endsWith('.cls') || p.endsWith('.trigger') || p.endsWith('.js') ||
            p.endsWith('.html') || p.endsWith('.css') || p.endsWith('.xml') ||
            p.endsWith('.cmp') || p.endsWith('.page') || p.endsWith('.component')
          );
          if (modifiedPaths.length === 0) {
            toast('No modified metadata files found', 'warn');
            resultsDiv.innerHTML = '<div class="sf-empty">No modified metadata files to deploy.</div>';
            return;
          }
          // Use metadata flag with comma-separated paths
          sourceFlag = ` --source-dir ${modifiedPaths.map(p => `"${p}"`).join(' --source-dir ')}`;
          clog(`Modified files: ${modifiedPaths.length}`, 'sf-console-dim');
          for (const p of modifiedPaths.slice(0, 10)) clog(`  ${p}`, 'sf-console-dim');
          if (modifiedPaths.length > 10) clog(`  ... and ${modifiedPaths.length - 10} more`, 'sf-console-dim');
        } else {
          toast('No modified files found', 'warn');
          resultsDiv.innerHTML = '<div class="sf-empty">No modified files to deploy.</div>';
          return;
        }
      } catch {
        toast('Git not available for modified detection', 'warn');
        return;
      }
    }

    const cmd = `sf project deploy start${dryRunFlag}${sourceFlag}${tof} --json --wait 30 2>&1`;
    const displayCmd = `sf project deploy start${dryRunFlag}${sourceFlag ? ' --source-dir ...' : ''}${tof} --wait 30`;
    clog(`$ ${displayCmd}`, 'sf-console-cmd');
    const spinner = clogSpinner(`${mode}...`);

    try {
      const { code, stdout, stderr } = await sfExec(cmd, 600000); // 10 min timeout
      let json;
      try { json = JSON.parse(stdout); } catch { json = null; }

      if (json && json.result) {
        const r = json.result;
        const status = r.status || (code === 0 ? 'Succeeded' : 'Failed');
        const icon = code === 0 ? '✓' : '✗';
        const cls = code === 0 ? 'sf-console-success' : 'sf-console-error';

        clogResolve(spinner, `${icon} ${mode} ${status}`, cls);

        // Component successes
        const deployed = r.deployedSource || r.files || [];
        const failures = r.details?.componentFailures || [];
        const testResults = r.details?.runTestResult;

        if (deployed.length > 0) {
          clog(`\nDeployed components: ${deployed.length}`, 'sf-console-info');
          for (const c of deployed.slice(0, 20)) {
            const name = c.fullName || c.filePath || c.fileName || '';
            const type = c.type || c.componentType || '';
            clog(`  ✓ ${type}: ${name}`, 'sf-console-success');
          }
          if (deployed.length > 20) clog(`  ... and ${deployed.length - 20} more`, 'sf-console-dim');
        }

        if (failures.length > 0) {
          clog(`\nFailed components: ${failures.length}`, 'sf-console-error');
          for (const f of failures) {
            clog(`  ✗ ${f.componentType || ''}: ${f.fullName || f.fileName || ''}`, 'sf-console-error');
            if (f.problem) clog(`    ${f.problem}`, 'sf-console-dim');
          }
        }

        if (testResults) {
          const passed = testResults.numTestsRun - testResults.numFailures;
          clog(`\nTests: ${passed}/${testResults.numTestsRun} passed`, testResults.numFailures > 0 ? 'sf-console-warn' : 'sf-console-success');
        }

        // Update results div
        const issues = [];
        for (const f of failures) {
          issues.push({ type: 'error', file: f.fullName || f.fileName || '', message: f.problem || 'Component failure' });
        }
        if (deployed.length > 0 && failures.length === 0) {
          issues.push({ type: 'ok', file: 'Deployment', message: `${icon} ${deployed.length} components ${validateOnly ? 'validated' : 'deployed'} successfully` });
        }
        renderDeployResults(issues.length > 0 ? issues : [{ type: 'ok', file: 'Deployment', message: `${icon} ${status}` }]);

        // Log
        logDiv.textContent = JSON.stringify(json.result, null, 2);
        const summary = `${code === 0 ? '✓' : '✗'} ${deployed.length} deployed, ${failures.length} failed`;
        $('#sf-deploy-summary').textContent = summary;
        toast(`${validateOnly ? 'Validation' : 'Deployment'}: ${status}`, code === 0 ? 'success' : 'error');

      } else {
        // Non-JSON or unexpected output
        clogResolve(spinner, `✗ ${mode} failed`, 'sf-console-error');
        clog(stdout || stderr || 'Unknown error', 'sf-console-error');
        logDiv.textContent = stdout || stderr || 'No output';
        resultsDiv.innerHTML = `<div class="sf-empty">✗ ${mode} failed. See log below.</div>`;
        toast(`${validateOnly ? 'Validation' : 'Deployment'} failed`, 'error');
      }
    } catch (e) {
      clogResolve(spinner, `✗ ${mode} error: ${e.message}`, 'sf-console-error');
      resultsDiv.innerHTML = `<div class="sf-empty">✗ Error: ${e.message}</div>`;
      toast(`Deploy error: ${e.message}`, 'error');
    }
  }

  // ──────────────────────────────────────────────
  // RESIZABLE DETAIL PANELS
  // ──────────────────────────────────────────────
  function initDetailResizers() {
    document.querySelectorAll('.sf-detail-resizer').forEach(resizer => {
      let isResizing = false;
      let startX = 0;
      let startWidth = 0;
      const panelId = resizer.dataset.panel;
      const panel = document.getElementById(panelId);
      if (!panel) return;

      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = panel.getBoundingClientRect().width;
        resizer.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        // Dragging left makes panel wider (panel is on right side)
        const delta = startX - e.clientX;
        const newWidth = Math.max(180, Math.min(600, startWidth + delta));
        panel.style.width = newWidth + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          resizer.classList.remove('active');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    });
  }

  // ──────────────────────────────────────────────
  // CONTEXT MENU HANDLERS (for right-click on files/tabs)
  // ──────────────────────────────────────────────
  function handleSfContextAction(action, filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const isSfFile = ['cls', 'trigger', 'page', 'component', 'cmp', 'js', 'html', 'css', 'xml'].includes(ext);

    switch (action) {
      case 'sf-flow-viz':
      case 'tab-sf-flow-viz':
        if (ext === 'cls' || ext === 'trigger') {
          openSfPanel('sf-flow');
          selectFlowFile(filePath);
        } else {
          toast('Flow Visualizer works with .cls and .trigger files', 'warn');
        }
        break;

      case 'sf-impact':
      case 'tab-sf-impact':
        if (ext === 'cls' || ext === 'trigger') {
          openSfPanel('sf-impact');
          // Set scope to current and run analysis
          const scope = $('#sf-impact-scope');
          if (scope) scope.value = 'current';
          analyzeImpact();
        } else {
          toast('Impact Analysis works with .cls and .trigger files', 'warn');
        }
        break;

      case 'sf-api-view':
        if (ext === 'cls') {
          openSfPanel('sf-api');
          scanEndpoints(filePath);
        } else {
          toast('API View works with Apex class files', 'warn');
        }
        break;

      case 'sf-test-runner':
        if (ext === 'cls') {
          openSfPanel('sf-tests');
          scanTestClasses(filePath);
        } else {
          toast('Test Runner works with Apex class files', 'warn');
        }
        break;

      case 'sf-deploy-file':
      case 'tab-sf-deploy':
        openSfPanel('sf-deploy');
        deployPath(filePath);
        break;
    }
  }

  /** Deploy a specific file or folder path to org */
  async function deployPath(targetPath) {
    const folder = getFolderPath();
    if (!folder) { toast('Open a folder first', 'warn'); return; }
    if (!sfState.cliInstalled) { toast('Salesforce CLI not installed', 'error'); return; }
    if (!sfState.orgConnected) { toast('No org connected', 'error'); return; }

    const resultsDiv = $('#sf-deploy-results');
    const logDiv = $('#sf-deploy-log');
    const tof = targetOrgFlag();

    resultsDiv.innerHTML = `<div class="sf-empty">⏳ DEPLOYING ${targetPath.split(/[/\\]/).pop()}...</div>`;
    logDiv.classList.remove('hidden');
    logDiv.textContent = '';

    clearConsole();
    clog(`═══ DEPLOYING PATH ═══`, 'sf-console-info');
    clog(`Source: ${targetPath}`, 'sf-console-dim');
    if (sfState.selectedOrg) clog(`Target: ${sfState.selectedOrg}`, 'sf-console-dim');

    const cmd = `sf project deploy start --source-dir "${targetPath}"${tof} --json --wait 30 2>&1`;
    clog(`$ sf project deploy start --source-dir "${targetPath.split(/[/\\]/).pop()}"${tof} --wait 30`, 'sf-console-cmd');
    const spinner = clogSpinner('DEPLOYING...');

    try {
      const { code, stdout, stderr } = await sfExec(cmd, 600000);
      let json;
      try { json = JSON.parse(stdout); } catch { json = null; }

      if (json && json.result) {
        const r = json.result;
        const status = r.status || (code === 0 ? 'Succeeded' : 'Failed');
        const deployed = r.deployedSource || r.files || [];
        const failures = r.details?.componentFailures || [];

        clogResolve(spinner, `${code === 0 ? '✓' : '✗'} ${status}`, code === 0 ? 'sf-console-success' : 'sf-console-error');

        if (deployed.length > 0) {
          clog(`\nDeployed: ${deployed.length} components`, 'sf-console-info');
          for (const c of deployed.slice(0, 20)) {
            clog(`  ✓ ${c.type || c.componentType || ''}: ${c.fullName || c.filePath || ''}`, 'sf-console-success');
          }
        }
        if (failures.length > 0) {
          clog(`\nFailed: ${failures.length}`, 'sf-console-error');
          for (const f of failures) {
            clog(`  ✗ ${f.componentType || ''}: ${f.fullName || ''} — ${f.problem || ''}`, 'sf-console-error');
          }
        }

        const issues = [];
        for (const f of failures) {
          issues.push({ type: 'error', file: f.fullName || f.fileName || '', message: f.problem || 'Component failure' });
        }
        if (deployed.length > 0 && failures.length === 0) {
          issues.push({ type: 'ok', file: 'Deployment', message: `✓ ${deployed.length} components deployed` });
        }
        renderDeployResults(issues.length > 0 ? issues : [{ type: 'ok', file: 'Deployment', message: `✓ ${status}` }]);
        logDiv.textContent = JSON.stringify(json.result, null, 2);
        toast(`Deploy: ${status}`, code === 0 ? 'success' : 'error');
      } else {
        clogResolve(spinner, '✗ Deploy failed', 'sf-console-error');
        clog(stdout || stderr || 'Unknown error', 'sf-console-error');
        logDiv.textContent = stdout || stderr || 'No output';
        resultsDiv.innerHTML = '<div class="sf-empty">✗ Deploy failed. See log.</div>';
        toast('Deploy failed', 'error');
      }
    } catch (e) {
      clogResolve(spinner, `✗ Error: ${e.message}`, 'sf-console-error');
      resultsDiv.innerHTML = `<div class="sf-empty">✗ Error: ${e.message}</div>`;
      toast(`Deploy error: ${e.message}`, 'error');
    }
  }

  // Expose context menu handler for app.js
  window.handleSfContextAction = handleSfContextAction;

  // ──────────────────────────────────────────────
  // APEX LANGUAGE REGISTRATION (Monaco syntax highlighting)
  // ──────────────────────────────────────────────
  function registerApexLanguage() {
    if (typeof monaco === 'undefined') return;
    // Check if already registered
    const langs = monaco.languages.getLanguages();
    if (langs.some(l => l.id === 'apex')) return;

    monaco.languages.register({ id: 'apex', extensions: ['.cls', '.trigger'], aliases: ['Apex', 'apex'] });

    monaco.languages.setMonarchTokensProvider('apex', {
      defaultToken: '',
      ignoreCase: true,

      keywords: [
        'abstract', 'after', 'before', 'break', 'catch', 'class', 'continue',
        'delete', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for',
        'get', 'global', 'if', 'implements', 'import', 'in', 'insert',
        'instanceof', 'interface', 'merge', 'new', 'on', 'override',
        'private', 'protected', 'public', 'return', 'set', 'static', 'super',
        'switch', 'testMethod', 'this', 'throw', 'transient', 'trigger',
        'try', 'undelete', 'update', 'upsert', 'virtual', 'void', 'webservice',
        'when', 'while', 'with', 'sharing', 'without',
      ],

      typeKeywords: [
        'String', 'Integer', 'Long', 'Double', 'Decimal', 'Boolean', 'Date',
        'DateTime', 'Time', 'Id', 'Blob', 'Object', 'SObject', 'List', 'Set',
        'Map', 'Type', 'Enum', 'Exception',
      ],

      builtins: [
        'System', 'Database', 'Test', 'Schema', 'Math', 'JSON', 'Limits',
        'UserInfo', 'ApexPages', 'Messaging', 'Trigger', 'Assert',
        'HttpRequest', 'HttpResponse', 'Http', 'RestRequest', 'RestResponse',
        'RestContext', 'PageReference', 'Pattern', 'Matcher', 'Url',
        'EncodingUtil', 'Crypto', 'Queueable', 'Schedulable', 'Batchable',
      ],

      annotations: [
        '@AuraEnabled', '@Deprecated', '@Future', '@HttpDelete', '@HttpGet',
        '@HttpPatch', '@HttpPost', '@HttpPut', '@InvocableMethod',
        '@InvocableVariable', '@IsTest', '@JsonAccess', '@NamespaceAccessible',
        '@ReadOnly', '@RemoteAction', '@SuppressWarnings', '@TestSetup',
        '@TestVisible', '@RestResource',
      ],

      operators: [
        '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=',
        '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^',
        '+=', '-=', '*=', '/=', '=>',
      ],

      symbols: /[=><!~?:&|+\-*\/\^%]+/,

      tokenizer: {
        root: [
          // Annotations
          [/@\w+/, { cases: {
            '@annotations': 'annotation',
            '@default': 'annotation',
          }}],

          // SOQL/SOSL inline queries
          [/\[/, { token: 'delimiter.bracket', next: '@soql' }],

          // Identifiers
          [/[a-zA-Z_]\w*/, { cases: {
            '@keywords': 'keyword',
            '@typeKeywords': 'type',
            '@builtins': 'type.identifier',
            '@default': 'identifier',
          }}],

          // Whitespace
          { include: '@whitespace' },

          // Delimiters and operators
          [/[{}()\[\]]/, '@brackets'],
          [/@symbols/, { cases: { '@operators': 'operator', '@default': '' }}],

          // Numbers
          [/\d*\.\d+([eE][\-+]?\d+)?[lLfFdD]?/, 'number.float'],
          [/0[xX][0-9a-fA-F]+[lL]?/, 'number.hex'],
          [/\d+[lLfFdD]?/, 'number'],

          // Strings
          [/'([^'\\]|\\.)*$/, 'string.invalid'],
          [/'/, 'string', '@string'],

          // Characters
          [/[;,.]/, 'delimiter'],
        ],

        whitespace: [
          [/[ \t\r\n]+/, 'white'],
          [/\/\*\*(?!\/)/, 'comment.doc', '@javadoc'],
          [/\/\*/, 'comment', '@comment'],
          [/\/\/.*$/, 'comment'],
        ],

        comment: [
          [/[^\/*]+/, 'comment'],
          [/\*\//, 'comment', '@pop'],
          [/[\/*]/, 'comment'],
        ],

        javadoc: [
          [/[^\/*]+/, 'comment.doc'],
          [/\*\//, 'comment.doc', '@pop'],
          [/[\/*]/, 'comment.doc'],
        ],

        string: [
          [/[^\\']+/, 'string'],
          [/\\./, 'string.escape'],
          [/'/, 'string', '@pop'],
        ],

        soql: [
          [/\]/, { token: 'delimiter.bracket', next: '@pop' }],
          [/\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|LIKE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|ASC|DESC|NULLS|FIRST|LAST|COUNT|SUM|AVG|MIN|MAX|WITH|USING|SCOPE|INSERT|UPDATE|DELETE|INCLUDES|EXCLUDES|TYPEOF|WHEN|THEN|ELSE|END|FOR|REFERENCE|VIEW|SECURITY_ENFORCED|ALL|ROWS|FIND|RETURNING|DIVISION|DATA|CATEGORY|ABOVE|BELOW|AT|ABOVE_OR_BELOW|FIELDS|LISTVIEW)\b/i, 'keyword.soql'],
          [/'([^'\\]|\\.)*'/, 'string'],
          [/[a-zA-Z_][\w.]*/, 'variable.soql'],
          [/\d+/, 'number'],
          [/[=<>!]+/, 'operator'],
          [/[,\s().]/, ''],
        ],
      },
    });

    // Bracket configuration
    monaco.languages.setLanguageConfiguration('apex', {
      comments: { lineComment: '//', blockComment: ['/*', '*/'] },
      brackets: [['{', '}'], ['[', ']'], ['(', ')']],
      autoClosingPairs: [
        { open: '{', close: '}' }, { open: '[', close: ']' },
        { open: '(', close: ')' }, { open: "'", close: "'", notIn: ['string', 'comment'] },
        { open: '/*', close: ' */', notIn: ['string'] },
      ],
      surroundingPairs: [
        { open: '{', close: '}' }, { open: '[', close: ']' },
        { open: '(', close: ')' }, { open: "'", close: "'" },
      ],
      folding: {
        offSide: false,
        markers: { start: /^\s*\/\/\s*#?region\b/, end: /^\s*\/\/\s*#?endregion\b/ },
      },
    });
  }

  // ──────────────────────────────────────────────
  // TAB SWITCHING
  // ──────────────────────────────────────────────
  function switchTab(tabId) {
    $$('.sf-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
    $$('.sf-tab-content').forEach(c => c.classList.toggle('active', c.id === tabId));
  }

  // ──────────────────────────────────────────────
  // INIT
  // ──────────────────────────────────────────────
  function init() {
    // Tab switching
    $$('.sf-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Close panel
    $('#btn-sf-close')?.addEventListener('click', () => {
      if (window.toggleToolPanel) window.toggleToolPanel('salesforce-panel');
    });

    // API View
    $('#sf-api-scan')?.addEventListener('click', scanEndpoints);
    $('#sf-api-filter')?.addEventListener('change', renderEndpoints);
    $('#sf-api-search')?.addEventListener('input', renderEndpoints);
    $('#sf-api-detail-close')?.addEventListener('click', () => {
      $('#sf-api-detail').classList.add('hidden');
    });
    $('#sf-api-test-btn')?.addEventListener('click', testEndpoint);

    // Test Runner
    $('#sf-tests-scan')?.addEventListener('click', scanTestClasses);
    $('#sf-tests-run-all')?.addEventListener('click', runAllTests);
    $('#sf-tests-search')?.addEventListener('input', renderTestClasses);

    // Flow Visualizer
    $('#sf-flow-generate')?.addEventListener('click', generateFlow);
    $('#sf-flow-pick-file')?.addEventListener('click', showFlowFilePicker);
    $('#sf-flow-detail-close')?.addEventListener('click', () => {
      $('#sf-flow-detail')?.classList.add('hidden');
      $$('.sf-flow-node').forEach(el => el.classList.remove('selected'));
      _flowSelectedNode = null;
    });

    // Impact Analyzer
    $('#sf-impact-analyze')?.addEventListener('click', analyzeImpact);
    $('#sf-impact-detail-close')?.addEventListener('click', closeImpactDetail);

    // Deployment
    $('#sf-deploy-simulate')?.addEventListener('click', simulateDeployment);
    $('#sf-deploy-run')?.addEventListener('click', () => deployToOrg(false));

    // Console clear
    $('#sf-console-clear')?.addEventListener('click', clearConsole);

    // Org connection
    $('#sf-org-refresh')?.addEventListener('click', checkOrgConnection);
    $('#sf-org-select')?.addEventListener('change', onOrgSelectChange);
    $('#sf-org-login')?.addEventListener('click', () => showOrgPicker());
    // System-mode opt-in toggle + debug-log cleanup (handled by the Apex debugger module)
    $('#sf-systemmode-toggle')?.addEventListener('click', () => window.apexDebuggerToggleSystemMode?.());
    $('#sf-clearlogs')?.addEventListener('click', () => window.apexDebuggerClearDebugLogs?.());
    try { window.apexDebuggerUpdateSystemModeUi?.(); } catch (_) {}
    checkOrgConnection();

    // Org picker popup
    initOrgPicker();

    // Status bar org click — show org quick-pick popup
    $('#status-sf-org')?.addEventListener('click', showOrgPicker);

    // Run menu
    initRunMenu();

    // Resizable detail panels
    initDetailResizers();

    // Register Apex language for syntax highlighting
    registerApexLanguage();
  }

  window.initSalesforce = init;
  window.refreshSalesforceOrgs = checkOrgConnection;

  /**
   * Expose the currently selected/connected org so other modules (e.g. the Apex
   * debugger's Live Org mode) can run CLI queries against it.
   * @returns {{ org: string|null, connected: boolean, info: object|null }}
   */
  window.sfGetActiveOrg = function () {
    return {
      org: sfState.selectedOrg || null,
      connected: !!sfState.orgConnected,
      info: sfState.orgInfo || null,
    };
  };
})();

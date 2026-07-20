/* ================================================================
   Apex Debug Studio — TODO / FIXME Tracker Module
   Scans workspace files for TODO, FIXME, HACK, BUG, NOTE comments.
   Auto-scans on panel open. Click items to preview code context.
   ================================================================ */
'use strict';

(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const TAGS = ['TODO', 'FIXME', 'HACK', 'BUG', 'NOTE', 'XXX', 'WARN', 'DEBUG'];
  const TAG_COLORS = {
    'TODO': '#3498db',
    'FIXME': '#e74c3c',
    'HACK': '#f39c12',
    'BUG': '#e74c3c',
    'NOTE': '#2ecc71',
    'XXX': '#9b59b6',
    'WARN': '#f39c12',
    'TO-DO': '#3498db',
    'DEBUG': '#ff6b35',
  };

  let todoItems = [];
  let activeFilter = 'all';
  let hasScanned = false;
  let selectedItem = null; // currently previewed item

  function init() {
    $('#btn-todo-close')?.addEventListener('click', () => window.toggleToolPanel('todo-panel'));
    $('#btn-todo-scan-big')?.addEventListener('click', () => runScan());
    $('#btn-todo-rescan')?.addEventListener('click', () => runScan());
    $('#btn-todo-preview-close')?.addEventListener('click', hidePreview);
    $('#btn-todo-goto')?.addEventListener('click', gotoSelectedItem);

    // Filter tabs
    $$('.todo-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.todo-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter || 'all';
        renderTodoList();
      });
    });
  }

  // ---- Auto-scan hook — called when panel becomes visible ----
  function onPanelOpen() {
    if (!hasScanned) {
      runScan();
    }
  }

  // ---- Main scan entry point ----
  async function runScan() {
    const landing = $('#todo-landing');
    const results = $('#todo-results');

    if (state.folderPath) {
      await scanWorkspace();
    } else if (state.tabs.length > 0) {
      await scanAllTabs();
    } else {
      window.showToast('Open a file or folder first', 'warning');
      return;
    }

    hasScanned = true;
    landing?.classList.add('hidden');
    results?.classList.remove('hidden');
  }

  async function scanAllTabs() {
    todoItems = [];
    for (const tab of state.tabs) {
      const text = tab.model.getValue();
      const lines = text.split('\n');
      const isApex = tab.filePath && (tab.filePath.endsWith('.cls') || tab.filePath.endsWith('.trigger'));
      lines.forEach((line, i) => {
        // Standard TODO/FIXME tags
        const lineRegex = new RegExp(`\\b(${TAGS.join('|')})[:\\s](.*)`, 'gi');
        let m;
        while ((m = lineRegex.exec(line)) !== null) {
          todoItems.push({
            tag: m[1].toUpperCase(),
            text: m[2].trim().replace(/\*\/\s*$/, '').trim(),
            file: tab.title,
            filePath: tab.filePath || tab.title,
            line: i + 1,
          });
        }
        // Salesforce debug items in Apex files
        if (isApex) {
          if (/\bSystem\.debug\s*\(/i.test(line)) {
            todoItems.push({
              tag: 'DEBUG',
              text: line.trim().replace(/^.*System\.debug\s*\(/i, 'System.debug(').replace(/;\s*$/, ''),
              file: tab.title,
              filePath: tab.filePath || tab.title,
              line: i + 1,
            });
          }
        }
      });
    }
    updateStats();
    renderTodoList();
    window.showToast(`Found ${todoItems.length} items in ${state.tabs.length} open tabs`, 'info');
  }

  async function scanWorkspace() {
    window.showToast('Scanning workspace…', 'info');
    try {
      const result = await window.apexStudio.scanTodos(state.folderPath);
      if (result && result.items) {
        todoItems = result.items;
      }
    } catch {
      // Fallback — scan open tabs
      await scanAllTabs();
      return;
    }
    updateStats();
    renderTodoList();
    window.showToast(`Found ${todoItems.length} items in workspace`, 'info');
  }

  // ---- Stats badges ----
  function updateStats() {
    const statsEl = $('#todo-stats');
    if (!statsEl) return;

    const counts = {};
    TAGS.forEach(t => counts[t] = 0);
    todoItems.forEach(item => { counts[item.tag] = (counts[item.tag] || 0) + 1; });

    statsEl.innerHTML = TAGS
      .filter(t => counts[t] > 0)
      .map(t => `<span class="todo-stat-badge" style="--badge-color:${TAG_COLORS[t]}">${t} <strong>${counts[t]}</strong></span>`)
      .join('') + `<span class="todo-stat-total">${todoItems.length} total</span>`;
  }

  // ---- Render list grouped by file ----
  function renderTodoList() {
    const container = $('#todo-list');
    if (!container) return;
    hidePreview();

    let items = todoItems;
    if (activeFilter !== 'all') {
      items = todoItems.filter(i => i.tag === activeFilter);
    }

    if (items.length === 0) {
      container.innerHTML = `<div class="todo-empty">${todoItems.length === 0 ? 'No TODO/FIXME comments found' : 'No items match this filter'}</div>`;
      return;
    }

    // Group by file
    const byFile = {};
    items.forEach(item => {
      if (!byFile[item.filePath]) byFile[item.filePath] = [];
      byFile[item.filePath].push(item);
    });

    let html = '';
    for (const [filePath, fileItems] of Object.entries(byFile)) {
      const fileName = filePath.split(/[/\\]/).pop();
      html += `<div class="todo-file-group">
        <div class="todo-file-header">
          <span class="todo-file-icon">${getFileIconForName(fileName)}</span>
          ${escHtml(fileName)}
          <span class="todo-file-count">${fileItems.length}</span>
        </div>`;
      fileItems.forEach((item, idx) => {
        const globalIdx = todoItems.indexOf(item);
        html += `
          <div class="todo-item" data-idx="${globalIdx}" data-file="${escHtml(item.filePath)}" data-line="${item.line}">
            <span class="todo-tag" style="background:${TAG_COLORS[item.tag] || '#888'}">${item.tag}</span>
            <span class="todo-text">${escHtml(item.text || '(no description)')}</span>
            <span class="todo-line">L${item.line}</span>
          </div>`;
      });
      html += '</div>';
    }
    container.innerHTML = html;

    // Click to show inline code preview
    container.querySelectorAll('.todo-item').forEach(el => {
      el.addEventListener('click', () => {
        // Highlight selected
        container.querySelectorAll('.todo-item').forEach(e => e.classList.remove('todo-item-selected'));
        el.classList.add('todo-item-selected');
        showPreview(+el.dataset.idx);
      });
    });
  }

  // ---- Inline Code Preview ----
  async function showPreview(idx) {
    const item = todoItems[idx];
    if (!item) return;
    selectedItem = item;

    const previewEl = $('#todo-preview');
    const filenameEl = $('#todo-preview-filename');
    const codeEl = $('#todo-preview-code');
    if (!previewEl || !codeEl) return;

    filenameEl.textContent = `${item.file} : ${item.line}`;

    // Get source lines — from open tab model or read file
    let lines = [];
    const tab = state.tabs.find(t => t.filePath === item.filePath);
    if (tab) {
      lines = tab.model.getValue().split('\n');
    } else {
      try {
        const content = await window.apexStudio.readFile(item.filePath);
        if (content != null) lines = content.split('\n');
      } catch { lines = []; }
    }

    if (lines.length === 0) {
      codeEl.innerHTML = '<span class="todo-preview-na">Unable to read file</span>';
      previewEl.classList.remove('hidden');
      return;
    }

    // Show ±5 lines of context around the TODO line
    const CONTEXT = 5;
    const startLine = Math.max(0, item.line - 1 - CONTEXT);
    const endLine = Math.min(lines.length, item.line + CONTEXT);
    const snippet = lines.slice(startLine, endLine);

    const html = snippet.map((line, i) => {
      const lineNum = startLine + i + 1;
      const isTodoLine = lineNum === item.line;
      return `<span class="todo-code-line${isTodoLine ? ' todo-code-highlight' : ''}">`
        + `<span class="todo-code-linenum">${String(lineNum).padStart(4)}</span>`
        + `<span class="todo-code-text">${escHtml(line)}</span>`
        + `</span>`;
    }).join('\n');

    codeEl.innerHTML = html;
    previewEl.classList.remove('hidden');
  }

  function hidePreview() {
    const previewEl = $('#todo-preview');
    if (previewEl) previewEl.classList.add('hidden');
    selectedItem = null;
    // Deselect item
    $$('.todo-item-selected').forEach(el => el.classList.remove('todo-item-selected'));
  }

  // ---- Navigate to file and line ----
  async function gotoSelectedItem() {
    if (!selectedItem) return;
    const item = selectedItem;

    // Close the TODO panel
    window.toggleToolPanel('todo-panel');

    // Open file if needed
    const tab = state.tabs.find(t => t.filePath === item.filePath);
    if (tab) {
      window.activateTab(tab.id);
    } else if (item.filePath && !item.filePath.startsWith('Untitled')) {
      try {
        const content = await window.apexStudio.readFile(item.filePath);
        if (content != null) await window.openFile(item.filePath, content);
      } catch {}
    }

    setTimeout(() => {
      if (state.editor) {
        state.editor.revealLineInCenter(item.line);
        state.editor.setPosition({ lineNumber: item.line, column: 1 });
        state.editor.focus();
      }
    }, 100);
  }

  // ---- Helpers ----
  function getFileIconForName(name) {
    try { return typeof getFileIcon === 'function' ? getFileIcon(name) : '📄'; } catch { return '📄'; }
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Expose ----
  window.initTodoTracker = init;
  window.todoTrackerOnOpen = onPanelOpen;
  window.scanTodosInFile = runScan;
})();

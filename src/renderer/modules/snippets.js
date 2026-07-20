/* ================================================================
   Apex Debug Studio — Snippet Manager Module
   Save, tag, search, and insert reusable code snippets.
   ================================================================ */
'use strict';

(function () {
  // ---- State ----
  const STORAGE_KEY = 'apexstudio-snippets';
  let snippets = [];
  let editingIdx = -1;

  // ---- Helpers (from global scope) ----
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // ---- Persistence ----
  function saveSnippets() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snippets)); } catch {}
  }

  function loadSnippets() {
    try { snippets = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { snippets = []; }
  }

  // ---- Init ----
  function init() {
    loadSnippets();

    const closeBtn  = $('#btn-snippet-close');
    const addBtn    = $('#btn-snippet-add');
    const searchEl  = $('#snippet-search');

    closeBtn?.addEventListener('click', () => window.toggleToolPanel('snippet-panel'));

    addBtn?.addEventListener('click', () => showSnippetForm());

    searchEl?.addEventListener('input', () => renderSnippetList(searchEl.value.trim().toLowerCase()));

    // Form buttons
    $('#btn-snippet-save')?.addEventListener('click', saveSnippetForm);
    $('#btn-snippet-cancel')?.addEventListener('click', hideSnippetForm);

    renderSnippetList();
  }

  // ---- Form ----
  function showSnippetForm(idx) {
    const form = $('#snippet-form');
    const list = $('#snippet-list-container');
    if (!form) return;

    form.classList.remove('hidden');
    list?.classList.add('hidden');

    if (idx !== undefined && snippets[idx]) {
      editingIdx = idx;
      const s = snippets[idx];
      $('#snippet-name').value = s.name || '';
      $('#snippet-lang').value = s.language || '';
      $('#snippet-tags').value = (s.tags || []).join(', ');
      $('#snippet-code').value = s.code || '';
    } else {
      editingIdx = -1;
      $('#snippet-name').value = '';
      $('#snippet-lang').value = '';
      $('#snippet-tags').value = '';
      $('#snippet-code').value = '';
    }
    $('#snippet-name')?.focus();
  }

  function hideSnippetForm() {
    const form = $('#snippet-form');
    const list = $('#snippet-list-container');
    form?.classList.add('hidden');
    list?.classList.remove('hidden');
    editingIdx = -1;
  }

  function saveSnippetForm() {
    const name = $('#snippet-name')?.value.trim();
    const code = $('#snippet-code')?.value;
    if (!name) { window.showToast('Snippet name is required', 'warning'); return; }
    if (!code) { window.showToast('Snippet code is required', 'warning'); return; }

    const snippet = {
      name,
      language: $('#snippet-lang')?.value.trim() || 'text',
      tags: ($('#snippet-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean),
      code,
      created: new Date().toISOString(),
    };

    if (editingIdx >= 0) {
      snippet.created = snippets[editingIdx].created;
      snippets[editingIdx] = snippet;
    } else {
      snippets.unshift(snippet);
    }

    saveSnippets();
    hideSnippetForm();
    renderSnippetList();
    window.showToast(`Snippet "${name}" saved`, 'info');
  }

  // ---- List ----
  function renderSnippetList(filter) {
    const container = $('#snippet-list');
    if (!container) return;

    let items = snippets;
    if (filter) {
      items = snippets.filter(s =>
        s.name.toLowerCase().includes(filter) ||
        s.language.toLowerCase().includes(filter) ||
        (s.tags || []).some(t => t.toLowerCase().includes(filter)) ||
        s.code.toLowerCase().includes(filter)
      );
    }

    if (items.length === 0) {
      container.innerHTML = `<div class="snippets-empty">${filter ? 'No matching snippets' : 'No snippets yet.<br>Click + New to create one.'}</div>`;
      return;
    }

    container.innerHTML = items.map((s, i) => {
      const realIdx = snippets.indexOf(s);
      const langLabel = s.language || 'text';
      const tagsHtml = (s.tags || []).map(t => `<span class="snippet-tag">${escHtml(t)}</span>`).join('');
      const preview = s.code.split('\n').slice(0, 3).join('\n');
      return `
        <div class="snippet-item" data-idx="${realIdx}">
          <button class="snippet-copy-corner" data-idx="${realIdx}" title="Copy to clipboard">📋</button>
          <div class="snippet-item-header">
            <span class="snippet-item-name">${escHtml(s.name)}</span>
            <span class="snippet-item-lang">${escHtml(langLabel)}</span>
          </div>
          ${tagsHtml ? `<div class="snippet-tags-row">${tagsHtml}</div>` : ''}
          <pre class="snippet-preview">${escHtml(preview)}</pre>
          <div class="snippet-actions">
            <button class="snippet-action-btn snippet-insert" data-idx="${realIdx}" title="Insert into editor">⏎ Insert</button>
            <button class="snippet-action-btn snippet-copy" data-idx="${realIdx}" title="Copy to clipboard">📋 Copy</button>
            <button class="snippet-action-btn snippet-edit" data-idx="${realIdx}" title="Edit">✏️</button>
            <button class="snippet-action-btn snippet-delete" data-idx="${realIdx}" title="Delete">🗑</button>
          </div>
        </div>`;
    }).join('');

    // Event delegation
    container.querySelectorAll('.snippet-copy-corner').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = snippets[+btn.dataset.idx];
        if (s) {
          navigator.clipboard.writeText(s.code);
          btn.textContent = '✅';
          setTimeout(() => { btn.textContent = '📋'; }, 1200);
          window.showToast('Copied to clipboard', 'info');
        }
      });
    });
    container.querySelectorAll('.snippet-insert').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        insertSnippet(+btn.dataset.idx);
      });
    });
    container.querySelectorAll('.snippet-copy').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = snippets[+btn.dataset.idx];
        if (s) { navigator.clipboard.writeText(s.code); window.showToast('Copied to clipboard', 'info'); }
      });
    });
    container.querySelectorAll('.snippet-edit').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); showSnippetForm(+btn.dataset.idx); });
    });
    container.querySelectorAll('.snippet-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        snippets.splice(+btn.dataset.idx, 1);
        saveSnippets();
        renderSnippetList();
        window.showToast('Snippet deleted', 'info');
      });
    });
  }

  function insertSnippet(idx) {
    const s = snippets[idx];
    if (!s || !state.editor) { window.showToast('Open a file first', 'warning'); return; }
    const pos = state.editor.getPosition();
    state.editor.executeEdits('snippet-insert', [{
      range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
      text: s.code,
    }]);
    state.editor.focus();
    window.showToast(`Inserted "${s.name}"`, 'info');
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- Expose ----
  window.initSnippets = init;
})();

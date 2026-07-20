/* =============================================================
   Diff Checker — module for Apex Debug Studio
   Side-by-side or inline diff using Monaco's built-in diff editor
   ============================================================= */
(function () {
  'use strict';

  let diffEditorInstance = null;
  let originalModel = null;
  let modifiedModel = null;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  function initDiffChecker() {
    const closeBtn    = $('#btn-diff-close');
    const swapBtn     = $('#btn-diff-swap');
    const compareBtn  = $('#btn-diff-compare');
    const clearBtn    = $('#btn-diff-clear');
    const inlineCheck = $('#diff-inline-check');
    const origTA      = $('#diff-original');
    const modTA       = $('#diff-modified');
    const outputEl    = $('#diff-output');
    const statsEl     = $('#diff-stats');

    if (!closeBtn) return; // panel not present

    // Close button
    closeBtn.addEventListener('click', () => {
      if (typeof window.toggleToolPanel === 'function') {
        window.toggleToolPanel('diff-panel');
      }
    });

    // Swap button
    swapBtn.addEventListener('click', () => {
      const tmp = origTA.value;
      origTA.value = modTA.value;
      modTA.value = tmp;
    });

    // Clear button
    clearBtn.addEventListener('click', () => {
      origTA.value = '';
      modTA.value = '';
      outputEl.classList.add('hidden');
      outputEl.innerHTML = '';
      statsEl.textContent = '';
      if (diffEditorInstance) {
        diffEditorInstance.dispose();
        diffEditorInstance = null;
      }
      if (originalModel) { originalModel.dispose(); originalModel = null; }
      if (modifiedModel) { modifiedModel.dispose(); modifiedModel = null; }
    });

    // Compare button
    compareBtn.addEventListener('click', () => runDiff());

    // Inline toggle — rebuild diff if output is visible
    inlineCheck.addEventListener('change', () => {
      if (!outputEl.classList.contains('hidden')) {
        runDiff();
      }
    });

    // Allow Ctrl/Cmd+Enter to trigger compare from textareas
    [origTA, modTA].forEach(ta => {
      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          runDiff();
        }
      });
    });

    function runDiff() {
      const origText = origTA.value;
      const modText  = modTA.value;

      if (!origText && !modText) {
        if (typeof window.showToast === 'function') {
          window.showToast('Paste text in both panels to compare', 'warn');
        }
        return;
      }

      outputEl.classList.remove('hidden');
      outputEl.innerHTML = '';

      // Calculate quick stats
      const origLines = origText.split('\n');
      const modLines  = modText.split('\n');
      const added   = modLines.filter((l, i) => i >= origLines.length || l !== origLines[i]).length;
      const removed = origLines.filter((l, i) => i >= modLines.length || l !== modLines[i]).length;
      statsEl.textContent = `+${added} added / -${removed} removed  •  ${origLines.length} → ${modLines.length} lines`;

      // Use Monaco diff editor if available
      if (typeof monaco !== 'undefined' && monaco.editor) {
        createMonacoDiff(origText, modText);
      } else {
        // Fallback: simple line-by-line diff table
        createSimpleDiff(origText, modText);
      }
    }

    function createMonacoDiff(origText, modText) {
      const outputEl = $('#diff-output');
      const isInline = $('#diff-inline-check').checked;

      // Dispose previous
      if (diffEditorInstance) { diffEditorInstance.dispose(); diffEditorInstance = null; }
      if (originalModel) { originalModel.dispose(); originalModel = null; }
      if (modifiedModel) { modifiedModel.dispose(); modifiedModel = null; }

      // Let CSS flex handle the height — just ensure minimum
      outputEl.style.height = '';

      // Get current theme
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const monacoTheme = (currentTheme === 'light' || currentTheme === 'solarized-light')
        ? 'vs' : 'vs-dark';

      diffEditorInstance = monaco.editor.createDiffEditor(outputEl, {
        readOnly: true,
        renderSideBySide: !isInline,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        lineNumbers: 'on',
        glyphMargin: false,
        folding: false,
        renderOverviewRuler: false,
        theme: monacoTheme,
        scrollbar: {
          vertical: 'auto',
          horizontal: 'auto',
        },
      });

      originalModel = monaco.editor.createModel(origText, 'text/plain');
      modifiedModel = monaco.editor.createModel(modText, 'text/plain');

      diffEditorInstance.setModel({
        original: originalModel,
        modified: modifiedModel,
      });
    }

    function createSimpleDiff(origText, modText) {
      const outputEl = $('#diff-output');
      const origLines = origText.split('\n');
      const modLines  = modText.split('\n');
      const maxLen = Math.max(origLines.length, modLines.length);

      let html = '<table class="diff-line-table">';
      for (let i = 0; i < maxLen; i++) {
        const oLine = i < origLines.length ? origLines[i] : undefined;
        const mLine = i < modLines.length ? modLines[i] : undefined;

        if (oLine === undefined) {
          html += `<tr class="diff-line-add"><td class="diff-line-num"></td><td class="diff-line-num">${i + 1}</td><td>+ ${escHtml(mLine)}</td></tr>`;
        } else if (mLine === undefined) {
          html += `<tr class="diff-line-remove"><td class="diff-line-num">${i + 1}</td><td class="diff-line-num"></td><td>- ${escHtml(oLine)}</td></tr>`;
        } else if (oLine !== mLine) {
          html += `<tr class="diff-line-remove"><td class="diff-line-num">${i + 1}</td><td class="diff-line-num"></td><td>- ${escHtml(oLine)}</td></tr>`;
          html += `<tr class="diff-line-add"><td class="diff-line-num"></td><td class="diff-line-num">${i + 1}</td><td>+ ${escHtml(mLine)}</td></tr>`;
        } else {
          html += `<tr class="diff-line-ctx"><td class="diff-line-num">${i + 1}</td><td class="diff-line-num">${i + 1}</td><td>  ${escHtml(oLine)}</td></tr>`;
        }
      }
      html += '</table>';
      outputEl.innerHTML = html;
      outputEl.style.height = 'auto';
    }

    function escHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }

  // Expose init
  window.initDiffChecker = initDiffChecker;
})();

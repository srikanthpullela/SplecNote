/* ================================================================
   Apex Debug Studio — Color Picker Module
   Detect colors in code, show inline swatches, visual picker.
   ================================================================ */
'use strict';

(function () {
  const $ = (s) => document.querySelector(s);
  let colorDecorations = [];
  let pickerOverlay = null;

  function init() {
    const closeBtn = $('#btn-color-close');
    closeBtn?.addEventListener('click', () => window.toggleToolPanel('color-panel'));

    $('#btn-color-scan')?.addEventListener('click', scanColors);
    $('#btn-color-insert')?.addEventListener('click', insertPickedColor);

    // Live picker value change
    $('#color-picker-input')?.addEventListener('input', updatePickerPreview);
    $('#color-hex-input')?.addEventListener('input', onHexInput);

    // Format buttons
    $$('.color-format-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.color-format-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updatePickerPreview();
      });
    });
  }

  function $$(s) { return [...document.querySelectorAll(s)]; }

  function scanColors() {
    if (!state.editor) { window.showToast('Open a file first', 'warning'); return; }
    const model = state.editor.getModel();
    const text = model.getValue();

    // Match hex, rgb, rgba, hsl, hsla, named CSS colors
    const colorRegex = /#(?:[0-9a-fA-F]{3,4}){1,2}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)|hsla?\(\s*\d+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?(?:\s*,\s*[\d.]+)?\s*\)/g;

    const matches = [];
    let m;
    while ((m = colorRegex.exec(text)) !== null) {
      const startPos = model.getPositionAt(m.index);
      const endPos = model.getPositionAt(m.index + m[0].length);
      matches.push({
        color: m[0],
        range: new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
        line: startPos.lineNumber,
      });
    }

    // Render results
    const list = $('#color-list');
    if (!list) return;

    if (matches.length === 0) {
      list.innerHTML = '<div class="color-empty">No colors found in current file</div>';
      colorDecorations = state.editor.deltaDecorations(colorDecorations, []);
      return;
    }

    // Add decorations
    const decorations = matches.map(m => ({
      range: m.range,
      options: {
        isWholeLine: false,
        className: 'color-highlight',
        overviewRuler: { color: m.color, position: monaco.editor.OverviewRulerLane.Right },
      },
    }));
    colorDecorations = state.editor.deltaDecorations(colorDecorations, decorations);

    list.innerHTML = matches.map((m, i) => `
      <div class="color-item" data-idx="${i}" data-line="${m.line}">
        <span class="color-swatch" style="background:${escHtml(m.color)}"></span>
        <span class="color-value">${escHtml(m.color)}</span>
        <span class="color-line">L${m.line}</span>
      </div>
    `).join('');

    list.querySelectorAll('.color-item').forEach(el => {
      el.addEventListener('click', () => {
        const line = +el.dataset.line;
        state.editor.revealLineInCenter(line);
        state.editor.setPosition({ lineNumber: line, column: 1 });
        state.editor.focus();

        // Set picker to this color
        const idx = +el.dataset.idx;
        const color = matches[idx]?.color;
        if (color) {
          const hex = colorToHex(color);
          $('#color-picker-input').value = hex;
          $('#color-hex-input').value = hex;
          updatePickerPreview();
        }
      });
    });

    window.showToast(`Found ${matches.length} colors`, 'info');
  }

  function updatePickerPreview() {
    const hex = $('#color-picker-input')?.value || '#000000';
    const preview = $('#color-preview-swatch');
    const hexInput = $('#color-hex-input');
    if (preview) preview.style.background = hex;
    if (hexInput && document.activeElement !== hexInput) hexInput.value = hex;

    // Update format outputs
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    $('#color-rgb-output').textContent = `rgb(${r}, ${g}, ${b})`;
    const [h, s, l] = rgbToHsl(r, g, b);
    $('#color-hsl-output').textContent = `hsl(${h}, ${s}%, ${l}%)`;
    $('#color-hex-output').textContent = hex;
  }

  function onHexInput() {
    let val = $('#color-hex-input')?.value.trim();
    if (!val.startsWith('#')) val = '#' + val;
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      $('#color-picker-input').value = val;
      updatePickerPreview();
    }
  }

  function insertPickedColor() {
    if (!state.editor) { window.showToast('Open a file first', 'warning'); return; }
    const format = document.querySelector('.color-format-btn.active')?.dataset.format || 'hex';
    const hex = $('#color-picker-input')?.value || '#000000';

    let colorStr = hex;
    if (format === 'rgb') {
      colorStr = $('#color-rgb-output')?.textContent || hex;
    } else if (format === 'hsl') {
      colorStr = $('#color-hsl-output')?.textContent || hex;
    }

    const pos = state.editor.getPosition();
    state.editor.executeEdits('color-insert', [{
      range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
      text: colorStr,
    }]);
    state.editor.focus();
    window.showToast('Color inserted', 'info');
  }

  function colorToHex(color) {
    const el = document.createElement('div');
    el.style.color = color;
    document.body.appendChild(el);
    const computed = getComputedStyle(el).color;
    document.body.removeChild(el);
    const match = computed.match(/\d+/g);
    if (!match) return '#000000';
    return '#' + match.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = ((b - r) / d + 2); break;
        case b: h = ((r - g) / d + 4); break;
      }
      h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.initColorPicker = init;
})();

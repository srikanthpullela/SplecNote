/* ================================================================
   Apex Debug Studio — Pomodoro Focus Timer Module
   25-min work / 5-min break timer in the status bar.
   ================================================================ */
'use strict';

(function () {
  const $ = (s) => document.querySelector(s);

  const WORK_MINS   = 25;
  const SHORT_BREAK = 5;
  const LONG_BREAK  = 15;
  const SESSIONS_BEFORE_LONG = 4;

  let timer = null;
  let remaining = WORK_MINS * 60; // seconds
  let isRunning = false;
  let mode = 'work'; // 'work' | 'break'
  let sessionCount = 0;

  function init() {
    // Titlebar widget click → open panel
    $('#pomo-titlebar')?.addEventListener('click', () => window.toggleToolPanel('pomo-panel'));

    // Panel controls
    const closeBtn   = $('#btn-pomo-close');
    const startBtn   = $('#btn-pomo-start');
    const pauseBtn   = $('#btn-pomo-pause');
    const resetBtn   = $('#btn-pomo-reset');
    const skipBtn    = $('#btn-pomo-skip');

    closeBtn?.addEventListener('click', () => window.toggleToolPanel('pomo-panel'));
    startBtn?.addEventListener('click', startTimer);
    pauseBtn?.addEventListener('click', pauseTimer);
    resetBtn?.addEventListener('click', resetTimer);
    skipBtn?.addEventListener('click', skipToNext);

    updateDisplay();
  }

  function startTimer() {
    if (isRunning) return;
    isRunning = true;
    updateButtonStates();

    timer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(timer);
        timer = null;
        isRunning = false;
        onTimerComplete();
      }
      updateDisplay();
    }, 1000);
  }

  function pauseTimer() {
    if (!isRunning) return;
    clearInterval(timer);
    timer = null;
    isRunning = false;
    updateButtonStates();
  }

  function resetTimer() {
    clearInterval(timer);
    timer = null;
    isRunning = false;
    remaining = (mode === 'work' ? WORK_MINS : getBreakDuration()) * 60;
    updateDisplay();
    updateButtonStates();
  }

  function skipToNext() {
    clearInterval(timer);
    timer = null;
    isRunning = false;
    switchMode();
  }

  function switchMode() {
    if (mode === 'work') {
      sessionCount++;
      const breakMins = getBreakDuration();
      mode = 'break';
      remaining = breakMins * 60;
      window.showToast(`Great work! Take a ${breakMins}-minute break 🎉`, 'info');
    } else {
      mode = 'work';
      remaining = WORK_MINS * 60;
      window.showToast('Break over — time to focus! 🍅', 'info');
    }
    updateDisplay();
    updateButtonStates();
  }

  function onTimerComplete() {
    // Play notification sound (system beep)
    try { new Audio('data:audio/wav;base64,UklGRl9vT19teleGFyAAABAAEARKwAAIhYAQACABAAAABkYXRh').play(); } catch {}

    // Show native notification
    if (Notification.permission === 'granted') {
      new Notification('Apex Debug Studio Pomodoro', {
        body: mode === 'work' ? `Session #${sessionCount + 1} complete! Time for a break.` : 'Break is over! Ready to focus?',
        icon: '🍅',
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }

    switchMode();
  }

  function getBreakDuration() {
    return sessionCount > 0 && sessionCount % SESSIONS_BEFORE_LONG === 0 ? LONG_BREAK : SHORT_BREAK;
  }

  function updateDisplay() {
    const timeStr = formatTime(remaining);

    // Panel display
    const timerEl   = $('#pomo-timer-display');
    const modeEl    = $('#pomo-mode-label');
    const sessionEl = $('#pomo-session-count');
    const progressEl = $('#pomo-progress');

    if (timerEl) timerEl.textContent = timeStr;
    if (modeEl) {
      modeEl.textContent = mode === 'work' ? '🍅 Focus Time' : '☕ Break Time';
      modeEl.className = 'pomo-mode-label ' + (mode === 'work' ? 'pomo-work' : 'pomo-break');
    }
    if (sessionEl) sessionEl.textContent = `Session ${sessionCount + 1}`;

    // Progress ring
    const totalSecs = (mode === 'work' ? WORK_MINS : getBreakDuration()) * 60;
    const pct = ((totalSecs - remaining) / totalSecs) * 100;
    if (progressEl) {
      progressEl.style.background = `conic-gradient(${mode === 'work' ? 'var(--accent)' : '#2ecc71'} ${pct}%, var(--bg-tertiary) ${pct}%)`;
    }

    // Titlebar header widget
    const tbWidget = $('#pomo-titlebar');
    const tbTime   = $('#pomo-tb-time');
    const tbMode   = $('#pomo-tb-mode');
    if (tbWidget) {
      if (isRunning) {
        tbWidget.classList.remove('hidden');
        if (tbTime) tbTime.textContent = timeStr;
        if (tbMode) {
          tbMode.textContent = mode === 'work' ? 'Focus' : 'Break';
          tbWidget.classList.toggle('pomo-tb-break', mode === 'break');
          tbWidget.classList.toggle('pomo-tb-running', true);
        }
      } else {
        tbWidget.classList.add('hidden');
      }
    }
  }

  function updateButtonStates() {
    const startBtn = $('#btn-pomo-start');
    const pauseBtn = $('#btn-pomo-pause');
    if (startBtn) startBtn.disabled = isRunning;
    if (pauseBtn) pauseBtn.disabled = !isRunning;
  }

  function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  window.initPomodoro = init;
})();

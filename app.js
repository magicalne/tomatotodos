/*
 * 🍅 Tomato Todos — app.js
 * A local-first todo list + pomodoro timer with per-task time tracking.
 * Plain vanilla JS, no dependencies, all state in localStorage.
 *
 * Timer design: timestamp-based, never tick-accumulated. A running session
 * stores `endsAt = Date.now() + remaining`; every repaint recomputes the
 * remaining time from the wall clock, so background-tab throttling and
 * closed tabs cannot cause drift. The 250ms interval (plus a one-shot
 * fallback timer) only repaints and detects completion.
 */
'use strict';

(function () {
  /* ============================== Constants ============================== */

  const APP = 'tomato-todos';
  const APP_VERSION = '1.0.0';
  const KEYS = {
    settings: APP + ':settings',
    tasks: APP + ':tasks',
    sessions: APP + ':sessions',
    timer: APP + ':timer',
    ui: APP + ':ui',
  };
  const MODES = ['focus', 'short', 'long'];
  const MODE_LABEL = { focus: 'focus', short: 'short break', long: 'long break' };
  const DEFAULT_SETTINGS = {
    focusMin: 24,
    shortBreakMin: 5,
    longBreakMin: 15,
    longBreakEvery: 4,
    autoStartBreaks: true,
    autoStartNextFocus: false,
    volume: 0.6,
    theme: 'auto',
    notifyEnabled: false,
  };
  const MAX_SESSIONS = 5000;      // oldest records are dropped beyond this
  const TICK_MS = 250;            // repaint interval only — never accumulates time
  const MIN_LOGGED_SKIP_MS = 1000; // skipping a session shorter than this logs nothing
  const BASE_TITLE = '🍅 Tomato Todos';
  const RING_C = 2 * Math.PI * 106; // progress-ring circumference (r=106, viewBox 240)

  /* ============================== Helpers ============================== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const toNum = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
  const toBool = (v, def) => (typeof v === 'boolean' ? v : def);
  const toStr = (v, def = '') => (typeof v === 'string' ? v : def);
  const deepCopy = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  /** Local calendar day key (day boundary = local midnight), e.g. "2026-10-05". */
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  const todayKey = () => dayKey(Date.now());

  /** mm:ss, rounding up so a full 24:00 session shows 24:00, not 23:59. */
  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
  }

  function fmtDuration(mins) {
    const m = Math.max(0, Math.round(mins));
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
  }

  function fmtTimeOfDay(ts) {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ============================== Storage ============================== */

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch (e) {
      console.warn('Tomato Todos: unreadable data for', key, e);
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('Tomato Todos: could not save', key, e);
      toast('Could not save — is storage available?');
      return false;
    }
  }

  /* ---------- Defensive validators: malformed data never breaks the app ---------- */

  function sanitizeSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const hasNotif = typeof Notification !== 'undefined';
    return {
      focusMin: clamp(Math.round(toNum(r.focusMin, DEFAULT_SETTINGS.focusMin)), 1, 180),
      shortBreakMin: clamp(Math.round(toNum(r.shortBreakMin, DEFAULT_SETTINGS.shortBreakMin)), 1, 60),
      longBreakMin: clamp(Math.round(toNum(r.longBreakMin, DEFAULT_SETTINGS.longBreakMin)), 1, 120),
      longBreakEvery: clamp(Math.round(toNum(r.longBreakEvery, DEFAULT_SETTINGS.longBreakEvery)), 2, 8),
      autoStartBreaks: toBool(r.autoStartBreaks, true),
      autoStartNextFocus: toBool(r.autoStartNextFocus, false),
      volume: clamp(toNum(r.volume, DEFAULT_SETTINGS.volume), 0, 1),
      theme: ['auto', 'light', 'dark'].includes(r.theme) ? r.theme : 'auto',
      // A stale "enabled" without live permission is useless — require the grant.
      notifyEnabled: toBool(r.notifyEnabled, false) && hasNotif && Notification.permission === 'granted',
    };
  }

  function sanitizeTasks(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue;
      const title = toStr(t.title).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!title) continue;
      let id = toStr(t.id);
      if (!id || seen.has(id)) id = uuid();
      seen.add(id);
      out.push({
        id,
        title,
        note: toStr(t.note).slice(0, 1000),
        dueToday: toBool(t.dueToday, false),
        done: toBool(t.done, false),
        createdAt: toNum(t.createdAt, Date.now()),
        completedAt: toNum(t.completedAt, null),
      });
    }
    return out;
  }

  function sanitizeSessions(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue;
      const type = MODES.includes(s.type) ? s.type : null;
      const startedAt = toNum(s.startedAt, null);
      const endedAt = toNum(s.endedAt, null);
      if (!type || startedAt == null || endedAt == null || endedAt < startedAt) continue;
      let id = toStr(s.id);
      if (!id) id = uuid();
      out.push({
        id,
        type,
        taskId: toStr(s.taskId) || null,
        taskTitle: toStr(s.taskTitle) || null,
        startedAt,
        endedAt,
        completed: toBool(s.completed, false),
        durationSec: clamp(Math.round(toNum(s.durationSec, (endedAt - startedAt) / 1000)), 0, 24 * 3600),
      });
    }
    return out;
  }

  function sanitizeTimer(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const mode = MODES.includes(r.mode) ? r.mode : 'focus';
    const t = {
      mode,
      running: toBool(r.running, false),
      endsAt: toNum(r.endsAt, null),
      remainingMs: Math.max(-1, Math.round(toNum(r.remainingMs, -1))),
      sessionStartedAt: toNum(r.sessionStartedAt, null),
      pausedTotal: Math.max(0, toNum(r.pausedTotal, 0)),
      pauseStartedAt: toNum(r.pauseStartedAt, null),
      focusStreak: clamp(Math.round(toNum(r.focusStreak, 0)), 0, 99),
      activeTaskId: toStr(r.activeTaskId) || null,
      sessionTaskTitle: toStr(r.sessionTaskTitle) || null,
    };
    if (!t.running) { t.endsAt = null; t.pauseStartedAt = null; }
    else if (t.endsAt == null) { t.running = false; }
    return t;
  }

  /* ============================== State ============================== */

  const state = {
    settings: sanitizeSettings(readJSON(KEYS.settings) ?? {}),
    tasks: sanitizeTasks(readJSON(KEYS.tasks) ?? []),
    sessions: sanitizeSessions(readJSON(KEYS.sessions) ?? []),
    timer: sanitizeTimer(readJSON(KEYS.timer) ?? {}),
  };
  const ui = Object.assign({ doneOpen: true }, sanitizeUi(readJSON(KEYS.ui)));

  function sanitizeUi(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return { doneOpen: toBool(r.doneOpen, true) };
  }

  function saveUi() { writeJSON(KEYS.ui, ui); }

  /** Reconcile timer state after load/import. */
  function normalizeTimer() {
    const t = state.timer;
    const sched = scheduledMs(t.mode);
    if (t.sessionStartedAt == null) {
      t.remainingMs = sched;
    } else if (!(t.remainingMs >= 0)) {
      // Corrupt remaining while mid-session — fall back to a fresh idle session.
      t.remainingMs = sched;
      t.sessionStartedAt = null;
    }
    if (t.running && (t.endsAt == null || t.sessionStartedAt == null)) {
      t.running = false;
      t.endsAt = null;
      t.sessionStartedAt = null;
      t.pauseStartedAt = null;
      t.remainingMs = sched;
    }
    if (!t.running) { t.endsAt = null; t.pauseStartedAt = null; }
    if (t.activeTaskId && !taskById(t.activeTaskId)) t.activeTaskId = null;
    if (state.sessions.length > MAX_SESSIONS) state.sessions = state.sessions.slice(-MAX_SESSIONS);
  }

  function saveState() {
    writeJSON(KEYS.settings, state.settings);
    writeJSON(KEYS.tasks, state.tasks);
    writeJSON(KEYS.sessions, state.sessions);
    writeJSON(KEYS.timer, state.timer);
    scheduleCompletionFallback();
  }

  /* ============================== Theme ============================== */

  function applyTheme() {
    const pref = state.settings.theme;
    const dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const btn = $('#themeBtn');
    if (btn) {
      btn.textContent = pref === 'auto' ? '🌗' : dark ? '🌙' : '☀️';
      btn.title = 'Theme: ' + pref + ' (click to cycle)';
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#141317' : '#f5f3f0';
  }

  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    saveState();
    applyTheme();
    if (!$('#settingsDrawer').hidden) renderSettingsPanel();
    toast('Theme: ' + state.settings.theme);
  }

  /* ============================== Audio & notifications ============================== */

  let audioCtx = null;

  /** Call from user gestures (Start button etc.) to unlock audio for later use. */
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch (e) { /* audio unavailable — alarm falls back to title flash */ }
  }

  /** Pleasant repeated triple-tone, ~2s. Safe to call without a gesture. */
  function playAlarm() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const ctx = audioCtx;
      const vol = clamp(state.settings.volume, 0, 1);
      if (vol <= 0 || ctx.state === 'closed') return;
      const t0 = ctx.currentTime + 0.05;
      const tones = [659.25, 880, 1108.73]; // E5 · A5 · C#6 — rising major arpeggio
      for (let rep = 0; rep < 2; rep++) {
        tones.forEach((freq, i) => {
          const start = t0 + rep * 0.96 + i * 0.3;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), start + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.27);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 0.32);
        });
      }
    } catch (e) { /* never let the alarm break the session flow */ }
  }

  function notifySessionEnd(wasFocus, taskTitle) {
    if (!state.settings.notifyEnabled) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const title = wasFocus ? '🍅 Focus complete — take a break' : '☕ Break over — back to focus';
    const body = wasFocus
      ? taskTitle ? '“' + taskTitle + '” logged. Time for a break.' : 'Nice work — time for a break.'
      : 'Stretch, water, eyes off the screen.';
    try {
      const n = new Notification(title, { body, tag: APP });
      if (n && typeof n.addEventListener === 'function') {
        n.addEventListener('click', () => { try { window.focus(); n.close(); } catch (e) {} });
      }
    } catch (e) { /* some platforms require a service worker — silent fallback */ }
  }

  /* ---------- Title flash fallback ---------- */

  let titleFlashing = false;
  let flashAlternate = null;
  let flashTimer = null;

  function startTitleFlash(wasFocus) {
    stopTitleFlash();
    titleFlashing = true;
    const msg = wasFocus ? 'Break time!' : 'Back to focus!';
    let on = false;
    const flash = () => { on = !on; document.title = on ? '⏰ ' + msg : BASE_TITLE; };
    flash();
    flashAlternate = setInterval(flash, 900);
    flashTimer = setTimeout(stopTitleFlash, 10000);
  }

  function stopTitleFlash() {
    titleFlashing = false;
    if (flashAlternate) { clearInterval(flashAlternate); flashAlternate = null; }
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    document.title = titleFor(remainingMs());
  }

  /* ============================== Timer engine ============================== */

  let completionFallbackTimer = null;

  function scheduledMs(mode = state.timer.mode) {
    const s = state.settings;
    const min = mode === 'focus' ? s.focusMin : mode === 'short' ? s.shortBreakMin : s.longBreakMin;
    return clamp(Math.round(min), 1, 240) * 60000;
  }

  function remainingMs() {
    const t = state.timer;
    if (t.sessionStartedAt == null) return Math.max(0, t.remainingMs);
    if (t.running) return Math.max(0, (t.endsAt ?? 0) - Date.now());
    return Math.max(0, t.remainingMs);
  }

  /** Elapsed focus time of the in-flight session, pause-compensated. */
  function elapsedNow() {
    const t = state.timer;
    if (t.sessionStartedAt == null) return 0;
    const ref = t.running ? Date.now() : (t.pauseStartedAt ?? Date.now());
    return clamp(ref - t.sessionStartedAt - t.pausedTotal, 0, scheduledMs());
  }

  function titleFor(rem) {
    const t = state.timer;
    if (t.sessionStartedAt == null && !t.running) return BASE_TITLE;
    const icon = t.mode === 'focus' ? '🍅' : '☕';
    return fmtClock(rem) + ' ・ ' + icon + ' ' + MODE_LABEL[t.mode] + (t.running ? '' : ' ⏸');
  }

  function updateTimeDisplay(rem) {
    const el = $('#timeDisplay');
    if (el) el.textContent = fmtClock(rem);
    const ring = $('#ringFg');
    if (ring) {
      const frac = clamp(rem / scheduledMs(), 0, 1);
      ring.style.strokeDashoffset = String(RING_C * (1 - frac));
    }
    if (!titleFlashing) document.title = titleFor(rem);
  }

  /** Repaint from the wall clock. The interval must never accumulate time. */
  function tick() {
    const t = state.timer;
    if (t.running) {
      const rem = (t.endsAt ?? 0) - Date.now();
      if (rem <= 0) { completeSession(); return; }
      updateTimeDisplay(rem);
    } else {
      updateTimeDisplay(remainingMs());
    }
  }

  /**
   * One-shot safety net: browsers heavily throttle intervals in hidden tabs,
   * but a single pending timeout fires close to on time — this makes the
   * alarm reasonably prompt even when the tab sits in the background.
   */
  function scheduleCompletionFallback() {
    if (completionFallbackTimer) { clearTimeout(completionFallbackTimer); completionFallbackTimer = null; }
    const t = state.timer;
    if (!t.running || t.endsAt == null) return;
    const wait = Math.max(500, t.endsAt - Date.now() + 500);
    completionFallbackTimer = setTimeout(() => { completionFallbackTimer = null; tick(); }, wait);
  }

  /* ---------- Session transitions ---------- */

  function primaryAction() {
    const t = state.timer;
    if (t.running) {
      // Pause: freeze the remaining time; the wall-clock link is cut until resume.
      t.remainingMs = Math.max(0, (t.endsAt ?? Date.now()) - Date.now());
      t.pauseStartedAt = Date.now();
      t.running = false;
      saveState();
      renderAll();
    } else if (t.sessionStartedAt != null) {
      // Resume a paused session.
      unlockAudio();
      const now = Date.now();
      if (t.pauseStartedAt != null) { t.pausedTotal += now - t.pauseStartedAt; t.pauseStartedAt = null; }
      t.endsAt = now + t.remainingMs;
      t.running = true;
      saveState();
      renderAll();
    } else {
      startFreshSession();
    }
  }

  function startFreshSession() {
    const t = state.timer;
    unlockAudio();
    const now = Date.now();
    const dur = scheduledMs();
    t.running = true;
    t.sessionStartedAt = now;
    t.endsAt = now + dur;
    t.remainingMs = dur;
    t.pausedTotal = 0;
    t.pauseStartedAt = null;
    t.sessionTaskTitle = t.mode === 'focus' ? (taskById(t.activeTaskId)?.title ?? null) : null;
    stopTitleFlash();
    saveState();
    renderAll();
  }

  /** Stop + reset current mode to full duration. Nothing is logged. */
  function resetSession() {
    const t = state.timer;
    t.running = false;
    t.endsAt = null;
    t.sessionStartedAt = null;
    t.remainingMs = scheduledMs();
    t.pausedTotal = 0;
    t.pauseStartedAt = null;
    t.sessionTaskTitle = null;
    stopTitleFlash();
    saveState();
    renderAll();
  }

  function endedAtFrom(now, t) {
    return t.endsAt ?? now;
  }

  function skipSession() {
    completeSession({ skipped: true });
  }

  /**
   * End the current session: log it, pick the next mode, optionally auto-start.
   * `skipped` marks an early exit (partial time is still credited);
   * `forcedNext` is used when the user manually switches modes mid-session.
   */
  function completeSession(opts = {}) {
    const skipped = !!opts.skipped;
    const forcedNext = opts.forcedNext ?? null;
    const t = state.timer;
    const wasFocus = t.mode === 'focus';
    const wasStarted = t.sessionStartedAt != null;
    const now = Date.now();
    const scheduled = scheduledMs();
    const elapsed = skipped ? elapsedNow() : scheduled;
    const startedAt = wasStarted ? t.sessionStartedAt : Math.max(0, endedAtFrom(now, t) - elapsed);
    // A backward wall-clock jump (NTP correction, simulated endsAt) must never
    // produce a record with endedAt < startedAt — clamp to keep the log valid.
    const endedAt = skipped ? now : Math.max(endedAtFrom(now, t), startedAt);

    stopTitleFlash();

    let loggedTaskTitle = null;
    if (!skipped || elapsed >= MIN_LOGGED_SKIP_MS) {
      const activeTask = wasFocus && t.activeTaskId ? taskById(t.activeTaskId) : null;
      loggedTaskTitle = activeTask ? activeTask.title : (wasFocus ? (t.sessionTaskTitle || null) : null);
      state.sessions.push({
        id: uuid(),
        type: t.mode,
        taskId: activeTask ? activeTask.id : null,
        taskTitle: loggedTaskTitle,
        startedAt,
        endedAt,
        completed: !skipped,
        durationSec: Math.round(elapsed / 1000),
      });
      if (state.sessions.length > MAX_SESSIONS) state.sessions.splice(0, state.sessions.length - MAX_SESSIONS);
    }

    // Pick the next mode and maintain the long-break cadence counter.
    let next;
    if (forcedNext && MODES.includes(forcedNext)) {
      next = forcedNext;
    } else if (wasFocus) {
      if (!skipped) t.focusStreak += 1;
      next = t.focusStreak >= state.settings.longBreakEvery ? 'long' : 'short';
    } else {
      next = 'focus';
    }
    if (!wasFocus && t.mode === 'long') t.focusStreak = 0; // long break taken-or-skipped resets the cadence

    const startNext = skipped ? wasStarted : (wasFocus ? state.settings.autoStartBreaks : state.settings.autoStartNextFocus);

    const dur = scheduledMs(next);
    t.mode = next;
    t.remainingMs = dur;
    t.pausedTotal = 0;
    t.pauseStartedAt = null;
    if (startNext) {
      const s = Date.now();
      t.running = true;
      t.sessionStartedAt = s;
      t.endsAt = s + dur;
      t.sessionTaskTitle = next === 'focus' ? (taskById(t.activeTaskId)?.title ?? null) : null;
    } else {
      t.running = false;
      t.sessionStartedAt = null;
      t.endsAt = null;
      t.sessionTaskTitle = null;
    }

    if (!skipped) {
      playAlarm();
      notifySessionEnd(wasFocus, loggedTaskTitle);
      startTitleFlash(wasFocus);
      pulseTimerCard();
    }
    saveState();
    renderAll();
  }

  /** Manual mode switch (tabs / keys 1-2-3). In-flight sessions log as skipped. */
  function switchMode(mode) {
    if (!MODES.includes(mode)) return;
    const t = state.timer;
    const wasStarted = t.sessionStartedAt != null;
    if (t.mode === mode && !wasStarted) {
      t.remainingMs = scheduledMs(mode);
      saveState();
      renderAll();
      return;
    }
    if (wasStarted && elapsedNow() >= MIN_LOGGED_SKIP_MS) {
      completeSession({ skipped: true, forcedNext: mode });
      return;
    }
    t.mode = mode;
    t.running = false;
    t.sessionStartedAt = null;
    t.endsAt = null;
    t.remainingMs = scheduledMs(mode);
    t.pausedTotal = 0;
    t.pauseStartedAt = null;
    t.sessionTaskTitle = null;
    saveState();
    renderAll();
  }

  function pulseTimerCard() {
    const card = $('#timerCard');
    if (!card) return;
    card.classList.remove('session-end');
    void card.offsetWidth; // restart the CSS animation
    card.classList.add('session-end');
    setTimeout(() => card.classList.remove('session-end'), 1600);
  }

  /* ============================== Tasks ============================== */

  function taskById(id) {
    return state.tasks.find((t) => t.id === id) || null;
  }

  function addTask(title) {
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    state.tasks.unshift({
      id: uuid(),
      title: clean.slice(0, 300),
      note: '',
      dueToday: false,
      done: false,
      createdAt: Date.now(),
      completedAt: null,
    });
    saveState();
    renderTasks();
    renderStats();
  }

  function toggleDone(id) {
    const task = taskById(id);
    if (!task) return;
    task.done = !task.done;
    task.completedAt = task.done ? Date.now() : null;
    if (task.done && state.timer.activeTaskId === id) state.timer.activeTaskId = null;
    saveState();
    renderTasks();
    renderTimer();
    renderStats();
  }

  function deleteTask(id) {
    const task = taskById(id);
    if (!task) return;
    confirmDialog({
      title: 'Delete task?',
      body: '“' + task.title + '” will be removed. Session history is kept.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      state.tasks = state.tasks.filter((t) => t.id !== id);
      if (state.timer.activeTaskId === id) state.timer.activeTaskId = null;
      saveState();
      renderAll();
      toast('Task deleted');
    });
  }

  function activateTask(id) {
    const t = state.timer;
    t.activeTaskId = t.activeTaskId === id ? null : id;
    // Keep the in-flight session's title snapshot in sync with the new target.
    if (t.sessionStartedAt != null && t.mode === 'focus') {
      t.sessionTaskTitle = taskById(t.activeTaskId)?.title ?? null;
    }
    saveState();
    renderTasks();
    renderTimer();
  }

  function updateTask(id, patch) {
    const task = taskById(id);
    if (!task) return;
    if (patch.title != null) {
      const clean = String(patch.title).replace(/\s+/g, ' ').trim();
      if (clean) task.title = clean.slice(0, 300);
    }
    if (patch.note != null) task.note = String(patch.note).slice(0, 1000);
    if (patch.dueToday != null) task.dueToday = !!patch.dueToday;
    saveState();
    renderTasks();
    renderTimer();
  }

  /** Reorder within the open (not-done) subsequence so done items never block a move. */
  function moveTask(id, dir) {
    const openIdx = state.tasks.map((t, i) => (t.done ? -1 : i)).filter((i) => i >= 0);
    const pos = openIdx.findIndex((i) => state.tasks[i].id === id);
    if (pos < 0) return;
    const swapPos = pos + dir;
    if (swapPos < 0 || swapPos >= openIdx.length) return;
    const a = openIdx[pos];
    const b = openIdx[swapPos];
    const tmp = state.tasks[a];
    state.tasks[a] = state.tasks[b];
    state.tasks[b] = tmp;
    saveState();
    renderTasks();
  }

  /* ============================== Stats ============================== */

  function sessionsOnDay(key) {
    return state.sessions.filter((s) => dayKey(s.endedAt) === key);
  }

  function todayStats() {
    const focus = sessionsOnDay(todayKey()).filter((s) => s.type === 'focus');
    return {
      minutes: focus.reduce((a, s) => a + (s.durationSec || 0) / 60, 0),
      pomodoros: focus.filter((s) => s.completed).length,
      streak: currentStreak(),
    };
  }

  /** Per-task focus stats for today, sorted by minutes desc. */
  function taskStatsToday() {
    const map = new Map();
    for (const s of sessionsOnDay(todayKey())) {
      if (s.type !== 'focus') continue;
      const key = s.taskId ?? (s.taskTitle ? 'title:' + s.taskTitle : 'none');
      let e = map.get(key);
      if (!e) {
        e = { key, title: taskById(s.taskId)?.title ?? s.taskTitle ?? '(no task)', minutes: 0, pomodoros: 0 };
        map.set(key, e);
      }
      e.minutes += (s.durationSec || 0) / 60;
      if (s.completed) e.pomodoros += 1;
    }
    return Array.from(map.values()).sort((a, b) => b.minutes - a.minutes || b.pomodoros - a.pomodoros);
  }

  function taskTodayStats(id) {
    let minutes = 0;
    let pomodoros = 0;
    for (const s of sessionsOnDay(todayKey())) {
      if (s.type !== 'focus' || s.taskId !== id) continue;
      minutes += (s.durationSec || 0) / 60;
      if (s.completed) pomodoros += 1;
    }
    return { minutes, pomodoros };
  }

  /** Consecutive days (ending today, or yesterday if today has none yet) with ≥1 completed 🍅. */
  function currentStreak() {
    const days = new Set(
      state.sessions.filter((s) => s.type === 'focus' && s.completed).map((s) => dayKey(s.endedAt))
    );
    const d = new Date();
    if (!days.has(dayKey(+d))) d.setDate(d.getDate() - 1); // grace for "not yet focused today"
    let streak = 0;
    while (days.has(dayKey(+d))) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  /** Focus minutes + completed 🍅 for each of the last 14 local days, oldest first. */
  function last14Days() {
    const out = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(base.getDate() - i); // date arithmetic survives DST; ms math does not
      const key = dayKey(+d);
      let minutes = 0;
      let pomodoros = 0;
      for (const s of state.sessions) {
        if (s.type !== 'focus' || dayKey(s.endedAt) !== key) continue;
        minutes += (s.durationSec || 0) / 60;
        if (s.completed) pomodoros += 1;
      }
      out.push({ key, dayNum: d.getDate(), minutes, pomodoros, isToday: i === 0 });
    }
    return out;
  }

  /* ============================== Export / import / Logseq ============================== */

  function buildExport() {
    return {
      app: APP,
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      tasks: state.tasks,
      sessions: state.sessions,
      timer: state.timer,
    };
  }

  function downloadFile(name, content, mime) {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function exportJson() {
    downloadFile('tomato-todos-backup-' + todayKey() + '.json', JSON.stringify(buildExport(), null, 2), 'application/json');
    toast('Backup downloaded');
  }

  function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });
  }

  function importJson(file) {
    readFileText(file)
      .then((txt) => {
        let obj;
        try {
          obj = JSON.parse(txt);
        } catch (e) {
          toast('Not valid JSON');
          return;
        }
        if (!obj || typeof obj !== 'object' || obj.app !== APP) {
          toast('Not a Tomato Todos backup');
          return;
        }
        const next = {
          settings: sanitizeSettings(obj.settings),
          tasks: sanitizeTasks(obj.tasks),
          sessions: sanitizeSessions(obj.sessions),
          timer: sanitizeTimer(obj.timer),
        };
        confirmDialog({
          title: 'Import backup?',
          body: 'Replaces current data with ' + next.tasks.length + ' task(s) and ' + next.sessions.length +
            ' session(s)' + (obj.exportedAt ? ' exported ' + obj.exportedAt.slice(0, 10) : '') + '.',
          confirmLabel: 'Import',
        }).then((ok) => {
          if (!ok) return;
          state.settings = next.settings;
          state.tasks = next.tasks;
          state.sessions = next.sessions;
          state.timer = next.timer;
          normalizeTimer();
          applyTheme();
          saveState();
          renderAll();
          renderSettingsPanel();
          closeDrawer();
          toast('Imported ✓');
        });
      })
      .catch(() => toast('Could not read file'));
  }

  /**
   * Logseq-style daily log for today:
   *   - ## 🍅 2026-10-05 — 6 pomodoros, 144m focus
   *     - DONE Write release notes
   *       pomodoros:: 3
   *       focused-minutes:: 72
   */
  function buildLogseqMarkdown() {
    const entries = taskStatsToday().filter((e) => e.pomodoros > 0 || e.minutes > 0);
    const totalPom = entries.reduce((a, e) => a + e.pomodoros, 0);
    const totalMin = Math.round(entries.reduce((a, e) => a + e.minutes, 0));
    const lines = ['- ## 🍅 ' + todayKey() + ' — ' + totalPom + ' pomodoro' + (totalPom === 1 ? '' : 's') + ', ' + totalMin + 'm focus'];
    for (const e of entries) {
      const task = e.key.startsWith('title:') || e.key === 'none' ? null : taskById(e.key);
      const status = task && task.done ? 'DONE' : 'DOING';
      lines.push('  - ' + status + ' ' + e.title);
      lines.push('    pomodoros:: ' + e.pomodoros);
      lines.push('    focused-minutes:: ' + Math.round(e.minutes));
    }
    return lines.join('\n');
  }

  async function copyLogseq() {
    const md = buildLogseqMarkdown();
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
      await navigator.clipboard.writeText(md);
      toast('Logseq log copied ✓');
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = md;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        toast(ok ? 'Logseq log copied ✓' : 'Copy failed — use Download instead');
      } catch (e2) {
        toast('Copy failed — use Download instead');
      }
    }
  }

  function downloadLogseq() {
    downloadFile('tomato-' + todayKey() + '.md', buildLogseqMarkdown(), 'text/markdown');
    toast('Markdown downloaded');
  }

  function wipeToday() {
    confirmDialog({
      title: "Wipe today's data?",
      body: "Removes today's sessions and un-completes tasks finished today. Tasks and earlier history stay.",
      confirmLabel: 'Wipe today',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      const key = todayKey();
      state.sessions = state.sessions.filter((s) => dayKey(s.endedAt) !== key);
      for (const t of state.tasks) {
        if (t.done && t.completedAt && dayKey(t.completedAt) === key) {
          t.done = false;
          t.completedAt = null;
        }
      }
      saveState();
      renderAll();
      toast("Today's data wiped");
    });
  }

  function wipeAll() {
    confirmDialog({
      title: 'Wipe everything?',
      body: 'Deletes all tasks, sessions and settings from this browser. This cannot be undone.',
      confirmLabel: 'Delete everything',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      try {
        for (const k of Object.values(KEYS)) localStorage.removeItem(k);
      } catch (e) { /* best effort */ }
      state.settings = deepCopy(DEFAULT_SETTINGS);
      state.tasks = [];
      state.sessions = [];
      state.timer = {
        mode: 'focus',
        running: false,
        endsAt: null,
        remainingMs: scheduledMs('focus'),
        sessionStartedAt: null,
        pausedTotal: 0,
        pauseStartedAt: null,
        focusStreak: 0,
        activeTaskId: null,
        sessionTaskTitle: null,
      };
      editingTaskId = null;
      applyTheme();
      saveState();
      renderAll();
      renderSettingsPanel();
      closeDrawer();
      toast('All data wiped');
    });
  }

  /* ============================== Rendering ============================== */

  let editingTaskId = null;

  function renderAll() {
    renderTimer();
    renderTasks();
    renderStats();
  }

  function renderTimer() {
    const t = state.timer;
    $$('.mode-tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === t.mode));
    const card = $('#timerCard');
    card.classList.toggle('mode-focus', t.mode === 'focus');
    card.classList.toggle('mode-break', t.mode !== 'focus');

    updateTimeDisplay(remainingMs());

    const btn = $('#startBtn');
    btn.textContent = t.running ? 'Pause' : (t.sessionStartedAt != null ? 'Resume' : 'Start');

    const every = state.settings.longBreakEvery;
    let dots = '';
    for (let i = 0; i < every; i++) dots += '<span class="dot' + (i < t.focusStreak ? ' filled' : '') + '"></span>';
    const dotsEl = $('#cycleDots');
    dotsEl.innerHTML = dots;
    dotsEl.title = t.focusStreak + ' of ' + every + ' focus sessions until a long break';

    const line = $('#activeTaskLine');
    const at = t.activeTaskId ? taskById(t.activeTaskId) : null;
    if (at) {
      line.innerHTML =
        '<span class="at-label">🎯 active:</span> <strong>' + esc(at.title) + '</strong>' +
        '<button class="icon-btn" data-action="clear-active" title="Clear active task" aria-label="Clear active task">✕</button>';
    } else {
      line.innerHTML = '<span class="at-muted">No active task — pick one with 🎯 below so focus time is credited.</span>';
    }
  }

  function taskRowHTML(task, index, count) {
    if (editingTaskId === task.id) return taskEditHTML(task);
    const st = taskTodayStats(task.id);
    const active = state.timer.activeTaskId === task.id;
    const stats = [
      st.pomodoros ? '🍅 ' + st.pomodoros : '',
      st.minutes ? fmtDuration(st.minutes) : '',
    ].filter(Boolean).join(' · ');
    return (
      '<li class="task' + (active ? ' active' : '') + '" data-id="' + task.id + '">' +
        '<button class="check-btn" data-action="toggle-done" aria-label="Mark &quot;' + esc(task.title) + '&quot; done" title="Mark done">✓</button>' +
        '<div class="task-main">' +
          '<div class="task-title-line">' +
            '<span class="task-title">' + esc(task.title) + '</span>' +
            (task.dueToday ? '<span class="badge due-badge" title="Due today">⚑ today</span>' : '') +
            (task.note ? '<span class="badge" title="' + esc(task.note) + '">📝</span>' : '') +
          '</div>' +
          (task.note ? '<div class="task-note">' + esc(task.note) + '</div>' : '') +
        '</div>' +
        '<div class="task-stats">' + stats + '</div>' +
        '<div class="task-actions">' +
          '<button class="icon-btn" data-action="move-up" title="Move up" aria-label="Move up"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="icon-btn" data-action="move-down" title="Move down" aria-label="Move down"' + (index === count - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button class="icon-btn" data-action="edit" title="Edit (or double-click the title)" aria-label="Edit task">✏️</button>' +
          '<button class="icon-btn activate-btn' + (active ? ' on' : '') + '" data-action="activate" title="' + (active ? 'Unset active task' : 'Set as active task') + '" aria-label="Set active">🎯</button>' +
          '<button class="icon-btn danger" data-action="delete" title="Delete task" aria-label="Delete task">🗑</button>' +
        '</div>' +
      '</li>'
    );
  }

  function taskEditHTML(task) {
    return (
      '<li class="task editing" data-id="' + task.id + '">' +
        '<form class="task-edit">' +
          '<input class="edit-title" name="title" value="' + esc(task.title) + '" maxlength="300" autocomplete="off" aria-label="Task title">' +
          '<input class="edit-note" name="note" value="' + esc(task.note) + '" placeholder="Note (optional)" maxlength="1000" autocomplete="off" aria-label="Task note">' +
          '<label class="edit-due"><input type="checkbox" name="dueToday"' + (task.dueToday ? ' checked' : '') + '> due today</label>' +
          '<div class="edit-actions">' +
            '<button type="submit" class="btn small primary">Save</button>' +
            '<button type="button" class="btn small" data-action="cancel-edit">Cancel</button>' +
          '</div>' +
        '</form>' +
      '</li>'
    );
  }

  function doneRowHTML(task) {
    const st = taskTodayStats(task.id);
    return (
      '<li class="task done" data-id="' + task.id + '">' +
        '<button class="check-btn checked" data-action="toggle-done" aria-label="Mark not done" title="Mark not done">✓</button>' +
        '<div class="task-main"><span class="task-title">' + esc(task.title) + '</span></div>' +
        '<div class="task-stats">' + (st.pomodoros ? '🍅 ' + st.pomodoros : '') + '</div>' +
        '<span class="done-at">' + (task.completedAt ? fmtTimeOfDay(task.completedAt) : '') + '</span>' +
        '<div class="task-actions">' +
          '<button class="icon-btn danger" data-action="delete" title="Delete task" aria-label="Delete task">🗑</button>' +
        '</div>' +
      '</li>'
    );
  }

  function renderTasks() {
    const open = state.tasks.filter((t) => !t.done);
    const doneToday = state.tasks.filter((t) => t.done && t.completedAt && dayKey(t.completedAt) === todayKey());
    const doneEarlier = state.tasks.filter((t) => t.done && !(t.completedAt && dayKey(t.completedAt) === todayKey()));

    const list = $('#taskList');
    list.innerHTML = open.length
      ? open.map((task, i) => taskRowHTML(task, i, open.length)).join('')
      : '<li class="empty">No open tasks. Add one above ☝️</li>';
    if (editingTaskId) {
      const inp = list.querySelector('.task.editing .edit-title');
      if (inp) { inp.focus(); inp.select(); }
    }

    const doneCount = doneToday.length + doneEarlier.length;
    $('#doneSection').hidden = doneCount === 0;
    const toggle = $('#doneToggle');
    toggle.textContent = (ui.doneOpen ? '▾' : '▸') + ' ✓ Done today (' + doneToday.length + ')';
    toggle.setAttribute('aria-expanded', String(ui.doneOpen));
    const doneList = $('#doneList');
    doneList.hidden = !ui.doneOpen;
    doneList.innerHTML =
      doneToday.map(doneRowHTML).join('') +
      (doneEarlier.length ? '<li class="done-earlier-label">before today</li>' : '') +
      doneEarlier.map(doneRowHTML).join('');
  }

  function renderStats() {
    const s = todayStats();
    $('#statMinutes').textContent = fmtDuration(s.minutes);
    $('#statPom').textContent = String(s.pomodoros);
    $('#statStreak').textContent = s.streak + (s.streak === 1 ? ' day' : ' days');
    $('#statsDate').textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
    });

    const entries = taskStatsToday().filter((e) => e.pomodoros > 0 || e.minutes > 0);
    const perTask = $('#perTask');
    perTask.innerHTML = entries.length
      ? entries.map((e) =>
          '<li><span class="pt-title">' + esc(e.title) + '</span>' +
          '<span class="pt-stats">' + (e.pomodoros ? '🍅 ' + e.pomodoros + ' · ' : '') + fmtDuration(e.minutes) + '</span></li>'
        ).join('')
      : '<li class="empty">No focus time logged yet today.</li>';

    const data = last14Days();
    const max = Math.max(1, ...data.map((d) => d.minutes));
    $('#chart').innerHTML = data.map((d) => {
      const pct = d.minutes > 0 ? Math.max(4, Math.round((d.minutes / max) * 100)) : 3;
      const label = d.key + ': ' + fmtDuration(d.minutes) + ' focus, ' + d.pomodoros + ' 🍅';
      return (
        '<div class="chart-col' + (d.isToday ? ' today' : '') + '" title="' + esc(label) + '">' +
          '<div class="chart-bar-area"><div class="chart-bar' + (d.minutes ? '' : ' zero') + '" style="height:' + pct + '%"></div></div>' +
          '<div class="chart-day">' + d.dayNum + '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderSettingsPanel() {
    const s = state.settings;
    $('#setFocus').value = String(s.focusMin);
    $('#setShort').value = String(s.shortBreakMin);
    $('#setLong').value = String(s.longBreakMin);
    $('#setEvery').value = String(s.longBreakEvery);
    $('#setAutoBreaks').checked = s.autoStartBreaks;
    $('#setAutoFocus').checked = s.autoStartNextFocus;
    $('#setVolume').value = String(s.volume);
    $('#setNotify').checked = s.notifyEnabled;
    const hint = $('#notifyHint');
    if (typeof Notification === 'undefined') hint.textContent = 'Notifications are not supported in this browser.';
    else if (Notification.permission === 'denied') hint.textContent = 'Blocked — allow notifications in browser settings.';
    else hint.textContent = '';
    $$('#themeSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === s.theme));
  }

  /* ============================== Drawer / modal / toast ============================== */

  function openDrawer() {
    renderSettingsPanel();
    $('#settingsDrawer').hidden = false;
    $('#drawerBackdrop').hidden = false;
  }

  function closeDrawer() {
    $('#settingsDrawer').hidden = true;
    $('#drawerBackdrop').hidden = true;
  }

  let modalResolve = null;

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      $('#modalTitle').textContent = opts.title;
      $('#modalBody').textContent = opts.body;
      const btn = $('#modalConfirm');
      btn.textContent = opts.confirmLabel || 'OK';
      btn.className = opts.danger ? 'btn danger' : 'btn primary';
      $('#modal').hidden = false;
      $('#modalBackdrop').hidden = false;
      btn.focus();
    });
  }

  function closeModal(result) {
    if ($('#modal').hidden) return;
    $('#modal').hidden = true;
    $('#modalBackdrop').hidden = true;
    if (modalResolve) {
      const r = modalResolve;
      modalResolve = null;
      r(result);
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ============================== Events ============================== */

  function startEdit(id) {
    editingTaskId = id;
    renderTasks();
  }

  function cancelEdit() {
    editingTaskId = null;
    renderTasks();
  }

  function onListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'cancel-edit') { cancelEdit(); return; }
    const li = e.target.closest('li.task');
    const id = li ? li.dataset.id : null;
    if (!id) return;
    switch (action) {
      case 'toggle-done': toggleDone(id); break;
      case 'edit': startEdit(id); break;
      case 'delete': deleteTask(id); break;
      case 'activate': activateTask(id); break;
      case 'move-up': moveTask(id, -1); break;
      case 'move-down': moveTask(id, 1); break;
    }
  }

  function bindEvents() {
    // Timer controls
    $('#startBtn').addEventListener('click', primaryAction);
    $('#resetBtn').addEventListener('click', resetSession);
    $('#skipBtn').addEventListener('click', skipSession);
    $$('.mode-tab').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));

    // Active-task line
    $('#activeTaskLine').addEventListener('click', (e) => {
      if (e.target.closest('[data-action="clear-active"]')) {
        state.timer.activeTaskId = null;
        state.timer.sessionTaskTitle = null;
        saveState();
        renderTasks();
        renderTimer();
      }
    });

    // Task form
    $('#taskForm').addEventListener('submit', (e) => {
      e.preventDefault();
      addTask($('#taskInput').value);
      $('#taskInput').value = '';
    });
    // Explicit Enter handling: implicit form submission is unreliable on some
    // virtual keyboards and embedded webviews.
    $('#taskInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTask($('#taskInput').value);
        $('#taskInput').value = '';
      }
    });

    // Task lists (delegated)
    $('#taskList').addEventListener('click', onListClick);
    $('#doneList').addEventListener('click', onListClick);
    $('#taskList').addEventListener('dblclick', (e) => {
      if (!e.target.closest('.task-main')) return;
      const li = e.target.closest('li.task');
      if (li && li.dataset.id && !li.classList.contains('done')) startEdit(li.dataset.id);
    });
    $('#taskList').addEventListener('submit', (e) => {
      const form = e.target.closest('form.task-edit');
      if (!form) return;
      e.preventDefault();
      const li = form.closest('li.task');
      if (!li || !li.dataset.id) return;
      const fd = new FormData(form);
      updateTask(li.dataset.id, {
        title: fd.get('title'),
        note: fd.get('note'),
        dueToday: fd.get('dueToday') === 'on',
      });
      editingTaskId = null;
      renderTasks();
    });
    $('#taskList').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches && e.target.matches('.edit-title, .edit-note')) {
        e.preventDefault();
        const form = e.target.closest('form.task-edit');
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      }
    });

    // Done section toggle
    $('#doneToggle').addEventListener('click', () => {
      ui.doneOpen = !ui.doneOpen;
      saveUi();
      renderTasks();
    });

    // Header
    $('#themeBtn').addEventListener('click', cycleTheme);
    $('#settingsBtn').addEventListener('click', openDrawer);
    $('#closeSettings').addEventListener('click', closeDrawer);
    $('#drawerBackdrop').addEventListener('click', closeDrawer);

    // Settings — durations
    const numFields = [
      ['setFocus', 'focusMin', 1, 180],
      ['setShort', 'shortBreakMin', 1, 60],
      ['setLong', 'longBreakMin', 1, 120],
      ['setEvery', 'longBreakEvery', 2, 8],
    ];
    numFields.forEach(([elId, key, min, max]) => {
      $('#' + elId).addEventListener('change', (e) => {
        const v = clamp(Math.round(Number(e.target.value) || min), min, max);
        e.target.value = String(v);
        state.settings[key] = v;
        if (state.timer.sessionStartedAt == null) state.timer.remainingMs = scheduledMs();
        saveState();
        renderTimer();
        renderStats();
      });
    });

    // Settings — behavior
    $('#setAutoBreaks').addEventListener('change', (e) => { state.settings.autoStartBreaks = e.target.checked; saveState(); });
    $('#setAutoFocus').addEventListener('change', (e) => { state.settings.autoStartNextFocus = e.target.checked; saveState(); });
    $('#setVolume').addEventListener('input', (e) => {
      state.settings.volume = clamp(Number(e.target.value) || 0, 0, 1);
      saveState();
    });
    $('#previewAlarm').addEventListener('click', () => { unlockAudio(); playAlarm(); });
    $('#setNotify').addEventListener('change', async (e) => {
      if (!e.target.checked) {
        state.settings.notifyEnabled = false;
        saveState();
        return;
      }
      if (typeof Notification === 'undefined') {
        e.target.checked = false;
        toast('Notifications are not supported in this browser');
        return;
      }
      let perm = Notification.permission;
      if (perm === 'default') {
        try { perm = await Notification.requestPermission(); } catch (err) { perm = 'denied'; }
      }
      if (perm === 'granted') {
        state.settings.notifyEnabled = true;
        toast('Notifications on');
      } else {
        e.target.checked = false;
        toast(perm === 'denied' ? 'Notifications are blocked in browser settings' : 'Permission not granted');
      }
      saveState();
    });

    // Settings — theme
    $$('#themeSeg .seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        state.settings.theme = b.dataset.themeSet;
        saveState();
        applyTheme();
        renderSettingsPanel();
      });
    });

    // Settings — data
    $('#exportJson').addEventListener('click', exportJson);
    $('#importJson').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importJson(f);
      e.target.value = '';
    });
    $('#copyLogseq').addEventListener('click', copyLogseq);
    $('#downloadLogseq').addEventListener('click', downloadLogseq);
    $('#wipeToday').addEventListener('click', wipeToday);
    $('#wipeAll').addEventListener('click', wipeAll);

    // Modal
    $('#modalConfirm').addEventListener('click', () => closeModal(true));
    $('#modalCancel').addEventListener('click', () => closeModal(false));
    $('#modalBackdrop').addEventListener('click', () => closeModal(false));

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      const typing = target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

      if (e.key === 'Escape') {
        if (!$('#modal').hidden) { closeModal(false); return; }
        if (!$('#settingsDrawer').hidden) { closeDrawer(); return; }
        if (editingTaskId) { cancelEdit(); return; }
        if (typing && target instanceof HTMLElement) target.blur();
        return;
      }
      if (!$('#modal').hidden || !$('#settingsDrawer').hidden) return;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const onWidget = target instanceof HTMLElement &&
        (target.tagName === 'BUTTON' || target.tagName === 'A' || target.tagName === 'SUMMARY');

      if (e.key === ' ') {
        if (!onWidget) { e.preventDefault(); primaryAction(); }
        return;
      }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $('#taskInput').focus(); return; }
      if (e.key === '1') { switchMode('focus'); return; }
      if (e.key === '2') { switchMode('short'); return; }
      if (e.key === '3') { switchMode('long'); return; }
    });

    // Repaint immediately when the tab becomes visible/focused again.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    window.addEventListener('focus', () => tick());

    // Follow the OS theme while in auto mode.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => { if (state.settings.theme === 'auto') applyTheme(); };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSchemeChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onSchemeChange);
  }

  /* ============================== Init ============================== */

  function init() {
    normalizeTimer();
    applyTheme();
    bindEvents();
    renderSettingsPanel();
    renderAll();

    // Restore an in-flight session. If it ended while the tab was closed,
    // complete it now: log + credit with the true endedAt, then continue.
    const t = state.timer;
    if (t.running && t.endsAt != null && Date.now() >= t.endsAt) {
      completeSession();
    } else {
      scheduleCompletionFallback();
    }

    const ring = $('#ringFg');
    if (ring) ring.style.strokeDasharray = String(RING_C);

    setInterval(tick, TICK_MS);
  }

  init();

  // Small debug/testing hook — data stays local, and it makes the timer
  // engine observable from the console (see README).
  window.__tomato = {
    state,
    tick,
    completeSession,
    buildExport,
    buildLogseqMarkdown,
    version: APP_VERSION,
  };
})();

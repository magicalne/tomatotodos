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
  const APP_VERSION = '1.1.0';
  const KEYS = {
    settings: APP + ':settings',
    tasks: APP + ':tasks',
    tags: APP + ':tags',
    recurrences: APP + ':recurrences',
    sessions: APP + ':sessions',
    timer: APP + ':timer',
    ui: APP + ':ui',
  };
  const MODES = ['focus', 'short', 'long'];
  const MODE_LABEL = { focus: 'focus', short: 'short break', long: 'long break' };
  const RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'];
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
  // Tags & task body (rich composer)
  const TAG_COLORS = 8;               // fixed palette size; tags store an index
  const TAG_COLOR_NAMES = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink'];
  const MAX_TAGS = 32;                // registry cap
  const MAX_TAGS_PER_TASK = 6;        // per-task cap
  const MAX_BODY = 5000;              // task description cap (chars)
  const DONE_TODAY_CAP = 10;          // main list shows today's newest 10; older days live in history.html

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

  const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isDayKey = (v) => typeof v === 'string' && DAY_KEY_RE.test(v);

  /** Day key -> local Date at midnight. Date arithmetic survives DST; ms math does not. */
  function dayToDate(key) {
    const p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  /** Whole calendar days between two day keys (DST-safe via rounding). */
  function diffDays(aKey, bKey) {
    return Math.round((dayToDate(bKey) - dayToDate(aKey)) / 86400000);
  }

  function daysInMonthOf(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }

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
        // Legacy single-line `note` migrates into `body`; new code writes only body.
        body: toStr(t.body).slice(0, MAX_BODY) || toStr(t.note).replace(/\s+/g, ' ').trim().slice(0, 1000),
        tagIds: Array.isArray(t.tagIds)
          ? Array.from(new Set(t.tagIds.filter((x) => typeof x === 'string'))).slice(0, MAX_TAGS_PER_TASK)
          : [],
        dueToday: toBool(t.dueToday, false),
        done: toBool(t.done, false),
        createdAt: toNum(t.createdAt, Date.now()),
        completedAt: toNum(t.completedAt, null),
        // Fields of materialized recurring-task instances (absent on plain tasks).
        recurrenceId: toStr(t.recurrenceId) || null,
        scheduledFor: isDayKey(t.scheduledFor) ? t.scheduledFor : null,
      });
    }
    return out;
  }

  function sanitizeTags(raw) {
    if (!Array.isArray(raw)) return [];
    const seenIds = new Set();
    const seenLabels = new Set();
    const out = [];
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue;
      const label = toStr(t.label).replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!label) continue;
      const key = label.toLowerCase();
      if (seenLabels.has(key)) continue;
      let id = toStr(t.id);
      if (!id || seenIds.has(id)) id = uuid();
      seenIds.add(id);
      seenLabels.add(key);
      out.push({
        id,
        label,
        // Color is an index into the fixed palette, never raw hex.
        color: clamp(Math.round(toNum(t.color, 0)), 0, TAG_COLORS - 1),
        createdAt: toNum(t.createdAt, Date.now()),
      });
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  function sanitizeRecurrences(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const title = toStr(r.title).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!title) continue;
      let id = toStr(r.id);
      if (!id || seen.has(id)) id = uuid();
      seen.add(id);
      const createdAt = toNum(r.createdAt, Date.now());
      const rawRecur = r.recur && typeof r.recur === 'object' ? r.recur : {};
      const freq = RECURRENCE_FREQS.includes(rawRecur.freq) ? rawRecur.freq : 'daily';
      let weekdays = Array.isArray(rawRecur.weekdays)
        ? Array.from(new Set(rawRecur.weekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))).sort((a, b) => a - b)
        : [];
      if (freq === 'weekly' && weekdays.length === 0) weekdays = [new Date(createdAt).getDay()];
      out.push({
        id,
        title,
        body: toStr(r.body).slice(0, MAX_BODY) || toStr(r.note).replace(/\s+/g, ' ').trim().slice(0, 1000),
        tagIds: Array.isArray(r.tagIds)
          ? Array.from(new Set(r.tagIds.filter((x) => typeof x === 'string'))).slice(0, MAX_TAGS_PER_TASK)
          : [],
        recur: {
          freq,
          interval: clamp(Math.round(toNum(rawRecur.interval, 1)), 1, 12),
          weekdays,
          monthDay: clamp(Math.round(toNum(rawRecur.monthDay, 1)), 1, 31),
        },
        startKey: isDayKey(r.startKey) ? r.startKey : dayKey(createdAt),
        nextDue: isDayKey(r.nextDue) ? r.nextDue : null,
        createdAt,
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

  // First run (no stored tags yet): seed a few example tags so the system is
  // discoverable. A corrupted value sanitizes to an empty registry instead.
  function seedTags() {
    const now = Date.now();
    return [
      { id: uuid(), label: 'work', color: 5, createdAt: now },
      { id: uuid(), label: 'home', color: 3, createdAt: now },
      { id: uuid(), label: 'learning', color: 6, createdAt: now },
    ];
  }

  const rawTagsStored = readJSON(KEYS.tags);
  const state = {
    settings: sanitizeSettings(readJSON(KEYS.settings) ?? {}),
    tasks: sanitizeTasks(readJSON(KEYS.tasks) ?? []),
    tags: rawTagsStored == null ? seedTags() : sanitizeTags(rawTagsStored),
    recurrences: sanitizeRecurrences(readJSON(KEYS.recurrences) ?? []),
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
    writeJSON(KEYS.tags, state.tags);
    writeJSON(KEYS.recurrences, state.recurrences);
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

  let lastDaySeen = todayKey();

  /** Repaint from the wall clock. The interval must never accumulate time. */
  function tick() {
    // Day rollover while the app stays open: materialize recurring tasks.
    const today = todayKey();
    if (today !== lastDaySeen) {
      lastDaySeen = today;
      const n = reconcileRecurrences();
      if (n > 0) {
        toast('🔁 ' + n + ' recurring task' + (n === 1 ? '' : 's') + ' due');
        renderTasks();
      }
    }
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

  function tagById(id) {
    return state.tags.find((t) => t.id === id) || null;
  }

  /** A task's tags resolved against the registry (dangling ids are dropped). */
  function taskTags(task) {
    return (task.tagIds || []).map(tagById).filter(Boolean);
  }

  /** Keep only known ids, deduped, capped. */
  function cleanTagIds(ids) {
    return Array.from(new Set((Array.isArray(ids) ? ids : []).filter((id) => tagById(id)))).slice(0, MAX_TAGS_PER_TASK);
  }

  function addTask(title, body, tagIds) {
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    state.tasks.unshift({
      id: uuid(),
      title: clean.slice(0, 300),
      body: String(body || '').trim().slice(0, MAX_BODY),
      tagIds: cleanTagIds(tagIds),
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
    if (patch.body != null) task.body = String(patch.body).trim().slice(0, MAX_BODY);
    if (patch.tagIds != null) task.tagIds = cleanTagIds(patch.tagIds);
    if (patch.dueToday != null) task.dueToday = !!patch.dueToday;
    // Renaming an instance renames the series; past instances keep their titles.
    if (task.recurrenceId) {
      const r = recurrenceById(task.recurrenceId);
      if (r) {
        if (patch.title != null) r.title = task.title;
        if (patch.body != null) r.body = task.body;
        if (patch.tagIds != null) r.tagIds = task.tagIds.slice();
      }
    }
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

  /* ============================== Recurring tasks ==============================
   * A recurrence is a template with a rule; a concrete task ("instance") is
   * materialized into the list when its due day arrives. Completing or
   * deleting an instance only affects that occurrence — the template spawns
   * the next one on schedule. At most one open instance exists per template,
   * and missed days collapse into a single instance so the list never piles up.
   * ============================================================================ */

  function recurrenceById(id) {
    return state.recurrences.find((r) => r.id === id) || null;
  }

  /** Does `date` (a local Date) hit the rule anchored at the template's startKey? */
  function ruleMatchesDay(date, rule, startKey) {
    if (rule.freq === 'daily') {
      const dd = diffDays(startKey, dayKey(+date));
      return dd >= 0 && dd % rule.interval === 0;
    }
    if (rule.freq === 'weekly') {
      if (!rule.weekdays.includes(date.getDay())) return false;
      const anchor = dayToDate(startKey);
      anchor.setHours(12);
      anchor.setDate(anchor.getDate() - anchor.getDay()); // start of anchor week
      const week = new Date(date);
      week.setHours(12);
      week.setDate(week.getDate() - week.getDay()); // start of this week
      const ww = Math.round((week - anchor) / (7 * 86400000));
      return ww >= 0 && ww % rule.interval === 0;
    }
    // monthly — day 31 in a 28-day month means its last day
    if (date.getDate() !== Math.min(rule.monthDay, daysInMonthOf(date))) return false;
    const anchor = dayToDate(startKey);
    const months = (date.getFullYear() - anchor.getFullYear()) * 12 + (date.getMonth() - anchor.getMonth());
    return months >= 0 && months % rule.interval === 0;
  }

  /**
   * First matching day on/after `fromKey` (strictly after unless `inclusive`).
   * Scans day by day, capped well beyond any real cadence.
   */
  function nextOccurrence(fromKey, rule, startKey, inclusive = false) {
    const d = dayToDate(fromKey);
    if (!inclusive) d.setDate(d.getDate() + 1);
    for (let i = 0; i < 800; i++) {
      if (ruleMatchesDay(d, rule, startKey)) return dayKey(+d);
      d.setDate(d.getDate() + 1);
    }
    return null;
  }

  /**
   * Sync templates with the task list and materialize whatever is due.
   * Returns the number of instances spawned.
   */
  function reconcileRecurrences() {
    const today = todayKey();
    let dirty = false;
    let spawned = 0;
    for (const r of state.recurrences) {
      // An open instance already represents this series — nothing to spawn.
      if (state.tasks.some((t) => t.recurrenceId === r.id && !t.done)) continue;
      if (!r.nextDue) {
        r.nextDue = nextOccurrence(r.startKey, r.recur, r.startKey, true);
        dirty = true;
      }
      let latest = null; // newest due day that is still waiting
      while (r.nextDue && r.nextDue <= today) {
        latest = r.nextDue;
        r.nextDue = nextOccurrence(r.nextDue, r.recur, r.startKey, false);
        dirty = true;
      }
      if (latest) {
        state.tasks.unshift({
          id: uuid(),
          title: r.title,
          body: r.body,
          tagIds: (r.tagIds || []).slice(),
          dueToday: true,
          done: false,
          createdAt: Date.now(),
          completedAt: null,
          recurrenceId: r.id,
          scheduledFor: latest,
        });
        spawned += 1;
        dirty = true;
      }
    }
    // Instances whose template vanished become plain tasks.
    for (const t of state.tasks) {
      if (t.recurrenceId && !recurrenceById(t.recurrenceId)) {
        t.recurrenceId = null;
        dirty = true;
      }
    }
    if (dirty) saveState();
    return spawned;
  }

  function recurShortLabel(rule) {
    const n = rule.interval;
    if (rule.freq === 'daily') return n === 1 ? 'daily' : 'every ' + n + ' days';
    if (rule.freq === 'weekly') return n === 1 ? 'weekly' : 'every ' + n + ' weeks';
    return n === 1 ? 'monthly' : 'every ' + n + ' months';
  }

  function recurDescribe(rule) {
    if (rule.freq === 'daily') return rule.interval === 1 ? 'Every day' : 'Every ' + rule.interval + ' days';
    if (rule.freq === 'weekly') {
      let s = rule.interval === 1 ? 'Every week' : 'Every ' + rule.interval + ' weeks';
      if (rule.weekdays.length && rule.weekdays.length < 7) {
        s += ' on ' + rule.weekdays.map((w) => WEEKDAY_NAMES[w]).join(', ');
      }
      return s;
    }
    return (rule.interval === 1 ? 'Monthly' : 'Every ' + rule.interval + ' months') + ' on day ' + rule.monthDay;
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
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      tasks: state.tasks,
      tags: state.tags,
      recurrences: state.recurrences,
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
          tags: sanitizeTags(obj.tags),
          recurrences: sanitizeRecurrences(obj.recurrences),
          sessions: sanitizeSessions(obj.sessions),
          timer: sanitizeTimer(obj.timer),
        };
        confirmDialog({
          title: 'Import backup?',
          body: 'Replaces current data with ' + next.tasks.length + ' task(s) and ' + next.sessions.length +
            ' session(s)' + (next.recurrences.length ? ' plus ' + next.recurrences.length + ' repeating' : '') +
            (obj.exportedAt ? ' exported ' + obj.exportedAt.slice(0, 10) : '') + '.',
          confirmLabel: 'Import',
        }).then((ok) => {
          if (!ok) return;
          state.settings = next.settings;
          state.tasks = next.tasks;
          state.tags = next.tags;
          state.recurrences = next.recurrences;
          state.sessions = next.sessions;
          state.timer = next.timer;
          normalizeTimer();
          reconcileRecurrences();
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
      state.tags = [];
      state.recurrences = [];
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
      resetComposer();
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

  /* ---------- Tags rendering ---------- */

  function renderTagPicker(selectedIds) {
    const sel = new Set(selectedIds || []);
    const chips = state.tags.map((t) =>
      '<button type="button" class="tag-chip tag-c' + t.color + (sel.has(t.id) ? ' on' : '') +
      '" data-tag-id="' + t.id + '" data-action="toggle-tag" aria-pressed="' + sel.has(t.id) +
      '" title="Tag: ' + esc(t.label) + '"><span class="dot"></span>' + esc(t.label) + '</button>'
    );
    chips.push('<button type="button" class="tag-chip add-tag" data-action="new-tag" title="Create a tag">+ tag</button>');
    return chips.join('');
  }

  /** Currently selected tag ids in a picker container (source of truth = DOM). */
  function pickerSelectedIds(container) {
    return $$('.tag-chip.on', container).map((b) => b.dataset.tagId).filter(Boolean);
  }

  /** Non-interactive colored chips for task rows. */
  function taskTagsHTML(task) {
    return taskTags(task).map((t) =>
      '<span class="tag-chip mini tag-c' + t.color + '" title="Tag: ' + esc(t.label) + '"><span class="dot"></span>' + esc(t.label) + '</span>'
    ).join('');
  }

  /** ⚑ today badge; recurring instances that missed their day show as overdue instead. */
  function dueBadgeHTML(task) {
    if (!task.dueToday) return '';
    if (task.recurrenceId && task.scheduledFor && task.scheduledFor < todayKey()) {
      return '<span class="badge due-badge" title="Scheduled ' + task.scheduledFor + '">⚠ overdue</span>';
    }
    return '<span class="badge due-badge" title="Due today">⚑ today</span>';
  }

  function recurBadgeHTML(task) {
    const r = recurrenceById(task.recurrenceId);
    if (!r) return '';
    return '<button type="button" class="badge recur-badge" data-action="edit-recur" aria-haspopup="dialog" title="' +
      esc(recurDescribe(r.recur)) + ' — click to edit the series">🔁 ' + esc(recurShortLabel(r.recur)) + '</button>';
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
            '<span class="task-title" title="' + esc(task.title) + '">' + esc(task.title) + '</span>' +
            dueBadgeHTML(task) +
            recurBadgeHTML(task) +
            taskTagsHTML(task) +
          '</div>' +
          (task.body
            ? '<div class="task-body" data-action="toggle-body" title="Click to expand/collapse">' + esc(task.body) + '</div>'
            : '') +
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
          '<textarea class="edit-body autogrow" name="body" maxlength="5000" rows="2" placeholder="Description (optional)" aria-label="Task description">' + esc(task.body) + '</textarea>' +
          '<div class="tag-picker">' + renderTagPicker(task.tagIds) + '</div>' +
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
        '<div class="task-main"><div class="task-title-line"><span class="task-title" title="' + esc(task.title) + '">' + esc(task.title) + '</span>' + taskTagsHTML(task) + '</div></div>' +
        '<div class="task-stats">' + (st.pomodoros ? '🍅 ' + st.pomodoros : '') + '</div>' +
        '<span class="done-at">' + (task.completedAt ? fmtTimeOfDay(task.completedAt) : '') + '</span>' +
        '<div class="task-actions">' +
          '<button class="icon-btn danger" data-action="delete" title="Delete task" aria-label="Delete task">🗑</button>' +
        '</div>' +
      '</li>'
    );
  }

  /** The main list is a working surface: today's finishes only, newest first,
   * capped — everything older is queried on history.html. */
  function renderTasks() {
    const open = state.tasks.filter((t) => !t.done);
    const doneToday = state.tasks
      .filter((t) => t.done && t.completedAt && dayKey(t.completedAt) === todayKey())
      .sort((a, b) => b.completedAt - a.completedAt);

    const list = $('#taskList');
    list.innerHTML = open.length
      ? open.map((task, i) => taskRowHTML(task, i, open.length)).join('')
      : '<li class="empty">No open tasks. Add one above ☝️</li>';
    if (editingTaskId) {
      const inp = list.querySelector('.task.editing .edit-title');
      if (inp) { inp.focus(); inp.select(); }
      const ta = list.querySelector('.task.editing .edit-body');
      if (ta) autosize(ta);
    }

    $('#doneSection').hidden = doneToday.length === 0;
    const toggle = $('#doneToggle');
    toggle.textContent = (ui.doneOpen ? '▾' : '▸') + ' ✓ Done today (' + doneToday.length + ')';
    toggle.setAttribute('aria-expanded', String(ui.doneOpen));
    const doneList = $('#doneList');
    doneList.hidden = !ui.doneOpen;
    doneList.innerHTML = doneToday.slice(0, DONE_TODAY_CAP).map(doneRowHTML).join('');
    const extra = doneToday.length - DONE_TODAY_CAP;
    const overflow = $('#doneOverflow');
    overflow.hidden = extra <= 0;
    if (extra > 0) overflow.textContent = '+' + extra + ' more finished today — open history →';
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

  /* ============================== Recurring task UI ============================== */

  const BUILDER = {
    freqSel: '#recurFreq', everyInp: '#recurEvery', wdBox: '#recurWeeklyPick',
    mdInp: '#recurMonthDay', mdBox: '#recurMonthlyPick', unit: '#recurEveryUnit',
  };
  const EDITOR = {
    freqSel: '#recurEditFreq', everyInp: '#recurEditEvery', wdBox: '#recurEditWeekly',
    mdInp: '#recurEditMonthDay', mdBox: '#recurEditMonthly', unit: '#recurEditUnit',
  };

  /** Rule from the controls of the builder or the series editor. */
  function readRule(t) {
    const freq = RECURRENCE_FREQS.includes($(t.freqSel).value) ? $(t.freqSel).value : 'daily';
    const interval = clamp(Math.round(Number($(t.everyInp).value) || 1), 1, 12);
    const weekdays = $$('.wd-chip.on', $(t.wdBox)).map((b) => Number(b.dataset.wd)).sort((a, b) => a - b);
    const monthDay = clamp(Math.round(Number($(t.mdInp).value) || 1), 1, 31);
    return {
      freq,
      interval,
      weekdays: freq === 'weekly' && weekdays.length === 0 ? [new Date().getDay()] : weekdays,
      monthDay,
    };
  }

  function recurUnitLabel(freq, interval) {
    const noun = freq === 'daily' ? 'day' : freq === 'weekly' ? 'week' : 'month';
    return noun + (interval === 1 ? '' : 's');
  }

  /** Clamp inputs and show/hide the weekday & day-of-month rows. */
  function syncRecurUI(t) {
    const freq = $(t.freqSel).value;
    $(t.wdBox).hidden = freq !== 'weekly';
    $(t.mdBox).hidden = freq !== 'monthly';
    const interval = clamp(Math.round(Number($(t.everyInp).value) || 1), 1, 12);
    $(t.everyInp).value = String(interval);
    $(t.mdInp).value = String(clamp(Math.round(Number($(t.mdInp).value) || 1), 1, 31));
    $(t.unit).textContent = recurUnitLabel(freq, interval);
  }

  function onFreqChange(t) {
    // Switching to weekly with nothing selected: start from today's weekday.
    if ($(t.freqSel).value === 'weekly' && $$('.wd-chip.on', $(t.wdBox)).length === 0) {
      const wd = new Date().getDay();
      $$('.wd-chip', $(t.wdBox)).forEach((b) => b.classList.toggle('on', Number(b.dataset.wd) === wd));
    }
    syncRecurUI(t);
    if (t === EDITOR) updateRecurHint();
  }

  function initBuilderDefaults() {
    const box = $('#recurBuilder');
    if (box.dataset.init) return; // keep the user's last configuration
    box.dataset.init = '1';
    $('#recurFreq').value = 'daily';
    $('#recurEvery').value = '1';
    $('#recurMonthDay').value = String(new Date().getDate());
    const wd = new Date().getDay();
    $$('#recurWeeklyPick .wd-chip').forEach((b) => b.classList.toggle('on', Number(b.dataset.wd) === wd));
    syncRecurUI(BUILDER);
  }

  function setRecurBuilderOpen(open) {
    $('#recurBuilder').hidden = !open;
    const btn = $('#recurToggle');
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-pressed', String(open));
  }

  /* ---------- Rich composer (description + tags) ---------- */

  /** Auto-grow a textarea to fit its content, scrolling past `max` px. */
  function autosize(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    const max = 240;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }

  function composerOpen() {
    return !$('#composerPanel').hidden;
  }

  function setComposerOpen(open) {
    $('#composerPanel').hidden = !open;
    const btn = $('#composerToggle');
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-pressed', String(open));
    $('#taskInput').placeholder = open ? 'Task title' : 'Add a task…  (press N)';
    if (open) autosize($('#taskBody'));
  }

  /** Collapse the composer and clear everything it holds. */
  function resetComposer() {
    $('#taskBody').value = '';
    $('#composerTags').innerHTML = renderTagPicker([]);
    setComposerOpen(false);
  }

  function submitNewTask() {
    const input = $('#taskInput');
    const clean = String(input.value || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const title = clean.slice(0, 300);
    const body = $('#taskBody').value.trim().slice(0, MAX_BODY);
    const tagIds = pickerSelectedIds($('#composerTags'));
    if ($('#recurToggle').classList.contains('on')) {
      const recur = readRule(BUILDER);
      state.recurrences.unshift({
        id: uuid(),
        title,
        body,
        tagIds,
        recur,
        startKey: todayKey(),
        nextDue: todayKey(),
        createdAt: Date.now(),
      });
      reconcileRecurrences(); // materializes today's instance and saves
      input.value = '';
      resetComposer();
      setRecurBuilderOpen(false);
      renderTasks();
      renderStats();
      toast('🔁 Repeats ' + recurShortLabel(recur));
    } else {
      addTask(title, body, tagIds);
      input.value = '';
      resetComposer();
    }
  }

  /* ---------- Tag creation (inline, inside any picker) ---------- */

  function openTagCreate(picker, addBtn) {
    if ($('.tag-create', picker)) return;
    addBtn.hidden = true;
    const swatches = Array.from({ length: TAG_COLORS }, (_, i) =>
      '<button type="button" class="swatch sw-c' + i + (i === 0 ? ' on' : '') +
      '" data-action="pick-color" data-color="' + i + '" title="' + TAG_COLOR_NAMES[i] +
      '" aria-label="Color: ' + TAG_COLOR_NAMES[i] + '"></button>'
    ).join('');
    const row = document.createElement('span');
    row.className = 'tag-create';
    row.innerHTML =
      '<input type="text" class="tag-name" maxlength="24" placeholder="new tag" aria-label="New tag name">' +
      '<span class="tag-swatches">' + swatches + '</span>' +
      '<button type="button" class="icon-btn" data-action="cancel-create-tag" title="Cancel (Esc)" aria-label="Cancel">✕</button>';
    picker.appendChild(row);
    $('.tag-name', row).focus();
  }

  function closeTagCreate(picker) {
    const row = $('.tag-create', picker);
    if (row) row.remove();
    const addBtn = $('.add-tag', picker);
    if (addBtn) addBtn.hidden = false;
  }

  function submitTagCreate(picker) {
    const row = $('.tag-create', picker);
    if (!row) return;
    const label = String(($('.tag-name', row) || {}).value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!label) { closeTagCreate(picker); return; }
    const color = clamp(Math.round(Number(($('.swatch.on', row) || {}).dataset?.color) || 0), 0, TAG_COLORS - 1);
    const key = label.toLowerCase();
    let tag = state.tags.find((t) => t.label.toLowerCase() === key);
    if (!tag) {
      if (state.tags.length >= MAX_TAGS) { toast('Tag limit reached (' + MAX_TAGS + ')'); return; }
      tag = { id: uuid(), label, color, createdAt: Date.now() };
      state.tags.push(tag);
      saveState();
    }
    // Re-render just this picker, keeping the user's current selection.
    const selected = pickerSelectedIds(picker);
    if (!selected.includes(tag.id)) selected.push(tag.id);
    picker.innerHTML = renderTagPicker(selected);
    toast('Tag “' + tag.label + '” ready');
  }

  /* ---------- Series editor modal ---------- */

  let recurEditId = null;

  function openRecurModal(rid) {
    const r = recurrenceById(rid);
    if (!r) return;
    recurEditId = rid;
    $('#recurModalTask').textContent = r.title;
    $(EDITOR.freqSel).value = r.recur.freq;
    $(EDITOR.everyInp).value = String(r.recur.interval);
    $$('.wd-chip', $(EDITOR.wdBox)).forEach((b) => b.classList.toggle('on', r.recur.weekdays.includes(Number(b.dataset.wd))));
    $(EDITOR.mdInp).value = String(r.recur.monthDay);
    syncRecurUI(EDITOR);
    updateRecurHint();
    $('#recurModal').hidden = false;
    $('#recurBackdrop').hidden = false;
    $(EDITOR.freqSel).focus();
  }

  function closeRecurModal() {
    if ($('#recurModal').hidden) return;
    $('#recurModal').hidden = true;
    $('#recurBackdrop').hidden = true;
    recurEditId = null;
  }

  function updateRecurHint() {
    const r = recurrenceById(recurEditId);
    if (!r) return;
    const next = nextOccurrence(todayKey(), readRule(EDITOR), r.startKey, true);
    let txt = 'Next occurrence: ';
    if (next === todayKey()) txt += 'today';
    else if (next) txt += dayToDate(next).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    else txt += '—';
    $('#recurEditHint').textContent = txt;
  }

  function saveRecurModal() {
    const r = recurrenceById(recurEditId);
    if (r) {
      r.recur = readRule(EDITOR);
      // With an open instance, the next spawn lands after today; otherwise a
      // rule that matches today spawns immediately via reconcile.
      const hasOpen = state.tasks.some((t) => t.recurrenceId === r.id && !t.done);
      r.nextDue = nextOccurrence(todayKey(), r.recur, r.startKey, !hasOpen) || r.nextDue;
      saveState();
      renderTasks();
      toast('Repeat updated — ' + recurShortLabel(r.recur));
    }
    closeRecurModal();
  }

  function removeRepeatFlow() {
    const r = recurrenceById(recurEditId);
    if (!r) { closeRecurModal(); return; }
    const rid = r.id;
    closeRecurModal();
    confirmDialog({
      title: 'Stop repeating?',
      body: '“' + r.title + '” will stop recurring. The current task stays in your list; past history is kept.',
      confirmLabel: 'Stop repeating',
    }).then((ok) => {
      if (!ok) { openRecurModal(rid); return; }
      state.recurrences = state.recurrences.filter((x) => x.id !== rid);
      for (const t of state.tasks) {
        if (t.recurrenceId === rid) {
          t.recurrenceId = null;
          t.scheduledFor = null;
        }
      }
      saveState();
      renderAll();
      toast('Repeat removed');
    });
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
      // Direct DOM toggle — no re-render, so text selection is not disturbed.
      case 'toggle-body': btn.classList.toggle('expanded'); break;
      case 'edit-recur': {
        const task = taskById(id);
        if (task && task.recurrenceId) openRecurModal(task.recurrenceId);
        break;
      }
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

    // Task form (shared path handles plain + recurring adds)
    $('#taskForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitNewTask();
    });
    // Explicit Enter handling: implicit form submission is unreliable on some
    // virtual keyboards and embedded webviews. With the composer open, Enter
    // moves to the description instead of submitting.
    $('#taskInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (composerOpen()) { $('#taskBody').focus(); return; }
        submitNewTask();
      }
    });

    // Rich composer
    $('#composerToggle').addEventListener('click', () => setComposerOpen(!composerOpen()));
    $('#composerCancel').addEventListener('click', () => { setComposerOpen(false); $('#taskInput').focus(); });
    $('#composerPanel').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitNewTask();
      }
    });

    // Textareas marked .autogrow resize to fit their content as you type.
    document.addEventListener('input', (e) => {
      if (e.target.matches && e.target.matches('textarea.autogrow')) autosize(e.target);
    });

    // Tag pickers (composer + edit rows share one delegated handler). These
    // only mutate the picker DOM — never a re-render, which would lose typed text.
    document.addEventListener('click', (e) => {
      const picker = e.target.closest('.tag-picker');
      if (!picker) return;
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      switch (btn.dataset.action) {
        case 'toggle-tag': {
          if (!btn.classList.contains('on') && $$('.tag-chip.on', picker).length >= MAX_TAGS_PER_TASK) {
            toast('Up to ' + MAX_TAGS_PER_TASK + ' tags per task');
            return;
          }
          btn.classList.toggle('on');
          btn.setAttribute('aria-pressed', btn.classList.contains('on') ? 'true' : 'false');
          break;
        }
        case 'new-tag': openTagCreate(picker, btn); break;
        case 'cancel-create-tag': closeTagCreate(picker); break;
        case 'create-tag': submitTagCreate(picker); break;
        case 'pick-color':
          $$('.swatch', picker).forEach((s) => s.classList.toggle('on', s === btn));
          break;
      }
    });
    // Enter creates the tag; Esc cancels just the create row. Registered before
    // the global shortcut handler so stopImmediatePropagation can shield it.
    document.addEventListener('keydown', (e) => {
      if (!e.target.matches || !e.target.matches('.tag-name')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        submitTagCreate(e.target.closest('.tag-picker'));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeTagCreate(e.target.closest('.tag-picker'));
      }
    });

    // Recurring tasks — creation builder
    $('#recurToggle').addEventListener('click', () => {
      const open = $('#recurBuilder').hidden;
      if (open) initBuilderDefaults();
      setRecurBuilderOpen(open);
    });
    $('#recurFreq').addEventListener('change', () => onFreqChange(BUILDER));
    $('#recurEvery').addEventListener('change', () => syncRecurUI(BUILDER));
    // Live unit label while typing — value clamping stays on `change`.
    $('#recurEvery').addEventListener('input', () => {
      const n = clamp(Math.round(Number($('#recurEvery').value) || 1), 1, 12);
      $('#recurEveryUnit').textContent = recurUnitLabel($('#recurFreq').value, n);
    });
    $('#recurMonthDay').addEventListener('change', () => syncRecurUI(BUILDER));
    $('#recurWeeklyPick').addEventListener('click', (e) => {
      const chip = e.target.closest('.wd-chip');
      if (chip) chip.classList.toggle('on');
    });

    // Recurring tasks — series editor modal
    $('#recurEditFreq').addEventListener('change', () => onFreqChange(EDITOR));
    $('#recurEditEvery').addEventListener('change', () => { syncRecurUI(EDITOR); updateRecurHint(); });
    $('#recurEditMonthDay').addEventListener('change', () => { syncRecurUI(EDITOR); updateRecurHint(); });
    // Live preview while typing — `input` only refreshes the hint; the
    // clamping rewrite stays on `change` so it never fights the keystrokes.
    $('#recurEditEvery').addEventListener('input', updateRecurHint);
    $('#recurEditMonthDay').addEventListener('input', updateRecurHint);
    $('#recurEditWeekly').addEventListener('click', (e) => {
      const chip = e.target.closest('.wd-chip');
      if (chip) { chip.classList.toggle('on'); updateRecurHint(); }
    });
    $('#recurEditSave').addEventListener('click', saveRecurModal);
    $('#recurEditCancel').addEventListener('click', closeRecurModal);
    $('#recurBackdrop').addEventListener('click', closeRecurModal);
    $('#recurRemoveRepeat').addEventListener('click', removeRepeatFlow);

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
        body: fd.get('body'),
        tagIds: pickerSelectedIds($('.tag-picker', form)),
        dueToday: fd.get('dueToday') === 'on',
      });
      editingTaskId = null;
      renderTasks();
    });
    $('#taskList').addEventListener('keydown', (e) => {
      // Enter in the title saves; in the description it inserts a newline —
      // Cmd/Ctrl+Enter saves from there instead.
      if (e.key !== 'Enter' || !e.target.matches) return;
      if (e.target.matches('.edit-title')) {
        e.preventDefault();
        const form = e.target.closest('form.task-edit');
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      } else if (e.target.matches('.edit-body') && (e.metaKey || e.ctrlKey)) {
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
        if (!$('#recurModal').hidden) { closeRecurModal(); return; }
        if (!$('#settingsDrawer').hidden) { closeDrawer(); return; }
        if (!$('#composerPanel').hidden) { setComposerOpen(false); return; }
        if (editingTaskId) { cancelEdit(); return; }
        if (typing && target instanceof HTMLElement) target.blur();
        return;
      }
      if (!$('#modal').hidden || !$('#recurModal').hidden || !$('#settingsDrawer').hidden) return;
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
    const spawnedOnLoad = reconcileRecurrences();
    applyTheme();
    bindEvents();
    $('#composerTags').innerHTML = renderTagPicker([]);
    renderSettingsPanel();
    renderAll();
    if (spawnedOnLoad > 0) toast('🔁 ' + spawnedOnLoad + ' recurring task' + (spawnedOnLoad === 1 ? '' : 's') + ' due');

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
    reconcileRecurrences,
    nextOccurrence,
    ruleMatchesDay,
    version: APP_VERSION,
  };
})();

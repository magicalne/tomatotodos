/*
 * 🍅 Tomato Todos — history.js
 * Read-only companion page for querying finished tasks across days.
 * Loads the same localStorage keys as app.js with the same defensive
 * discipline (malformed data renders empty, never crashes), but never
 * writes task data — the only write is the theme setting. The few shared
 * helpers are small deliberate duplicates: history must never boot the
 * timer app's runtime.
 */
'use strict';

(function () {
  /* ============================== Helpers ============================== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const toStr = (v, def = '') => (typeof v === 'string' ? v : def);
  const toNum = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');

  const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isDayKey = (v) => typeof v === 'string' && DAY_KEY_RE.test(v);

  /** Local calendar day key (day boundary = local midnight), same as app.js. */
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  /** Day key -> local Date at midnight; date arithmetic survives DST. */
  function dayToDate(key) {
    const p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function daysAgoKey(n) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return dayKey(+d);
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

  /* ============================== Data ============================== */

  const APP = 'tomato-todos';
  const KEYS = {
    tasks: APP + ':tasks',
    tags: APP + ':tags',
    sessions: APP + ':sessions',
    settings: APP + ':settings',
  };
  const DAY_CHUNK = 7; // day-groups rendered per "Load more"
  const RANGES = ['today', 'yesterday', '7d', '30d', 'all', 'custom'];

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch (e) {
      console.warn('Tomato History: unreadable data for', key, e);
      return null;
    }
  }

  function loadTags() {
    const raw = readJSON(KEYS.tags);
    const map = new Map();
    if (Array.isArray(raw)) {
      for (const t of raw) {
        if (!t || typeof t !== 'object' || !toStr(t.id) || !toStr(t.label)) continue;
        map.set(t.id, {
          id: t.id,
          label: toStr(t.label).slice(0, 24),
          color: Math.min(7, Math.max(0, Math.round(toNum(t.color, 0)))),
        });
      }
    }
    return map;
  }

  function loadDone() {
    const raw = readJSON(KEYS.tasks);
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw) {
      if (!t || typeof t !== 'object' || t.done !== true) continue;
      const completedAt = toNum(t.completedAt, null);
      if (completedAt == null) continue;
      out.push({
        id: toStr(t.id),
        title: toStr(t.title).replace(/\s+/g, ' ').trim().slice(0, 300),
        body: toStr(t.body).slice(0, 5000),
        tagIds: Array.isArray(t.tagIds) ? t.tagIds.filter((x) => typeof x === 'string') : [],
        completedAt,
        day: dayKey(completedAt),
      });
    }
    return out.sort((a, b) => b.completedAt - a.completedAt);
  }

  function loadFocusSessions() {
    const raw = readJSON(KEYS.sessions);
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const s of raw) {
      if (!s || typeof s !== 'object' || s.type !== 'focus') continue;
      const startedAt = toNum(s.startedAt, null);
      const endedAt = toNum(s.endedAt, null);
      if (startedAt == null || endedAt == null || endedAt < startedAt) continue;
      out.push({
        taskId: toStr(s.taskId) || null,
        endedAt,
        completed: s.completed === true,
        durationSec: Math.max(0, toNum(s.durationSec, Math.round((endedAt - startedAt) / 1000))),
      });
    }
    return out;
  }

  /** Per-day focus totals and per-(task, day) pomodoro counts, indexed once. */
  function buildSessionIndex(sessions) {
    const byDay = new Map();
    const byTaskDay = new Map();
    for (const s of sessions) {
      const day = dayKey(s.endedAt);
      let d = byDay.get(day);
      if (!d) { d = { mins: 0, pom: 0 }; byDay.set(day, d); }
      d.mins += s.durationSec / 60;
      if (s.completed) d.pom += 1;
      if (s.taskId) {
        const k = day + '|' + s.taskId;
        byTaskDay.set(k, (byTaskDay.get(k) || 0) + (s.completed ? 1 : 0));
      }
    }
    return { byDay, byTaskDay };
  }

  const TAGS = loadTags();
  const DONE = loadDone();
  const SESSIONS = loadFocusSessions();

  /* ============================== Filters ============================== */

  const params = new URLSearchParams(location.search);
  const filters = {
    q: toStr(params.get('q')),
    range: RANGES.includes(params.get('range')) ? params.get('range') : '30d',
    from: isDayKey(params.get('from')) ? params.get('from') : '',
    to: isDayKey(params.get('to')) ? params.get('to') : '',
    tags: new Set(toStr(params.get('tags')).split(',').filter(Boolean)),
    shownDays: DAY_CHUNK,
  };

  /** Inclusive [fromKey, toKey] of the active range ('' = unbounded). */
  function rangeBounds() {
    const today = dayKey(Date.now());
    switch (filters.range) {
      case 'today': return [today, today];
      case 'yesterday': { const y = daysAgoKey(1); return [y, y]; }
      case '7d': return [daysAgoKey(6), today];
      case '30d': return [daysAgoKey(29), today];
      case 'custom': return [filters.from, filters.to];
      default: return ['', '']; // all
    }
  }

  function applyFilters(done) {
    const [fromKey, toKey] = rangeBounds();
    const q = filters.q.trim().toLowerCase();
    return done.filter((t) => {
      if (fromKey && t.day < fromKey) return false;
      if (toKey && t.day > toKey) return false;
      if (q && !(t.title + '\n' + t.body).toLowerCase().includes(q)) return false;
      if (filters.tags.size) {
        // AND semantics — narrowing, like GitHub label filters.
        const have = new Set(t.tagIds);
        for (const id of filters.tags) if (!have.has(id)) return false;
      }
      return true;
    });
  }

  function groupByDay(list) {
    const groups = new Map(); // dayKey -> rows (input is already newest-first)
    for (const t of list) {
      let rows = groups.get(t.day);
      if (!rows) { rows = []; groups.set(t.day, rows); }
      rows.push(t);
    }
    return Array.from(groups.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }

  function syncUrl() {
    try {
      const p = new URLSearchParams();
      if (filters.q.trim()) p.set('q', filters.q.trim());
      if (filters.range !== '30d') p.set('range', filters.range);
      if (filters.tags.size) p.set('tags', Array.from(filters.tags).join(','));
      if (filters.range === 'custom') {
        if (filters.from) p.set('from', filters.from);
        if (filters.to) p.set('to', filters.to);
      }
      const qs = p.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    } catch (e) { /* sandboxed contexts may forbid replaceState */ }
  }

  /* ============================== Rendering ============================== */

  function dayLabel(key) {
    if (key === dayKey(Date.now())) return 'Today';
    if (key === daysAgoKey(1)) return 'Yesterday';
    const d = dayToDate(key);
    let s = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (d.getFullYear() !== new Date().getFullYear()) s += ', ' + d.getFullYear();
    return s;
  }

  function tagChipsHTML(tagIds) {
    return tagIds
      .map((id) => TAGS.get(id))
      .filter(Boolean)
      .map((t) => '<span class="tag-chip mini tag-c' + t.color + '"><span class="dot"></span>' + esc(t.label) + '</span>')
      .join('');
  }

  function render() {
    const filtered = applyFilters(DONE);
    const groups = groupByDay(filtered);
    const idx = buildSessionIndex(SESSIONS);
    const shown = groups.slice(0, filters.shownDays);

    let html = '';
    for (const [day, rows] of shown) {
      const st = idx.byDay.get(day) || { mins: 0, pom: 0 };
      html +=
        '<section class="day-group"><h2 class="day-head">' + esc(dayLabel(day)) +
        '<span class="day-stats">' + rows.length + ' finished' +
        (st.mins >= 1 ? ' · ' + fmtDuration(st.mins) + ' focus' : '') +
        (st.pom ? ' · ' + st.pom + ' 🍅' : '') + '</span></h2>' +
        '<ul class="task-list">';
      for (const t of rows) {
        const pom = idx.byTaskDay.get(day + '|' + t.id) || 0;
        html +=
          '<li class="task done">' +
            '<span class="check-btn checked" aria-hidden="true">✓</span>' +
            '<div class="task-main"><div class="task-title-line">' +
              '<span class="task-title">' + esc(t.title) + '</span>' +
              tagChipsHTML(t.tagIds) +
              (pom ? '<span class="badge" title="Pomodoros logged on this task that day">🍅 ' + pom + '</span>' : '') +
            '</div></div>' +
            '<span class="done-at">' + fmtTimeOfDay(t.completedAt) + '</span>' +
          '</li>';
      }
      html += '</ul></section>';
    }
    $('#results').innerHTML = html || '<div class="empty">No finished tasks match these filters.</div>';

    const lm = $('#loadMore');
    lm.hidden = groups.length <= filters.shownDays;
    $('#historySummary').textContent = filtered.length
      ? filtered.length + ' finished task' + (filtered.length === 1 ? '' : 's') + ' across ' + groups.length + ' day' + (groups.length === 1 ? '' : 's')
      : '';
    syncUrl();
  }

  function renderFilterBar() {
    $('#hq').value = filters.q;
    $$('.range-chip').forEach((b) => b.classList.toggle('active', b.dataset.range === filters.range));
    const [fromKey, toKey] = rangeBounds();
    $('#hfrom').value = filters.range === 'custom' ? filters.from : fromKey;
    $('#hto').value = filters.range === 'custom' ? filters.to : toKey;
    $('#htagfilter').innerHTML = Array.from(TAGS.values()).map((t) =>
      '<button type="button" class="tag-chip tag-c' + t.color + (filters.tags.has(t.id) ? ' on' : '') +
      '" data-tag-id="' + t.id + '" aria-pressed="' + filters.tags.has(t.id) + '">' +
      '<span class="dot"></span>' + esc(t.label) + '</button>'
    ).join('');
  }

  function apply() {
    filters.shownDays = DAY_CHUNK; // a filter change resets paging
    renderFilterBar();
    render();
  }

  /* ============================== Theme ============================== */

  function applyTheme() {
    let pref = 'auto';
    const s = readJSON(KEYS.settings);
    if (s && typeof s === 'object' && (s.theme === 'light' || s.theme === 'dark' || s.theme === 'auto')) pref = s.theme;
    const dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('#themeBtn').textContent = pref === 'auto' ? '🌗' : dark ? '🌙' : '☀️';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#141317' : '#f5f3f0';
    return pref;
  }

  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    let s = readJSON(KEYS.settings);
    if (!s || typeof s !== 'object') s = {};
    const cur = order.includes(s.theme) ? s.theme : 'auto';
    s.theme = order[(order.indexOf(cur) + 1) % order.length];
    try { localStorage.setItem(KEYS.settings, JSON.stringify(s)); } catch (e) { /* storage unavailable — theme still cycles for this page */ }
    applyTheme();
  }

  /* ============================== Events & init ============================== */

  function bind() {
    let deb = null;
    $('#hq').addEventListener('input', (e) => {
      filters.q = e.target.value;
      clearTimeout(deb);
      deb = setTimeout(render, 150);
    });
    $$('.range-chip').forEach((b) => b.addEventListener('click', () => {
      filters.range = b.dataset.range;
      apply();
    }));
    $('#hfrom').addEventListener('change', (e) => {
      filters.range = 'custom';
      filters.from = isDayKey(e.target.value) ? e.target.value : '';
      apply();
    });
    $('#hto').addEventListener('change', (e) => {
      filters.range = 'custom';
      filters.to = isDayKey(e.target.value) ? e.target.value : '';
      apply();
    });
    $('#htagfilter').addEventListener('click', (e) => {
      const b = e.target.closest('.tag-chip');
      if (!b) return;
      const id = b.dataset.tagId;
      if (filters.tags.has(id)) filters.tags.delete(id);
      else filters.tags.add(id);
      apply();
    });
    $('#loadMore').addEventListener('click', () => {
      filters.shownDays += DAY_CHUNK;
      render();
    });
    $('#themeBtn').addEventListener('click', cycleTheme);
    document.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        $('#hq').focus();
      }
    });
  }

  applyTheme();
  renderFilterBar();
  bind();
  render();
})();

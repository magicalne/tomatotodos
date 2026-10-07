# Spec: Done list cap + history page

- **Status:** draft — awaiting design review
- **Date:** 2026-10-07
- **Background:** the 2000-task stress test (docs/specs/rich-task-composer.md
  review session) showed the main list rendering every finished task ever,
  with a "before today" pile growing forever.

## Goal

The main list is a *working surface*, not an archive:

1. Show only **today's** finished tasks.
2. Show at most **10** of them (newest first), with a jump link when more.
3. Move everything older to a dedicated, read-only **history page**
   (`history.html`) with real query tools.

## Main page changes

- The done section keeps its collapsible header — `✓ Done today (N)` shows
  the true count for today.
- Rows: today's finishes sorted by `completedAt` **newest first**, capped at
  the 10 most recent.
- When N > 10, a footer link inside the section:
  `+K more finished today — open history →` → `history.html?range=today`.
- The "before today" group and its label are removed from the main list.
- A 📚 header button links to `history.html` unconditionally (history must be
  reachable even on a day with zero finishes).
- `ui.doneOpen` persistence unchanged.

## History page (`history.html` + `history.js`)

A **separate static page** (same no-build, relative-path rules), styled by the
same `style.css`, with its own small read-only script. It never boots the
timer: `app.js` stays an index-only concern, so no session can be logged,
started, or mutated from history.

### Query controls

- **Text search** — case-insensitive substring over title + description.
  `/` focuses the field.
- **Date range chips** — Today · Yesterday · 7 days · 30 days · All time,
  plus two custom `from`–`to` date inputs (editing them switches to a custom
  range). Day boundaries are local midnight via the same `dayKey` rules.
- **Tag filter** — the existing colored tag chips; multi-select with AND
  semantics (narrowing, like GitHub label filters).
- **Deep links** — filters serialize to URL params
  (`?q=…&range=7d&tags=id,id&from=…&to=…`) via `replaceState`, so a filtered
  view is bookmarkable and the main page can link straight into one.

### Results

- Grouped by day, newest day first; each group header shows the weekday/date,
  how many finished, and that day's focus totals (minutes + 🍅) computed from
  the session log.
- Rows are lean: check mark, title, tag chips, per-task 🍅 count for that day,
  completion time. No description preview, no actions — history is read-only.
- Renders 7 day-groups at a time with a **Load more** button (no infinite
  scroll; predictable and dependency-free).
- Empty state for zero matches.

### Data & privacy

- **No data model changes, no pruning.** Done tasks stay in
  `tomato-todos:tasks` forever — the history page can only query what storage
  retains. "Keep 10" is a *display* cap, never a deletion. (Storage growth is
  bounded in practice by the session cap; task rows are tiny — 2000 tasks ≈
  600 KB.)
- The only write the page performs is the theme setting (shared
  `tomato-todos:settings` key), via the same cycle button.
- Same defensive reading discipline as `app.js`: malformed storage renders an
  empty page, never an error.

### Code organization

`history.js` intentionally duplicates a handful of tiny helpers (`esc`,
`dayKey`, formatting) instead of sharing a module: extracting a common core
would couple both pages' boot paths for ~40 lines of utilities. Revisit if the
history page grows write actions (restore-to-today, delete) — that would
warrant a shared `core.js`.

## Alternatives considered

- **In-app overlay view instead of a page:** keeps one HTML file but bloats
  `app.js` with a second surface and re-renders; a real page gives clean
  deep links and zero timer baggage.
- **Pruning done tasks to 10 in storage:** destroys the very data history
  exists to query; rejected.
- **Infinite scroll:** unpredictably renders thousands of rows (the exact
  problem this spec removes from the main page); paged day-groups instead.

## Non-goals this round

Restoring/deleting from history, exporting a filtered range, open-task
history, per-tag history stats.

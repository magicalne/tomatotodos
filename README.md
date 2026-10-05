# 🍅 Tomato Todos

A todo list fused with a pomodoro timer and per-task time tracking. Pure **HTML + CSS + vanilla JS** — no backend, no build step, no npm, no external dependencies. Everything is stored in your browser's `localStorage`; nothing ever leaves your device (see [PRIVACY.md](PRIVACY.md)).

## Features

- **Tasks** — add, inline-edit (double-click or ✏️), delete, complete/un-complete, reorder (↑/↓), optional note and due-today flag. Mark one task **active** (🎯) and every focus session's time is credited to it.
- **Pomodoro timer** — focus (default 24 min) / short break (5) / long break (15, after every 4 focus sessions — all configurable). Start / pause / resume / skip / reset. Auto-start breaks and auto-start next focus are toggleable.
  - The timer is **timestamp-based**: it stores `endsAt` and recomputes remaining time from the wall clock, so background-tab throttling and closed tabs never cause drift. Reload mid-session and the in-flight session is restored — including sessions that ended while the tab was closed (they get logged and credited with the correct end time).
  - **Alarm**: a Web Audio triple-tone (~2s) with a volume slider. The `AudioContext` is unlocked inside the Start-button click handler, so the alarm plays at session end without any further interaction. Optional desktop **notifications** (permission is requested from the settings toggle, never on page load) and a **flashing page title** as fallback. The live countdown is also shown in `document.title` (e.g. `18:24 ・ 🍅 focus`).
- **Time tracking & stats** — per-task 🍅 count and focus minutes for today, a "Today" dashboard (focus minutes, 🍅 count, day streak), time-per-task sorted, and a 14-day bar chart rendered with plain CSS. Day boundary = **local midnight**, computed lazily on render.
- **Session log** — every completed (or skipped-after-start) session is appended as `{type, taskId, taskTitle, startedAt, endedAt, completed, durationSec}`. Editing/renaming/deleting/reordering tasks never rewrites history — each session snapshots the task title, so logs survive task deletion.
- **Portability** — one-click **Export/Import JSON** backup (lossless round-trip), **Logseq-friendly markdown export** for today (copy or download), and "wipe today / wipe everything" behind confirm dialogs.
- **UX** — light/dark/auto theme (respects `prefers-color-scheme`, then persists your choice), tabular-numeral timer digits with a progress ring, subtle session-end animation, responsive single-column layout on small screens, keyboard shortcuts, and defensive parsing so malformed `localStorage` can never break the app.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Start / pause / resume |
| `N` | Focus the "new task" input |
| `1` / `2` / `3` | Focus / short break / long break mode |
| `Esc` | Cancel edit · close settings · close dialog |

## Run it

It's static files — serve the folder with any static server (a server is needed for clean localStorage origins; double-clicking `index.html` also works in most browsers):

```sh
cd tomatotodos
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Push these files to a GitHub repository (branch `main`, repo root):

   ```sh
   git init && git add -A && git commit -m "Tomato Todos"
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. In the repo: **Settings → Pages → Build and deployment → Source: "Deploy from a branch" → Branch: `main`, Folder: `/ (root)` → Save.**
3. Your app is live at `https://<you>.github.io/<repo>/` within a minute or two.

**Sub-path caveat:** GitHub Pages serves project sites under `/repo-name/`, not at the domain root. This app therefore uses **relative paths only** (`style.css`, `app.js`, `icon.svg`, and a manifest with `"start_url": "./"`). Keep it that way if you add files — an absolute `/icon.svg` reference would break on Pages.

## Data & storage

`localStorage` keys: `tomato-todos:settings`, `tomato-todos:tasks`, `tomato-todos:sessions`, `tomato-todos:timer`, `tomato-todos:ui`.

- **Export JSON** writes a single `{app, version, exportedAt, settings, tasks, sessions, timer}` file; **Import JSON** restores it losslessly (with validation).
- **Logseq export** for today looks like:

  ```markdown
  - ## 🍅 2026-10-05 — 6 pomodoros, 144m focus
    - DONE Write release notes
      pomodoros:: 3
      focused-minutes:: 72
    - DOING Fix the flaky timer test
      pomodoros:: 3
      focused-minutes:: 72
  ```

## Design decisions (where the spec was ambiguous, the simpler option was chosen)

- **Focus time is credited at session end**, not live second-by-second. Paused time is excluded (pause is compensated). The credited task is the one marked active *at completion*; switching the active task mid-session moves the credit.
- **Skipped sessions**: skipping after ≥1s of elapsed time logs a `completed: false` record and credits the elapsed partial time. Skipping a not-yet-started session logs nothing. Skipping after start also auto-starts the next phase; automatic transitions follow the auto-start toggles.
- **Focus minutes today** = full duration for completed sessions + elapsed time for skipped ones; only completed sessions count as 🍅.
- **Streak** = consecutive days with ≥1 completed 🍅, counting back from today; if you haven't earned one yet today, it counts back from yesterday (grace).
- **"Wipe today"** removes today's sessions *and* un-completes tasks completed today; tasks themselves and earlier history stay.
- **Reordering** uses ↑/↓ buttons rather than drag-and-drop — HTML5 drag is unreliable on touch devices.
- **Long-break cadence**: the counter resets when a long break completes or is skipped, so a long break keeps being suggested until you actually take one.
- The session log is capped at **5000 records** (oldest dropped) to keep `localStorage` happy.
- Notifications need a secure context (GitHub Pages ✓, `localhost` ✓). iOS Safari doesn't support the `Notification` API — the beep and title flash still work there.
- `window.__tomato` exposes `{state, tick, completeSession, buildExport, buildLogseqMarkdown}` on the console as a small debug/testing hook.

## Files

```
index.html            markup
style.css             themes + layout
app.js                all logic (vanilla JS, one file)
manifest.webmanifest  optional PWA manifest (relative start_url)
icon.svg              favicon / app icon
PRIVACY.md            data-stays-local statement
```

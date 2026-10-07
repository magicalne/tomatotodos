See [README.md](README.md) for what the app does. Essentials: static HTML + CSS + vanilla JS, all state in `localStorage`, no backend, auto-deployed to GitHub Pages from `main`/root on every push.

## Hard constraints

- **No dependencies, no build step, no framework** — this is the project's identity, not an accident.
- **Relative paths only** (`app.js`, `icon.svg`, manifest `start_url: "./"`). Pages serves under `/tomatotodos/`; an absolute `/foo` breaks the live site.
- **localStorage is untrusted.** Reads go through `toNum`/`toBool`/`toStr`/shape checks; malformed stored data must never crash the app.
- **Session log is append-only.** Editing/deleting tasks never rewrites past sessions — each session snapshots the task title.
- **Timer is timestamp-based, never tick-accumulated.** A running session stores `endsAt`; repaints recompute remaining time from the wall clock. The 250ms interval only repaints. (docs/decisions/0001)
- **Day boundary = local midnight** via `dayKey()`. Convert day keys with `dayToDate()` (DST-safe), never raw ms math across days.
- **Check PRIVACY.md** before changing anything about storage, export, or data flow.
- Keep the `MAX_SESSIONS = 5000` cap.

## Code layout

- `index.html` — structure
- `style.css` — all styling; themes via CSS custom properties
- `app.js` — the whole app, one IIFE, organized by banner sections:

  Constants → Helpers → Storage → State → Theme → Audio & notifications → Timer engine → Tasks → Recurring tasks → Stats → Export / import / Logseq → Rendering → Drawer / modal / toast → Recurring task UI → Events → Init

Put new code in the matching section. `esc()` any user string before it enters HTML.

## docs/ — shared memory

Specs, plans, and decision records live in `docs/` (structure and ADR format in [docs/README.md](docs/README.md)). Code records *how*; docs record *why* and *what's planned*.

- `docs/specs/` — what a feature should do: behavior, data model, edge cases
- `docs/plans/` — how to build it: steps, files touched, risks
- `docs/decisions/` — one `NNNN-slug.md` per major decision

For non-trivial work (new feature, data-model change, timer/state/storage refactor): read the relevant docs first and write a short spec if none exists; record major decisions as they're made; update docs to match what shipped — in the same commit. Trivial changes (typo, CSS tweak, copy) need no doc.

## Verification (no test suite)

```sh
python3 -m http.server 8000   # open http://localhost:8000
```

- Timer changes: reload mid-session (must restore), background the tab, session ending while the tab is closed.
- Storage/schema changes: corrupted `localStorage` key must not crash the app; old export files still import.
- Recurrence changes: materialization at load and midnight rollover; missed days collapse into one ⚠ overdue instance.
- Always: add / edit / delete / reorder tasks, stats render, export/import round-trip, both themes, small viewport.

## Commits

One logical change per commit, short imperative subject (`Truncate long task titles with ellipsis`). Related doc updates go in the same commit.

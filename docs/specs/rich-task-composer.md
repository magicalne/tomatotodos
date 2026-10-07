# Spec: Rich task composer (title + description + colored tags)

- **Status:** draft — awaiting design review
- **Date:** 2026-10-07

## Problem

The "new todo" action is a single-line input. There is nowhere to put lengthy
content (context, links, acceptance steps, notes-to-self), and the only "tags"
are system badges (⚑ today, 🔁 recurring). Users who break work down inside a
task have no home for that text.

## Goal

A GitHub-issue-like composer: **title + description + colored tags**, without
sacrificing the app's fast one-line capture.

## UX design

### Two paths, one form

- **Quick path (unchanged):** type in the single-line input, press Enter →
  task added. Zero extra clicks for small todos. This is the app's identity
  and must not regress.
- **Rich path (new):** a 📝 toggle in the form row expands an inline composer
  card directly below the input (same interaction pattern as the existing 🔁
  repeat builder — no modal):

  ```
  ┌──────────────────────────────────────────────┐
  │ Task title                              [📝] [🔁] [Add] │
  ├──────────────────────────────────────────────┤
  │ │ Description textarea                    │  │  ← auto-grows to
  │ │ (multi-line, plain text)                │  │    ~240px, then scrolls
  │ ┌──────────────────────────────────────┐ │  │
  │ │ ● work  ● home  ● learning  + tag    │ │  │  ← tag picker
  │ └──────────────────────────────────────┘ │  │
  │ Ctrl/⌘+↵ adds · Esc closes      [Close]  │  │
  └──────────────────────────────────────────────┘
  ```

- Title input placeholder switches to "Task title" while expanded.
- **Keyboard:** Enter in title → jumps to description (when expanded);
  `Ctrl/⌘+Enter` submits from anywhere in the composer; `Esc` collapses
  (text is kept); plain Enter in the collapsed input still submits instantly.
- **Tags:** chips toggle on/off with a click. `+ tag` opens an inline create
  row: name field + 8 color swatches. Created tags are auto-selected.

### Tags in the list

- Task rows show their tags as small colored pills next to the title.
- The description shows as a muted 2-line clamped preview under the title;
  clicking the preview expands it to full height (click again to collapse).
- The old 📝 badge (note indicator) is superseded by the visible preview.

### Editing

The inline edit row gets the same fields: title, description textarea
(auto-grow), tag picker, due-today. `Ctrl/⌘+Enter` saves; Enter in the title
saves; Enter inside the description inserts a newline.

### Recurring tasks

The 🔁 builder stays a separate toggle and composes with the composer. The
recurrence **template** stores title + description + tags; every materialized
instance inherits them. Editing an instance's description/tags updates the
series (same rule as title today).

## Data model

New localStorage key `tomato-todos:tags`:

```json
[{ "id": "…", "label": "work", "color": 5, "createdAt": 1728000000000 }]
```

- `label` ≤ 24 chars, unique case-insensitively; `color` is an **index (0–7)
  into a fixed palette**, never a raw hex — keeps stored data small and
  guarantees both themes look right.
- Registry cap: 32 tags. Per-task cap: 6 `tagIds`.
- First run seeds three example tags (work · home · learning) so the system is
  discoverable; users can ignore or build their own set.

Task schema additions:

- `body` — string ≤ 5000 chars, multi-line plain text. **Migration:** on load,
  a non-empty legacy `note` with no `body` becomes `body` (the `note` field is
  retired; old backups still import via the same migration).
- `tagIds` — array of tag ids, sanitized against the registry.

Recurrence templates gain the same two fields. Export stays `version: 2`
(fields are additive both directions; importing an old backup into a new app
yields an empty tag registry, since import is a documented full replace).

## Color palette

8 fixed pairs (soft background / strong text) defined as CSS custom
properties, re-declared per theme: red, orange, amber, green, teal, blue,
purple, pink. A tag chip is: colored dot + label; unselected chips sit on the
surface with a border, selected chips fill with the tag's soft background.

## Edge cases

- Malformed `tomato-todos:tags` (non-array, junk entries, duplicate labels/ids)
  → sanitized on load, never crashes.
- `tagIds` referencing a missing tag are ignored at render time.
- Description that is only whitespace saves as `''`.
- Corrupted/absent keys, old export files, mid-session reload: existing
  guarantees unchanged.

## Alternatives considered

- **Modal dialog** (literal GitHub new-issue): rejected — heavier, covers the
  list, and creates a second competing "add" surface; the inline card achieves
  the same stacked title/body/tags layout while matching the existing
  recur-builder pattern.
- **Always-expanded form:** rejected — crowds the 90% quick-capture case.
- **Markdown rendering:** deferred — a hand-rolled parser is real scope; plain
  multi-line text with preserved newlines covers the need and keeps
  export/import/Logseq honest. Revisit if bodies grow structured.

## Non-goals this round

Tag filtering of the list, tag rename/delete management UI, markdown, per-tag
stats, Logseq export of body text. (Filtering is the natural follow-up once
tag usage settles.)

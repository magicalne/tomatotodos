# 0001. Timestamp-based timer, never tick-accumulated

- **Status:** accepted
- **Date:** 2026-10-07

## Context

The pomodoro countdown must stay correct while the tab is backgrounded or closed. Browsers throttle `setInterval` in background tabs (down to once per minute or worse), and users routinely close or reload the tab mid-session. A naive timer that decrements `remaining` on each tick loses time under throttling and loses the whole session on reload.

Sessions also need to be *credited* with the correct end time when they finish while the tab is closed, because the session log is append-only history.

## Options

1. **Tick accumulation** — decrement `remaining` every interval. Simple, but drifts under background throttling and cannot survive a reload.
2. **Timestamp-based** — store `endsAt = Date.now() + remaining` when starting/pausing; recompute remaining from the wall clock on every repaint. The interval only repaints and detects completion.

## Decision

The timer engine is timestamp-based (option 2): a running session persists `endsAt` to `localStorage`, and remaining time is always recomputed from the wall clock. A reload restores the in-flight session, and a session that ended while the tab was closed is logged with its true end time. The 250ms tick exists solely to repaint and detect completion — it never accumulates time.

## Consequences

- Background-tab throttling, sleeping machines, and closed tabs cannot cause drift.
- Pausing/resuming must rewrite `endsAt` on each transition — timer state changes touch persisted state, so they need the same defensive read/write discipline as everything else.
- Any future timer feature (e.g. per-task session length) must be built on `endsAt`, not on tick counting.

# docs/

This folder is the project's shared memory. Code records *how*; these docs record *why* and *what's planned* — so that context survives across sessions, agents, and contributors. See `AGENTS.md` for when reading and writing here is required.

| Folder | Contents | Written |
| --- | --- | --- |
| `specs/` | What a feature should do: user-visible behavior, data model, edge cases | **Before** building anything non-trivial |
| `plans/` | How it will be built: ordered steps, files touched, risks, verification checklist | Before/while building |
| `decisions/` | Decision records (ADR style): one file per major decision | The moment the decision is made |

File naming: `kebab-case.md`; decision records are `NNNN-slug.md` with the next free zero-padded number.

## Decision record format

```markdown
# NNNN. <short title>

- **Status:** accepted | superseded by NNNN
- **Date:** YYYY-MM-DD

## Context

What forced a choice; the constraints that matter.

## Options

The realistic alternatives, each with its trade-off.

## Decision

What we chose, in one or two sentences.

## Consequences

What this commits us to, and what becomes harder.
```

Update a record instead of deleting it when thinking evolves; supersede it (`Status: superseded by NNNN`) when it's reversed.

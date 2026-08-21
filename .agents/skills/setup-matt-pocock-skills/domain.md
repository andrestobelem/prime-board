# Domain Docs

Rules for how engineering skills consume this repository's domain documentation during codebase exploration.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repository root, if it exists. It points to one `CONTEXT.md` per context. Read each file relevant to the topic.
- **`docs/adr/`** — read ADRs that affect the area you will change. In a multi-context repository, also check `src/<context>/docs/adr/` for context-specific decisions.

If any file is missing, **proceed silently**. Do not report the absence or suggest creating the file before it is needed. The `/domain-modeling` skill, reached through `/grill-with-docs` and `/improve-codebase-architecture`, creates files when it resolves terms or decisions.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When output names a domain concept, such as in an issue title, refactor proposal, hypothesis, or test name, use the term defined in `CONTEXT.md`. Do not use a synonym that the glossary explicitly avoids.

If the required concept is not in the glossary, treat this as a signal. You may be inventing language the project does not use; reconsider it. If the glossary has a real gap, note it for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, report the conflict explicitly instead of silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

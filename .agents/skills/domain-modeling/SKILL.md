---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a CONTEXT.md, or recording or editing an ADR.
---

# Domain Modeling

Build and sharpen the project's domain model during design. This is the *active* discipline: challenge terms, create edge-case scenarios, and record glossary entries and decisions when they become clear. *Reading* `CONTEXT.md` for vocabulary is not this skill. Any skill can do that. Use this skill when you change the model, not when you only consume it.

## File structure

Most repos have a single context:

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If `CONTEXT-MAP.md` exists at the root, the repository has multiple contexts. The map identifies the location of each context:

```
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
```

Create files only when you have content to write. If `CONTEXT.md` does not exist, create it when you resolve the first term. If `docs/adr/` does not exist, create it when you need the first ADR.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the language in `CONTEXT.md`, identify the conflict immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses a vague or overloaded term, propose one precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When the user discusses domain relationships, test them with specific scenarios. Create scenarios that probe edge cases and require precise boundaries between concepts.

### Cross-reference with code

When the user states how something works, check the code. If the code contradicts the statement, report the contradiction: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When you resolve a term, update `CONTEXT.md` immediately. Record each term as you resolve it. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`CONTEXT.md` contains no implementation details. Do not use it as a spec, scratch pad, or record of implementation decisions. It is only a glossary.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any criterion is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

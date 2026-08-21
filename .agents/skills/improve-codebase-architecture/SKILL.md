---
name: improve-codebase-architecture
description: Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick.
disable-model-invocation: true
---

# Improve Codebase Architecture

Find architectural friction and propose **deepening opportunities**: refactors that turn shallow modules into deep ones. The goals are testability and AI-navigability.

This skill uses the project's domain model and a shared design vocabulary:

- Call the Skill tool with "codebase-design" for the architecture vocabulary (**module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**) and its principles (the deletion test, "the interface is the test surface", "one adapter = hypothetical seam, two = real"). Use these terms exactly in every suggestion. Do not replace them with "component," "service," "API," or "boundary."
- Use the domain language in `CONTEXT.md` to name good seams. Use ADRs in `docs/adr/` as decisions that this skill must not reconsider.

## Process

### 1. Explore

**Define scope before scanning — YAGNI.** Deepening a module makes future changes easier, so focus on parts of the codebase that changed recently. Decide *where* to look before scanning:

- If the user named a direction, such as a module, subsystem, or pain point, use it and skip the inference below.
- Otherwise, inspect recent commit history (`git log --oneline`) to find hot spots: files and areas that recur. Start with those paths. If changes are scattered and no hot spot exists, widen the scope.

First read the project's domain glossary (`CONTEXT.md`) and ADRs in the area you will inspect.

Then spawn a sub-agent to inspect the codebase. Do not use rigid heuristics. Explore and record where you find friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to each suspected shallow module. Would deletion concentrate complexity or only move it? A result of "yes, concentrates" is the signal to keep.

### 2. Present candidates as an HTML report

Write a self-contained HTML file to the OS temporary directory so no report enters the repository. Resolve the temporary directory from `$TMPDIR`, using `/tmp` (or `%TEMP%` on Windows) as fallback. Write to `<tmpdir>/architecture-review-<timestamp>.html` so each run has a new file. Open the file for the user with `xdg-open <path>` on Linux, `open <path>` on macOS, or `start <path>` on Windows. Report the absolute path.

Use **Tailwind via CDN** for layout and styling. Use **Mermaid via CDN** for diagrams when a graph, flow, or sequence communicates the structure. Use Mermaid for graph-shaped relationships (call graphs, dependencies, sequences). Use hand-built divs/SVG for editorial visuals (mass diagrams, cross-sections, collapse animations). Give each candidate a **before/after visualization**.

For each candidate, render one card with:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and how tests would improve
- **Before / After diagram** — side-by-side, custom-drawn, illustrating the shallowness and the deepening
- **Recommendation strength** — one of `Strong`, `Worth exploring`, `Speculative`, rendered as a badge

End the report with a **Top recommendation** section that names the first candidate to address and explains why.

**Use CONTEXT.md vocabulary for the domain and `/codebase-design` vocabulary for architecture.** If `CONTEXT.md` defines "Order," write "the Order intake module", not "the FooBarHandler" or "the Order service."

**ADR conflicts**: if a candidate contradicts an ADR, report it only when real friction justifies revisiting that ADR. Mark the conflict clearly in the card (for example, a warning callout: _"contradicts ADR-0007 — but worth reopening because…"_). Do not list theoretical refactors that the ADR forbids.

See [HTML-REPORT.md](HTML-REPORT.md) for the full HTML scaffold, diagram patterns, and styling guidance.

Do NOT propose interfaces yet. After writing the file, ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

After the user selects a candidate, call the Skill tool with "grilling" to walk the decision tree with them: constraints, dependencies, deepened-module shape, contents behind the seam, and surviving tests.

Apply side effects inline as decisions become clear. Call the Skill tool with "domain-modeling" to keep the domain model current:

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md`. Create the file only when needed.
- **Sharpening a vague term during the conversation?** Update `CONTEXT.md` immediately.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR with: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Offer one only when a future explorer needs the reason to avoid repeating the suggestion. Skip temporary reasons ("not worth it right now") and self-evident reasons.
- **Want to explore alternative interfaces for the deepened module?** Call the Skill tool with "codebase-design" and use its design-it-twice parallel sub-agent pattern.

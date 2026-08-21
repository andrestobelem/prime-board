---
name: code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

Review the diff between `HEAD` and the fixed point supplied by the user on two axes:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?

Run both axes as **parallel sub-agents**. This keeps their contexts separate. Then aggregate their findings.

Use the provided issue tracker. If `docs/agents/issue-tracker.md` is missing, tell the user to run `/setup-matt-pocock-skills`.

## Process

### 1. Pin the fixed point

Use the user's stated fixed point: a commit SHA, branch name, tag, `main`, `HEAD~5`, or another ref. If the user did not specify one, ask for it.

Record the diff command once: `git diff <fixed-point>...HEAD` (three-dot compares against the merge-base). Also record the commits with `git log <fixed-point>..HEAD --oneline`.

Before continuing, confirm that the fixed point resolves (`git rev-parse <fixed-point>`) and that the diff is non-empty. Stop here for an invalid ref or empty diff. Do not defer this check to a sub-agent.

### 2. Identify the spec source

Find the originating spec in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.) — fetch via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If no spec is found, ask the user where it is. If the user says that no spec exists, skip the **Spec** sub-agent and report "no spec available".

### 3. Identify the standards sources

Use every repository file that documents code standards, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

In addition to repository standards, the Standards axis always uses the **smell baseline** below. It is a fixed set of Fowler code smells (_Refactoring_, ch.3) and applies even when the repository has documented standards. Apply these two rules:

- **The repo overrides.** A documented repository standard always wins. When it endorses something the baseline would flag, suppress the smell.
- **Always a judgment call.** Each smell is a labeled heuristic ("possible Feature Envy"), not a hard violation. As with every standard here, skip checks enforced by tooling.

For each smell, identify *what it is* and *how to fix it*. Match the smell against the diff:

- **Mysterious Name** — a function, variable, or type name does not reveal what it does or holds. → rename it. If no accurate name exists, review the design.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape and call it from both locations.
- **Feature Envy** — a method accesses another object's data more than its own. → move the method to the data it uses.
- **Data Clumps** — the same fields or parameters travel together. → bundle them in one type and pass that type.
- **Primitive Obsession** — a primitive or string represents a domain concept that needs its own type. → give the concept a small type.
- **Repeated Switches** — the same `switch`/`if` cascade on one type appears in several places. → replace it with polymorphism or one shared map.
- **Shotgun Surgery** — one logical change requires scattered edits across many files in the diff. → collect the changing code in one module.
- **Divergent Change** — one file or module changes for several unrelated reasons. → split it so each module changes for one reason.
- **Speculative Generality** — an abstraction, parameter, or hook supports a need absent from the spec. → delete it or inline it until a real need exists.
- **Message Chains** — long `a.b().c().d()` navigation creates a dependency the caller should not have. → hide the navigation behind one method on the first object.
- **Middle Man** — a class or function mainly delegates to another target. → remove it and call the target directly.
- **Refused Bequest** — a subclass or implementer ignores or overrides most inherited behavior. → replace inheritance with composition.

### 4. Spawn both sub-agents in parallel

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the reports under `## Standards` and `## Spec` headings, either verbatim or with light cleanup. **Do not** merge or rerank findings. The two axes must remain separate (see _Why two axes_).

End with one line that states the total findings for each axis and the worst issue _within each axis_, if one exists. Do not select one winner across axes. The separation prevents that reranking.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Separate reporting prevents one axis from masking the other.

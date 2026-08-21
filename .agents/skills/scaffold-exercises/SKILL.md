---
name: scaffold-exercises
description: Create exercise directory structures with sections, problems, solutions, and explainers that pass linting. Use when user wants to scaffold exercises, create exercise stubs, or set up a new course section.
---

# Scaffold Exercises

Create exercise directory structures that pass `pnpm ai-hero-cli internal lint`. Then commit with `git commit`.

## Directory naming

- **Sections**: `XX-section-name/` inside `exercises/` (for example, `01-retrieval-skill-building`).
- **Exercises**: `XX.YY-exercise-name/` inside a section (for example, `01.03-retrieval-with-bm25`).
- The section number is `XX`. The exercise number is `XX.YY`.
- Use dash-case names with lowercase letters and hyphens.

## Exercise variants

Each exercise needs at least one of these subfolders:

- `problem/` — student workspace with TODOs
- `solution/` — reference implementation
- `explainer/` — conceptual material with no TODOs

When creating stubs, use `explainer/` unless the plan specifies another variant.

## Required files

Each subfolder (`problem/`, `solution/`, `explainer/`) needs a `readme.md` that:

- Is **not empty**. It must contain real content; a title line is sufficient.
- Has no broken links.

When creating a stub, write a minimal readme with a title and description:

```md
# Exercise Title

Description here
```

If a subfolder has code, it also needs a `main.ts` (>1 line). A readme-only exercise is valid for stubs.

## Workflow

1. **Parse the plan** — extract section names, exercise names, and variant types.
2. **Create directories** — run `mkdir -p` for each path.
3. **Create stub readmes** — write one `readme.md` per variant folder with a title.
4. **Run lint** — run `pnpm ai-hero-cli internal lint`.
5. **Fix errors** — repeat until lint passes.

## Lint rules summary

The linter (`pnpm ai-hero-cli internal lint`) checks:

- Each exercise has subfolders (`problem/`, `solution/`, `explainer/`)
- At least one of `problem/`, `explainer/`, or `explainer.1/` exists
- `readme.md` exists and is non-empty in the primary subfolder
- No `.gitkeep` files
- No `speaker-notes.md` files
- No broken links in readmes
- No `pnpm run exercise` commands in readmes
- `main.ts` required per subfolder unless it's readme-only

## Moving/renaming exercises

When renumbering or moving exercises:

1. Use `git mv` (not `mv`) to rename directories. This preserves git history.
2. Update the numeric prefix to preserve order.
3. Run lint again after moving files.

Example:

```bash
git mv exercises/01-retrieval/01.03-embeddings exercises/01-retrieval/01.04-embeddings
```

## Example: stubbing from a plan

Given a plan like:

```
Section 05: Memory Skill Building
- 05.01 Introduction to Memory
- 05.02 Short-term Memory (explainer + problem + solution)
- 05.03 Long-term Memory
```

Create:

```bash
mkdir -p exercises/05-memory-skill-building/05.01-introduction-to-memory/explainer
mkdir -p exercises/05-memory-skill-building/05.02-short-term-memory/{explainer,problem,solution}
mkdir -p exercises/05-memory-skill-building/05.03-long-term-memory/explainer
```

Then create readme stubs:

```
exercises/05-memory-skill-building/05.01-introduction-to-memory/explainer/readme.md -> "# Introduction to Memory"
exercises/05-memory-skill-building/05.02-short-term-memory/explainer/readme.md -> "# Short-term Memory"
exercises/05-memory-skill-building/05.02-short-term-memory/problem/readme.md -> "# Short-term Memory"
exercises/05-memory-skill-building/05.02-short-term-memory/solution/readme.md -> "# Short-term Memory"
exercises/05-memory-skill-building/05.03-long-term-memory/explainer/readme.md -> "# Long-term Memory"
```

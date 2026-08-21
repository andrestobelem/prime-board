---
name: setup-matt-pocock-skills
description: Configure this repo for the engineering skills — set up its issue tracker, triage label vocabulary, and domain doc layout. Run once before first use of the other engineering skills.
disable-model-invocation: true
---

# Setup Matt Pocock's Skills

Create the per-repository configuration required by the engineering skills:

- **Issue tracker** — where issues live (GitHub by default; local markdown is also supported out of the box)
- **Triage labels** — the strings used for the five canonical triage roles
- **Domain docs** — where `CONTEXT.md` and ADRs live, and the consumer rules for reading them

This is a prompt-driven skill, not a deterministic script. Explore the repository, present the findings, confirm the choices with the user, and then write the files.

## Process

### 1. Explore

Inspect the current repository to determine its starting state. Read existing files and do not assume:

- `git remote -v` and `.git/config` — is this a GitHub repo? Which one?
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `CONTEXT.md` and `CONTEXT-MAP.md` at the repo root
- `docs/adr/` and any `src/*/docs/adr/` directories
- `docs/agents/` — does this skill's prior output already exist?
- `.scratch/` — sign that a local-markdown issue tracker convention is already in use
- Is the `triage` skill installed? Check for a `triage` skill folder alongside this one or `triage` in the available skills. This determines whether Section B runs.
- Monorepo signals — a `pnpm-workspace.yaml`, a `workspaces` field in `package.json`, or a populated `packages/*` with its own `src/`. Treat these as monorepo signals only when the repository is a large multi-package repository. Without them, use single-context, which is the usual case.

### 2. Present findings and ask

Summarize what exists and what is missing. Then process the sections in order. Ask one section at a time and wait for one answer before continuing.

Start each section with the recommended answer so the user can accept it with one word. Add a one-line explanation only when the choice has meaningful branches. Skip a section when exploration already settled it: skip Section B when `triage` is not installed, and skip Section C when no monorepo exists.

**Section A — Issue tracker.**

> Explainer: The "issue tracker" is where issues live for this repo. Skills like `to-tickets`, `triage`, and `to-spec` read from and write to it — they need to know whether to call `gh issue create`, write a markdown file under `.scratch/`, or follow some other workflow you describe. Pick the place you actually track work for this repo.

Use this default: these skills target GitHub. If a `git remote` points to GitHub, recommend GitHub. If a `git remote` points to GitLab (`gitlab.com` or a self-hosted host), recommend GitLab. Otherwise, or when the user prefers another option, offer:

- **GitHub** — issues live in the repo's GitHub Issues (uses the `gh` CLI)
- **GitLab** — issues live in the repo's GitLab Issues (uses the [`glab`](https://gitlab.com/gitlab-org/cli) CLI)
- **Local markdown** — issues live as files under `.scratch/<feature>/` in this repo (good for solo projects or repos without a remote)
- **Other** (Jira, Linear, etc.) — ask the user to describe the workflow in one paragraph; the skill will record it as freeform prose

Record the choice in `docs/agents/issue-tracker.md`. The GitHub and GitLab templates include a "PRs as a request surface" flag that defaults **off**. Leave it off and do not raise it. A user who wants external PRs in the triage queue can change the flag in the file later.

**Section B — Triage label vocabulary.** Skip this section entirely if the `triage` skill isn't installed (exploration told you) — an uninstalled skill needs no labels.

If it is installed, ask exactly one question:

> Do you want to keep the default triage labels? (recommended: **yes**)

The defaults are the five canonical roles, with label strings equal to their names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. On **yes**, write them as-is. If the user says no, collect the overrides. This usually means the tracker already uses other names, such as `bug:triage` for `needs-triage`. Apply existing labels instead of creating duplicates.

**Section C — Domain docs.** Use **single-context** by default: one `CONTEXT.md` and `docs/adr/` at the repository root. This fits most repositories. Write it without asking.

Offer **multi-context** — a root `CONTEXT-MAP.md` that points to per-context `CONTEXT.md` files — only when exploration finds monorepo signals. Then confirm the layout.

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and `docs/agents/triage-labels.md` (the last only when `triage` is installed)

Let the user edit the draft before writing.

### 4. Write

**Choose the file to edit:**

- If `CLAUDE.md` exists, edit it.
- Otherwise, if `AGENTS.md` exists, edit it.
- If neither file exists, ask the user which file to create. Do not choose for the user.

Never create `AGENTS.md` when `CLAUDE.md` already exists, or the reverse. Edit the file that already exists.

If the chosen file already has an `## Agent skills` block, update it in place instead of appending a duplicate. Do not overwrite user edits in surrounding sections.

The block:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout — "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

Include the `### Triage labels` sub-block and write `docs/agents/triage-labels.md` only when `triage` is installed and Section B ran. Otherwise omit both.

Then write the documentation files. Use the seed templates in this skill folder as the starting point:

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub issue tracker
- [issue-tracker-gitlab.md](./issue-tracker-gitlab.md) — GitLab issue tracker
- [issue-tracker-local.md](./issue-tracker-local.md) — local-markdown issue tracker
- [triage-labels.md](./triage-labels.md) — label mapping (only if `triage` is installed)
- [domain.md](./domain.md) — domain doc consumer rules + layout

For "other" issue trackers, write `docs/agents/issue-tracker.md` from the user's description.

### 5. Done

Tell the user that setup is complete and list the engineering skills that will read these files. Tell the user that they can edit `docs/agents/*.md` directly. They need to rerun this skill only to switch issue trackers or start again from scratch.

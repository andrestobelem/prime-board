# Out-of-Scope Knowledge Base

The `.out-of-scope/` directory stores persistent records of rejected feature requests. It has two purposes:

1. **Institutional memory** — record why a feature was rejected so the reasoning remains available after the issue closes.
2. **Deduplication** — when a new issue matches a prior rejection, surface the previous decision instead of evaluating the request again.

## Directory structure

```
.out-of-scope/
├── dark-mode.md
├── plugin-system.md
└── graphql-api.md
```

Create one file per **concept**, not per issue. Group multiple requests for the same concept in one file.

## File format

Write the file in a readable style. Treat it as a short design document, not a database entry. Use paragraphs, code samples, and examples when they make the reasoning clear to a new reader.

```markdown
# Dark Mode

This project does not support dark mode or user-facing theming.

## Why this is out of scope

The rendering pipeline assumes a single color palette defined in
`ThemeConfig`. Supporting multiple themes would require:

- A theme context provider wrapping the entire component tree
- Per-component theme-aware style resolution
- A persistence layer for user theme preferences

This is a significant architectural change that doesn't align with the
project's focus on content authoring. Theming is a concern for downstream
consumers who embed or redistribute the output.

```ts
// The current ThemeConfig interface is not designed for runtime switching:
interface ThemeConfig {
  colors: ColorPalette; // single palette, resolved at build time
  fonts: FontStack;
}
```

## Prior requests

- #42 — "Add dark mode support"
- #87 — "Night theme for accessibility"
- #134 — "Dark theme option"
```

### Naming the file

Use a short, descriptive kebab-case filename for the concept: `dark-mode.md`, `plugin-system.md`, `graphql-api.md`. The name must tell someone browsing the directory what was rejected.

### Writing the reason

The reason must explain why the request was rejected, not only state "we don't want this". Good reasons reference:

- Project scope or philosophy ("This project focuses on X; theming is a downstream concern")
- Technical constraints ("Supporting this would require Y, which conflicts with our Z architecture")
- Strategic decisions ("We chose to use A instead of B because...")

The reason must remain valid. Do not cite temporary circumstances such as "we're too busy right now". Those circumstances defer a request; they do not reject it.

## When to check `.out-of-scope/`

During triage (Step 1: Gather context), read every file in `.out-of-scope/`. When evaluating a new issue:

- Check if the request matches an existing out-of-scope concept
- Match by concept similarity, not keyword. For example, "night theme" matches `dark-mode.md`.
- If a match exists, report it to the maintainer: "This is similar to `.out-of-scope/dark-mode.md` — we rejected this before because [reason]. Do you still feel the same way?"

The maintainer can:

- **Confirm** — the new issue gets added to the existing file's "Prior requests" list, then closed
- **Reconsider** — the out-of-scope file gets deleted or updated, and the issue proceeds through normal triage
- **Disagree** — the issues are related but distinct, proceed with normal triage

## When to write to `.out-of-scope/`

Write here only when an **enhancement**, not a bug, is *rejected* as `wontfix`. Apply this rule to enhancement PRs as well as issues. Record a rejected PR so the same request does not return as new work.

Do **not** write here when something is closed as `wontfix` because it is **already implemented**. This is a built feature, not a rejected feature. Recording it would create a false rejection during deduplication. Instead, point to the existing feature in the closing comment.

The flow:

1. Maintainer decides a feature request is out of scope
2. Check if a matching `.out-of-scope/` file already exists
3. If yes: append the new issue to the "Prior requests" list
4. If no: create a new file with the concept name, decision, reason, and first prior request
5. Post a comment on the issue explaining the decision and mentioning the `.out-of-scope/` file
6. Close the issue with the `wontfix` label

## Updating or removing out-of-scope files

If the maintainer changes the decision about a rejected concept:

- Delete the `.out-of-scope/` file
- Do not reopen old issues. They are historical records.
- Process the new issue that triggered reconsideration through normal triage.

# Issue tracker: Local Markdown

Issues and specs for this repository live as Markdown files in `.scratch/`.

## Conventions

- Use one directory per feature: `.scratch/<feature-slug>/`.
- Store the spec at `.scratch/<feature-slug>/spec.md`.
- Store one implementation issue per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`. Number files from `01`. Never use one combined tickets file.
- Record triage state in a `Status:` line near the top of each issue file. See `triage-labels.md` for role strings.
- Append comments and conversation history under a `## Comments` heading at the bottom of each file.

## When a skill says "publish to the issue tracker"

Create a file under `.scratch/<feature-slug>/`. Create the directory when needed.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user normally provides the path or issue number.

## Wayfinding operations

`/wayfinder` uses these operations. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — stores the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`). A `Status:` line records `claimed`/`resolved`.
- **Blocking**: add a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every listed file is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for open, unblocked, unclaimed files. The first file by number is next.
- **Claim**: set `Status: claimed` and save before doing any work.
- **Resolve**: append the answer under an `## Answer` heading. Set `Status: resolved`. Then append a context pointer (gist + link) to Decisions-so-far in `map.md`.

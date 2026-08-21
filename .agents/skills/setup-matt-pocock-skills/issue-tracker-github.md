# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`. `gh` does this automatically inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repository treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, process PRs with the same labels and states as issues. Use the equivalent `gh pr` commands:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub uses one number space for issues and PRs. A bare `#42` may refer to either type. Resolve it with `gh pr view 42`; if that fails, use `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

`/wayfinder` uses these operations. The **map** is one issue with **child** issues as tickets.

- **Map**: create one issue labeled `wayfinder:map`. Store the Notes / Decisions-so-far / Fog body in it. Use `gh issue create --label wayfinder:map`.
- **Child ticket**: link an issue to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). If sub-issues are not enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Use labels `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Assign the ticket to the developer driving the map when claimed.
- **Blocking**: use GitHub's **native issue dependencies** as the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. `<blocker-db-id>` is the blocker's numeric **database id**, obtained with `gh api repos/<owner>/<repo>/issues/<n> --jq .id`; it is _not_ the `#number` or `node_id`. GitHub reports `issue_dependencies_summary.blocked_by` for open blockers. If dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children with `gh issue list --state open`, scoped to the map's sub-issues or task list. Remove tickets with an open blocker (`issue_dependencies_summary.blocked_by > 0` or an open issue in the `Blocked by` line) or an assignee. The first remaining ticket in map order is next.
- **Claim**: run `gh issue edit <n> --add-assignee @me` as the session's first write.
- **Resolve**: run `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

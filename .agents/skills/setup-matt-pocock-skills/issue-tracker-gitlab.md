# Issue tracker: GitLab

Issues and specs for this repository live in GitLab Issues. Use the [`glab`](https://gitlab.com/gitlab-org/cli) CLI for all operations.

## Conventions

- **Create an issue**: `glab issue create --title "..." --description "..."`. Use a heredoc for multi-line descriptions. Pass `--description -` to open an editor.
- **Read an issue**: `glab issue view <number> --comments`. Use `-F json` for machine-readable output.
- **List issues**: `glab issue list -F json` with appropriate `--label` filters.
- **Comment on an issue**: `glab issue note <number> --message "..."`. GitLab calls comments "notes".
- **Apply / remove labels**: `glab issue update <number> --label "..."` / `--unlabel "..."`. Multiple labels can be comma-separated or by repeating the flag.
- **Close**: `glab issue close <number>`. `glab issue close` does not accept a closing comment, so post the explanation first with `glab issue note <number> --message "..."`, then close.
- **Merge requests**: GitLab calls PRs "merge requests". Use `glab mr create`, `glab mr view`, `glab mr note`, etc. — the same shape as `gh pr ...` with `mr` in place of `pr` and `note`/`--message` in place of `comment`/`--body`.

Infer the repository from `git remote -v`. `glab` does this automatically inside a clone.

## Merge requests as a triage surface

**MRs as a request surface: no.** _(Set to `yes` if this repository treats external merge requests as feature requests; `/triage` reads this flag.)_

When set to `yes`, process MRs with the same labels and states as issues. Use the equivalent `glab mr` commands:

- **Read an MR**: `glab mr view <number> --comments` and `glab mr diff <number>` for the diff.
- **List external MRs for triage**: `glab mr list -F json`, then keep only MRs whose author is not a project member/owner (a contributor's MR, not a maintainer's in-flight work).
- **Comment / label / close**: `glab mr note`, `glab mr update --label`/`--unlabel`, `glab mr close`.

Unlike GitHub, GitLab uses separate number spaces for issues and MRs. `#42` is unambiguous after you identify the surface.

## When a skill says "publish to the issue tracker"

Create a GitLab issue.

## When a skill says "fetch the relevant ticket"

Run `glab issue view <number> --comments`.

## Wayfinding operations

`/wayfinder` uses these operations. The **map** is one issue with **child** issues as tickets.

- **Map**: create one issue labeled `wayfinder:map` with the Notes / Decisions-so-far / Fog body. Use `glab issue create --label wayfinder:map`. On GitLab tiers with native epics, an epic can hold the map; a labeled issue works on every tier.
- **Child ticket**: add `Part of #<map>` at the top of the description and use the labels `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Assign the ticket to the developer driving the map when claimed.
- **Blocking**: use GitLab's **native blocking link** as the canonical, UI-visible representation. Add it with the `/blocked_by #<n>` quick action in a note (`glab issue note <child> --message "/blocked_by #<blocker>"`). Native blocking links require Premium/Ultimate. On a free tier or when links are unavailable, put `Blocked by: #<n>, #<n>` at the top of the description. A ticket is unblocked when every blocker is closed.
- **Frontier query**: run `glab issue list -F json` for the map's children. Remove tickets with an open blocker: a native `blocked_by` link to an open issue (`glab api projects/:id/issues/:iid/links`) or an open issue in the `Blocked by` line. Also remove assigned tickets. The first remaining ticket in map order is next.
- **Claim**: run `glab issue update <n> --assignee @me` as the session's first write.
- **Resolve**: run `glab issue note <n> --message "<answer>"`, then `glab issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

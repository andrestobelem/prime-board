---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---

1. **Inspect the current state** of the merge or rebase. Check the git history and the conflicting files.

2. **Find the primary source** for each conflict. Understand why each change was made and identify its original intent. Read the commit messages, pull requests, and original issues or tickets.

3. **Resolve each hunk.** Preserve both intents where possible. When the intents conflict, choose the one that matches the stated goal of the merge and record the trade-off. Do **not** invent behavior. Resolve every conflict; never run `--abort`.

4. Discover and run the project's **automated checks**. Run typecheck, tests, and format checks as available. Fix any problem caused by the merge.

5. **Finish the merge or rebase.** Stage all resolved files and commit. If rebasing, continue until all commits are rebased.

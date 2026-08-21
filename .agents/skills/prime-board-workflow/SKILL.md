---
name: prime-board-workflow
description: Use when this project is connected to an isolated prime-board instance, when creating or updating PRB issues, or when configuring the prime-board CLI/MCP workflow.
---

# Prime-board workflow

Use the project's isolated prime-board instance as the operational issue tracker. The target
project repository and its `.prime-board/` replica are separate from the prime-board source
repository.

## Activate the connection

Set these environment variables:

- `PRIME_BOARD_URL`: this project's server URL.
- `PRIME_BOARD_API_KEY`: API key for the current Actor.
- `PRIME_BOARD_TEAM`: Team key for this project. If unset, discover it with `pb team list`.
- `PRIME_BOARD_ROOT`: path to the cloned prime-board repository. The source CLI/MCP requires this path.

If the server is not running, ask the human to start an isolated instance with:

```bash
bun "$PRIME_BOARD_ROOT/scripts/prime-board-project.ts" --project "$PWD"
```

The first start prints the admin API key once. Keep this key outside the repository.
To configure the shell without starting the server, run:

```bash
eval "$(bun "$PRIME_BOARD_ROOT/scripts/prime-board-project.ts" --project "$PWD" --print-env)"
```

Then set `PRIME_BOARD_API_KEY` and authenticate the CLI. See [references/setup.md](references/setup.md)
for detailed CLI and MCP configuration.

## Work loop

1. **Find or create one issue per unit of work.** Search the project's Team before you create a
   duplicate. Put new work on the project's board, not in Linear or a hand-written
   `.prime-board/` file.
2. **Claim before editing.** Move the issue to the team's active workflow state. Assign it to
   the current Actor.
3. **Implement and validate.** Follow the target project's `AGENTS.md`, tests, and conventions.
   Create separate issues for newly discovered bugs before you fix them.
4. **Leave evidence.** Comment on the issue with the changes, commands run, and known gaps.
5. **Resolve only after validation.** Move the issue to the completed workflow state only after
   the acceptance criteria and regression checks pass.

Use the CLI commands in [references/commands.md](references/commands.md). The GraphQL API is the
authority for authorization and issue state. The CLI and MCP are adapters.

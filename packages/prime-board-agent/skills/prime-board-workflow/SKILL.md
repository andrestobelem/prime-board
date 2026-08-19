---
name: prime-board-workflow
description: Use when this project is connected to an isolated prime-board instance, when creating or updating PRB issues, or when configuring the prime-board CLI/MCP workflow.
---

# Prime-board workflow

Use the project's isolated prime-board instance as the operational issue tracker. The
project repository and its `.prime-board/` replica are separate from the prime-board
source repository.

## Activate the connection

Use these environment variables:

- `PRIME_BOARD_URL`: this project's server URL.
- `PRIME_BOARD_API_KEY`: API key for the current Actor.
- `PRIME_BOARD_TEAM`: Team key for this project; discover it with `pb team list` when unset.
- `PRIME_BOARD_ROOT`: path to the cloned prime-board repository, needed by the source CLI/MCP.

If the server is not running, ask the human to start an isolated instance:

```bash
bun "$PRIME_BOARD_ROOT/scripts/prime-board-project.ts" --project "$PWD"
```

The first start prints the admin API key once. Keep the key outside the repository.
For a shell configuration without starting the server:

```bash
eval "$(bun "$PRIME_BOARD_ROOT/scripts/prime-board-project.ts" --project "$PWD" --print-env)"
```

Then set `PRIME_BOARD_API_KEY` and authenticate the CLI. Detailed setup and MCP
configuration are in [references/setup.md](references/setup.md).

## Work loop

1. **Find or create one issue per unit of work.** Search the project's Team before creating a
   duplicate. New work belongs in the project's board, not in Linear or a hand-written
   `.prime-board/` file.
2. **Claim before editing.** Move the issue to the team's active workflow state and assign it to
   the current Actor.
3. **Implement and validate.** Follow the target project's `AGENTS.md`, tests, and conventions.
   Record newly discovered bugs as separate issues before fixing them.
4. **Leave evidence.** Comment the issue with what changed, commands run, and known gaps.
5. **Resolve only after validation.** Move the issue to the completed workflow state only after
   the acceptance criteria and regression checks pass.

Use the CLI commands in [references/commands.md](references/commands.md). The GraphQL API is
the authority for authorization and issue state; the CLI and MCP are adapters.

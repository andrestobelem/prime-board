# Isolated project setup

## 1. Start the instance

From the cloned prime-board repository:

```bash
bun scripts/prime-board-project.ts --project /path/to/project
```

The command derives an isolated database under `~/.prime-board/projects/`, sets
`PRIME_BOARD_REPO` to the target repository, and starts the server on port 3333. Override
`--port` or `--db` when needed. The server writes the target project's `.prime-board/`
replica; do not edit that directory directly.

To inspect the derived configuration without starting a server:

```bash
eval "$(bun scripts/prime-board-project.ts --project /path/to/project --print-env)"
```

The admin key is printed only on the first server start. Create an Actor and an API key for
normal work, then export the resulting key as `PRIME_BOARD_API_KEY`.

## 2. Install the skill in the target project

Copy this skill directory into the target project's agent skills directory:

```bash
mkdir -p /path/to/project/.agents/skills
cp -R /path/to/prime-board/.agents/skills/prime-board-workflow \
  /path/to/project/.agents/skills/prime-board-workflow
```

Keep the target project's own `AGENTS.md` as the authority for code conventions. Add a short
pointer there if the agent does not discover project skills automatically.

## 3. Configure the CLI

```bash
export PRIME_BOARD_ROOT=/path/to/prime-board
export PRIME_BOARD_URL=http://localhost:3333
export PRIME_BOARD_API_KEY=pb_...
export PRIME_BOARD_TEAM=PB
alias pb='bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts"'
pb issue list --team "$PRIME_BOARD_TEAM" --json
```

## 4. Configure MCP

```json
{
  "mcpServers": {
    "prime-board": {
      "command": "bun",
      "args": ["/path/to/prime-board/apps/mcp/src/index.ts"],
      "env": {
        "PRIME_BOARD_URL": "http://localhost:3333",
        "PRIME_BOARD_API_KEY": "pb_..."
      }
    }
  }
}
```

For multiple projects, run one instance per project with a distinct database and port. Never
reuse a database between projects.

# Isolated project setup

## 1. Start the instance

From the cloned prime-board repository:

```bash
bun scripts/prime-board-project.ts --project /path/to/project
```

The command derives an isolated database under `~/.prime-board/projects/`, sets
`PRIME_BOARD_REPO` to the target repository, and starts one instance per project. The default
port is 3333. For a new database, choose the initial Workspace and Team identity with
`--workspace-name`, `--workspace-url-key`, `--team-name`, and `--team-key`. The matching
variables are `PRIME_BOARD_WORKSPACE_NAME`, `PRIME_BOARD_WORKSPACE_URL_KEY`,
`PRIME_BOARD_TEAM_NAME`, and `PRIME_BOARD_TEAM_KEY`; flags override variables. The defaults are
`workspace`, `prime-board`, `Prime Board`, and `PB`. This identity is applied only on first
bootstrap. The URL key uses lowercase letters, numbers, and hyphens. The Team key uses 1-8
alphanumeric characters and starts with a letter.

If that port is occupied and you did not provide `--port`, the launcher selects
the next free loopback port. An explicitly occupied port causes an error instead of connecting
to another project. The server writes the target project's `.prime-board/` replica. Do not edit
that directory directly.

The launcher records the active instance in a project lock under `~/.prime-board/projects/`.
A second invocation for the same repository reuses the process, database, and port. Different
repositories receive different database identities and ports.

To discover the active configuration without starting a server:

```bash
eval "$(bun scripts/prime-board-project.ts --project /path/to/project --print-env)"
```

Use `--status` to inspect the instance. It exits with 0 for `running`, 1 for `not-running`,
and 2 for `stale`.

The admin key is printed only on the first server start. Create an Actor and an API key for
normal work. Then export the resulting key as `PRIME_BOARD_API_KEY`.

## 2. Install the skill in the target project

Copy this skill directory into the target project's agent skills directory:

```bash
mkdir -p /path/to/project/.agents/skills
cp -R /path/to/prime-board/.agents/skills/prime-board-workflow \
  /path/to/project/.agents/skills/prime-board-workflow
```

Use the target project's own `AGENTS.md` as the authority for code conventions. Add a short
pointer there if the agent does not discover project skills automatically.

## 3. Configure the CLI

```bash
export PRIME_BOARD_ROOT=/path/to/prime-board
export PRIME_BOARD_API_KEY=pb_...
export PRIME_BOARD_TEAM=PB
alias pb='bun "$PRIME_BOARD_ROOT/apps/cli/src/index.ts"'
pb issue list --team "$PRIME_BOARD_TEAM" --json
```

## 4. Configurar MCP HTTP (interfaz principal)

Inicia el transporte local en otra terminal. El servidor MCP no lee una API key del entorno:
valida el Bearer enviado por cada cliente.

```bash
PRIME_BOARD_URL="$PRIME_BOARD_URL" \
PRIME_BOARD_MCP_HOST=127.0.0.1 \
PRIME_BOARD_MCP_PORT=3334 \
bun "$PRIME_BOARD_ROOT/apps/mcp/src/http.ts"
```

Configura Prime Agent con `bearerTokenEnvVar` para que la credencial permanezca en el entorno:

```json
{
  "mcpServers": {
    "prime-board": {
      "type": "http",
      "url": "http://127.0.0.1:3334/mcp",
      "bearerTokenEnvVar": "PRIME_BOARD_API_KEY"
    }
  }
}
```

El transporte stdio existente sigue disponible para clientes que aún no soportan HTTP:
usa `bun "$PRIME_BOARD_ROOT/apps/mcp/src/index.ts"` con `PRIME_BOARD_URL` y
`PRIME_BOARD_API_KEY` en el entorno del proceso, nunca en el package ni en `.prime-board/`.

Para varios proyectos, ejecuta una instancia por proyecto con una base y un puerto distintos.
Nunca reutilices una base entre proyectos.

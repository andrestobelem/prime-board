# prime-board

Clon de Linear para agentes. Gestiona issues y proyectos para agentes y otros clientes,
incluido [prime-agent](https://github.com/nicolaschapur/prime-agent).

## Estado

**Parte 1 — Definición del MVP: completa.** [`docs/alcance-mvp.md`](docs/alcance-mvp.md)
define el MVP. [`docs/specs/mvp.md`](docs/specs/mvp.md) lo especifica con Bun + TypeScript +
SQLite, API GraphQL, arquitectura local-first single-tenant, CLI, MCP server y una UI
similar a Linear.

**Parte 2 — Núcleo del backend: completa.** La API GraphQL opera sobre SQLite e incluye
Teams, Actors humanos y agentes con API keys y roles de workspace, Memberships, Issues con
sub-issues, Relations, Activity, Labels, Projects con Milestones y Project Updates, Cycles,
Initiatives, Reviews, Inbox, Saved Views, Favorites, filtros componibles y full-text (FTS5),
paginación por cursor y Webhooks firmados con HMAC. La suite ejecutable se valida con
`bun test`; esta descripción no fija una cantidad de tests.

**Parte 3 — Interfaces para agentes: completa.** El CLI `pb` y el MCP server por stdio
cubren Issues, Teams, Actors, API keys, Memberships, Workflow States, Labels, Projects,
Milestones, Cycles, Initiatives, Reviews, Inbox, Saved Views, Favorites, Relations y
Webhooks. Ambas interfaces ofrecen JSON cuando corresponde, devuelven errores estables y
delegan la autorización en GraphQL. Consulta la guía completa en
[`docs/guia-agentes.md`](docs/guia-agentes.md). Crea los datos de demo con `bun run seed`.

**Parte 4 — UI web: completa. 🎉 MVP terminado.** El mismo proceso sirve una UI similar a
Linear. Incluye una lista agrupada por estado, un board con drag & drop, navegación por
teclado entre Issues, detalle con edición inline y markdown, creación rápida (`C`), command
palette (`⌘K`) con búsqueda full-text, Inbox, My Issues, Projects, Cycles, Saved Views,
Favorites y configuración de Teams y Workspace.

### Inicio rápido

```bash
bun install
bun run build    # buildea la UI
bun run server   # imprime la API key de admin en el primer arranque
bun run seed     # (opcional) datos de demo + un agente con su key
bun run export   # exporta el estado operativo a la réplica .prime-board/
# bun run rebuild --from /ruta/repo  # reconstruye el estado operativo desde un export completo
# UI en http://localhost:3333/?key=pb_...  ·  GraphQL en /graphql (GraphiQL en dev)
```

## Usar prime-board en otro proyecto

Para operar un proyecto externo con una instancia aislada, ejecuta desde este clon:

```bash
bun scripts/prime-board-project.ts --project /ruta/a/mi-proyecto
```

El launcher deriva una DB independiente en `~/.prime-board/projects/`, configura
`PRIME_BOARD_REPO` con la raíz del proyecto y escribe allí la réplica `.prime-board/`.
Usa `--port` y `--db` para personalizar la instancia. Puedes elegir la identidad que se
siembra en una base nueva:

```bash
bun scripts/prime-board-project.ts --project /ruta/a/mi-proyecto \
  --workspace-name "Mi Workspace" \
  --workspace-url-key mi-workspace \
  --team-name "Mi Team" \
  --team-key MT
```

Los flags equivalen a `PRIME_BOARD_WORKSPACE_NAME`, `PRIME_BOARD_WORKSPACE_URL_KEY`,
`PRIME_BOARD_TEAM_NAME` y `PRIME_BOARD_TEAM_KEY`. Un flag tiene prioridad sobre su variable.
Los defaults son `workspace`, `prime-board`, `Prime Board` y `PB`. La configuración solo se
aplica durante el primer arranque. Reiniciar una base existente conserva sus nombres y keys.
El `urlKey` usa minúsculas, números y guiones. La `key` del Team tiene entre 1 y 8 caracteres
alfanuméricos y comienza con una letra.

Para obtener solo las variables:

```bash
eval "$(bun scripts/prime-board-project.ts --project /ruta/a/mi-proyecto --print-env)"
```

La skill instalable para el agente está en
[`.agents/skills/prime-board-workflow`](.agents/skills/prime-board-workflow). Cópiala al
`.agents/skills/` del proyecto consumidor junto con su configuración MCP. La skill define
el ciclo de crear, reclamar, validar, comentar evidencia y resolver issues.

## Clientes de agentes

Para operar con el CLI, guarda la API key que imprime el server y configura el cliente:

```bash
bun /ruta/a/prime-board/apps/cli/src/index.ts auth login \
  --url http://localhost:3333 --key pb_...
bun /ruta/a/prime-board/apps/cli/src/index.ts issue list --team PRB --assignee me --json
```

El MCP server usa stdio y las mismas credenciales:

```json
{
  "mcpServers": {
    "prime-board": {
      "command": "bun",
      "args": ["/ruta/a/prime-board/apps/mcp/src/index.ts"],
      "env": {
        "PRIME_BOARD_URL": "http://localhost:3333",
        "PRIME_BOARD_API_KEY": "pb_..."
      }
    }
  }
}
```

Consulta el inventario de comandos y el contrato de GraphQL en
[`docs/guia-agentes.md`](docs/guia-agentes.md).

## Exportación y reconstrucción

La base operativa es la autoridad para el estado vigente. `.prime-board/` es una réplica
versionada y legible que contiene el Log de Activities, los Issue Markdown y metadatos.
No edites esta réplica a mano. `bun run export` escribe una réplica completa por defecto;
`bun run export --team PRB` escribe una réplica parcial y registra su alcance en
`.prime-board/meta/export.json`.

`bun run rebuild --from <repo>` reconstruye el estado operativo desde la réplica indicada.
El comando rechaza los exports parciales por defecto para evitar que borre en silencio otros
Teams. Solo acepta esos exports con `bun run rebuild --from <repo> --allow-partial`, que
reemplaza explícitamente ese alcance y no hace un merge.

No guardes API keys ni secretos de Webhooks en `.prime-board/`. Revisa el export antes de
aplicarlo y conserva un backup de la base operativa. Consulta la terminología completa en
[`CONTEXT.md`](CONTEXT.md) y las instrucciones para agentes en
[`docs/guia-agentes.md`](docs/guia-agentes.md).

## Convenciones

Consulta [`AGENTS.md`](AGENTS.md) para conocer las convenciones del repo: idioma, commits y
estructura.

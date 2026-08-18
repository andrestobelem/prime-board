# prime-board

Clon de Linear para agentes: un gestor de issues y proyectos pensado para que lo
usen agentes — en principio [prime-agent](https://github.com/nicolaschapur/prime-agent),
aunque debería poder usarse con otros.

## Estado

**Parte 1 — Definición del MVP: completa.** El MVP quedó definido en
[`docs/alcance-mvp.md`](docs/alcance-mvp.md) y especificado en
[`docs/specs/mvp.md`](docs/specs/mvp.md): Bun + TypeScript + SQLite, API GraphQL,
local-first single-tenant, con CLI, MCP server y UI Linear-like.

**Parte 2 — Núcleo del backend: completa.** API GraphQL operativa sobre SQLite:
Teams, Actors humano/agente con API keys y roles de workspace, Memberships,
Issues con sub-issues, Relations, Activity, Labels, Projects con Milestones y
Project Updates, Cycles, Initiatives, Reviews, Inbox, Saved Views, Favorites,
filtros componibles + full-text (FTS5), paginación por cursor y Webhooks firmados
con HMAC. La cobertura ejecutable se valida con `bun test`; no se fija una cantidad
de tests en esta descripción.

**Parte 3 — Interfaces para agentes: completa.** CLI `pb` y MCP server por stdio
cubren Issues, Teams, Actors, API keys, Memberships, Workflow States, Labels,
Projects, Milestones, Cycles, Initiatives, Reviews, Inbox, Saved Views, Favorites,
Relations y Webhooks. Ambas interfaces ofrecen JSON donde corresponde, errores
estables y delegan la autorización en GraphQL. La guía completa está en
[`docs/guia-agentes.md`](docs/guia-agentes.md) y los datos de demo se crean con
`bun run seed`.

**Parte 4 — UI web: completa. 🎉 MVP terminado.** UI Linear-like servida por el
mismo proceso: lista agrupada por estado, board con drag & drop, navegación por
teclado entre Issues, detalle con edición inline y markdown, creación rápida (`C`),
command palette (`⌘K`) con búsqueda full-text, Inbox, My Issues, Projects, Cycles,
Saved Views, Favorites y configuración de Teams y Workspace.

### Quick start

```bash
bun install
bun run build    # buildea la UI
bun run server   # imprime la API key de admin en el primer arranque
bun run seed     # (opcional) datos de demo + un agente con su key
bun run export   # exporta el estado operativo a la réplica .prime-board/
# bun run rebuild --from /ruta/repo  # reconstruye el estado operativo desde un export completo
# UI en http://localhost:3333/?key=pb_...  ·  GraphQL en /graphql (GraphiQL en dev)
```

## Clientes de agentes

Para operar con el CLI, guardá la API key que imprime el server y configurá el cliente:

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

Para el inventario de comandos y el contrato de GraphQL, consultá
[`docs/guia-agentes.md`](docs/guia-agentes.md).

## Exportación y reconstrucción

La base operativa es la autoridad para el estado vigente. `.prime-board/` es una réplica
versionada y legible que contiene el Log de Activities, los Issue Markdown y metadatos;
no se edita a mano. `bun run export` escribe una réplica completa por defecto;
`bun run export --team PRB` escribe una réplica parcial y registra su alcance en
`.prime-board/meta/export.json`.

`bun run rebuild --from <repo>` reconstruye el estado operativo desde la réplica indicada.
Los exports parciales se rechazan por defecto para evitar borrar silenciosamente otros
Teams; solo se aceptan con `bun run rebuild --from <repo> --allow-partial`, que reemplaza
explícitamente ese alcance y no hace un merge.

No guardes API keys ni secretos de Webhooks en `.prime-board/`. Revisá el export antes de
aplicarlo y conservá un backup de la base operativa. La terminología completa está en
[`CONTEXT.md`](CONTEXT.md) y las instrucciones para agentes en
[`docs/guia-agentes.md`](docs/guia-agentes.md).

## Convenciones

Ver [`AGENTS.md`](AGENTS.md) para las convenciones del repo (idioma, commits, estructura).

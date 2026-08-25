# prime-board

Clon de Linear para agentes. Gestiona issues y proyectos para agentes y otros clientes,
incluido [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent).

## Rutas rápidas

- **Instalar y levantar:** sigue [Inicio rápido](#inicio-rápido).
- **Operar como agente:** consulta la [guía de operación](docs/guia-agentes.md).
- **Usar el tracker del repositorio:** consulta el [issue tracker](docs/agents/issue-tracker.md).
- **Buscar documentación por audiencia o tipo:** abre el [índice de documentación](docs/README.md).

## Estado

**Parte 1 — Definición del MVP: completa.** [`docs/alcance-mvp.md`](docs/alcance-mvp.md)
define el alcance histórico del MVP. [`docs/specs/mvp.md`](docs/specs/mvp.md) conserva la
especificación técnica histórica. No es el contrato actual. Para operar el producto, usa la
[guía de operación](docs/guia-agentes.md) y los [contratos para agentes](docs/agents/).

**Parte 2 — Núcleo del backend: completa.** La API GraphQL comparte el contrato y el endpoint
`/graphql` entre los backends disponibles. SQLite es el backend predeterminado y cubre el núcleo
completo: Teams, Actors humanos y agentes con API keys y roles de Workspace, Memberships, Issues
con sub-issues, Relations, Activity, Labels, Projects con Milestones y Project Updates, Cycles,
Initiatives, Reviews, Inbox, Saved Views, Favorites, filtros componibles y full-text (FTS5),
paginación por cursor y Webhooks firmados con HMAC. PostgreSQL es opcional y su migración es
incremental. La cobertura por backend y las brechas conocidas están en
[`docs/alcance-mvp.md`](docs/alcance-mvp.md). La suite ejecutable se valida con `bun test`; esta
descripción no fija una cantidad de tests.

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

### Selección del backend

SQLite es el valor predeterminado cuando `PRIME_BOARD_PERSISTENCE` no está definido o vale
`sqlite`. Usa `PRIME_BOARD_DB` para elegir el archivo de datos. Para seleccionar PostgreSQL,
define `PRIME_BOARD_PERSISTENCE=postgres` y `PRIME_BOARD_POSTGRES_URL`:

```bash
# SQLite (predeterminado)
bun run server

# PostgreSQL (selección explícita)
PRIME_BOARD_PERSISTENCE=postgres \
  PRIME_BOARD_POSTGRES_URL='postgres://usuario:contraseña@localhost:5432/prime_board' \
  bun run server
```

PostgreSQL conserva una única Workspace y una migración por dominios. Las operaciones todavía no
migradas pueden fallar de forma explícita o usar un SQLite efímero de compatibilidad, según el
dominio; no hay paridad completa entre backends. Consulta el [estado vigente y sus brechas](docs/alcance-mvp.md#persistencia-vigente-sqlite-y-postgresql) antes de asumir que una operación
presente en el SDL está disponible en PostgreSQL.

### Inicio rápido

```bash
bun install
bun run build    # buildea la UI
bun run server   # guarda la credencial de bootstrap fuera del proyecto
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
Usa `--port`, `--host`, `--db` y `--web-dist` para personalizar la instancia. Espera `/health`
antes de indicar que el runtime está listo. Para una instalación limpia, empaqueta
`packages/prime-board-runtime` con `bun run build:runtime` y ejecuta el binario `prime-board`;
el paquete requiere Bun >= 1.3.14, incluye UI y migraciones, y documenta la matriz y los
checksums en su README. La DB, el lock, los logs y las credenciales quedan fuera del paquete.
Puedes elegir la identidad que se
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

Para actualizar una instalación con SQLite, detén la instancia y usa `prime-board --update`.
El launcher crea un backup verificado con `VACUUM INTO` antes de iniciar migraciones. No copies
`<db>-wal` ni `<db>-shm` a mano. Si el health-check inicial falla, el launcher restaura la DB y
conserva la réplica `.prime-board/`. El procedimiento completo, los comandos `--backup` y
`--restore`, la política de instancia viva y las limitaciones están en
[`packages/prime-board-runtime/README.md`](packages/prime-board-runtime/README.md).

La skill instalable para el agente está en
[`.agents/skills/prime-board-workflow`](.agents/skills/prime-board-workflow). Cópiala al
`.agents/skills/` del proyecto consumidor junto con su configuración MCP. La skill define
el ciclo de crear, reclamar, validar, comentar evidencia y resolver issues.

## Clientes de agentes

Para operar con el CLI, usa la API key guardada fuera del proyecto en `~/.prime-board/credentials/` y configura el cliente:

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

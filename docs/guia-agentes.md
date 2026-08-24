# Guía de operación para agentes

> Cómo operar prime-board de principio a fin como agente o como persona con terminal.

## Índice operativo

- [Levantar el server](#1-levantar-el-server)
- [Conceptos básicos](#2-conceptos-en-30-segundos)
- [Darse de alta como agente](#3-darse-de-alta-como-agente)
- [Usar GraphQL](#4-graphql-directo)
- [Usar el CLI `pb`](#5-cli-pb)
- [Usar el MCP](#6-mcp)
- [Configurar webhooks](#7-webhooks-enterarse-de-las-cosas)
- [Exportar y reconstruir](#8-exportar-y-reconstruir-con-seguridad)
- [Ejecutar la receta completa](#9-receta-completa-para-un-agente-nuevo)

## 1. Levantar el server

```bash
bun install
bun run server
```

En una base nueva, el server crea el Workspace, un Team inicial, sus Workflow States y el Actor `admin`. Con la configuración predeterminada, el Team usa la key `PB`. Un Workspace migrado opera con el Team `PRB`.
En modo `api-key`, el server guarda la API key de admin fuera del proyecto, en `~/.prime-board/credentials/`, con permisos `0600`. El server no imprime la key ni la incluye en settings, logs o exports.

```text
First run: workspace seeded.
Admin API key stored outside the project under ~/.prime-board/credentials/ (mode 0600).
prime-board server listening on http://127.0.0.1:3333
```

Configuración por variable de entorno: `PRIME_BOARD_PORT` (default 3333), `PRIME_BOARD_HOST` (default
`127.0.0.1` en modo `api-key`) y `PRIME_BOARD_DB` (default `~/.prime-board/prime-board.db`). El
host no loopback requiere un override explícito de `PRIME_BOARD_HOST` en modo `api-key`. El modo
`local` ignora el override y siempre usa `127.0.0.1`. En una base nueva también puedes elegir la identidad
inicial con `PRIME_BOARD_WORKSPACE_NAME`, `PRIME_BOARD_WORKSPACE_URL_KEY`,
`PRIME_BOARD_TEAM_NAME` y `PRIME_BOARD_TEAM_KEY`. Los defaults son `workspace`, `prime-board`,
`Prime Board` y `PB`. El server recorta los nombres. `urlKey` usa minúsculas, números y guiones. La
`key` del Team tiene entre 1 y 8 caracteres alfanuméricos y comienza con una letra.

### Selección del backend

El endpoint GraphQL es el mismo con ambos backends. SQLite es el backend predeterminado cuando
`PRIME_BOARD_PERSISTENCE` no está definido o vale `sqlite`. Su archivo se configura con
`PRIME_BOARD_DB`.

PostgreSQL requiere una selección explícita y una URL de conexión:

```bash
PRIME_BOARD_PERSISTENCE=postgres \
  PRIME_BOARD_POSTGRES_URL='postgres://usuario:contraseña@localhost:5432/prime_board' \
  bun run server
```

PostgreSQL conserva una única Workspace y una migración incremental por dominios. Los dominios
migrados usan PostgreSQL. Una operación todavía no migrada puede responder `VALIDATION_FAILED` o
usar un SQLite efímero de compatibilidad, según el dominio. La presencia de una operación en el
SDL no garantiza que esté migrada en PostgreSQL. Consulta la [tabla de estado y brechas](alcance-mvp.md#persistencia-vigente-sqlite-y-postgresql) antes de automatizar una operación.

Para una instancia de desarrollo local, desactiva la solicitud de API key:

```bash
PRIME_BOARD_AUTH_MODE=local bun scripts/prime-board-project.ts --project /ruta/a/mi-proyecto
```

Este modo fija el server en `127.0.0.1`, autentica como Workspace Admin y concede acceso completo.
Úsalo solo en la máquina local. No lo ejecutes detrás de un proxy ni en una interfaz de red compartida.
El modo normal (`api-key`) no cambia.

### Instancia aislada para otro proyecto

Para usar prime-board con un repositorio externo, inicia una instancia por proyecto desde el
clon de prime-board:

```bash
bun scripts/prime-board-project.ts --project /ruta/a/mi-proyecto
```

El launcher usa una DB independiente en `~/.prime-board/projects/`, configura
`PRIME_BOARD_REPO=/ruta/a/mi-proyecto` y escribe la réplica `.prime-board/` en ese proyecto.
Puedes cambiar el puerto o la DB con `--port` y `--db`. Para elegir la identidad inicial, usa
`--workspace-name`, `--workspace-url-key`, `--team-name` y `--team-key`. Estos flags pisan las
variables de entorno equivalentes y solo afectan una base nueva. Por ejemplo:

```bash
bun scripts/prime-board-project.ts --project /ruta/a/mi-proyecto \
  --workspace-name "Mi Workspace" --workspace-url-key mi-workspace \
  --team-name "Mi Team" --team-key MT
```

Para cargar la configuración en una shell sin iniciar otra instancia:

```bash
eval "$(bun scripts/prime-board-project.ts --project /ruta/a/mi-proyecto --print-env)"
```

Copia `.agents/skills/prime-board-workflow` al proyecto consumidor para que el agente conozca
el ciclo de crear, reclamar, validar, comentar evidencia y resolver Issues.

### Preflight antes de editar o ejecutar tests

Ejecuta el preflight desde la worktree que vas a usar:

```bash
bun run preflight -- \
  --root "$PWD" --unit PRB-543 --branch ghostty-scout/prb-543 --dry-run --json
```

El informe de solo lectura comprueba la rama, la worktree, `core.bare`, el estado limpio,
worktrees o ramas duplicadas, la DB y el puerto efectivos, y las rutas del hook de tests.
Las rutas explícitas evitan que Bun descubra `scratchpad/worktrees`. El hook mantiene la suite
general en `--max-concurrency=5` y ejecuta cada test del launcher en un proceso separado con
`--max-concurrency=1`.

El preflight no reserva recursos ni corrige Git. El launcher reserva de forma atómica el puerto
y la DB antes de iniciar el servidor; esas reservas protegen contra carreras entre dos inicios.
El lock de DB conserva el path como alias léxico y no sigue symlinks. Por eso un symlink con
target pendiente mantiene el mismo lock antes y después de crear el target. También agrega
un lock por la ruta target estable y, cuando la DB ya existe, un lock físico por dispositivo e
inode para que los hardlinks compartan la reserva. Usa `--strict` para tratar advertencias como fallos. El informe no imprime variables de entorno
ni API keys.

### Datos de demo (opcional)

```bash
bun run seed
```

Crea un Project, cuatro Issues con Sub-issue, Labels y Comments, y un Actor
`demo-agent` con su propia API key. Estos datos sirven para probar los clientes. El seed es
idempotente. Si la base ya contiene Issues, no crea datos.

## 2. Conceptos en 30 segundos

- **Actors**: personas y agentes son iguales ante la API (`type: HUMAN | AGENT`).
  Cada Actor tiene su **API key** (`pb_...`) y toda acción queda atribuida a quien la ejecuta.
  El equipo identifica a cada agente por un nombre operativo, no por el modelo o LLM que lo ejecuta.
  El nombre puede cambiar sin rotar la key.
- **Identifiers legibles**: la API referencia las Issues operativas como `PRB-153`.
- **Workflow States con tipo semántico**: cada Team define sus estados, pero todos tienen un
  tipo portable (`triage|backlog|unstarted|started|completed|canceled`). Filtra por tipo y tu código funciona en cualquier Team.
- **Ruta de datos de los clientes**: el CLI y el MCP envían sus operaciones al endpoint GraphQL
  documentado. Consulta la sección de cada cliente para conocer las operaciones disponibles.
- **Workspace vs Team**: el Workspace es el contenedor de la instalación y tiene un nombre
  editable por Workspace Admins. Cada Team conserva su `key` (`PRB`) y su nombre. Renombrar
  el Workspace no cambia las keys, los Identifiers (`PRB-153`), los IDs ni las referencias históricas.

## 3. Darse de alta como agente

Con la key de admin, crea un Actor con nombre operativo y su key. La mutación muestra la key una sola vez; no la guardes en el repositorio, settings, logs ni exports:

```bash
curl -s http://localhost:3333/graphql \
  -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"query": "mutation { actorCreate(input: { name: \"atlas\", type: AGENT }) { actor { id } } }"}'

curl -s http://localhost:3333/graphql \
  -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"query": "mutation { apiKeyCreate(input: { actorId: \"<ID>\", name: \"atlas key\" }) { key } }"}'
```

Para cambiar el nombre sin perder la identidad ni las keys del agente:

```bash
curl -s http://localhost:3333/graphql \
  -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"query": "mutation { actorUpdate(id: \"<ID>\", input: { name: \"nuevo-nombre\" }) { actor { id name } } }"}'
```

El `id` del Actor es estable y las keys se asocian a ese ID. Por eso renombrarlo no
rompe la autenticación ni la auditoría. Repite `actorCreate` y `apiKeyCreate` para agregar
agentes adicionales.

## 4. GraphQL directo

Usa `POST /graphql` con `authorization: Bearer pb_...` como endpoint único.
GraphiQL está disponible en `http://localhost:3333/graphql` (en dev).

La query de ejemplo devuelve mis Issues urgentes, aún no iniciadas y que mencionan webhooks:

```graphql
query ($me: ID!) {
  issues(
    filter: {
      assignee: { eq: $me }
      priority: { eq: 1 }
      stateType: { eq: UNSTARTED }
      search: "webhook"
    }
  ) {
    nodes {
      identifier
      title
      url
      branchName
    }
  }
}
```

### Semántica de `filter.search`

La búsqueda usa prefijos sobre tokens y frases exactas entre comillas. Una frase vacía
(`""`) se ignora y no restringe los resultados. `*` se trata como un token literal y normalmente
no devuelve resultados. Las comillas sin cerrar se tratan como tokens literales, nunca como
sintaxis FTS5. Estas entradas no exponen errores internos de SQLite y conservan el comportamiento
de filtros anidados y paginación.

Ciclo de vida completo: `issueCreate` → `issueUpdate` (estado/prioridad/assignee/labels/
parent/project) → `commentCreate` → `issueArchive` → `issueUnarchive`. Las operaciones de archivo
registran `archived` o `unarchived` en la Activity de `Issue.activity`.

Para una entrega de agente, el comentario debe incluir SHA, criterios cubiertos, comandos y
resultados, brechas y siguiente estado. La entrega pasa a `Ready for Review`; otro Actor verifica
el cambio y la mueve a `Done` o la devuelve a `In Progress`. `Ready for Human` queda reservado
para implementación o decisión humana. El agente avisa a `admin` cuando termina o queda bloqueado.

## 5. CLI `pb`

```bash
alias pb="bun /ruta/a/prime-board/apps/cli/src/index.ts"

pb auth login --url http://localhost:3333 --key pb_xxx
pb workspace list --json
pb workspace use <ID|URLKEY|NAME> --json
pb workspace view --json
pb workspace update --name "Mi Workspace" --json  # requiere Workspace Admin
pb issue list --team PRB --state started --assignee me --json
pb issue create --team PRB --title "Hacer algo" --priority high --label agent:review
pb issue update PRB-153 --state done
pb issue comment PRB-153 --body -   # el body por stdin
pb project view <id> --json
pb project archive <id>
pb project milestone-create --project <id> --name "Beta"
pb project update-create --project <id> --health on_track --body -
pb webhook create --url http://localhost:9999/hook --events issue.created
```

- `--json` en todo comando de lectura produce una salida estable para parsear.
- `pb workspace list` devuelve solo los Workspaces que la API concede a la key. `pb workspace use`
  valida la referencia contra esa lista, guarda `workspaceId` y `workspaceUrlKey` en el perfil
  actual y envía `X-Workspace-ID` en las requests siguientes. Un perfil legacy sin selector no
  agrega el header y conserva el comportamiento singleton.
- El CLI también expone `project archive|unarchive`, `milestone-list|create|update|delete` y
  `update-list|create|delete`; los comandos de creación aceptan referencias por ID y los cuerpos
  pueden leerse desde stdin con `--body -` o `--description -`.
- Las superficies de planificación se operan con `pb cycle`, `pb review`, `pb initiative`,
  `pb inbox` y `pb favorite`; todos sus comandos de lectura aceptan `--json` y las mutaciones
  conservan los códigos de salida comunes del CLI.
- El MCP incluye tools para estas áreas. En planificación se llaman `list_cycles`, `save_cycle`,
  `carry_over_cycle`, `mark_inbox_read`, `archive_inbox` y `reorder_favorite`, entre otras.
- Administración operativa: `pb team create|update|archive|unarchive|delete|membership-*|workflow-state-*|label-*`,
  `pb actor list|create|update` y `pb api-key create|delete` exponen las mutaciones
  administrativas GraphQL y conservan sus errores/autorización.
- `pb issue archive <REF>` archiva una issue y devuelve la issue archivada con `--json`.
- `pb issue unarchive <REF>` restaura una issue archivada y devuelve la issue activa con `--json`.
- Exit codes: `0` ok, `1` error de API (incluye `NOT_FOUND` y `UNAUTHORIZED`), `2` error de uso o parseo de flags.
- Env `PRIME_BOARD_URL` / `PRIME_BOARD_API_KEY` pisan la config guardada.
- `pb auth login` guarda las credenciales en `~/.prime-board/cli.json`; el directorio queda
  con permisos `0700` y el archivo con `0600`. El CLI vuelve a endurecer esos permisos al
  cargar una configuración existente. No compartas ese archivo ni lo subas al repositorio.

## 6. MCP

El server MCP habla stdio y ofrece tools para consultar y modificar el Workspace, Teams,
Issues, Projects y otras entidades operativas. Entre sus nombres principales están
`get_workspace`, `list_teams`, `list_issues`, `get_issue`, `save_issue`, `list_comments`,
`save_comment`, `list_projects`, `get_project`, `save_project`, `list_cycles`, `list_reviews`,
`list_initiatives`, `list_inbox`, `list_favorites`, `list_webhooks` y `list_saved_views`.
La implementación actual también incluye tools para estados, labels, memberships, relaciones,
milestones, project updates y las mutaciones de archivado correspondientes.

Para verificar el inventario completo, consulta `apps/mcp/src/server.ts`. Las tools llaman al
endpoint GraphQL y la API conserva la autorización y los códigos de error.

Para renombrar el Workspace, usa `save_workspace` con `{ "name": "Mi Workspace" }`.
La API rechaza la operación para Actors con rol `MEMBER`. El nombre es independiente de las keys y
los nombres de los Teams.

El MCP ofrece estas tools administrativas: `archive_issue`, `unarchive_issue`, `archive_team`, `unarchive_team`,
`delete_team`, `save_team`, `list_team_memberships`, `save_team_membership`,
`delete_team_membership`, `save_user`, `save_api_key`, `delete_api_key`, `save_issue_status`,
`delete_issue_status`, `save_issue_label` y `delete_issue_label`. Las tools adaptan entradas y
salidas para el cliente MCP.
La API GraphQL sigue siendo la autoridad para la autorización y los códigos de error.

Configura un cliente MCP como Claude Desktop o prime-agent:

```json
{
  "mcpServers": {
    "prime-board": {
      "command": "bun",
      "args": ["/ruta/a/prime-board/apps/mcp/src/index.ts"],
      "env": {
        "PRIME_BOARD_URL": "http://localhost:3333",
        "PRIME_BOARD_API_KEY": "pb_xxx"
      }
    }
  }
}
```

## 7. Webhooks: enterarse de las cosas

Registra una URL y recibe un POST por cada evento
(`issue.created`, `issue.updated`, `issue.archived`, `issue.unarchived`, `comment.created`,
`project.created`, `project.updated`, `team.deleted`):

```bash
pb webhook create --url http://localhost:9999/hook --events issue.created,comment.created
# imprime el signing secret UNA vez
```

Payload: `{ event, actor: {id,name,type}, data, changes?, createdAt }`.
En `issue.updated`, `changes` trae `{ campo: { from, to } }`.

El `secret` se muestra **una sola vez**, al crear el webhook: guárdalo en el receptor.
Cada request lleva `X-PrimeBoard-Signature`, un HMAC-SHA256 en hexadecimal minúscula
calculado sobre el **body crudo exacto** (los bytes antes de parsearlo como JSON). No
reserialices el payload antes de verificar: cambios de espacios, orden de claves o saltos
de línea producen otra firma.

Ejemplo de verificación en Node:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, rawBody: string, received: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

// Verifica rawBody antes de ejecutar: const payload = JSON.parse(rawBody);
```

Los nombres de los headers HTTP no distinguen mayúsculas de minúsculas.
El server intenta la entrega tres veces, con backoff de 1 s, 5 s y 25 s.
Si el receptor sigue caído después de esos intentos, reconstruye el estado mediante la API.
La actividad por Issue permanece completa.

## 8. Exportar y reconstruir con seguridad

La DB es la fuente operativa y `.prime-board/` es su réplica versionada. No edites la
réplica a mano. Exporta desde la DB y revisa los cambios antes de hacer commit.

```bash
bun run export                         # export completo a la raíz del repo
bun run export --team PRB --out /tmp/pb-export  # export parcial, con alcance registrado
bun run rebuild --from /ruta/prime-board       # reemplaza desde un export completo
bun run rebuild --from /tmp/pb-export --allow-partial  # reemplazo parcial explícito
```

`bun run rebuild` rechaza un export con `meta/export.json` de alcance `team:KEY` si no pasas
`--allow-partial`. El flag no fusiona datos. Confirma que reemplazarás el índice con el alcance
parcial y que los Teams ausentes no se recuperarán. No ejecutes `rebuild` sobre la DB operativa sin
revisar el export y confirmar que existe un backup.

Los exports no contienen API keys ni secretos de webhooks. El rebuild puede volver a
asociar keys locales por nombre de actor, pero la réplica nunca es un mecanismo para
transportar credenciales.

Verificamos la receta anterior contra una DB temporal. Un export completo se reconstruye con
`--from`. Un export `team:PRB` falla sin `--allow-partial` y se reconstruye con éxito al pasar ese
flag. La prueba no usa ni reemplaza la DB operativa.

## 9. Receta completa para un agente nuevo

```bash
bun run server &                 # 1. inicia el server; no imprime ninguna key
bun run seed                     # 2. datos de demo opcionales
# Instala el package prime-board-agent y ejecuta /prime-board auth en Prime Agent.
# El comando reclama la credencial HUMAN externa y guarda solo la credencial AGENT.
# Define PRIME_BOARD_API_KEY desde esa credencial sin imprimirla.
pb auth login --url http://localhost:3333 --key "$PRIME_BOARD_API_KEY"
pb issue list --team PRB --assignee me --json    # 3. mi cola de trabajo
pb issue update PRB-153 --state started            # 4. tomo el issue
pb issue comment PRB-153 --body "On it"            # 5. aviso
pb issue update PRB-153 --state done               # 6. entrego
```

### Archivado reversible de Teams

Un Workspace Admin puede retirar un Team sin borrar sus Issues, estados ni actividades:

```bash
pb team archive AT --json
pb team list --include-archived --json
pb team unarchive AT --json
```

Las consultas y listados normales omiten Teams archivados. Para inspeccionar su historial se usa
`teams(includeArchived: true)` o `team(..., includeArchived: true)`; las operaciones sobre recursos
team-scoped archivados fallan con `VALIDATION_FAILED` hasta restaurar el Team.

### Borrado definitivo de Teams

`archive` es reversible. `delete` es definitivo y no sustituye al archivado. Solo un Workspace
Admin puede borrar un Team. Debe confirmar exactamente su key:

```bash
pb team delete EMPTY --confirm EMPTY --json
```

La API rechaza el borrado si existen Issues, Projects, Cycles, Labels, Saved Views o Initiatives.
La operación no deja cambios parciales. La API elimina los Workflow States y las memberships del
Team vacío en la misma transacción.

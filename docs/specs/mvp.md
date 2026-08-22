# Especificación histórica del MVP de prime-board

> Convención: la prosa de este doc está en español; todo lo que es parte de la aplicación
> (esquemas, tipos, comandos, nombres de campos) está en inglés.
> **Alcance:** esta es la especificación histórica del MVP. No la uses como contrato actual.
> Para el contrato vigente de Workspace, consulta [`docs/agents/graphql-workspace.md`](../agents/graphql-workspace.md).
> Para exportación, réplica y reconstrucción, prevalecen [`README.md`](../../README.md),
> [`docs/guia-agentes.md`](../guia-agentes.md) y [ADR-0004](../adr/0004-repo-como-fuente-de-verdad.md).

## 0. Estado de esta especificación

Esta especificación histórica conserva decisiones útiles para el modelo local-first.
El producto vigente también incluye Relations entre Issues, Milestones, Cycles, Inbox, Initiatives,
Saved Views y Project Updates. La matriz de clientes y el alcance vigente están documentados en
[`docs/alcance-mvp.md`](../alcance-mvp.md). Esa matriz, el schema GraphQL y los tickets `PRB-*`
son la referencia actual para distinguir una capacidad implementada de un gap de UI.

El alcance histórico del MVP excluye multi-workspace/multi-tenant, Documents, Timeline/analytics,
funcionalidad Enterprise (SSO/SCIM, SLAs) e integraciones que no son necesarias para el flujo API-first
de agentes. Linear funciona como archivo histórico, no como contrato actual del producto.

## 1. Resumen

El MVP define prime-board como un clon de Linear para agentes. Es un gestor de Issues
**local-first, single-tenant y API-first**. Un proceso Bun sirve la API GraphQL, la UI web y el
dispatcher de Webhooks sobre una base SQLite en disco. Tres clientes consumen esa API: la **UI**
(Linear-like), el **CLI `pb`** y el **MCP server**.

```
                    ┌────────────────────────────────────┐
   pb (CLI) ──────► │            Bun process             │
   MCP server ────► │  GraphQL (/graphql) ── SQLite (WAL)│ ──► webhooks (HTTP POST)
   UI (browser) ──► │  static UI (/)                     │
                    └────────────────────────────────────┘
```

## 2. Stack y estructura del repo

- **Runtime:** Bun con TypeScript estricto. SQLite mediante `bun:sqlite`.
- **GraphQL:** GraphQL Yoga (o equivalente liviano compatible con Bun) + schema SDL-first.
- **UI:** React + Vite, compilada como archivos estáticos que sirve el mismo proceso.
- **Monorepo:**

```
apps/
  server/     # GraphQL + webhooks + static serving + migraciones
  web/        # UI React
  cli/        # pb
  mcp/        # MCP server (cliente de la API)
packages/
  schema/     # SDL + tipos compartidos
docs/         # documentación (español)
```

- **Datos:** un archivo `prime-board.db` (WAL activado). Ubicación por defecto
  `~/.prime-board/prime-board.db`, override con `PRIME_BOARD_DB`.
- **Config:** variables de entorno con prefijo `PRIME_BOARD_`, como `PORT` y `DB`. En el primer
  arranque, `PRIME_BOARD_WORKSPACE_NAME`, `PRIME_BOARD_WORKSPACE_URL_KEY`,
  `PRIME_BOARD_TEAM_NAME` y `PRIME_BOARD_TEAM_KEY` eligen la identidad estable y el nombre
  visible del Workspace y Team. Los defaults son `workspace`, `prime-board`, `Prime Board` y
  `PB`. Un reinicio no cambia una identidad ya persistida.

## 3. Modelo de datos

Todas las entidades usan `id` UUID v7, ordenable por tiempo. También usan `createdAt` y
`updatedAt` en ISO-8601 UTC. Las entidades que lo requieren usan soft-delete mediante `archivedAt`.
El server ejecuta migraciones SQL versionadas al arrancar.

| Tabla             | Campos clave                                                                                                                             | Notas                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`       | `id, name, urlKey`                                                                                                                       | Fila única en el modelo histórico del MVP.                                                                                                        |
| `teams`           | `id, name, key, description, nextIssueNumber`                                                                                            | `key` corta única (`AT`). Al crear un team se siembra el workflow default.                                                         |
| `actors`          | `id, name, email?, type ('human'\|'agent'), avatarUrl?`                                                                                  | Humanos y agentes en la misma tabla; `type` es informativo y visible en UI/API.                                                    |
| `api_keys`        | `id, actorId, name, hash, lastUsedAt`                                                                                                    | La key en claro se muestra una sola vez. Formato `pb_<random>`.                                                                    |
| `workflow_states` | `id, teamId, name, type, color, position`                                                                                                | `type ∈ {triage, backlog, unstarted, started, completed, canceled}`. Default: Backlog, Todo, In Progress, Done, Canceled.          |
| `issues`          | `id, teamId, number, title, description, stateId, priority (0-4), assigneeId?, parentId?, projectId?, creatorId, sortOrder, archivedAt?` | Identificador legible = `team.key + '-' + number`, inmutable. `priority`: 0 none, 1 urgent, 2 high, 3 medium, 4 low (como Linear). |
| `labels`          | `id, name, color, teamId?`                                                                                                               | `teamId NULL` = label de workspace.                                                                                                |
| `issue_labels`    | `issueId, labelId`                                                                                                                       | N:M.                                                                                                                               |
| `projects`        | `id, name, description, state, leadId?, targetDate?, archivedAt?`                                                                        | `state ∈ {backlog, planned, started, paused, completed, canceled}`.                                                                |
| `comments`        | `id, issueId, actorId, body, createdAt, editedAt?`                                                                                       | Markdown plano.                                                                                                                    |
| `activity`        | `id, issueId, actorId, type, payload (JSON), createdAt`                                                                                  | Append-only: `created, state_changed, assigned, priority_changed, labeled, commented, ...`                                         |
| `webhooks`        | `id, url, secret, events (JSON), enabled`                                                                                                | `events`: lista de tipos suscriptos o `*`.                                                                                         |
| `issues_fts`      | FTS5: `title, description`                                                                                                               | Sincronizada por triggers; los comentarios se agregan post-MVP si hace falta.                                                      |

## 4. API GraphQL

El endpoint único es `POST /graphql`. **Paridad total**: la UI, el CLI y el MCP no usan canales privados. GraphiQL está habilitado en dev.

### Convenciones

- **Auth:** usa el header `Authorization: Bearer pb_...`. Toda mutación registra al Actor de la key en los campos de autoría, como `activity` y `creatorId`.
- **Identifiers:** las queries aceptan UUID o Identifier legible (`TEAM-126`) donde corresponda (`issue(id:)`).
- **Paginación:** cursor-based (`first/after`), estilo Relay simplificado
  (`nodes`, `pageInfo { hasNextPage, endCursor }`).
- **Filtros:** input objects componibles con `and`/`or`, inspirados en los de Linear.
- **Errores:** GraphQL devuelve errors con `extensions.code` (`NOT_FOUND`, `UNAUTHORIZED`, `VALIDATION_FAILED`).

### Esquema (SDL resumido)

```graphql
type Issue {
  id: ID!
  identifier: String!        # "TEAM-126"
  title: String!
  description: String
  team: Team!
  state: WorkflowState!
  priority: Int!             # 0 none, 1 urgent, 2 high, 3 medium, 4 low
  assignee: Actor
  creator: Actor!
  parent: Issue
  children(first: Int, after: String): IssueConnection!
  project: Project
  labels: [Label!]!
  comments(first: Int, after: String): CommentConnection!
  activity(first: Int, after: String): ActivityConnection!
  url: String!               # deep-link a la UI
  branchName: String!        # "agent/at-126-titulo" (derivado, gratis)
  createdAt: DateTime!
  updatedAt: DateTime!
  archivedAt: DateTime
}

type Actor { id: ID! name: String! type: ActorType! email: String }
enum ActorType { HUMAN AGENT }

type WorkflowState { id: ID! name: String! type: StateType! color: String! position: Float! }
enum StateType { TRIAGE BACKLOG UNSTARTED STARTED COMPLETED CANCELED }

type Team { id: ID! key: String! name: String! states: [WorkflowState!]! labels: [Label!]! }
type Label { id: ID! name: String! color: String! team: Team }
type Project {
  id: ID! name: String! description: String state: ProjectState!
  lead: Actor targetDate: Date issues(filter: IssueFilter, first: Int, after: String): IssueConnection!
}
type Comment { id: ID! body: String! actor: Actor! issue: Issue! createdAt: DateTime! editedAt: DateTime }
type Activity { id: ID! type: String! actor: Actor! payload: JSON! createdAt: DateTime! }

input IssueFilter {
  team: IDComparator; state: IDComparator; stateType: StateTypeComparator
  assignee: IDComparator; creator: IDComparator; priority: IntComparator
  labels: IDArrayComparator; project: IDComparator; parent: IDComparator
  search: String                       # full-text (FTS5)
  and: [IssueFilter!]; or: [IssueFilter!]
}

type Query {
  workspace: Workspace!
  viewer: Actor!                       # actor de la API key
  teams: [Team!]!
  team(id: ID, key: String): Team
  issue(id: ID!): Issue                # UUID o "TEAM-126"
  issues(filter: IssueFilter, first: Int, after: String, orderBy: IssueOrder): IssueConnection!
  projects(filter: ProjectFilter): [Project!]!
  project(id: ID!): Project
  actors(type: ActorType): [Actor!]!
  labels(team: ID): [Label!]!
}

type Mutation {
  issueCreate(input: IssueCreateInput!): IssuePayload!
  issueUpdate(id: ID!, input: IssueUpdateInput!): IssuePayload!   # estado, prioridad, assignee, labels, parent, project, título, descripción
  issueArchive(id: ID!): IssuePayload!
  commentCreate(input: CommentCreateInput!): CommentPayload!
  projectCreate(input: ProjectCreateInput!): ProjectPayload!
  projectUpdate(id: ID!, input: ProjectUpdateInput!): ProjectPayload!
  teamCreate(input: TeamCreateInput!): TeamPayload!
  labelCreate(input: LabelCreateInput!): LabelPayload!
  workflowStateCreate(input: WorkflowStateCreateInput!): WorkflowStatePayload!
  actorCreate(input: ActorCreateInput!): ActorPayload!            # alta de humanos y agentes
  actorUpdate(id: ID!, input: ActorUpdateInput!): ActorPayload!  # renombra sin cambiar su identidad
  apiKeyCreate(input: ApiKeyCreateInput!): ApiKeyPayload!         # devuelve la key una sola vez
  webhookCreate(input: WebhookCreateInput!): WebhookPayload!
  webhookDelete(id: ID!): DeletePayload!
}
```

Los `*Payload` devuelven `{ success: Boolean!, <entidad> }` como en Linear.

## 5. Identidad y auth

- **Bootstrap:** en el primer arranque, el server crea el Workspace, un Team default y el Actor
  `admin` (human). Las variables de entorno de configuración pueden elegir la identidad. El server
  imprime la API key una sola vez.
- El sistema guarda las keys como hashes SHA-256. Sin key, devuelve `UNAUTHORIZED`, excepto para
  la UI servida y GraphiQL en dev cuando están configurables.
- Cada agente se registra como `Actor(type: AGENT)` con un nombre operativo, no con el nombre del
  modelo o LLM, y su propia key. `actorUpdate` permite renombrarlo sin cambiar su identidad. La API
  atribuye Issues, Comments y Activity al agente real.

## 6. Webhooks

- `POST` JSON a cada webhook suscripto, firmado con HMAC-SHA256 del body en el header
  `X-PrimeBoard-Signature` usando el `secret` del webhook.
- **Eventos MVP:** `issue.created`, `issue.updated`, `issue.archived`,
  `comment.created`, `project.created`, `project.updated`.
- **Payload:** `{ event, actor {id,name,type}, data { ...entidad }, changes? { campo: {from,to} }, createdAt }`.
- Entrega asíncrona mediante una cola en memoria, con tres reintentos y backoff.
  El sistema registra los fallos. Las garantías de entrega fuertes quedan fuera del MVP.

## 7. CLI (`pb`)

El CLI es un cliente de la API GraphQL y no toca la DB. Guarda la configuración en `~/.prime-board/cli.json`
(`url`, `apiKey`; override con `PRIME_BOARD_URL` / `PRIME_BOARD_API_KEY`).

```
pb auth login                        # guarda url + api key
pb issue list [--team PRB] [--state started] [--assignee me] [--search "..."] [--json]
pb issue view <issue-id> [--json]        # incluye comentarios y actividad
pb issue create --team PRB --title "..." [--description -] [--priority high] [--label x]
pb issue update <issue-id> --state done [--assignee agent-x] [--priority urgent]
pb issue comment <issue-id> --body "..." # o body por stdin
pb project list | view | create
pb team list
pb webhook create --url http://... --events issue.created,comment.created
```

- `--json` en todos los comandos de lectura produce una salida estable para agentes.
- Exit codes: 0 ok, 1 error de API, 2 error de uso.

## 8. MCP server

El MCP expone tools espejo de la API con los mismos nombres que el MCP de Linear.
Un agente que ya sabe usar Linear puede operar prime-board sin aprender un contrato nuevo.

`list_issues`, `get_issue`, `save_issue`, `list_comments`, `save_comment`,
`list_projects`, `get_project`, `save_project`, `list_teams`, `get_team`,
`list_issue_statuses`, `list_issue_labels`, `list_users`, `get_workspace`.

- Transporte: stdio (`pb-mcp` o `bunx prime-board mcp`), con la URL y API key del server
  local por env/config. Devuelve JSON estructurado.

## 9. UI web

Requisito explícito: **lo más parecida posible a Linear** en look & feel, densidad, velocidad y teclado. Usa dark theme por defecto.

**Pantallas del MVP:**

1. **Shell:** sidebar izquierda (workspace, teams con sus vistas, proyectos), contenido a
   la derecha, sin recargas (SPA).
2. **Lista de issues por team** agrupada por estado, con prioridad, identificador,
   título, labels, assignee (avatar/inicial + badge 🤖 para agentes).
3. **Board** (columnas por estado) con drag & drop para cambiar estado.
4. **Detalle de issue:** panel con edición inline de título/descripción (markdown
   render + edit), propiedades a la derecha (estado, prioridad, assignee, labels,
   proyecto, parent/sub-issues), comentarios e historial abajo.
5. **Creación rápida:** tecla `C` abre modal de nuevo issue.
6. **Command palette (`Cmd+K`):** navegar, crear, cambiar estado/prioridad/assignee.
7. **Vista de proyecto:** header con estado/lead/fecha + lista de issues.
8. **Atajos base:** `C` crear, `Cmd+K` palette, `↑↓/J/K` moverse, `Enter` abrir,
   `Esc` cerrar.

La UI consume exclusivamente `/graphql` con una key de sesión local. En el MVP, el usuario pega la key una vez en Settings y la UI la guarda en `localStorage`.

## 10. Criterios de aceptación del MVP

1. `bun run server` levanta API + UI con DB nueva, workspace sembrado y key de admin
   impresa en consola.
2. Un agente, **solo con su API key y GraphQL**, puede: crear un issue en un team,
   asignárselo, moverlo por estados hasta `Done`, etiquetarlo, comentarlo, crear
   sub-issues y consultarlo todo con filtros (incl. full-text).
3. Todo lo anterior es posible también vía `pb` (CLI) y vía tools MCP.
4. La autoría queda correctamente atribuida (creator/assignee/comentarista/actividad)
   al actor real, humano o agente, en API y UI.
5. Un webhook suscripto a `issue.created` y `comment.created` recibe los eventos
   firmados al ocurrir.
6. En la UI se puede navegar por Teams y Projects, ver la lista y el board, crear un Issue con
   `C`, editarlo inline, cambiar su estado con drag & drop, comentar y operar con `Cmd+K`.
   La UI conserva una estética Linear-like en dark mode.
7. El historial de actividad de un issue reconstruye la secuencia completa de cambios.
8. Reiniciar el proceso no pierde ningún dato (SQLite WAL en disco).

## 11. Fuera de alcance

Consulta la lista de exclusiones en [`alcance-mvp.md` § Exclusiones históricas](../alcance-mvp.md#exclusiones-históricas-del-mvp-con-justificación):
relaciones entre issues, milestones, ciclos, estimaciones, due dates, templates, triage
dedicado, status updates, initiatives, documents, adjuntos, custom views, OAuth/SSO,
multi-tenant, notificaciones en UI, integraciones de terceros, importers, insights.

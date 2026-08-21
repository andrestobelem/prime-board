# Auditoría de paridad de la API GraphQL con Linear

> Ticket: [PRB-396](http://localhost:3333/issue/PRB-396)  
> Fecha: 2026-08-18  
> Alcance: contrato GraphQL público; no implementación de correcciones.

## Método y fuentes

Comparamos la introspección del SDL de `packages/schema/src/sdl.ts` con la introspección pública del endpoint oficial de Linear:

```text
https://api.linear.app/graphql
```

Linear documenta que ese endpoint soporta introspección en [Getting started – GraphQL](https://linear.app/developers/graphql). También consultamos [Issue relations](https://linear.app/docs/issue-relations), [Custom Views](https://linear.app/docs/custom-views), [Inbox](https://linear.app/docs/inbox) y [Documents](https://linear.app/docs/documents).

La comparación distingue la paridad del núcleo de la compatibilidad completa con Linear. La compatibilidad completa incluye integraciones, CRM, releases, AI y otras superficies fuera del MVP.

## Veredicto

Prime Board ofrece un contrato GraphQL coherente para el núcleo de Issues y planificación, pero **no es compatible drop-in con la API GraphQL de Linear**. Los conceptos principales están presentes. Difieren los nombres, los tipos, la paginación, los filtros y la cobertura de operaciones.

### Tamaño del contrato

| Superficie              | Prime Board | Linear | Lectura                                                     |
| ----------------------- | ----------: | -----: | ----------------------------------------------------------- |
| Campos de `Query`       |          24 |    166 | Linear incluye muchas superficies fuera del MVP.            |
| Campos de `Mutation`    |          54 |    373 | Prime Board cubre CRUD y operaciones del núcleo.            |
| Campos del tipo Issue   |          24 |     86 | Prime Board conserva el núcleo y omite recursos avanzados.  |
| Campos del tipo Project |          13 |     80 | Faltan miembros, recursos, relaciones y métricas avanzadas. |
| Campos de `PageInfo`    |           2 |      4 | Falta paginación Relay bidireccional completa.              |

Los conteos no son una métrica de calidad. Linear expone funcionalidades que Prime Board todavía no intenta replicar.

## Correspondencias del núcleo

| Prime Board     | Linear             | Observación                                                                                              |
| --------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `Workspace`     | `Organization`     | Mismo contexto raíz; nombre y campos distintos.                                                          |
| `Actor`         | `User`             | Prime Board añade `ActorType.AGENT`; Linear distingue app/guest/active y más roles.                      |
| `Team`          | `Team`             | Correspondencia directa, pero Linear tiene settings, jerarquía y conexiones más ricas.                   |
| `WorkflowState` | `WorkflowState`    | Prime Board usa enum `StateType`; Linear publica `type: String` y más relaciones.                        |
| `Issue`         | `Issue`            | Correspondencia principal, con muchos metadatos y recursos omitidos localmente.                          |
| `Project`       | `Project`          | Estado, lead, teams, milestones, issues y updates; Linear añade members, labels, relaciones y resources. |
| `Milestone`     | `ProjectMilestone` | Mismo concepto, distinto nombre y campos de fecha/estado.                                                |
| `Cycle`         | `Cycle`            | Correspondencia directa; Linear expone más métricas y documentos.                                        |
| `Initiative`    | `Initiative`       | Correspondencia parcial; Linear añade jerarquía, labels, updates y relaciones.                           |
| `SavedView`     | `CustomView`       | Modelo de filtros común, contrato incompatible y capacidades distintas.                                  |
| `InboxItem`     | `Notification`     | Mismo flujo de atención, entidad y operaciones distintas.                                                |
| `Label`         | `IssueLabel`       | Prime Board simplifica labels a nombre/color/scope.                                                      |

## Hallazgos de contrato

### 1. Conexiones y paginación

Linear usa conexiones Relay con:

```graphql
type PageInfo {
  hasPreviousPage: Boolean!
  hasNextPage: Boolean!
  startCursor: String
  endCursor: String
}
```

Las conexiones también exponen `edges` además de `nodes`. Prime Board solo expone `nodes`, `hasNextPage` y `endCursor`.

Diferencias verificadas:

- `Query.issues`: Prime Board acepta `filter`, `first`, `after`, `orderBy`; Linear agrega `before`, `last`, `includeArchived` y `sort`.
- `Query.projects` y `Query.teams`: Prime Board devuelve listas con filtros simples; Linear usa conexiones, filtros, cursor bidireccional y orden.
- `Project.issues` y `Milestone.issues`: Prime Board acepta `first/after`; Linear agrega `before/last/orderBy`.
- `Issue.children`: Prime Board solo añade `includeArchived`; Linear ofrece filtro, cursor bidireccional y orden.
- Varias colecciones locales (`teams`, `actors`, `labels`, `projects`, `cycles`, `reviews`, `initiatives`, comments y relations) son listas no paginables.

**Clasificación:** gap de compatibilidad de API. La paginación forward local cubre el MVP, pero los clientes Relay de Linear necesitan un adapter.

### 2. Issue, filtros y orden

Prime Board cubre title, description, state, priority, assignee, creator, project, milestone, cycle, parent, labels, full-text, archived y frontier (`unblocked`).

Linear también expone filtros por:

- `number`, fechas de creación/actualización/transición y `dueDate`.
- estimate, subscribers, delegate, attachments, reactions y releases.
- SLA, activity/comments, sugerencias, clientes y métricas de lead/cycle time.
- existencia y dirección de relaciones.

Prime Board tiene cuatro órdenes (`CREATED_ASC`, `CREATED_DESC`, `UPDATED_ASC`, `UPDATED_DESC`). Linear ofrece `IssueSortInput` para prioridad, estimate, título, labels, SLA, estado, cycle, milestone, assignee, project, team y orden manual, entre otros.

### 3. Campos e inputs de Issue

Faltan en el tipo local `Issue` o en sus inputs:

- `number` separado del `identifier`.
- `estimate`, `dueDate` y timestamps `startedAt`, `completedAt`, `canceledAt`.
- `subscribers`, `delegate`, `attachments`, `documents`, `history`, `reactions`, `releases` e `inverseRelations`.
- `IssueUpdateInput.teamId` para mover el issue entre teams.
- Mutaciones específicas para subscribe/unsubscribe, unarchive/delete y operaciones batch.

### 4. Project y fechas

Linear publica `ProjectStatus` como objeto y campos para icon/color, prioridad, start date, target date, miembros, labels, documentos, attachments, relaciones/dependencias, iniciativas y conexiones de updates/milestones/issues.

Prime Board publica un enum `ProjectState`, lead, target date, teams, milestones, issues y updates. No publica miembros, labels, dependencias, documents ni attachments.

Además, Linear usa `TimelessDate` para fechas sin hora (`targetDate`, `dueDate`). Prime Board usa `DateTime` para `targetDate` de Project, Milestone e Initiative. Los clientes observan esta diferencia semántica.

### 5. Team, User y WorkflowState

Linear expone `organization`, team hierarchy (`parent`, `children`), privacidad, icon/color, configuración de cycles, estimaciones, triage, members como conexión y herencia de estados. Prime Board expone el núcleo: key, name, description, states, default state, labels, projects, cycles y memberships.

El local `Actor` solo ofrece nombre/email/type/workspace role/api keys. Linear `User` incluye perfiles, guest/app/active, admin/owner, teams, memberships, asignaciones, preferencias e identidad.

`WorkflowState` local tiene id, name, enum type, color y position. Linear añade team, issues, inheritedFrom, description y archivado.

### 6. Relaciones, labels y views

- `IssueRelationType` local expone `BLOCKS`, `BLOCKED_BY`, `RELATED`, `DUPLICATE_OF` y `DUPLICATED_BY`. Linear expone relaciones canónicas `blocks`, `duplicate`, `related` y `similar`, con `inverseRelations` separadas.
- Prime Board no tiene el tipo Linear `similar`.
- `SavedView` local tiene scope, owner, filtro JSON, order/group/columns. Linear `CustomView` tiene `filterData` tipado, views de issue/project/initiative/feed, sharing, slug, preferencias y relaciones a recursos.
- `Label` local tiene nombre, color y team scope. Linear `IssueLabel` añade descripción, grupos, jerarquía, creator, retired state e issues.

### 7. Operaciones ausentes

Además del CRUD del núcleo, Linear expone operaciones que no tienen equivalente local:

- Documents, attachments, file uploads y external links.
- Notifications, subscriptions, snooze y acciones batch de Inbox.
- Reacciones y comentarios update/delete/resolve/threading.
- Issue unarchive/delete/subscribe, issue batch create/update y relation update.
- Project members, project labels, project relations/dependencies y milestone move.
- Releases/release notes, audit entries, integraciones y recursos externos.

`Review` (`reviewCreate`, `reviewUpdate`, `reviewDelete`) es una divergencia propia de Prime Board, no un gap que deba forzarse a encajar con Linear.

### 8. Errores

Hay paridad en el formato base: ambos usan la respuesta GraphQL estándar con `errors[]`, `message`, `path` y `extensions`, y pueden devolver `data` parcial con HTTP 200.

Prime Board define explícitamente tres códigos de dominio:

- `UNAUTHORIZED`
- `NOT_FOUND`
- `VALIDATION_FAILED`

La documentación de Linear indica que `extensions` puede contener códigos y detalles de validación, sin limitar el vocabulario a esos tres códigos. El formato es compatible, pero el contrato de códigos de Prime Board es más pequeño.

## Prioridad sugerida

1. Completar conexiones Relay y paginación de las colecciones públicas.
2. Añadir metadatos y filtros de Issue que impactan búsqueda y planificación (`number`, estimate, due date, transición y subscribers).
3. Completar Project con members, labels y relaciones/dependencias.
4. Definir recursos vinculables (documents, attachments y notifications).
5. Evaluar operaciones avanzadas solo según el alcance agent-first.

Esta auditoría no implementó correcciones ni creó tickets. Prioriza los gaps antes de convertirlos en trabajo.

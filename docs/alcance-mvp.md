# Alcance del MVP de prime-board

> La especificación técnica histórica del MVP vive en [`specs/mvp.md`](specs/mvp.md). El contrato
> operativo de Projects e Initiatives vive en [`specs/project-initiative-settings.md`](specs/project-initiative-settings.md).
> Las dos referencias históricas no sustituyen el estado vigente que aparece más abajo.

## Decisiones históricas del MVP

El dueño del proyecto confirmó estas decisiones para el MVP original. Esta sección conserva el
registro histórico y no sustituye el estado vigente que aparece más abajo.

| Decisión      | Elección                                 | Motivo                                                                                                                                      |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack         | **Bun + TypeScript + SQLite**            | Bun incluye SQLite (`bun:sqlite`) y sirve la API y la UI desde un solo proceso. SQLite persiste en un archivo único con transacciones ACID. |
| API           | **GraphQL**                              | Mantiene la paridad conceptual con Linear, cuya API pública es GraphQL, y ofrece queries flexibles para los agentes.                        |
| Modelo de uso | **Local-first, single-tenant**           | Un proceso local con un Workspace, igual que prime-agent. La autenticación usa API keys.                                                    |
| UI            | **Sí, lo más parecida posible a Linear** | Requisito explícito: la UI es parte de la identidad del clon (dark-first, densa, keyboard-first y con command palette).                     |

> **Decisión histórica de persistencia (2026-08-14):** el equipo evaluó PostgreSQL y ratificó
> SQLite puro para el MVP. El motivo fue conservar el modelo local-first, single-tenant, de
> proceso único y cero configuración. Esta decisión no describe el backend opcional que el
> estado vigente habilita durante la migración incremental.

## Estado vigente (verificado el 2026-09-06)

La implementación actual ya superó la lista cerrada del MVP. Esta sección es la referencia para
el estado operativo, las auditorías y la planificación. Las exclusiones históricas no son un
inventario de faltantes actuales.

| Capacidad actualmente implementada                  | GraphQL | CLI (`pb`) | MCP | UI web    |
| --------------------------------------------------- | ------- | ---------- | --- | --------- |
| Issues, comentarios, relaciones y sub-issues        | Sí      | Sí         | Sí  | Sí        |
| Teams, actores, memberships y API keys              | Sí      | Sí         | Sí  | Sí        |
| Workflow states y labels                            | Sí      | Sí         | Sí  | Sí        |
| Projects, milestones y Project Updates              | Sí      | Sí         | Sí  | Parcial   |
| Project settings: startDate, members y dependencies | Sí      | Sí         | Sí  | Parcial   |
| Cycles y carry-over                                 | Sí      | Sí         | Sí  | Parcial   |
| Filtros, búsqueda y vistas guardadas                | Sí      | Sí         | Sí  | Parcial   |
| Inbox, favoritos y seguimiento del Actor            | Sí      | Sí         | Sí  | Sí        |
| Initiatives: priority, labels, resources y Projects | Sí      | Sí         | Sí  | Parcial   |
| Initiative Status Updates                           | Sí      | No         | No  | No        |
| Documents Markdown (retirado)                       | No      | No         | No  | No        |
| Webhooks y actividad/auditoría                      | Sí      | Sí         | Sí  | No aplica |

`Sí` en una fila de planificación indica que el SDL y algún path de cliente están definidos en la
entrega de PRB-391; no afirma paridad de backend ni de ACL. `Parcial` indica que la UI no expone
todos los campos. CLI y MCP no tienen una operación dedicada para `InitiativeStatusUpdate`; GraphQL
sí la expone. PRB-610, PRB-612 y PRB-613 siguen el trabajo de integración de esas superficies y no
cambian el contrato de datos descrito aquí.

### Persistencia vigente: SQLite y PostgreSQL

Los backends no tienen el mismo alcance. SQLite sigue siendo el backend predeterminado y la fuente
operativa local. PostgreSQL es opcional y su migración todavía es incremental.

| Backend        | Migraciones y estado                                                                                                                                                                    | Diferencias comprobadas                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SQLite**     | `bun:sqlite`, archivo definido por `PRIME_BOARD_DB`, migraciones `0001`–`0031`. `0030` retira Documents y `0031` agrega la configuración de Projects e Initiatives.                     | Es el camino operativo local. `0031` agrega `start_date`, `priority`, `lead_team_id`, `resources_json`, members, dependencies, labels y Initiative Status Updates. Sus triggers conservan el autofill legacy en una DB singleton y rechazan un contexto ambiguo. |
| **PostgreSQL** | Se activa con `PRIME_BOARD_PERSISTENCE=postgres` y requiere `PRIME_BOARD_POSTGRES_URL`; usa migraciones independientes `0001`–`0012`. `0011` retira Documents y `0012` agrega planning. | Mantiene una única Workspace y cobertura incremental. `0012` agrega las mismas relaciones sin `workspace_id`; el backend usa el Workspace singleton. La paridad de ACL de dependencies y la revalidación de Team limits siguen en PRB-609 y PRB-618.             |

La numeración `0031` y `0012` pertenece al contrato de planificación de PRB-391. No se debe
renumerar la migración SQLite para compartir el espacio de PostgreSQL. No se debe presentar
PostgreSQL como un reemplazo con paridad de persistencia. Un campo del SDL tampoco garantiza que
cada backend o cliente lo soporte.

### Contrato vigente de Projects e Initiatives

La lista siguiente contiene solo campos y relaciones que el contrato de planificación soporta.
La especificación canónica describe las entradas, los adaptadores y las reglas de autorización.

#### Project

- Propiedades: `name`, `description`, `state`, `lead`, `startDate`, `targetDate`, `createdAt`,
  `updatedAt` y `archivedAt`.
- Relaciones de alcance: `teams` es many-to-many y `members` contiene Actors asociados de forma
  directa. `lead` es un dato de planificación y no concede permisos.
- Relaciones de trabajo: `milestones`, `issues` y `updates`. Milestones y Project Updates heredan
  el alcance del Project. Un Issue solo se asocia a un Project cuando su Team pertenece al Project.
- Dependencies: `dependencies` relaciona el Project origen con `dependsOnProject` y admite `blocks`
  o `related`. `dependencyIds` en create/update reemplaza el conjunto y usa `blocks`; la mutación
  `projectDependencyCreate` permite elegir el tipo.

El Project no tiene `owner`, labels propias, resources ni configuración de templates o canales de
notificación en este contrato. Esas propiedades no se deben inferir de la paridad con Linear.

#### Initiative

- Propiedades: `name`, `description`, `state`, `priority` de 0 a 4, `targetDate`, `resources`,
  `createdAt`, `updatedAt` y `archivedAt`.
- Relaciones de alcance: `owner`, `leadTeam`, `teams` y `projects`. `teams` y los Teams de los
  Projects asociados determinan el alcance efectivo.
- Organización: `labels` admite Labels de Workspace o de Team.
- Seguimiento: `updates` contiene `InitiativeStatusUpdate`; `progress`, `completedIssues` y
  `totalIssues` se calculan con las Issues de los Projects asociados. Las Issues no se asocian
  directamente a una Initiative. Las Issues `completed` y `canceled` cuentan como completadas; las
  archivadas no cuentan.

Una Initiative sin Teams ni Projects es workspace-scoped. La lectura de una Initiative con
relaciones valida el Workspace, los Teams y los Projects asociados. Si existe owner, solo ese owner
puede mutarla o borrarla, incluso si el viewer es admin; una fila migrada sin owner conserva la regla
de viewer autorizado. No tiene jerarquía de Initiatives, dependencies propias ni Documents locales.

#### Updates

`ProjectStatusUpdate` conserva `health`, `body`, `risks`, `author`, `createdAt` y `updatedAt`.
`InitiativeStatusUpdate` conserva `health`, `body`, `author`, `createdAt` y `updatedAt`. Un update
narrativo no cambia `Project.state` ni `Initiative.state`.

### Autorización y ownership

- PRB-391 es dueño de los campos, relaciones, ACL y export/rebuild de Projects e Initiatives.
- Un admin del Workspace puede administrar los recursos que estén dentro del Workspace. Un miembro
  directo de Project puede leer y administrar su configuración. Sin ese vínculo, la lectura de un
  Project exige acceso a sus Teams asociados.
- Las mutaciones de `teamIds` validan la política de escritura de todos los Teams destino. Las
  dependencies validan origen, destino, tipo, self-dependency y alcance de Workspace.
- Las mutaciones de Initiative validan todos los Projects y Teams asociados. Si existe `owner`, el
  owner controla los cambios. Una ACL de miembro de Project no se convierte en ACL de Initiative.
- Milestones, Project Updates e Issues asociados heredan el acceso del Project o de su Team. Las
  consultas no deben revelar recursos ajenos: usan `NOT_FOUND` cuando corresponde.
- Una API key con límite de Teams debe cubrir todos los Teams implicados. El límite no agrega
  permisos. PostgreSQL todavía necesita completar la ACL de create de dependencies en PRB-609 y
  cerrar la carrera de Team limits en PRB-618.

La implementación actual aplica la ACL directa de `Project` cuando existe; sin esa relación,
valida cada Team asociado. Initiative valida cada Project y Team de su alcance. Esta regla no
sustituye la decisión pendiente sobre las frases antiguas de "al menos un Team" en ADR-0007 y
ADR-0012. Esas frases no deben usarse para omitir los checks del contrato vigente.

### Export y rebuild

El export de planificación conserva los datos soportados:

- `meta/projects.json` conserva `name`, `description`, `state`, `lead`, `startDate`, `targetDate`,
  `members`, dependencies con destino y tipo, `teams`, milestones y `archived`.
- `meta/project-updates.json` conserva Project, Actor autor, `health`, `body`, `risks` y fechas.
- `meta/initiatives.json` conserva `name`, `description`, `state`, `priority`, `targetDate`,
  `leadTeam`, `resources`, `owner`, `labels`, `projects`, `teams`, updates y `archived`.

Un export parcial por Team falla cerrado si una dependency, un Project de Initiative, un Team
asociado a Initiative, `leadTeam` o una Label de Initiative queda fuera del alcance. La relación
`Project.teams` se proyecta al Team seleccionado en un export parcial. El rebuild exige
`--allow-partial` para reemplazar el índice y valida metadata, Workspace, alcance parcial y nombres
ambiguos antes de la transacción destructiva. Las referencias restantes se validan dentro de la
transacción; cualquier error revierte la operación y no deja estado parcial.

El rebuild genera IDs nuevos para memberships, dependencies, relaciones y updates. No exporta
hashes ni secretos de API keys y Webhooks. Tampoco inventa campos para Templates, preferencias de
notificación o Views. Saved Views siguen siendo una capacidad separada y se exportan en
`meta/saved-views.json`.

### Ownership de configuraciones relacionadas

| Configuración                             | Ticket dueño                                   | Regla                                                            |
| ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| Templates de Issues y Projects            | [PRB-385](http://localhost:3333/issue/PRB-385) | PRB-391 los consume, pero no crea modelos duplicados.            |
| Categorías y preferencias de notificación | [PRB-386](http://localhost:3333/issue/PRB-386) | Webhooks pertenecen a integraciones y no son un canal personal.  |
| Views, display options y suscripciones    | [PRB-390](http://localhost:3333/issue/PRB-390) | PRB-391 no agrega Initiative Views ni configuración de Views.    |
| Projects e Initiatives                    | [PRB-391](http://localhost:3333/issue/PRB-391) | Incluye campos, relaciones, ACL y export/rebuild descritos aquí. |

### Documents retirados

`Document` es una capacidad histórica. Ya no forma parte del SDL GraphQL, del CLI `pb`, del MCP,
de la UI ni de la Repository Replica. Las descripciones Markdown de las Issues siguen siendo
operativas y no reciben contenido de Documents. Los datos existentes se archivan fuera del
repositorio mediante `archive:documents`, con un manifest y checksums verificables, antes de la
migración `0030` de SQLite o `0011` de PostgreSQL. Un rebuild con `meta/documents.json` antiguo
falla cerrado si no recibe un archivo externo explícito. Los artefactos `documents` de una captura
externa de Linear se conservan como enlaces Markdown con título; no crean entidades locales.

### Inventario de operaciones por cliente

Este inventario verifica las mutaciones administrativas, la planificación y el archivo de Issues.

| Dominio                   | CLI `pb`                                   | MCP                                                                       |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Issues                    | `issue archive`                            | `archive_issue`                                                           |
| Teams                     | `team create/update`                       | `save_team`                                                               |
| Memberships               | `team membership-list/create/delete`       | `list_team_memberships`, `save_team_membership`, `delete_team_membership` |
| Actores                   | `actor list/create/update`                 | `list_users`, `save_user`                                                 |
| API keys                  | `api-key create/delete`                    | `save_api_key`, `delete_api_key`                                          |
| Workflow states           | `team workflow-state-create/update/delete` | `save_issue_status`, `delete_issue_status`                                |
| Labels                    | `team label-create/update/delete`          | `save_issue_label`, `delete_issue_label`                                  |
| Projects                  | `project create/update/archive/unarchive`  | `save_project`, `archive_project`, `unarchive_project`                    |
| Project Updates           | `project update-create/update-delete`      | `save_project_update`, `delete_project_update`                            |
| Initiatives               | `initiative create/update/delete`          | `save_initiative`, `delete_initiative`                                    |
| Initiative Status Updates | No operation                               | No operation                                                              |

Las operaciones privilegiadas conservan la autorización del server GraphQL. CLI y MCP no intentan
replicarla localmente. La tabla no declara soporte de UI para campos que la UI no solicita.

## Lista cerrada del MVP histórico

Regla heredada de Linear: **paridad total de API**. Todo lo que aparece en esta lista era accesible por GraphQL en la especificación original. La UI, CLI y MCP eran clientes de esa API. Esta lista no es el contrato vigente.

### Núcleo del board

1. **Workspace único** — contenedor de configuración global. _Multi-workspace no aporta en single-tenant._
2. **Teams** — nombre y clave corta (`AT`); son dueños de Workflow States, Labels propios y numeración de Issues.
3. **Actores: humanos y agentes** — miembros del Workspace con `type: human | agent`. Los agentes son Actors de primera clase: crean, comentan y reciben asignaciones. _Es la razón de ser del producto._
4. **Issues** — CRUD con título y descripción Markdown, Identifier legible (`TEAM-126`), estado, Priority (escala fija de Linear), Labels, un Assignee y Sub-issues (Parent/child). _Es el núcleo del clon._
5. **Workflow States por Team** — personalizables y con **State Type** obligatorio (`triage | backlog | unstarted | started | completed | canceled`). _La semántica portable permite que un agente opere cualquier Team sin configuración específica._
6. **Labels** — de Workspace y de Team. _Metadatos simples para dirigir trabajo a Agents._
7. **Comments** — Markdown en Issues. _Son el canal principal entre personas y agentes._
8. **Activity** — historial por Issue de quién cambió qué y cuándo. _Ofrece contexto reconstruible y auditoría de Agents._
9. **Projects** — nombre, descripción, estado, lead, fecha objetivo e Issues asociadas. _Es la unidad natural para encargar un objetivo grande a un agente._
10. **Filtros y búsqueda** — filtros combinables por cualquier propiedad y full-text con SQLite FTS5. _La consulta programática es el caso de uso principal de los agentes._

### Capa de integración (constitutiva, no opcional)

11. **API GraphQL con paridad total** — servida por el mismo proceso Bun.
12. **API keys por Actor** — header `Authorization`; cada key identifica a una persona o agente. _Es suficiente en local-first; OAuth queda para una versión hosteada._
13. **Webhooks** — POST a URLs registradas ante eventos (Issue creada/actualizada, Comment, etc.). _Funcionan como Inbox de Agents: informan que recibieron una asignación._
14. **CLI (`pb`)** — cliente de la API GraphQL para el flujo completo. _Es la interfaz más simple para un agente. Linear no ofrece una equivalente._
15. **MCP server** — tools espejo de la API (crear, listar y actualizar Issues, comentar, etc.). _Es la interfaz nativa de los agentes._

### UI web

16. **UI Linear-like** — replica el look & feel de Linear: tema oscuro por defecto, alta densidad, navegación por teclado, sidebar con Teams/Projects, **vista de lista agrupada por estado**, **vista board**, **detalle de Issue** con edición inline y Comments, **creación rápida** (`C`) y **command palette** (`Cmd+K`).

## Exclusiones históricas del MVP (con justificación)

La tabla describe las funcionalidades excluidas del MVP original. No debe leerse como un inventario de faltantes actuales. Para conocer el estado vigente, consulta la matriz anterior y los tickets `PRB-*`.

| Funcionalidad                                      | Por qué queda afuera                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Relaciones entre issues (blocks/related/duplicate) | Sub-issues cubren la descomposición, que es el caso agente principal; las dependencias llegan en Parte 5.                |
| Milestones                                         | Estructura secundaria dentro de Projects; el MVP planifica con Projects y Labels.                                        |
| Ciclos (sprints)                                   | Cadencia pensada para capacidad humana; es menos central para agentes 24/7.                                              |
| Estimaciones, due dates editables                  | Metadatos de planificación fina; no bloquean el flujo core.                                                              |
| Templates, issues recurrentes                      | Los Agents generan estructura por sí mismos; un cron o heartbeat externo cubre la recurrencia.                           |
| Triage como bandeja dedicada                       | Un Workflow State de tipo `triage` simula la bandeja (el modelo ya lo soporta).                                          |
| Status updates de Project                          | Los Comments de Project cubren esta necesidad en una parte posterior.                                                    |
| Initiatives, roadmap/timeline, insights            | Capa de management y visualización; no aporta valor API-first inmediato.                                                 |
| Documents, adjuntos, reacciones                    | No formaban parte del MVP original. Documents locales se retiraron; adjuntos ricos y colaboración avanzada siguen fuera. |
| Custom Views persistidas                           | Los clientes (Agents) guardan sus propias queries; la UI del MVP ofrece vistas fijas.                                    |
| Notificaciones/Inbox en UI                         | Los Webhooks son el mecanismo correcto para Agents; el Inbox humano llega con la UI madura.                              |
| OAuth, SSO/SCIM, multi-tenant                      | No son necesarios en local-first single-tenant.                                                                          |
| Integraciones de terceros, importers               | Webhooks y API bastan para integrar otros sistemas; las migraciones no aplican sin usuarios.                             |
| SLAs, asks, customer requests, releases/diffs      | Pertenecen a Enterprise u otro producto; quedan fuera de la misión.                                                      |

## Plan histórico de implementación

El MVP original se implementaba en tres partes (hitos en Linear):

- **Parte 2 — Núcleo del backend:** SQLite + GraphQL + auth + webhooks.
- **Parte 3 — Interfaces para agentes:** CLI + MCP.
- **Parte 4 — UI web:** shell Linear-like, lista/board, detalle y command palette.

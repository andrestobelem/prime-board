# Alcance del MVP de prime-board

> La especificación técnica histórica del MVP vive en [`specs/mvp.md`](specs/mvp.md). No es el
> contrato actual; el estado vigente se resume en este documento y en el SDL de GraphQL.

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

## Estado vigente (verificado el 2026-08-23)

La implementación actual ya superó la lista cerrada del MVP. Esta sección es la referencia para
el estado operativo, las auditorías y la planificación. Las exclusiones históricas no son un
inventario de faltantes actuales.

| Capacidad actualmente implementada           | GraphQL | CLI (`pb`) | MCP |    UI web |
| -------------------------------------------- | ------: | ---------: | --: | --------: |
| Issues, comentarios, relaciones y sub-issues |      Sí |         Sí |  Sí |        Sí |
| Teams, actores, memberships y API keys       |      Sí |         Sí |  Sí |        Sí |
| Workflow states y labels                     |      Sí |         Sí |  Sí |        Sí |
| Proyectos, milestones y project updates      |      Sí |         Sí |  Sí |   Parcial |
| Ciclos y carry-over                          |      Sí |         Sí |  Sí |   Parcial |
| Filtros, búsqueda y vistas guardadas         |      Sí |         Sí |  Sí |   Parcial |
| Inbox, favoritos y seguimiento del actor     |      Sí |         Sí |  Sí |        Sí |
| Initiatives y status updates                 |      Sí |         Sí |  Sí |   Parcial |
| Documents Markdown (retirado)                |      No |         No |  No |        No |
| Webhooks y actividad/auditoría               |      Sí |         Sí |  Sí | No aplica |

Las celdas `Parcial` indican gaps de experiencia de usuario. No indican ausencia del modelo o de la API. Tickets `PRB-*` independientes siguen esos gaps. Documents es una capacidad retirada: no forma parte del SDL, de los clientes ni de la réplica vigente. Los datos existentes se archivan fuera del repositorio con un manifest verificable. El soporte de varios Workspaces también es incremental en SQLite y no tiene paridad en PostgreSQL.

### Persistencia vigente: SQLite y PostgreSQL

Los backends no tienen el mismo alcance. SQLite sigue siendo el backend predeterminado y la fuente
operativa local. PostgreSQL es opcional y su migración todavía es incremental.

| Backend        | Estado verificado                                                                                                                                                                                                                                     | Diferencias comprobadas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SQLite**     | `bun:sqlite`, archivo definido por `PRIME_BOARD_DB`, migraciones `0001`–`0030`.                                                                                                                                                                       | Es el camino operativo completo. La migración `0030` retira Documents después de validar el archivo externo; el esquema vigente conserva FTS5 y el soporte de Workspace Context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **PostgreSQL** | Se activa con `PRIME_BOARD_PERSISTENCE=postgres` y requiere `PRIME_BOARD_POSTGRES_URL`; usa migraciones independientes `0001`–`0011` y `0016` (las versiones intermedias quedan reservadas). `0010` agrega la tabla `projector_checkpoints`, `0011` retira Documents después de validar el archivo externo y `0016` registra receipts por evento del projector. | Mantiene una única Workspace y tiene cobertura incremental. Los paths directos cubren Actors, autenticación, API keys y límites de Team, Teams, Issues, Relations, Projects, Milestones, Cycles, Labels, Activity, suscriptores, Reviews, Initiatives, Project Updates, Saved Views, Favorites, Inbox y Webhooks. Relations está implementado por PRB-437; API keys y límites de Team usan `0008` y `0009` por PRB-552. `workspaceCreate` sigue sin migrar. Comments no tiene persistencia PostgreSQL y el event log canónico con su proyector Repository Source → PostgreSQL sigue pendiente según ADR-0019 y PRB-445/453. El SQLite efímero solo sirve como compatibilidad para dominios sin path PG. |

No se debe presentar PostgreSQL como un reemplazo con paridad de persistencia. La diferencia es de
capacidad implementada, no solo de configuración: el contrato GraphQL puede existir en ambos
caminos, pero una operación puede no estar migrada en PostgreSQL.

### Documents retirados

`Document` es una capacidad histórica. Ya no forma parte del SDL GraphQL, del CLI `pb`, del MCP,
de la UI ni de la Repository Replica. Las descripciones Markdown de las Issues siguen siendo
operativas y no reciben contenido de Documents. Los datos existentes se archivan fuera del
repositorio mediante `archive:documents`, con un manifest y checksums verificables, antes de la
migración `0030` de SQLite o `0011` de PostgreSQL. Un rebuild con `meta/documents.json` antiguo
falla cerrado si no recibe un archivo externo explícito. Los artefactos `documents` de una captura
externa de Linear se conservan como enlaces Markdown con título; no crean entidades locales.

### Inventario de operaciones por cliente

Este inventario estable verifica la paridad de las mutaciones administrativas y el archivo de Issues:

| Dominio         | CLI `pb`                                   | MCP                                                                       |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Issues          | `issue archive`                            | `archive_issue`                                                           |
| Teams           | `team create/update`                       | `save_team`                                                               |
| Memberships     | `team membership-list/create/delete`       | `list_team_memberships`, `save_team_membership`, `delete_team_membership` |
| Actores         | `actor list/create/update`                 | `list_users`, `save_user`                                                 |
| API keys        | `api-key create/delete`                    | `save_api_key`, `delete_api_key`                                          |
| Workflow states | `team workflow-state-create/update/delete` | `save_issue_status`, `delete_issue_status`                                |
| Labels          | `team label-create/update/delete`          | `save_issue_label`, `delete_issue_label`                                  |

Las operaciones privilegiadas conservan la autorización del server GraphQL. CLI y MCP no intentan replicarla localmente. Los contratos e2e de ambos clientes verifican el inventario, las respuestas JSON y los errores GraphQL.

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

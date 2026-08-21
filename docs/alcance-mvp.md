# Alcance del MVP de prime-board

> La especificación técnica del MVP vive en [`specs/mvp.md`](specs/mvp.md).

## Decisiones estructurales

El dueño del proyecto confirmó estas decisiones:

| Decisión      | Elección                                 | Motivo                                                                                                                                      |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack         | **Bun + TypeScript + SQLite**            | Bun incluye SQLite (`bun:sqlite`) y sirve la API y la UI desde un solo proceso. SQLite persiste en un archivo único con transacciones ACID. |
| API           | **GraphQL**                              | Mantiene la paridad conceptual con Linear, cuya API pública es GraphQL, y ofrece queries flexibles para los agentes.                        |
| Modelo de uso | **Local-first, single-tenant**           | Un proceso local con un Workspace, igual que prime-agent. La autenticación usa API keys.                                                    |
| UI            | **Sí, lo más parecida posible a Linear** | Requisito explícito: la UI es parte de la identidad del clon (dark-first, densa, keyboard-first y con command palette).                     |

## Alcance vigente (2026-08-17)

Este documento conserva la decisión histórica del MVP, pero la implementación ya superó esa lista cerrada. La siguiente matriz sirve como referencia para auditorías y planificación. Si existe una diferencia, el código y esta sección prevalecen sobre las exclusiones históricas.

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
| Webhooks y actividad/auditoría               |      Sí |         Sí |  Sí | No aplica |

Las celdas `Parcial` indican gaps de experiencia de usuario. No indican ausencia del modelo o de la API. Tickets `PRB-*` independientes siguen esos gaps. La matriz no implica soporte multi-workspace: prime-board continúa siendo single-workspace y local-first.

### Inventario de operaciones por cliente

Este inventario estable verifica la paridad de las mutaciones administrativas y del archivo de Issues:

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

> **Decisión revisada (2026-08-14):** el equipo evaluó PostgreSQL y **ratificó SQLite puro**.
> Motivo: con local-first single-tenant el proceso Bun es el único escritor, por lo que la limitación de concurrencia de SQLite no aplica. El volumen esperado es trivial y PostgreSQL rompería la premisa de cero configuración. La decisión se reabre solo si la visión cambia a un servicio alojado o multi-tenant, si se ejecutan varias instancias del server o si aparecen escritores externos directos a la DB.

## Lista cerrada del MVP

Regla heredada de Linear: **paridad total de API**. Todo lo que aparece en esta lista es accesible por GraphQL. La UI, CLI y MCP son clientes de esa API.

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

| Funcionalidad                                      | Por qué queda afuera                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Relaciones entre issues (blocks/related/duplicate) | Sub-issues cubren la descomposición, que es el caso agente principal; las dependencias llegan en Parte 5. |
| Milestones                                         | Estructura secundaria dentro de Projects; el MVP planifica con Projects y Labels.                         |
| Ciclos (sprints)                                   | Cadencia pensada para capacidad humana; es menos central para agentes 24/7.                               |
| Estimaciones, due dates editables                  | Metadatos de planificación fina; no bloquean el flujo core.                                               |
| Templates, issues recurrentes                      | Los Agents generan estructura por sí mismos; un cron o heartbeat externo cubre la recurrencia.            |
| Triage como bandeja dedicada                       | Un Workflow State de tipo `triage` simula la bandeja (el modelo ya lo soporta).                           |
| Status updates de Project                          | Los Comments de Project cubren esta necesidad en una parte posterior.                                     |
| Initiatives, roadmap/timeline, insights            | Capa de management y visualización; no aporta valor API-first inmediato.                                  |
| Documents, adjuntos, reacciones                    | Quedan fuera del núcleo de Issue tracking; Markdown con links cubre lo esencial.                          |
| Custom Views persistidas                           | Los clientes (Agents) guardan sus propias queries; la UI del MVP ofrece vistas fijas.                     |
| Notificaciones/Inbox en UI                         | Los Webhooks son el mecanismo correcto para Agents; el Inbox humano llega con la UI madura.               |
| OAuth, SSO/SCIM, multi-tenant                      | No son necesarios en local-first single-tenant.                                                           |
| Integraciones de terceros, importers               | Webhooks y API bastan para integrar otros sistemas; las migraciones no aplican sin usuarios.              |
| SLAs, asks, customer requests, releases/diffs      | Pertenecen a Enterprise u otro producto; quedan fuera de la misión.                                       |

## Consecuencia para el plan

El MVP se implementa en tres partes (hitos en Linear):

- **Parte 2 — Núcleo del backend:** SQLite + GraphQL + auth + webhooks.
- **Parte 3 — Interfaces para agentes:** CLI + MCP.
- **Parte 4 — UI web:** shell Linear-like, lista/board, detalle y command palette.

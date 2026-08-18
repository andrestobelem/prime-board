# Alcance del MVP de prime-board

> La especificación técnica del MVP vive en [`specs/mvp.md`](specs/mvp.md).

## Decisiones estructurales

Confirmadas con el dueño del proyecto:

| Decisión      | Elección                                 | Motivo                                                                                                                                               |
| ------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack         | **Bun + TypeScript + SQLite**            | Bun trae SQLite integrado (`bun:sqlite`) y sirve API + UI desde un solo proceso; SQLite persiste a disco en un archivo único con transacciones ACID. |
| API           | **GraphQL**                              | Paridad conceptual con Linear (su API pública es GraphQL); queries flexibles que les vienen bien a los agentes.                                      |
| Modelo de uso | **Local-first, single-tenant**           | Un proceso local con un workspace, igual que corre prime-agent. Auth simple por API keys.                                                            |
| UI            | **Sí, lo más parecida a Linear posible** | Requisito explícito: la UI es parte de la identidad del clon (dark-first, densa, keyboard-first, command palette).                                   |

## Alcance vigente (2026-08-17)

Este documento conserva la decisión histórica del MVP, pero la implementación avanzó
más allá de aquella lista cerrada. La siguiente matriz es la referencia para auditorías y
planificación; cuando hay una diferencia, prevalece el código y esta sección sobre las
exclusiones históricas de abajo.

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

Las celdas `Parcial` identifican gaps de experiencia de usuario, no ausencia del
modelo o de la API. Esos gaps se siguen en tickets `PRB-*` independientes. La matriz
no implica soporte multi-workspace: prime-board continúa siendo single-workspace y
local-first.

### Inventario de operaciones por cliente

La paridad de las mutaciones administrativas y del archivo de issues se verifica con
este inventario estable:

| Dominio         | CLI `pb`                                   | MCP                                                                       |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Issues          | `issue archive`                            | `archive_issue`                                                           |
| Teams           | `team create/update`                       | `save_team`                                                               |
| Memberships     | `team membership-list/create/delete`       | `list_team_memberships`, `save_team_membership`, `delete_team_membership` |
| Actores         | `actor list/create/update`                 | `list_users`, `save_user`                                                 |
| API keys        | `api-key create/delete`                    | `save_api_key`, `delete_api_key`                                          |
| Workflow states | `team workflow-state-create/update/delete` | `save_issue_status`, `delete_issue_status`                                |
| Labels          | `team label-create/update/delete`          | `save_issue_label`, `delete_issue_label`                                  |

Las operaciones privilegiadas conservan la autorización del servidor GraphQL; el CLI y
MCP no intentan replicarla localmente. Los contratos e2e de ambos clientes verifican el
inventario, las respuestas JSON y los errores GraphQL.

> **Decisión revisada (2026-08-14):** se evaluó usar PostgreSQL y se **ratificó SQLite puro**.
> Racional: con local-first single-tenant el único escritor es el proceso Bun (la limitación
> de concurrencia de SQLite no aplica), el volumen esperado es trivial, y Postgres rompería
> la premisa de cero configuración. Se reabre solo si la visión cambia a hosteado/multi-tenant,
> múltiples instancias del server, o escritores externos directos a la DB.

## Lista cerrada del MVP

Regla de oro heredada de Linear: **paridad total de API** — todo lo que está en esta
lista es accesible por GraphQL, y la UI/CLI/MCP son clientes de esa API.

### Núcleo del board

1. **Workspace único** — contenedor de configuración global. _Multi-workspace no aporta en single-tenant._
2. **Teams** — nombre + clave corta (`AT`); dueños de workflow, labels propios y numeración de issues.
3. **Actores: humanos y agentes** — miembros del workspace con `type: human | agent`. Los agentes son actores de primera clase: crean, comentan, se les asigna. _Es la razón de ser del producto._
4. **Issues** — CRUD con título + descripción markdown, identificador legible (`TEAM-126`), estado, prioridad (escala fija de Linear), labels, assignee único, sub-issues (padre/hijo). _El corazón del clon._
5. **Estados de workflow por team** — personalizables, con **tipo semántico** obligatorio (`triage | backlog | unstarted | started | completed | canceled`). _La semántica portable es lo que permite a un agente operar cualquier team sin configuración._
6. **Labels** — de workspace y de team. _Metadato barato para rutear trabajo a agentes._
7. **Comentarios** — markdown, en issues. _Canal principal humano↔agente._
8. **Historial de actividad** — registro por issue de quién cambió qué y cuándo. _Contexto reconstructible + auditoría de agentes._
9. **Proyectos** — nombre, descripción, estado, lead, fecha objetivo, issues asociados. _Unidad natural para encargar un objetivo grande a un agente._
10. **Filtros y búsqueda** — filtros combinables por cualquier propiedad + full-text (SQLite FTS5). _La consulta programática es EL caso de uso de agentes._

### Capa de integración (constitutiva, no opcional)

11. **API GraphQL con paridad total** — servida por el mismo proceso Bun.
12. **API keys por actor** — header `Authorization`; cada key identifica a un humano o agente. _Suficiente en local-first; OAuth queda para una versión hosteada._
13. **Webhooks** — POST a URLs registradas ante eventos (issue creado/actualizado, comentario, etc.). _Es el "inbox" de los agentes: así se enteran de que les asignaron algo._
14. **CLI (`pb`)** — cliente de la API GraphQL para el flujo completo. _La interfaz más barata para cualquier agente; Linear no la tiene — acá nos diferenciamos._
15. **MCP server** — tools espejo de la API (crear/listar/actualizar issues, comentar, etc.). _Interfaz nativa de los agentes hoy._

### UI web

16. **UI Linear-like** — replicando el look & feel de Linear: tema oscuro por defecto, densidad alta, navegación por teclado, sidebar con teams/proyectos, **vista lista agrupada por estado**, **vista board**, **detalle de issue** con edición inline y comentarios, **creación rápida** (`C`) y **command palette** (`Cmd+K`).

## Exclusiones históricas del MVP (con justificación)

La tabla siguiente describe lo que se decidió excluir del MVP original. No debe leerse
como un inventario de faltantes actuales; para el estado vigente consultar la matriz
anterior y los tickets `PRB-*`.

| Funcionalidad                                      | Por qué queda afuera                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Relaciones entre issues (blocks/related/duplicate) | Sub-issues cubren la descomposición, que es el caso agente principal; dependencias llegan en Parte 5. |
| Milestones                                         | Estructura secundaria dentro de proyectos; el MVP planifica con proyectos + labels.                   |
| Ciclos (sprints)                                   | Cadencia pensada para capacity humana; menos central para agentes 24/7.                               |
| Estimaciones, due dates editables                  | Metadatos de planificación fina; no bloquean el flujo core.                                           |
| Templates, issues recurrentes                      | Los agentes generan estructura por sí mismos; recurrencia se cubre con cron/heartbeat externo.        |
| Triage como bandeja dedicada                       | Se simula con un estado de tipo `triage` en el workflow (ya soportado por el modelo).                 |
| Status updates de proyecto                         | Se cubre con comentarios de proyecto en una parte posterior.                                          |
| Initiatives, roadmap/timeline, insights            | Capa de management/visualización; sin valor API-first inmediato.                                      |
| Documents, adjuntos, reacciones                    | Fuera del núcleo issue-tracking; markdown con links cubre lo esencial.                                |
| Custom views persistidas                           | Los clientes (agentes) guardan sus propias queries; la UI del MVP trae vistas fijas.                  |
| Notificaciones/inbox en UI                         | Los webhooks son el mecanismo correcto para agentes; inbox humano llega con la UI madura.             |
| OAuth, SSO/SCIM, multi-tenant                      | Sin sentido en local-first single-tenant.                                                             |
| Integraciones de terceros, importers               | Con webhooks + API alcanza para que cualquiera integre; migraciones no aplican sin usuarios.          |
| SLAs, asks, customer requests, releases/diffs      | Enterprise / otro producto; fuera de la misión.                                                       |

## Consecuencia para el plan

El MVP se implementa en tres partes (hitos en Linear):

- **Parte 2 — Núcleo del backend:** SQLite + GraphQL + auth + webhooks.
- **Parte 3 — Interfaces para agentes:** CLI + MCP.
- **Parte 4 — UI web:** shell Linear-like, lista/board, detalle, command palette.

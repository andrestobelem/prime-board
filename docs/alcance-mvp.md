# Alcance del MVP de prime-board

> Ticket: [AT-127](https://linear.app/andrestobelem/issue/AT-127/definir-el-alcance-del-mvp-de-prime-board)
> Insumo: [`relevamiento-linear.md`](relevamiento-linear.md) (AT-126).
> La especificación técnica del MVP vive en [`specs/mvp.md`](specs/mvp.md) (AT-128).

## Decisiones estructurales

Confirmadas con el dueño del proyecto:

| Decisión | Elección | Motivo |
|---|---|---|
| Stack | **Bun + TypeScript + SQLite** | Bun trae SQLite integrado (`bun:sqlite`) y sirve API + UI desde un solo proceso; SQLite persiste a disco en un archivo único con transacciones ACID. |
| API | **GraphQL** | Paridad conceptual con Linear (su API pública es GraphQL); queries flexibles que les vienen bien a los agentes. |
| Modelo de uso | **Local-first, single-tenant** | Un proceso local con un workspace, igual que corre prime-agent. Auth simple por API keys. |
| UI | **Sí, lo más parecida a Linear posible** | Requisito explícito: la UI es parte de la identidad del clon (dark-first, densa, keyboard-first, command palette). |

## Lista cerrada del MVP

Regla de oro heredada de Linear: **paridad total de API** — todo lo que está en esta
lista es accesible por GraphQL, y la UI/CLI/MCP son clientes de esa API.

### Núcleo del board

1. **Workspace único** — contenedor de configuración global. *Multi-workspace no aporta en single-tenant.*
2. **Teams** — nombre + clave corta (`AT`); dueños de workflow, labels propios y numeración de issues.
3. **Actores: humanos y agentes** — miembros del workspace con `type: human | agent`. Los agentes son actores de primera clase: crean, comentan, se les asigna. *Es la razón de ser del producto.*
4. **Issues** — CRUD con título + descripción markdown, identificador legible (`AT-126`), estado, prioridad (escala fija de Linear), labels, assignee único, sub-issues (padre/hijo). *El corazón del clon.*
5. **Estados de workflow por team** — personalizables, con **tipo semántico** obligatorio (`triage | backlog | unstarted | started | completed | canceled`). *La semántica portable es lo que permite a un agente operar cualquier team sin configuración.*
6. **Labels** — de workspace y de team. *Metadato barato para rutear trabajo a agentes.*
7. **Comentarios** — markdown, en issues. *Canal principal humano↔agente.*
8. **Historial de actividad** — registro por issue de quién cambió qué y cuándo. *Contexto reconstructible + auditoría de agentes.*
9. **Proyectos** — nombre, descripción, estado, lead, fecha objetivo, issues asociados. *Unidad natural para encargar un objetivo grande a un agente.*
10. **Filtros y búsqueda** — filtros combinables por cualquier propiedad + full-text (SQLite FTS5). *La consulta programática es EL caso de uso de agentes.*

### Capa de integración (constitutiva, no opcional)

11. **API GraphQL con paridad total** — servida por el mismo proceso Bun.
12. **API keys por actor** — header `Authorization`; cada key identifica a un humano o agente. *Suficiente en local-first; OAuth queda para una versión hosteada.*
13. **Webhooks** — POST a URLs registradas ante eventos (issue creado/actualizado, comentario, etc.). *Es el "inbox" de los agentes: así se enteran de que les asignaron algo.*
14. **CLI (`pb`)** — cliente de la API GraphQL para el flujo completo. *La interfaz más barata para cualquier agente; Linear no la tiene — acá nos diferenciamos.*
15. **MCP server** — tools espejo de la API (crear/listar/actualizar issues, comentar, etc.). *Interfaz nativa de los agentes hoy.*

### UI web

16. **UI Linear-like** — replicando el look & feel de Linear: tema oscuro por defecto, densidad alta, navegación por teclado, sidebar con teams/proyectos, **vista lista agrupada por estado**, **vista board**, **detalle de issue** con edición inline y comentarios, **creación rápida** (`C`) y **command palette** (`Cmd+K`).

## Exclusiones del MVP (con justificación)

| Funcionalidad | Por qué queda afuera |
|---|---|
| Relaciones entre issues (blocks/related/duplicate) | Sub-issues cubren la descomposición, que es el caso agente principal; dependencias llegan en Parte 5. |
| Milestones | Estructura secundaria dentro de proyectos; el MVP planifica con proyectos + labels. |
| Ciclos (sprints) | Cadencia pensada para capacity humana; menos central para agentes 24/7. |
| Estimaciones, due dates editables | Metadatos de planificación fina; no bloquean el flujo core. |
| Templates, issues recurrentes | Los agentes generan estructura por sí mismos; recurrencia se cubre con cron/heartbeat externo. |
| Triage como bandeja dedicada | Se simula con un estado de tipo `triage` en el workflow (ya soportado por el modelo). |
| Status updates de proyecto | Se cubre con comentarios de proyecto en una parte posterior. |
| Initiatives, roadmap/timeline, insights | Capa de management/visualización; sin valor API-first inmediato. |
| Documents, adjuntos, reacciones | Fuera del núcleo issue-tracking; markdown con links cubre lo esencial. |
| Custom views persistidas | Los clientes (agentes) guardan sus propias queries; la UI del MVP trae vistas fijas. |
| Notificaciones/inbox en UI | Los webhooks son el mecanismo correcto para agentes; inbox humano llega con la UI madura. |
| OAuth, SSO/SCIM, multi-tenant | Sin sentido en local-first single-tenant. |
| Integraciones de terceros, importers | Con webhooks + API alcanza para que cualquiera integre; migraciones no aplican sin usuarios. |
| SLAs, asks, customer requests, releases/diffs | Enterprise / otro producto; fuera de la misión. |

## Consecuencia para el plan

El MVP se implementa en tres partes (hitos en Linear):

- **Parte 2 — Núcleo del backend:** SQLite + GraphQL + auth + webhooks.
- **Parte 3 — Interfaces para agentes:** CLI + MCP.
- **Parte 4 — UI web:** shell Linear-like, lista/board, detalle, command palette.

# Relevamiento de funcionalidades de Linear

> Ticket: [AT-126](https://linear.app/andrestobelem/issue/AT-126/relevar-funcionalidades-core-de-linear)
> Objetivo: inventariar las funcionalidades de Linear candidatas a clonar en prime-board,
> con una primera clasificación pensando en **agentes como usuarios principales**.
> La decisión final de alcance se toma en AT-127.

## Criterio de clasificación

| Categoría | Significado |
|---|---|
| 🟢 Imprescindible | Sin esto no hay clon útil para agentes; candidato directo al MVP. |
| 🟡 Deseable | Suma mucho pero el MVP funciona sin esto; candidato a Parte 2+. |
| 🔴 Fuera de alcance | No aporta al caso de uso "board para agentes" o su costo no se justifica. |

Criterio rector: prime-board es **API-first**. Un agente tiene que poder hacer todo el
flujo (crear, consultar, actualizar, comentar, reaccionar a cambios) sin UI.

---

## 1. Modelo organizacional

| Funcionalidad | Descripción | Clasificación | Nota para agentes |
|---|---|---|---|
| Workspace | Contenedor raíz (org) con settings globales. | 🟢 | Alcanza con soportar un workspace único al inicio. |
| Teams | Unidad de trabajo con clave corta (`AT`), estados y settings propios. | 🟢 | Los identificadores legibles (`AT-126`) salen de acá; clave para que los agentes referencien trabajo. |
| Usuarios y roles | Miembros, admins, guests. | 🟢 (mínimo) | El giro de prime-board: los **agentes son actores de primera clase** (creador, asignado, comentarista), no un add-on. Roles finos pueden esperar. |
| Sub-teams / jerarquía de equipos | Equipos anidados. | 🔴 | Complejidad organizacional que un board para agentes no necesita de entrada. |

## 2. Issues (el núcleo)

| Funcionalidad | Descripción | Clasificación | Nota para agentes |
|---|---|---|---|
| CRUD de issues | Título + descripción markdown, crear/editar/archivar. | 🟢 | El corazón del producto. Markdown es el formato natural de los agentes. |
| Identificadores legibles | `AT-126`, únicos por team, estables. | 🟢 | Fundamental para referenciar trabajo en prompts, commits y branches. |
| Estados de workflow | Por team, personalizables, con **tipos** (triage, backlog, unstarted, started, completed, canceled). | 🟢 | Los tipos permiten semántica portable entre teams — clave para que un agente razone sin conocer cada workflow. |
| Prioridades | Urgent / High / Medium / Low / None. | 🟢 | Escala fija y simple; los agentes la usan para ordenar su cola de trabajo. |
| Labels | De workspace y de team, con grupos. | 🟢 | Metadato barato y muy usado para rutear trabajo a agentes (`agente:review`, `area:api`). |
| Asignación | Un assignee + suscriptores. | 🟢 | "Asignar a un agente" es el gesto central de prime-board. |
| Sub-issues | Jerarquía padre/hijo. | 🟢 | Es exactamente cómo un agente descompone una tarea en sub-tareas delegables. |
| Relaciones | Blocks / blocked by / related / duplicate of. | 🟡 | Útil para planificación con dependencias; puede llegar después del MVP. |
| Fechas | Due date, created/updated/started/completed. | 🟡 | Los timestamps de sistema son 🟢 (gratis); due dates editables pueden esperar. |
| Estimaciones | Points / t-shirt por team. | 🟡 | Útil para planificar capacity de agentes, no bloquea el MVP. |
| Templates de issues | Plantillas por team. | 🟡 | Los agentes pueden generar la estructura ellos mismos; útil para estandarizar más adelante. |
| Triage | Bandeja de entrada del team para clasificar issues externos. | 🟡 | Muy interesante como "inbox de trabajo para agentes", pero se puede simular con un estado. |
| Issues recurrentes | Creación periódica automática. | 🟡 | Los agentes con heartbeat/cron ya cubren este caso desde afuera. |
| SLAs | Tiempos máximos de respuesta/resolución. | 🔴 | Feature enterprise; no aporta al MVP. |
| Nombre de branch sugerido | `usuario/at-126-titulo`. | 🟡 | Barato de generar y muy útil para agentes que programan. |

## 3. Colaboración sobre issues

| Funcionalidad | Descripción | Clasificación | Nota para agentes |
|---|---|---|---|
| Comentarios | Threads en issues, markdown, menciones. | 🟢 | Canal principal de comunicación humano↔agente y agente↔agente sobre el trabajo. |
| Historial de actividad | Registro de cambios del issue (quién, qué, cuándo). | 🟢 | Permite a un agente reconstruir contexto al retomar un issue. Auditable por diseño. |
| Reacciones | Emojis en comentarios. | 🔴 | Azúcar social; irrelevante para agentes. |
| Adjuntos | Links/archivos con metadata asociados al issue. | 🟡 | Útil para vincular PRs, docs y artefactos; un link en markdown lo cubre al inicio. |
| Suscripciones y notificaciones | Inbox, menciones, snooze. | 🟡 | Para agentes el equivalente correcto son **webhooks/eventos** (ver §7), no un inbox visual. |

## 4. Proyectos y planificación

| Funcionalidad | Descripción | Clasificación | Nota para agentes |
|---|---|---|---|
| Proyectos | Agrupan issues (multi-team), con lead, estado, fechas objetivo. | 🟢 | Unidad natural para encargarle a un agente un objetivo grande. |
| Milestones | Hitos ordenados dentro de un proyecto. | 🟡 | Lo usamos nosotros mismos en Linear; suma estructura pero no bloquea el MVP. |
| Status updates de proyecto | Updates periódicos con health (on track / at risk / off track). | 🟡 | Encaja perfecto con agentes que reportan avance; fácil de agregar después. |
| Documentos de proyecto | Docs markdown colgados del proyecto. | 🟡 | Los repos ya cumplen ese rol (`docs/`); reevaluar en Parte 2. |
| Ciclos (sprints) | Iteraciones automáticas con cooldown y rollover. | 🟡 | Tiene sentido cuando hay capacity humana; para agentes es menos central. |
| Initiatives | Agrupan proyectos (nivel estrategia). | 🔴 | Capa de management que el MVP no necesita. |
| Roadmap / timeline | Vistas Gantt de proyectos. | 🔴 | Visualización pura; sin valor API-first. |

## 5. Búsqueda y vistas

| Funcionalidad | Descripción | Clasificación | Nota para agentes |
|---|---|---|---|
| Filtrado potente | Por cualquier propiedad, combinable (AND/OR). | 🟢 | La consulta programática es EL caso de uso de un agente ("mis issues urgentes sin empezar"). |
| Búsqueda full-text | Sobre título/descripción/comentarios. | 🟢 | Necesaria para que un agente encuentre trabajo previo relacionado. |
| Custom views guardadas | Filtros con nombre, compartibles. | 🟡 | Equivalen a "queries guardadas"; útiles pero derivables. |
| Layouts (board/list), display options, favorites | Presentación visual. | 🔴 | Solo tiene sentido en UI; el MVP es API-first. |

## 6. Documentos y conocimiento

| Funcionalidad | Descripción | Clasificación | Nota para agentes |
|---|---|---|---|
| Documents (workspace) | Editor de docs colaborativo. | 🔴 | Fuera del núcleo issue-tracking; los agentes ya tienen repos/Notion. |
| Issue documents | Docs largos embebidos en issues. | 🔴 | La descripción markdown alcanza. |

## 7. API e integración (la parte más importante para prime-board)

| Funcionalidad | Descripción | Clasificación | Nota para agentes |
|---|---|---|---|
| API completa | En Linear: GraphQL con paridad total (la UI la usa). | 🟢 | Principio a copiar: **todo lo que existe es accesible por API**. La forma (REST/GraphQL) se decide en AT-127/AT-128. |
| MCP server | Tools sobre issues, proyectos, comentarios, etc. | 🟢 | Interfaz nativa de los agentes hoy; prime-board debería nacer con MCP. |
| Webhooks / eventos | Notificación push de cambios. | 🟢 | Reemplaza al inbox humano: es como un agente se entera de que le asignaron algo. |
| Autenticación (API keys / OAuth) | Actores identificables, apps con identidad propia. | 🟢 | Mínimo: API keys por actor (humano o agente). OAuth completo es 🟡. |
| "Linear for Agents" (delegación) | Asignar issues a agentes, sesiones de agente, actor semantics. | 🟢 | En Linear es un add-on reciente; en prime-board es la razón de ser — diseñarlo de entrada. |
| CLI | Linear no tiene CLI oficial. | 🟢 | Oportunidad de diferenciarse: un CLI es la interfaz más barata para cualquier agente. |
| Importers / exporters (CSV, etc.) | Migración de datos. | 🔴 | Sin usuarios que migrar, no aplica al MVP. |
| Integraciones de terceros (GitHub, Slack, Sentry…) | Sync bidireccional con otras herramientas. | 🔴 | Costo alto; con webhooks genéricos alcanza para que otros integren. |

## 8. Administración y varios

| Funcionalidad | Descripción | Clasificación | Nota para agentes |
|---|---|---|---|
| Auto-archive / auto-close | Higiene automática de issues viejos. | 🟡 | Barato y útil para boards operados por agentes 24/7. |
| Audit log | Registro administrativo de acciones. | 🟡 | El historial por issue (🟢, §3) cubre lo esencial; el log global puede esperar. |
| SSO / SCIM | Identidad enterprise. | 🔴 | Enterprise puro. |
| Insights / analytics | Gráficos y métricas agregadas. | 🔴 | Derivable de la API por el propio agente. |
| Releases / diffs (code review) | Features nuevas de Linear alrededor de código. | 🔴 | Otro producto; fuera de la misión. |
| Asks / customer requests | Intake desde Slack/email y voz del cliente. | 🔴 | Fuera de la misión. |

---

## Resumen de la clasificación

**🟢 Imprescindible (candidatos directos al MVP):**
workspace + teams con identificadores legibles · usuarios con agentes como actores de primera clase ·
issues CRUD (markdown) · estados con tipos semánticos · prioridades · labels · asignación ·
sub-issues · comentarios · historial de actividad · proyectos · filtrado + búsqueda ·
API completa · MCP · webhooks · API keys · delegación a agentes · CLI.

**🟡 Deseable (Parte 2+):**
relaciones entre issues · due dates · estimaciones · templates · triage · issues recurrentes ·
branch name sugerido · adjuntos · milestones · status updates de proyecto · ciclos ·
custom views guardadas · OAuth · auto-archive · audit log global · docs de proyecto.

**🔴 Fuera de alcance:**
sub-teams · SLAs · reacciones · initiatives · roadmaps/timeline · layouts visuales ·
documents · importers · integraciones de terceros · SSO/SCIM · insights · releases/diffs · asks.

## Observación transversal

Dos ideas de diseño de Linear valen más que cualquier feature suelta y deberían ser
principios de prime-board:

1. **Paridad total de API**: no existe funcionalidad solo-UI; la UI es un cliente más.
   Para un board de agentes esto no es deseable, es constitutivo.
2. **Semántica portable**: los tipos de estado (started, completed…), la escala fija de
   prioridades y los identificadores legibles permiten razonar sobre cualquier team sin
   configuración previa — exactamente lo que un agente necesita.

## Fuentes

- Documentación oficial de Linear (workspaces, labels, use-cycles, project-milestones,
  linear-agent, issue-templates, triage, entre otras — vía `search_documentation` del MCP).
- El propio MCP server de Linear como evidencia de qué operaciones se les exponen a los
  agentes hoy: issues, estados, labels, proyectos, milestones, ciclos, comentarios,
  documentos, teams, usuarios, adjuntos, status updates, releases y diffs.

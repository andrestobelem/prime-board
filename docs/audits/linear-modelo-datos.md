# Auditoría del modelo de datos frente a Linear

> Ticket: [PRB-377](http://localhost:3333/issue/PRB-377)  
> Fecha del relevamiento: 2026-08-18 (snapshot histórico)
> Verificación del contrato local vigente: 2026-08-23
> Commit base de la revisión: `1e9bf7d` (`main`), con cambios locales verificados
> Alcance: entidades, relaciones y responsabilidades del modelo; no incluye la implementación de correcciones.

## Método y fuentes

El relevamiento de 2026-08-18 revisó el SDL y las migraciones de SQLite hasta `0018_team_archive.sql`.
Ese material es un snapshot histórico. La verificación del contrato vigente revisó además las migraciones
SQLite `0019`–`0027`, el backend PostgreSQL y la selección de Workspace. Usamos como referencia externa la
documentación oficial de Linear:

- [Modelo conceptual](https://linear.app/docs/conceptual-model)
- [Teams](https://linear.app/docs/teams)
- [Projects](https://linear.app/docs/projects)
- [Project milestones](https://linear.app/docs/project-milestones)
- [Cycles](https://linear.app/docs/use-cycles)
- [Issue relations](https://linear.app/docs/issue-relations)
- [Custom views](https://linear.app/docs/custom-views)
- [Inbox](https://linear.app/docs/inbox)
- [Documents](https://linear.app/docs/documents)
- [Modelo exportable de Linear/Airbyte](https://linear.app/docs/airbyte)

La comparación distingue **paridad conceptual**, **divergencias intencionales** y **gaps pendientes**. Una diferencia con Linear no es necesariamente un defecto.

## Estado del contrato vigente (verificado el 2026-08-23)

El mapa y el veredicto que siguen conservan el snapshot histórico de 2026-08-18. No deben leerse como
la topología actual sin estas correcciones:

- El backend predeterminado es SQLite (`apps/server/src/config.ts`). Su runner aplica `0001`–`0027`.
  Las migraciones `0024` y `0025` agregan `workspace_id`, Memberships y FKs compuestas; `0026`
  agrega grants de API keys y `0027` agrega Documents. El contrato GraphQL lista/crea Workspaces y
  selecciona el contexto mediante `X-Workspace-ID`; la CLI y la web tienen el mismo camino.
- PostgreSQL es un backend opcional (`PRIME_BOARD_PERSISTENCE=postgres`) con migrador independiente
  de cinco versiones (`apps/server/src/db/postgres/migrator.ts`). Su baseline impone un singleton de
  Workspace; `workspaceCreate` no está migrado y el servidor mantiene un SQLite efímero para dominios
  aún no migrados. No debe describirse PostgreSQL como un modelo multi-Workspace ni como un cutover
  completo.
- El SDL vigente contiene 28 campos de `Query`, 67 de `Mutation`, 25 de `Issue`, 14 de `Project` y
  2 de `PageInfo`. Los conteos del snapshot histórico no son un objetivo de paridad.

## Veredicto

El núcleo jerárquico del snapshot se alinea con Linear: un Workspace contiene Teams y Actors; los Teams
contienen Issues y Workflow States; Projects, Cycles y Milestones organizan el trabajo; Initiatives
agrupan Projects; y Labels, Relations, Comments, Saved Views e Inbox completan la operación.

Prime Board no pretende replicar todo el modelo actual de Linear. Su diferencia principal es el enfoque local
y agent-first: Actors humanos y agentes, API keys por Actor, CLI, MCP y webhooks. En el contrato vigente,
SQLite admite varias Workspaces con aislamiento; PostgreSQL conserva un singleton durante la migración.

## Mapa de entidades y relaciones del snapshot histórico (2026-08-18)

El siguiente mapa documenta la topología singleton que se auditó en esa fecha. No describe por sí solo
el alcance actual de SQLite ni el backend PostgreSQL.

```text
Workspace (singleton lógico en el snapshot)
├── Team[] ── WorkflowState[]
│   ├── Issue[] ── Comment[] / Activity[]
│   │   ├── 0..1 Project, Milestone, Cycle, Assignee, Parent
│   │   ├── N..M Label
│   │   └── N..M IssueRelation (dirigida o simétrica)
│   ├── Cycle[]
│   ├── Label[] (además de labels de workspace)
│   ├── Project[] (N..M por project_teams)
│   └── TeamMembership[] ↔ Actor[]
├── Actor[] ── ApiKey[]
├── Project[] ── Milestone[] / ProjectStatusUpdate[]
├── Initiative[] ── Project[] y Team[]
├── SavedView[] (personal, team o workspace)
└── Favorite[] (Project o SavedView por actor)

InboxItem = Activity relevante + InboxReceipt por Actor
```

### Correspondencias principales del snapshot histórico

Estas correspondencias conservan las conclusiones de 2026-08-18. Para el estado vigente, aplica la sección
anterior sobre los dos backends.

| Prime Board                | Linear                             | Resultado                                                                                                               |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Workspace`                | `Organization`                     | Paridad conceptual en el snapshot; SQLite actual tiene alcance por Workspace y PostgreSQL conserva singleton.           |
| `Actor` + `TeamMembership` | `User` + membresías de team        | Paridad básica; Prime Board añade `AGENT` y API keys como primera clase.                                                |
| `Team`                     | `Team`                             | Paridad básica: issues, estados, labels, projects y cycles.                                                             |
| `WorkflowState`            | `WorkflowState`                    | Paridad básica: nombre, tipo, color y posición.                                                                         |
| `Issue`                    | `Issue`                            | Paridad del núcleo: team, estado, prioridad, assignee, creator, project, cycle, milestone, parent, labels y relaciones. |
| `Project`                  | `Project`                          | Paridad básica: teams, lead, estado, fecha objetivo, milestones, issues y updates.                                      |
| `Milestone`                | `ProjectMilestone`                 | Paridad: milestone dentro de project, issues, fecha y progreso.                                                         |
| `Cycle`                    | `Cycle`                            | Paridad: ciclo time-boxed por team, issues y progreso.                                                                  |
| `Initiative`               | `Initiative`                       | Paridad parcial: agrupa projects y tiene owner, estado, fecha y progreso.                                               |
| `SavedView`                | `CustomView`                       | Paridad conceptual, con contrato y capacidades distintas.                                                               |
| `InboxItem`                | `Notification`                     | Mismo propósito, distinto modelo: Prime Board lo deriva de activity + receipts.                                         |
| `IssueRelation`            | `IssueRelation`                    | Paridad en blocks/related/duplicate; el modelo de lectura de inversas difiere.                                          |
| `Review`                   | Sin equivalente directo del núcleo | Divergencia intencional de producto.                                                                                    |

## Hallazgos y clasificación

### Paridad suficiente para el núcleo MVP en el snapshot

- La pertenencia de un issue a un team y su workflow por team siguen el modelo conceptual de Linear.
- Projects pueden pertenecer a varios teams mediante `project_teams`, igual que en Linear.
- Milestones son hijos de projects y cycles son hijos de teams.
- Parent/sub-issues, labels y relaciones entre issues tienen representación persistente y API.
- Initiatives agrupan projects y conservan alcance por teams.
- Saved views, favorites, updates y Inbox cubren los flujos principales de organización personal y seguimiento.

### Divergencias intencionales del snapshot histórico

- En el snapshot, `Workspace`, `Initiative` y varios vínculos no tenían FK de Workspace porque la réplica
  local era single-tenant (ADR-0003). SQLite ahora tiene alcance explícito en `0024`–`0027`.
- `Actor.type = AGENT`, API keys, CLI, MCP y webhooks están diseñados para agentes y no modelan exactamente
  el usuario/app user de Linear.
- `Review` es una cola de revisión propia de Prime Board.
- `Activity` + `inbox_receipts` es una simplificación deliberada del historial/notificaciones para mantener
  el dominio local pequeño.

### Gaps de modelo frente a Linear en el snapshot

1. **Issue:** faltan estimate, due date, timestamps de transición, subscribers, reactions, attachments, documents, releases y otros recursos externos.
2. **Project:** faltan miembros, labels de project, dependencias/enlaces entre projects, documents y attachments.
3. **Documents y attachments:** en el snapshot no existían entidades ni vínculos; SQLite ahora tiene
   `Document` desde `0027`, y el backend PostgreSQL ya tiene el dominio equivalente desde la migración `0005`; los adjuntos ricos siguen ausentes.
4. **Historial y auditoría:** `Activity` es issue-céntrica y genérica; Linear separa issue history, audit entries y notificaciones.
5. **Favorites:** solo apunta a Project o SavedView; Linear permite favoritos de más tipos, como Issue, Cycle, Label, Team y Document.
6. **Superficies actuales de Linear:** releases/release notes, integraciones y recursos externos no forman parte del modelo MVP.

## Prioridad sugerida

1. Separar, si el producto lo necesita, historial de issue, auditoría y notificaciones.
2. Añadir documents/attachments como recursos vinculables.
3. Completar metadatos de Issue.
4. Añadir miembros y dependencias de Project.
5. Evaluar releases e integraciones solo después de definir el alcance del producto agent-first.

Esta auditoría no exige implementar todos los gaps. Los usa como mapa para priorizar decisiones futuras de producto.

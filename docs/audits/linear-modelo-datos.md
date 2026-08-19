# Auditoría del modelo de datos frente a Linear

> Ticket: [PRB-377](http://localhost:3333/issue/PRB-377)  
> Fecha: 2026-08-18  
> Alcance: entidades, relaciones y responsabilidades del modelo; no implementación de correcciones.

## Método y fuentes

Se revisaron el SDL vigente en `packages/schema/src/sdl.ts` y las migraciones de SQLite `apps/server/src/db/migrations/0001_init.sql` a `0018_team_archive.sql`. La referencia externa fue la documentación oficial de Linear:

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

La comparación busca distinguir **paridad conceptual**, **divergencias intencionales** y **gaps pendientes**. No toda diferencia con Linear es un defecto.

## Veredicto

El núcleo jerárquico de Prime Board está bien alineado con Linear: un workspace contiene teams y actores; los teams contienen issues y workflow states; projects, cycles y milestones organizan el trabajo; initiatives agrupan projects; y labels, relaciones, comentarios, vistas e Inbox completan la operación.

Prime Board no pretende ser una réplica completa del modelo actual de Linear. Su diferencia principal es el enfoque local y agent-first: un único workspace, actores humanos/agentes, API keys por actor, CLI, MCP y webhooks.

## Mapa de entidades y relaciones

```text
Workspace (singleton lógico)
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

### Correspondencias principales

| Prime Board                | Linear                             | Resultado                                                                                                               |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Workspace`                | `Organization`                     | Paridad conceptual; Prime Board es single-workspace y no tiene FK de workspace en cada fila.                            |
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

### Paridad suficiente para el núcleo MVP

- La pertenencia de un issue a un team y su workflow por team siguen el modelo conceptual de Linear.
- Projects pueden pertenecer a varios teams mediante `project_teams`, igual que en Linear.
- Milestones son hijos de projects y cycles son hijos de teams.
- Parent/sub-issues, labels y relaciones entre issues tienen representación persistente y API.
- Initiatives agrupan projects y conservan alcance por teams.
- Saved views, favorites, updates y Inbox cubren los flujos principales de organización personal y seguimiento.

### Divergencias intencionales

- `Workspace`, `Initiative` y varios vínculos no tienen FK de workspace porque la réplica local es single-tenant (ADR-0003).
- `Actor.type = AGENT`, API keys, CLI, MCP y webhooks están diseñados para agentes y no modelan exactamente el usuario/app user de Linear.
- `Review` es una cola de revisión propia de Prime Board.
- `Activity` + `inbox_receipts` es una simplificación deliberada del historial/notificaciones para mantener el dominio local pequeño.

### Gaps de modelo frente a Linear

1. **Issue:** faltan estimate, due date, timestamps de transición, subscribers, reactions, attachments, documents, releases y otros recursos externos.
2. **Project:** faltan miembros, labels de project, dependencias/enlaces entre projects, documents y attachments.
3. **Documents y attachments:** no existen entidades ni vínculos a teams, projects, initiatives, cycles o issues.
4. **Historial y auditoría:** `Activity` es issue-céntrica y genérica; Linear separa issue history, audit entries y notificaciones.
5. **Favorites:** solo apunta a Project o SavedView; Linear permite favoritos de más tipos, como Issue, Cycle, Label, Team y Document.
6. **Superficies actuales de Linear:** releases/release notes, integraciones y recursos externos no forman parte del modelo MVP.

## Prioridad sugerida

1. Separar, si el producto lo necesita, historial de issue, auditoría y notificaciones.
2. Añadir documents/attachments como recursos vinculables.
3. Completar metadatos de Issue.
4. Añadir miembros y dependencias de Project.
5. Evaluar releases e integraciones solo después de definir el alcance del producto agent-first.

Esta auditoría no implica que los gaps deban implementarse todos: son un mapa para priorizar futuras decisiones de producto.

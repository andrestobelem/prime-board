# prime-board

Un gestor de issues y proyectos modelado sobre Linear, pensado para que lo operen **agentes**
antes que humanos. Este glosario fija el vocabulario del dominio; los términos van en inglés
porque son los identificadores de la app (ver `AGENTS.md`).

## Actores y pertenencia

**Workspace**:
La instalación entera de prime-board: un único espacio con todos sus teams y actores. No hay
más de uno por instancia.
_Avoid_: Organization, tenant, account

**Team**:
Agrupación de trabajo dueña de sus propios workflow states, labels y prefijo de identificador
(`AT`, `PB`). Un issue pertenece a exactamente un team.
_Avoid_: Squad, group, workspace

**Actor**:
Quien opera el board. Es de tipo **Human** o **Agent**; ambos crean issues, comentan y son
asignables, y se autentican con su propia API key.
_Avoid_: User, account

**Membership**:
La pertenencia de un **Actor** a un **Team**. Un actor puede tener memberships en varios
teams; un issue sigue perteneciendo a exactamente un team. La membership tiene un rol mínimo
(`member` u `owner`); el owner administra el roster. La UI puede decir «Members» para el
roster; el término de dominio de la relación es Membership.
_Avoid_: User assignment, account link, seat

## Trabajo

**Identifier**:
Clave legible e inmutable de un issue (`AT-172`): prefijo del **Team** + número. No se
renumera ni se reasigna.
_Avoid_: Issue key, ticket number, slug

**Issue**:
La unidad de trabajo. Tiene un Identifier, un workflow state, una prioridad de 0 a 4 y,
opcionalmente, un padre.
_Avoid_: Ticket, task, card, story

**Sub-issue**:
Un issue cuyo `parent` es otro issue. No es una entidad distinta: es la misma cosa en una
relación jerárquica.
_Avoid_: Subtask, child task

**Relation**:
Arista tipada entre dos issues: **blocked-by / blocks** (dirigida, sin ciclos), **related**
(simétrica) y **duplicate-of / duplicated-by** (dirigida). Se guarda una sola vez y cada
extremo la ve con el tipo que le corresponde. Distinta del `parent`: no es jerarquía.
_Avoid_: Link, dependency, edge

**Blocked**:
Un issue con al menos una relación blocked-by cuyo bloqueante sigue abierto.
_Avoid_: Stuck, waiting

**Frontier**:
Conjunto derivado de issues abiertos cuyos bloqueantes están todos cerrados. Delimita el
trabajo que puede avanzar sin esperar a que otro issue se desbloquee.
_Avoid_: Unblocked set, ready queue, next issues

**Workflow State**:
La posición de un issue en el ciclo de vida de su team (`Todo`, `In Progress`, `Ready for
Agent`). Cada team define los suyos; cada uno declara un **State Type**.
_Avoid_: Status, column, stage

**State Type**:
Categoría del ciclo de vida que declara un Workflow State: `triage`, `backlog`,
`unstarted`, `started`, `completed`, `canceled`. Es lo que la UI y las integraciones
interpretan (abierto/cerrado, columnas, filtros), no el nombre del estado.
_Avoid_: Status category, lifecycle type

**Label**:
Etiqueta transversal y acumulable de un issue (`web`, `graphql`, `epic:repo-truth`). A
diferencia del workflow state, un issue puede tener muchas o ninguna.
_Avoid_: Tag, category

**Priority**:
Entero de 0 a 4 con la misma semántica que Linear: 0 sin prioridad, 1 urgent, 2 high,
3 medium, 4 low. El orden es inverso al número.

## Planificación

**Project**:
Un esfuerzo con nombre, estado y fecha objetivo, que agrupa issues de **uno o varios teams**.
Un team puede tener varios projects.
_Avoid_: Epic, board

**Milestone**:
Una fase dentro de un project, con su propia fecha objetivo y su progreso. Los milestones
ordenan el project; los projects agrupan el trabajo. Distinto de **Cycle**.
_Avoid_: Phase, sprint, iteration, part

**Initiative**:
Agrupa projects bajo un objetivo estratégico. Puede ser workspace-scoped (sin teams, visible
para todo actor autenticado) o team-scoped (limitada a uno o más teams). Distinta de Project:
el project agrupa issues; la initiative agrupa projects.
_Avoid_: Epic, theme, OKR

**Cycle**:
Ventana de tiempo de un **Team** (`upcoming` / `active` / `completed`) a la que se asignan
issues. Distinta de Milestone: el cycle es del team y es time-boxed; el milestone es del
project.
_Avoid_: Sprint, iteration

## Colaboración y superficie

**Review**:
Pedido de revisión entre actors sobre un issue (`requested` → `in_progress` →
`approved` / `rejected`).
_Avoid_: PR review, approval request

**Project Update**:
Nota de salud de un project (`on_track` / `at_risk` / `off_track`) con cuerpo narrativo.
_Avoid_: Status report, pulse

**Saved View**:
Preset nombrado de filtros y alcance (`personal`, `team` o `workspace`).
_Avoid_: Filter, bookmark, custom view

**Inbox**:
Cola personal de **Activity** relevante para un actor (menciones, asignaciones, comentarios).
_Avoid_: Notifications, feed, mailbox

## Registro

**Activity**:
El historial append-only de lo que le pasó a un issue: cada cambio queda como un evento con
su actor y su fecha. Es el registro del que se reconstruye el issue.
_Avoid_: History, audit log, changelog

**Comment**:
Texto que un actor agrega a un issue. En prime-board es además el lugar donde se deja la
**evidencia**: qué se entregó y cómo se verificó.

**Log**:
El archivo de eventos de un issue versionado en el repo (`.prime-board/log/AT-172.jsonl`).
Es la fuente de verdad (ver ADR-0004).
_Avoid_: Journal, history file

**Issue Markdown**:
El markdown derivado de un issue en el repo (`.prime-board/issues/AT-172.md`), pensado para
leerse en un PR. Se regenera; nunca se edita a mano.
_Avoid_: Snapshot, dump, export file

**Index**:
La base SQLite derivada del log, usada para queries, filtros y full-text. Es descartable y se
reconstruye con `bun run rebuild`.
_Avoid_: Database, source of truth, cache

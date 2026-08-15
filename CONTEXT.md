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
_Avoid_: User, member, account

## Trabajo

**Issue**:
La unidad de trabajo. Tiene un **Identifier** legible e inmutable (`AT-172`), un workflow
state, una prioridad de 0 a 4 y, opcionalmente, un padre.
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
Un issue con al menos una relación blocked-by cuyo bloqueante sigue abierto. Su complemento
abierto es el **frontier**: los issues abiertos cuyos bloqueantes están todos cerrados
(`issues(filter: { unblocked: true })`).
_Avoid_: Stuck, waiting

**Workflow State**:
La posición de un issue en el ciclo de vida de su team (`Todo`, `In Progress`, `Ready for
Agent`). Cada team define los suyos y cada uno declara un **State Type** —`triage`,
`backlog`, `unstarted`, `started`, `completed`, `canceled`— que es lo que la UI y las
integraciones interpretan.
_Avoid_: Status, column, stage

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
_Avoid_: Epic, initiative, board

**Milestone**:
Una fase dentro de un project, con su propia fecha objetivo y su progreso. Los milestones
ordenan el project; los projects agrupan el trabajo.
_Avoid_: Phase, sprint, iteration, part

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

**Snapshot**:
El markdown derivado de un issue en el repo (`.prime-board/issues/AT-172.md`), pensado para
leerse en un PR. Se regenera; nunca se edita a mano.
_Avoid_: Dump, export file

**Index**:
La base SQLite derivada del log, usada para queries, filtros y full-text. Es descartable y se
reconstruye con `bun run rebuild`.
_Avoid_: Database, source of truth, cache

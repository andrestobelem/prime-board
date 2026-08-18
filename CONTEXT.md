# prime-board

prime-board es un gestor de trabajo para agentes. Este glosario fija las entidades, relaciones y
alcances del dominio; los términos canónicos se conservan en inglés porque también son los
identificadores de la aplicación.

## Espacio y autorización

**Workspace**:
Límite de autorización y estado operativo que contiene actors, teams y recursos de planificación.
La implementación actual mantiene un único Workspace por proceso/DB; la arquitectura se prepara
para que una instalación pueda contener más de uno sin habilitar todavía su selección o creación.
_Avoid_: Organization, tenant, account

**Workspace Context**:
Identidad efectiva del Workspace que acompaña una operación de API, CLI, MCP o UI y delimita sus
lecturas, mutaciones, eventos y réplica. En el modo actual siempre resuelve el único Workspace de
la instalación; no es un valor que el caller pueda falsificar mediante un input.
_Avoid_: Current organization, namespace

**Actor**:
Persona o agente que opera uno o más Workspaces. Puede crear y asignar issues, comentar,
autenticarse y recibir actividad; `Human` y `Agent` son tipos de Actor, no roles de autorización.
La implementación actual conserva la identidad del Actor en el Workspace único mientras se prepara
la futura relación de Membership de Workspace.
_Avoid_: User, account

**Workspace Role**:
Capacidad de un Actor dentro de un Workspace: `admin` o `member`. En el modo single-workspace
actual se conserva de forma compatible como atributo global del Actor; la preparación multi-workspace
lo trasladará a una Membership de Workspace antes de habilitar más de uno.
_Avoid_: Workspace membership, account role

**Workspace Membership**:
Relación futura entre un Actor y un Workspace que expresa pertenencia, rol, estado de acceso y
posibles límites de sus credenciales. Todavía no se expone como entidad operativa separada porque
la instalación sigue teniendo un único Workspace.
_Avoid_: Team membership, seat

**Team**:
Agrupación de trabajo que posee sus workflow states, cycles y configuración team-scoped, y define
el prefijo de los identifiers (`AT`, `PB`, `PRB`). Cada Issue pertenece a exactamente un Team.
_Avoid_: Squad, group

**Membership**:
Relación entre un Actor y un Team. Tiene rol `member` u `owner`; el owner administra el roster y
no puede eliminarse al último owner. Membership y asignación de una Issue son relaciones distintas.
_Avoid_: User assignment, seat

**Scope**:
Alcance de pertenencia y visibilidad de un recurso: `workspace`, `team`, `project` o `personal`.
Un recurso puede heredar autorización de su scope aunque su contenido refiera a entidades de otro
scope.
_Avoid_: Tenant scope, namespace

**Workspace-scoped**:
Recurso sin Team asociado, visible para cualquier Actor autenticado y administrable según su
Workspace Role.
_Avoid_: Global, public

**Team-scoped**:
Recurso asociado a un Team. Su lectura o mutación puede depender de la Membership de ese Team;
los owners y admins conservan las capacidades administrativas definidas por el producto.
_Avoid_: Group-scoped

**Project-scoped**:
Recurso que pertenece a un Project y hereda el alcance de los Teams asociados a ese Project.
Milestones y Project Updates son project-scoped.
_Avoid_: Epic-scoped

## Trabajo

**Identifier**:
Clave legible e inmutable de una Issue (`AT-172`): prefijo del Team más un número único dentro de
ese Team. No se renumera ni se reasigna.
_Avoid_: Issue key, ticket number, slug

**Issue**:
Unidad de trabajo perteneciente a un Team, con título, descripción, Workflow State, Priority,
Creator y, opcionalmente, Assignee, Parent, Project, Milestone, Cycle y Labels. Puede archivarse
sin dejar de existir.
_Avoid_: Ticket, task, card, story

**Creator**:
Actor que originó una Issue. Es un dato de procedencia y no implica ownership ni permisos sobre la
Issue.
_Avoid_: Owner, author

**Assignee**:
Actor responsable de una Issue en un momento dado. Una Issue puede no tener Assignee; la
asignación no crea una Membership ni exige que el Actor pertenezca al Team.
_Avoid_: Owner, member

**Sub-issue**:
Issue cuyo Parent es otra Issue del mismo Team. No es una entidad distinta: es una relación
jerárquica entre Issues y no una Relation.
_Avoid_: Subtask, child task

**Parent**:
Relación jerárquica opcional de una Issue hacia otra Issue del mismo Team. La cadena no puede
formar ciclos.
_Avoid_: Epic, container

**Relation**:
Arista tipada entre dos Issues: `blocks`/`blocked_by` es dirigida y acíclica, `related` es
simétrica y `duplicate_of`/`duplicated_by` es dirigida. Se almacena una sola relación canónica y
cada extremo la observa con su tipo inverso cuando corresponde.
_Avoid_: Link, dependency, edge

**Blocked**:
Estado derivado de una Issue abierta que tiene al menos una Relation `blocked_by` cuyo bloqueante
sigue abierto.
_Avoid_: Stuck, waiting

**Frontier**:
Conjunto derivado de Issues abiertas cuyos bloqueantes están todos cerrados. Delimita el trabajo
que puede avanzar sin esperar otra Issue.
_Avoid_: Unblocked set, ready queue

**Workflow State**:
Posición de una Issue en el ciclo de vida de su Team (`Todo`, `In Progress`, `Ready for Agent`,
etc.). Cada Team define sus propios estados y cada estado declara un State Type.
_Avoid_: Status, column, stage

**State Type**:
Categoría semántica de un Workflow State: `triage`, `backlog`, `unstarted`, `started`,
`completed` o `canceled`. Las integraciones interpretan el tipo, no el nombre visible del estado.
_Avoid_: Status category, lifecycle type

**Label**:
Etiqueta acumulable y opcional de una Issue (`web`, `graphql`, `epic:repo-truth`). Puede ser
workspace-scoped o pertenecer a un Team; un Issue puede tener muchas Labels o ninguna.
_Avoid_: Tag, category

**Priority**:
Valor entero de 0 a 4: 0 sin prioridad, 1 urgent, 2 high, 3 medium y 4 low. Un número menor
representa mayor urgencia.
_Avoid_: Severity

**Archived**:
Estado de retención de una entidad que deja de aparecer en consultas normales, pero conserva su
identidad e historial y puede incluirse explícitamente en consultas históricas.
_Avoid_: Deleted, removed

## Planificación

**Project**:
Esfuerzo con nombre, estado y fecha objetivo que agrupa Issues de uno o varios Teams. La relación
Project–Team es many-to-many; para asignar una Issue, su Team debe estar asociado al Project.
_Avoid_: Epic, board

**Milestone**:
Fase ordenada dentro de un Project, con fecha objetivo y progreso derivado de sus Issues. Es
project-scoped y no es un Cycle.
_Avoid_: Phase, sprint, iteration

**Cycle**:
Ventana de tiempo de un Team (`upcoming`, `active` o `completed`) a la que se asignan Issues. Es
team-scoped y time-boxed; no representa una fase de Project.
_Avoid_: Sprint, iteration, milestone

**Initiative**:
Objetivo estratégico que agrupa Projects. Puede ser workspace-scoped o estar asociada a uno o
más Teams; no agrupa Issues directamente.
_Avoid_: Epic, theme, OKR

**Project Update**:
Nota narrativa de salud de un Project con estado `on_track`, `at_risk` u `off_track`, autor y
cuerpo. Es información de seguimiento, no un cambio de estado del Project.
_Avoid_: Status report, pulse

## Colaboración y superficies personales

**Review**:
Solicitud de revisión entre Actors sobre una Issue, con ciclo `requested` → `in_progress` →
`approved` o `rejected`.
_Avoid_: PR review, approval request

**Saved View**:
Preset nombrado de filtros, orden, agrupación y columnas. Puede ser `personal`, `team` o
`workspace`; una vista personal pertenece a su Actor y una vista team requiere el Team indicado.
_Avoid_: Filter, bookmark

**Favorite**:
Relación privada y ordenada entre un Actor y un Project o Saved View. No cambia la visibilidad ni
la pertenencia del recurso favorito.
_Avoid_: Bookmark, shortcut

**Activity**:
Evento append-only asociado a una Issue que registra un cambio observable, su Actor y su momento.
Alimenta el historial, el Inbox y la réplica del repositorio; no es por sí solo el estado operativo
actual de la Issue.
_Avoid_: Audit log, changelog

**Comment**:
Texto que un Actor agrega a una Issue. El contenido pertenece a la conversación de la Issue y
además genera una Activity `commented`; no se duplica dentro del Issue Markdown.
_Avoid_: Note, message

**Inbox**:
Proyección personal de Activity relevante para un Actor, como asignaciones, cambios de Issues o
menciones. No es un segundo historial: cada entrada referencia una Activity y su estado personal se
mantiene mediante un Inbox Receipt.
_Avoid_: Notifications, feed, mailbox

**Inbox Receipt**:
Estado personal de un Actor sobre una entrada del Inbox: leída o archivada. No modifica la
Activity ni altera su relevancia histórica para otros Actors.
_Avoid_: Notification state

**Webhook**:
Suscripción de un Actor a eventos del workspace, entregada a una URL externa. Es una superficie de
integración y no una fuente adicional del estado de las entidades.
_Avoid_: Callback, notification

## Registro y réplica

**Operational State**:
Estado vigente del Workspace que la API consulta y modifica. Es la referencia para resolver
permisos, filtros y relaciones actuales.
_Avoid_: Snapshot, cache

**Repository Replica**:
Representación versionada y legible del Operational State, sus Activities y metadatos. Se genera
para revisión, recuperación y colaboración; no se edita manualmente ni sustituye al estado
operativo sin un rebuild explícito.
_Avoid_: Backup, dump

**Log**:
Serie versionada de Activities de una Issue dentro de la Repository Replica
(`.prime-board/log/AT-172.jsonl`). Conserva el historial exportado y puede participar en un rebuild,
pero la API sigue siendo la autoridad operativa.
_Avoid_: Journal, source of truth

**Issue Markdown**:
Representación derivada y legible de una Issue dentro de la Repository Replica
(`.prime-board/issues/AT-172.md`). Se regenera desde el estado operativo y sus referencias; nunca
se edita a mano.
_Avoid_: Snapshot, dump

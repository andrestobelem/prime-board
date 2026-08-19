# prime-board

prime-board es un gestor de trabajo para agentes. Este glosario fija las entidades, relaciones y
alcances del dominio; los términos canónicos se conservan en inglés porque también son los
identificadores de la aplicación.

## Espacio y autorización

**Workspace**:
Límite de autorización y estado operativo que contiene actors, teams y recursos de planificación.
El modelo objetivo permite varios Workspaces dentro de una DB/proceso, cada uno aislado por su
Workspace Context; la implementación actual todavía opera con un único Workspace hasta completar
PRB-411–420. En el dominio se conserva este término aunque Linear use `Organization` en GraphQL.
_Avoid_: Organization, tenant, account

**Workspace Context**:
Identidad efectiva del Workspace que acompaña una operación de API, CLI, MCP o UI y delimita sus
lecturas, mutaciones, eventos y réplica. Debe resolverse desde credencial, Membership y selector
validado; nunca es autoridad un `workspaceId` enviado sin prueba de acceso. Hoy resuelve el único
Workspace de la instalación; PRB-411–420 lo convertirá en contexto seleccionable y no falsificable.
_Avoid_: Current organization, namespace

**Actor**:
Persona o agente que opera uno o más Workspaces. Puede crear y asignar issues, comentar,
autenticarse y recibir actividad; `Human` y `Agent` son tipos de Actor, no roles de autorización.
En el modelo objetivo la identidad es global y su rol/estado viven en cada Workspace Membership; la
implementación actual conserva compatibilidad con columnas globales mientras se prepara la migración.
Su ciclo de acceso por Workspace se expresa con `active`, `suspended` o `left`: un Actor no activo no
puede autenticarse en ese Workspace, pero su autoría histórica permanece. Las invitaciones son locales
y entregan el token y la API key una sola vez.
_Avoid_: User, account

**Workspace Role**:
Capacidad de un Actor dentro de un Workspace: `admin` o `member`. Durante la transición se conserva
`workspace_role` como compatibilidad single-workspace; antes de habilitar un segundo Workspace la
autoridad se traslada a la Membership correspondiente.
_Avoid_: Workspace membership, account role

**Workspace Membership**:
Relación entre un Actor y un Workspace que expresa pertenencia, rol, estado de acceso y posibles
límites de sus credenciales. Es la autoridad objetivo para roster y permisos; mientras la migración no
esté habilitada, la instalación conserva la compatibilidad single-workspace y no expone aún esta
relación como selector operativo.
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
Recurso sin Team asociado, visible para cualquier Actor con Membership activa en el Workspace y
administrable según su Workspace Role efectivo.
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
Proyección legible de un evento de dominio observable asociado a una Issue, con su Actor y momento.
Alimenta el historial, el Inbox y los snapshots Markdown; el Log canónico conserva el evento que la
origina y Activity no es por sí sola la fuente de verdad ni el estado actual.
_Avoid_: Audit log, changelog, CDC del WAL

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
Proyección vigente del Workspace que la API consulta para permisos, filtros y relaciones actuales.
En la topología PostgreSQL objetivo es reconstruible desde el Repository Source; el runtime SQLite
actual conserva la autoridad operativa hasta completar el cutover.
_Avoid_: Source of truth, cache

**Repository Source**:
Estado compartido y versionado del dominio. Su Log append-only es la autoridad canónica para la
topología PostgreSQL objetivo; los snapshots Markdown y el Operational State se derivan de él.
Los secretos y las proyecciones personales no forman parte de esta fuente.
_Avoid_: Repository Replica, backup, dump

**Log**:
Serie versionada de eventos de dominio append-only dentro del Repository Source
(`.prime-board/log/AT-172.jsonl`). Cada evento tiene identidad, tipo, actor, momento y payload
suficiente para que un reducer reconstruya el estado de su agregado; los merges se resuelven de
forma determinista y PostgreSQL puede reproyectarse desde cero.
_Avoid_: Activity, CDC del WAL, source of truth aislado del Repository Source

**Issue Markdown**:
Representación derivada y legible de una Issue dentro del Repository Source
(`.prime-board/issues/AT-172.md`). Se regenera desde el Log y puede alimentar un importador
explícito que emita eventos; no escribe directamente en PostgreSQL ni se edita como autoridad.
_Avoid_: Snapshot editable, dump

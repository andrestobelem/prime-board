# prime-board

prime-board es un gestor de trabajo para agentes. Este glosario define las entidades, las relaciones y los límites del dominio. Conserva los términos canónicos en inglés porque también son identificadores de la aplicación.

## Espacio y autorización

**Workspace**:
Límite de autorización y estado operativo. Contiene Actors, Teams y recursos de planificación. El modelo objetivo admite varios Workspaces en una misma DB/proceso y aísla cada uno mediante su Workspace Context. La implementación actual usa un solo Workspace hasta completar PRB-411–420. El dominio conserva este término aunque Linear use `Organization` en GraphQL.
_Avoid_: Organization, tenant, account

**Workspace Context**:
Identidad efectiva del Workspace que acompaña cada operación de API, CLI, MCP o UI. Delimita lecturas, mutaciones, eventos y réplicas. El sistema debe resolverlo desde una credencial, una Membership y un selector validado. Un `workspaceId` enviado sin prueba de acceso nunca tiene autoridad. La instalación actual resuelve el único Workspace disponible. PRB-411–420 convertirá el contexto en seleccionable y no falsificable.
_Avoid_: Current organization, namespace

**Actor**:
Persona o agente que opera uno o más Workspaces. Puede crear y asignar Issues, comentar, autenticarse y recibir Activity. `Human` y `Agent` son tipos de Actor, no roles de autorización. El modelo objetivo mantiene la identidad global y guarda el rol y el estado en cada Workspace Membership. La implementación actual conserva columnas globales por compatibilidad mientras prepara la migración.

El ciclo de acceso de un Actor en un Workspace usa `active`, `suspended` o `left`. Un Actor que no está `active` no puede autenticarse en ese Workspace, pero su autoría histórica permanece. Las invitaciones son locales y entregan el token y la API key una sola vez.
_Avoid_: User, account

**Workspace Role**:
Capacidad de un Actor dentro de un Workspace: `admin` o `member`. Durante la transición, `workspace_role` mantiene compatibilidad con el modo single-workspace. Antes de habilitar un segundo Workspace, la autoridad pasará a la Workspace Membership correspondiente.
_Avoid_: Workspace membership, account role

**Workspace Membership**:
Relación entre un Actor y un Workspace. Expresa pertenencia, rol, estado de acceso y posibles límites de sus credenciales. Es la autoridad objetivo para el roster y los permisos. Mientras la migración no esté habilitada, la instalación conserva el modo single-workspace y no ofrece esta relación como selector operativo.
_Avoid_: Team membership, seat

**Team**:
Agrupación de trabajo que posee sus Workflow States, Cycles y configuración team-scoped. También define el prefijo de los Identifiers (`AT`, `PB`, `PRB`). Cada Issue pertenece a un solo Team.
_Avoid_: Squad, group

**Membership**:
Relación entre un Actor y un Team. Tiene rol `member` u `owner`. El owner administra el roster y no puede eliminar al último owner del Team. Membership y asignación de una Issue son relaciones distintas.
_Avoid_: User assignment, seat

**Scope**:
Alcance de pertenencia y visibilidad de un recurso: `workspace`, `team`, `project` o `personal`. Un recurso puede heredar autorización de su Scope aunque su contenido refiera a entidades de otro Scope.
_Avoid_: Tenant scope, namespace

**Workspace-scoped**:
Recurso sin Team asociado. Cualquier Actor con Membership activa en el Workspace puede leerlo. El Workspace Role efectivo determina quién puede administrarlo.
_Avoid_: Global, public

**Team-scoped**:
Recurso asociado a un Team. Su lectura o mutación puede depender de la Membership de ese Team. Owners y admins conservan las capacidades administrativas definidas por el producto.
_Avoid_: Group-scoped

**Project-scoped**:
Recurso que pertenece a un Project y hereda el alcance de los Teams asociados a ese Project. Milestones y Project Updates son project-scoped.
_Avoid_: Epic-scoped

## Trabajo

**Identifier**:
Clave legible e inmutable de una Issue (`AT-172`). Combina el prefijo del Team con un número único dentro de ese Team. El sistema no la renumera ni la reasigna.
_Avoid_: Issue key, ticket number, slug

**Issue**:
Unidad de trabajo que pertenece a un Team. Tiene título, descripción, Workflow State, Priority y Creator. Puede tener Assignee, Parent, Project, Milestone, Cycle y Labels. El sistema puede archivarla sin eliminarla.
_Avoid_: Ticket, task, card, story

**Creator**:
Actor que originó una Issue. Indica procedencia, pero no concede ownership ni permisos sobre la Issue.
_Avoid_: Owner, author

**Assignee**:
Actor responsable de una Issue en un momento dado. Una Issue puede no tener Assignee. La asignación no crea una Membership ni exige que el Actor pertenezca al Team.
_Avoid_: Owner, member

**Sub-issue**:
Issue cuyo Parent es otra Issue del mismo Team. No es una entidad distinta: es una relación jerárquica entre Issues, no una Relation.
_Avoid_: Subtask, child task

**Parent**:
Relación jerárquica opcional entre una Issue y otra Issue del mismo Team. La cadena no puede formar ciclos.
_Avoid_: Epic, container

**Relation**:
Arista tipada entre dos Issues. `blocks`/`blocked_by` es dirigida y acíclica; `related` es simétrica; `duplicate_of`/`duplicated_by` es dirigida. El sistema almacena una sola relación canónica y cada extremo observa el tipo inverso cuando corresponde.
_Avoid_: Link, dependency, edge

**Blocked**:
Estado derivado de una Issue abierta. La Issue está Blocked si tiene al menos una Relation `blocked_by` cuyo bloqueante permanece abierto.
_Avoid_: Stuck, waiting

**Frontier**:
Conjunto derivado de Issues abiertas cuyos bloqueantes están todos cerrados. Delimita el trabajo que puede avanzar sin esperar otra Issue.
_Avoid_: Unblocked set, ready queue

**Workflow State**:
Posición de una Issue en el ciclo de vida de su Team (`Todo`, `In Progress`, `Ready for Agent`, etc.). Cada Team define sus estados y cada estado declara un State Type.
_Avoid_: Status, column, stage

**State Type**:
Categoría semántica de un Workflow State: `triage`, `backlog`, `unstarted`, `started`, `completed` o `canceled`. Las integraciones interpretan el tipo, no el nombre visible del estado.
_Avoid_: Status category, lifecycle type

**Label**:
Etiqueta opcional y acumulable de una Issue (`web`, `graphql`, `epic:repo-truth`). Puede ser workspace-scoped o pertenecer a un Team. Una Issue puede tener muchas Labels o ninguna.
_Avoid_: Tag, category

**Priority**:
Valor entero de 0 a 4: 0 sin prioridad, 1 urgent, 2 high, 3 medium y 4 low. Un número menor representa mayor urgencia.
_Avoid_: Severity

**Archived**:
Estado de retención de una entidad. La entidad deja de aparecer en consultas normales, pero conserva su identidad y su historial. Las consultas históricas pueden incluirla de forma explícita.
_Avoid_: Deleted, removed

## Planificación

**Project**:
Esfuerzo con nombre, estado y fecha objetivo que agrupa Issues de uno o varios Teams. La relación Project–Team es many-to-many. Para asignar una Issue, su Team debe estar asociado al Project.
_Avoid_: Epic, board

**Milestone**:
Fase ordenada dentro de un Project, con fecha objetivo y progreso derivado de sus Issues. Es project-scoped y no es un Cycle.
_Avoid_: Phase, sprint, iteration

**Cycle**:
Ventana de tiempo de un Team (`upcoming`, `active` o `completed`) a la que se asignan Issues. Es team-scoped y time-boxed; no representa una fase de Project.
_Avoid_: Sprint, iteration, milestone

**Initiative**:
Objetivo estratégico que agrupa Projects. Puede ser workspace-scoped o asociarse a uno o más Teams. No agrupa Issues directamente.
_Avoid_: Epic, theme, OKR

**Project Update**:
Nota narrativa sobre la salud de un Project. Tiene estado `on_track`, `at_risk` u `off_track`, autor y cuerpo. Describe el seguimiento; no cambia el estado del Project.
_Avoid_: Status report, pulse

## Colaboración y superficies personales

**Review**:
Solicitud de revisión entre Actors sobre una Issue. Su ciclo es `requested` → `in_progress` → `approved` o `rejected`.
_Avoid_: PR review, approval request

**Saved View**:
Preset nombrado de filtros, orden, agrupación y columnas. Puede tener Scope `personal`, `team` o `workspace`. Una vista personal pertenece a su Actor; una vista team requiere el Team indicado.
_Avoid_: Filter, bookmark

**Favorite**:
Relación privada y ordenada entre un Actor y un Project o Saved View. No cambia la visibilidad ni la pertenencia del recurso favorito.
_Avoid_: Bookmark, shortcut

**Activity**:
Proyección legible de un evento de dominio observable asociado a una Issue. Incluye Actor y momento. Alimenta el historial, el Inbox y los snapshots Markdown. El Log canónico conserva el evento de origen. Activity no es por sí sola la fuente de verdad ni el estado actual.
_Avoid_: Audit log, changelog, CDC del WAL

**Comment**:
Texto que un Actor agrega a una Issue. El contenido pertenece a la conversación de la Issue y genera una Activity `commented`. El sistema no lo duplica dentro del Issue Markdown.
_Avoid_: Note, message

**Inbox**:
Proyección personal de Activity relevante para un Actor, como asignaciones, cambios de Issues o menciones. No es un segundo historial. Cada entrada referencia una Activity y su estado personal se mantiene mediante un Inbox Receipt.
_Avoid_: Notifications, feed, mailbox

**Inbox Receipt**:
Estado personal de un Actor sobre una entrada del Inbox: leída o archivada. No modifica la Activity ni cambia su relevancia histórica para otros Actors.
_Avoid_: Notification state

**Webhook**:
Suscripción de un Actor a eventos del Workspace, entregada a una URL externa. Es una superficie de integración, no una fuente adicional del estado de las entidades.
_Avoid_: Callback, notification

## Registro y réplica

**Operational State**:
Proyección vigente del Workspace. La API la consulta para permisos, filtros y relaciones actuales. En la topología PostgreSQL objetivo, el sistema puede reconstruirla desde el Repository Source. El runtime SQLite actual conserva la autoridad operativa hasta completar el cutover.
_Avoid_: Source of truth, cache

**Repository Source**:
Estado compartido y versionado del dominio. En la topología PostgreSQL objetivo, su Log append-only es la autoridad canónica. Los snapshots Markdown y el Operational State se derivan de él. Los secretos y las proyecciones personales quedan fuera de esta fuente.
_Avoid_: Repository Replica, backup, dump

**Log**:
Serie versionada de eventos de dominio append-only dentro del Repository Source (`.prime-board/log/AT-172.jsonl`). Cada evento tiene identidad, tipo, actor, momento y payload suficiente para que un reducer reconstruya el estado de su agregado. Los merges se resuelven de forma determinista y PostgreSQL puede reproyectarse desde cero.
_Avoid_: Activity, CDC del WAL, source of truth aislado del Repository Source

**Issue Markdown**:
Representación derivada y legible de una Issue dentro del Repository Source (`.prime-board/issues/AT-172.md`). El sistema la regenera desde el Log. Un importador explícito puede leerla y emitir eventos; la representación no escribe directamente en PostgreSQL ni actúa como autoridad.
_Avoid_: Snapshot editable, dump

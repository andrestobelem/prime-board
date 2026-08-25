# prime-board

prime-board es un gestor de trabajo para agentes. Este glosario define las entidades, las relaciones y los límites del dominio. Conserva los términos canónicos en inglés porque también son identificadores de la aplicación.

## Espacio y autorización

**Workspace**:
Límite de autorización y estado operativo. Contiene Actors, Teams y recursos de planificación. Varios Workspaces pueden vivir en una misma DB/proceso SQLite y cada una queda aislada por su Workspace Context. La instalación inicial sigue creando un Workspace, pero SQLite ya permite crear, seleccionar y operar varios. Durante la migración incremental, el backend PostgreSQL conserva un solo Workspace por DB/proceso. El dominio conserva este término aunque Linear use `Organization` en GraphQL.
_Avoid_: Organization, tenant, account

**Workspace Context**:
Identidad efectiva del Workspace que acompaña cada operación de API, CLI, MCP o UI. Delimita lecturas, mutaciones, eventos y réplicas. En SQLite, el sistema lo resuelve mediante el grant de la credencial, una Workspace Membership activa y un selector validado cuando hace falta. Un `workspaceId` enviado sin prueba de acceso nunca tiene autoridad. En PostgreSQL, la migración actual mantiene el contexto ligado al único Workspace y todavía no ofrece selección multi-Workspace.
_Avoid_: Current organization, namespace

**Actor**:
Persona o agente que opera uno o más Workspaces. Puede crear y asignar Issues, comentar, autenticarse y recibir Activity. `Human` y `Agent` son tipos de Actor, no roles de autorización. El modelo objetivo mantiene la identidad global y guarda el rol y el estado en cada Workspace Membership. La implementación actual conserva columnas globales por compatibilidad mientras prepara la migración.

El ciclo de acceso de un Actor en un Workspace usa `active`, `suspended` o `left`. Un Actor que no está `active` no puede autenticarse en ese Workspace, pero su autoría histórica permanece. Las invitaciones son locales y entregan el token y la API key una sola vez.
_Avoid_: User, account

**Workspace Role**:
Capacidad de un Actor dentro de un Workspace: `admin` o `member`. `workspace_role` en Actor se conserva por compatibilidad. En SQLite, el rol efectivo proviene de la Workspace Membership activa y el grant de la credencial. En PostgreSQL, la migración actual todavía usa `workspace_role` para su único Workspace.
_Avoid_: Workspace membership, account role

**Workspace Membership**:
Relación entre un Actor y un Workspace. Expresa pertenencia, rol, estado de acceso y posibles límites de sus credenciales. En SQLite ya es la autoridad operativa para el roster, los permisos y la selección entre Workspaces. En PostgreSQL, la ruta en migración conserva un solo Workspace y todavía no usa Membership para seleccionar varios.
_Avoid_: Team membership, seat

**Team**:
Agrupación de trabajo que posee sus Workflow States, Cycles y configuración team-scoped. También define el prefijo de los Identifiers (`AT`, `PB`, `PRB`). Cada Issue pertenece a un solo Team.
_Avoid_: Squad, group

**Team Visibility**:
Regla de descubrimiento y lectura de un Team. `public` permite a los Actors activos del Workspace descubrir y leer el Team; `private` limita esa capacidad a sus Memberships activas y a los admins. No concede capacidad de escritura.
_Avoid_: Public access, privacy

**Team Access Policy**:
Regla de escritura y asignación de un Team. `workspace_members` permite esas operaciones a los Actors activos del Workspace en un Team público; `team_members` exige Membership activa. Un Team privado siempre usa `team_members`; esta política es independiente de Team Visibility y Workspace Role.
_Avoid_: Permission level, role

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
Actor responsable de una Issue en un momento dado. Una Issue puede no tener Assignee. El Assignee debe ser un Actor `active` del Workspace; la Team Access Policy puede exigir una Membership activa en el Team. La asignación no crea una Membership.
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
Etiqueta opcional de una Issue (`web`, `graphql`, `epic:repo-truth`). Puede ser de Workspace o pertenecer a un Team, tiene descripción y puede archivarse sin quitarse de Issues existentes. Una Label puede ser un grupo de un nivel con hasta 250 hijas; una Issue solo puede tener una hija de cada grupo.
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

## Contenido

**Document**:
Unidad de contenido Markdown que pertenece a un Workspace. Puede ser global o vincularse a exactamente un recurso de trabajo: Issue, Project, Team, Initiative o Cycle. Es contenido largo independiente de la descripción operativa de una Issue.
_Avoid_: Issue description, attachment, page

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
Proyección legible de un evento de dominio observable asociado a una Issue. Incluye Actor y momento. Alimenta el historial, el Inbox y los snapshots Markdown. El Event Log conserva el evento de origen en la réplica actual y será la autoridad canónica en la topología PostgreSQL de ADR-0019. Activity no es por sí sola la fuente de verdad ni el estado actual.
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

## Persistencia

**SQLite backend**:
Backend predeterminado de prime-board. Mantiene el modo local-first y la operación sin configuración adicional. Una DB/proceso SQLite puede contener varios Workspaces aislados, con selección validada por Workspace Context. SQLite conserva la autoridad operativa mientras la migración a PostgreSQL siga en curso.
_Avoid_: SQLite-only contract, cache

**PostgreSQL backend**:
Backend opcional que se activa de forma explícita. La migración es incremental: PostgreSQL recibe los dominios que ya tienen adaptador, mientras el resto conserva su camino de transición. Durante esta migración, PostgreSQL mantiene un solo Workspace por DB/proceso y no ofrece selección multi-Workspace. ADR-0019 define su arquitectura objetivo, con el Event Log del Repository Source como autoridad y PostgreSQL como proyección.
_Avoid_: PostgreSQL default, replica completa

## Registro y réplica

**Operational State**:
Proyección vigente del Workspace. La API la consulta para permisos, filtros y relaciones actuales. SQLite la conserva como autoridad operativa por defecto. PostgreSQL mantiene el estado de los dominios migrados durante la transición, pero no reemplaza todavía a SQLite ni al Repository Source. ADR-0019 define su reconstrucción desde el Repository Source en la topología PostgreSQL objetivo.
_Avoid_: Source of truth, cache

**Repository Source**:
Estado compartido y versionado del dominio. En el runtime SQLite actual, `.prime-board` es una réplica controlada de SQLite, según ADR-0004. ADR-0019 define la transición en la que su Event Log append-only será la autoridad canónica para la topología PostgreSQL objetivo. Los secretos y las proyecciones personales quedan fuera de esta fuente.
_Avoid_: Repository Replica, backup, dump

**Event Log**:
Registro append-only de eventos de dominio del Repository Source. Cada evento tiene identidad, tipo, Actor, momento y payload suficiente para reconstruir el estado de su agregado. En el runtime SQLite actual, forma parte de la réplica y la DB conserva la autoridad operativa; en la topología PostgreSQL de ADR-0019, será la fuente canónica y PostgreSQL podrá reproyectarse desde cero. No es Activity ni un historial operativo por Issue. Los merges se resuelven de forma determinista.
_Avoid_: Log, Activity, Audit log, CDC del WAL

**Issue Markdown**:
Representación derivada y legible de una Issue dentro del Repository Source (`.prime-board/issues/AT-172.md`). En el runtime SQLite actual, se genera como parte de la réplica. En la topología PostgreSQL de ADR-0019, se regenerará desde el Event Log. Un importador explícito puede leerla y emitir eventos; la representación no escribe directamente en PostgreSQL ni actúa como autoridad.
_Avoid_: Snapshot editable, dump

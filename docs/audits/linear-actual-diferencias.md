# Diferencias actuales entre prime-board y Linear

> Ticket: [PRB-421](http://localhost:3333/issue/PRB-421)
> Épica relacionada: [Soporte multi-workspace](http://localhost:3333/project/01a0193e-16e4-7000-9836-0e8495aafea6)
> Fecha del relevamiento: 2026-08-19 (snapshot histórico)
> Verificación del contrato local vigente: 2026-08-23
> Commit base de la revisión: `8899e11` (`main`), con cambios locales verificados
> Estado: documento canónico de comparación. No promete paridad total ni replica todas las funciones de Linear.

## Propósito

Este documento consolida las notas anteriores sobre las diferencias entre prime-board y Linear. Clasifica cada
diferencia en uno de cuatro casos:

- **Implementado:** prime-board ofrece una capacidad equivalente para su modelo.
- **Parcial:** existe el concepto, pero faltan campos, operaciones o una superficie de cliente.
- **Ausente:** Linear lo ofrece y prime-board todavía no tiene una representación equivalente.
- **Divergencia intencional / fuera de alcance:** la diferencia es una decisión de producto, no una deuda
  que haya que cerrar para llamar “completo” al board para agentes.

La comparación usa como referencias el Linear documentado públicamente y un snapshot del código local.
Las auditorías anteriores siguen siendo útiles y aparecen enlazadas al final. Este archivo es el índice de
decisión. El relevamiento de Linear y los conteos del 2026-08-19 son históricos; no son el contrato local
vigente.

## Método y fuentes

### Fuentes de Linear

Consultamos estas fuentes primarias de Linear el 2026-08-19:

- [Workspaces](https://linear.app/docs/workspaces)
- [Login methods](https://linear.app/docs/login-methods)
- [Members and roles](https://linear.app/docs/members-roles)
- [Teams](https://linear.app/docs/teams)
- [Private teams](https://linear.app/docs/private-teams)
- [Sub-teams](https://linear.app/docs/sub-teams)
- [Issue status y workflows](https://linear.app/docs/configuring-workflows)
- [GraphQL API](https://linear.app/developers/graphql)
- [OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)
- [OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization)
- [API y webhooks](https://linear.app/docs/api-and-webhooks)
- [Issue relations](https://linear.app/docs/issue-relations)
- [Custom views](https://linear.app/docs/custom-views)
- [Filters](https://linear.app/docs/filters)
- [Display options](https://linear.app/docs/display-options)
- [Inbox](https://linear.app/docs/inbox)
- [Documents](https://linear.app/docs/documents)
- [Projects](https://linear.app/docs/projects)
- [Project overview](https://linear.app/docs/project-overview)
- [Project milestones](https://linear.app/docs/project-milestones)
- [Schema GraphQL público actual](https://studio.apollographql.com/public/Linear-API/schema/reference?variant=current)

El endpoint GraphQL público documentado por Linear es `https://api.linear.app/graphql`. La introspección
identifica `Organization` como el objeto que la documentación de producto llama Workspace y lo describe
como el contenedor raíz de teams, usuarios, proyectos, issues y settings. En el snapshot read-only de esta
fecha se observaron 161 queries, 361 mutations, 85 campos de `Issue`, 76 de `Project`, 4 de `PageInfo`,
75 de `Organization`, 43 de `User`, 82 de `Team`, 28 de `CustomView`, 27 de `Notification` y 14 de
`Webhook`. El endpoint puede cambiar. Estos números solo sirven como referencia fechada.

### Snapshot local del relevamiento (2026-08-19)

Revisamos el SDL, las migraciones, los dominios, los resolvers y las superficies GraphQL/CLI/MCP/UI.
El snapshot local de esa fecha contenía 25 campos de `Query`, 62 de `Mutation`, 24 campos de `Issue`,
13 de `Project` y 2 de `PageInfo`. Es evidencia histórica, no una lista vigente.

- `packages/schema/src/sdl.ts`
- `apps/server/src/db/migrations/0001_init.sql` a `0023_webhook_team_scope.sql` (snapshot histórico);
  el runner SQLite vigente llega a `0028_issue_subscribers.sql`.
- `apps/server/src/auth/viewer.ts`, `apps/server/src/auth/permissions.ts` y
  `apps/server/src/domain/workspace-context.ts`
- `apps/server/src/export/exporter.ts`, `importer.ts`, `replica-metadata.ts` y `repo-sync.ts`
- `apps/cli/src/commands/workspace.ts`, `apps/cli/src/config.ts` y `apps/cli/src/api.ts`
- `apps/mcp/src/api.ts` y `apps/mcp/src/server.ts`
- `apps/web/src/components/Sidebar.tsx`, `App.tsx`, `router.tsx`, `api.ts` y `ui-context.ts`

### Contrato local vigente (verificado el 2026-08-23)

El código actual separa dos backends. `SQLite` es el valor predeterminado en
`apps/server/src/config.ts`; `PRIME_BOARD_PERSISTENCE=postgres` activa el backend opcional de
PostgreSQL. No hay un único esquema de migraciones que describa ambos backends.

- El runner de SQLite en `apps/server/src/db/database.ts` aplica las migraciones `0001` a `0028`.
  `0024` y `0025` agregan raíces, columnas `workspace_id` e invariantes compuestas; `0026` agrega
  grants de API keys por Workspace, `0027` agrega Documents y `0028` agrega suscriptores de Issues.
- El migrador de PostgreSQL en `apps/server/src/db/postgres/migrator.ts` aplica diez migraciones
  independientes (`0001` a `0010`). `0005` agrega Documents, `0006` agrega suscriptores, `0007`
  agrega Memberships y grants de Workspace, `0008` agrega `workspace_id` a los límites de Team de
  API keys y `0009` hace explícito el Workspace efectivo de cada grant. Su baseline conserva un
  singleton de Workspace y todavía no representa todo el alcance multi-Workspace de SQLite.
- En SQLite, el contrato GraphQL vigente lista y crea Workspaces y acepta selección por contexto;
  la CLI y la web exponen esa selección. En PostgreSQL, `workspaceCreate` aún devuelve que la
  operación no está migrada y el resolver de auth conserva el singleton. Los resolvers migrados usan
  `context.persistence` para Actors, autenticación, API keys y límites, Teams, Issues, Relations,
  Projects, Milestones, Cycles, Labels, Documents, Activity, suscriptores, Reviews, Initiatives,
  Project Updates, Saved Views, Favorites, Inbox y Webhooks. Relations incluye lectura y mutaciones
  PostgreSQL desde PRB-437. Comments no tiene una ruta PostgreSQL. El event log canónico y el
  proyector Repository Source → PostgreSQL siguen fuera del runtime, según ADR-0019 y PRB-445/453.
  Los dominios sin path PG usan un SQLite efímero o rechazan la operación de forma explícita.
- El SDL actual contiene 28 campos de `Query`, 67 de `Mutation`, 25 de `Issue`, 14 de `Project` y
  2 de `PageInfo`. Estos números describen este commit, no un objetivo de paridad con Linear.

Linear.app estaba instalado y el proceso `Linear.app` (versión observada: 1.32.1) estaba activo. También
comprobamos que existía almacenamiento local de `linear.app`. Lo tratamos como solo lectura y no usamos su
contenido como contrato ni incorporamos identificadores del Workspace al documento. La observación de accesibilidad solo mostró una ventana de preferencias y otra sin nombre. La captura de
pantalla en primer plano mostró otra aplicación. No pudimos navegar de forma confiable el board de Linear
sin automatizar ni alterar la cuenta. No hicimos clicks, mutaciones ni cambios en Linear. Por eso, las
afirmaciones de producto se basan en la documentación oficial y el esquema público. La auditoría visual
existente es evidencia complementaria, no una suposición sobre una sesión de usuario.

## Resumen ejecutivo

prime-board ya cubre el núcleo necesario para un gestor agent-first: Teams, Issues, workflow,
labels, asignación de humanos y agentes, comentarios, actividad, Projects, ciclos, milestones, filtros,
CLI, MCP, API keys y webhooks. No es un cliente drop-in de Linear: el contrato GraphQL, los nombres, la
paginación y la cobertura son distintos.

La diferencia estructural más importante sigue siendo la frontera de Workspace, pero el estado depende del
backend. Linear permite varias Workspaces por cuenta y asigna cada dato a una de ellas. En SQLite, prime-board
ya tiene Workspace Memberships, grants, `workspace_id`, selección por contexto y aislamiento en las
migraciones `0024`–`0028`. Esa capacidad todavía es incremental y no se puede trasladar al backend
PostgreSQL: su baseline impone un singleton, no migra `workspaceCreate` y deja dominios en transición.
Por eso, “multi-Workspace” describe hoy el camino SQLite y el objetivo del producto, no una paridad de
backends ni un servicio hosted.

## Matriz canónica de diferencias

| Área                   | Linear actual                                                                                                      | prime-board actual                                                                                                                                                                                                                                                  | Clasificación                                      | Próximo paso                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Workspace              | Una cuenta puede pertenecer a varias Workspaces; cada una tiene miembros, Teams, datos y settings propios.         | SQLite permite varias Workspaces, Memberships, grants y selección por contexto; PostgreSQL conserva un singleton y `workspaceCreate` no está migrado.                                                                                                               | **Parcial por backend**.                           | PRB-411–420 y cutover PostgreSQL                                         |
| Nombre API             | Producto: Workspace; GraphQL: `Organization`.                                                                      | `Workspace` en dominio y GraphQL.                                                                                                                                                                                                                                   | **Divergencia intencional** de nomenclatura.       | Mantener `Workspace`; adaptar importaciones si hiciera falta.            |
| Identidad              | `User` tiene organización, roles, estado, memberships de Team y variantes guest/app.                               | `Actor` puede ser `human` o `agent`. SQLite aplica role/status por Membership y grants de key; PostgreSQL usa la Membership efectiva y conserva columnas globales por compatibilidad.                                                                               | **Parcial + divergencia agent-first**.             | PRB-413 y cutover PostgreSQL                                             |
| Workspace Membership   | La pertenencia a la Workspace delimita acceso; invitaciones tienen rol y Teams.                                    | Existe en SQLite con estado, rol, invitaciones y grants de API key. PostgreSQL tiene Memberships y grants desde `0007`, límites con Workspace desde `0008` y grants explícitos desde `0009`, pero conserva un singleton y no permite seleccionar varias Workspaces. | **Parcial por backend**.                           | PRB-413 y cutover PostgreSQL                                             |
| Team Membership        | User–Team es una relación separada; Team Owner no es Workspace Admin.                                              | `TeamMembership` es separada en ambos caminos; SQLite valida el Workspace de ambos extremos.                                                                                                                                                                        | **Parcial por backend**.                           | PRB-413–414 y cutover PostgreSQL                                         |
| Teams                  | Teams pueden ser públicos/privados, tener jerarquía, settings y acceso rico.                                       | Team, states, labels, cycles, memberships, visibilidad y política de acceso ya existen; no hay sub-teams.                                                                                                                                                           | **Parcial; sub-teams fuera de alcance**.           | PRB-414; evaluar sub-teams después.                                      |
| Team keys              | Linear publica `key` y shorthand de Issue; no se asume unicidad global entre Workspaces.                           | SQLite aplica unicidad por Workspace y contexto; el baseline PostgreSQL conserva `UNIQUE` global.                                                                                                                                                                   | **Parcial por backend**.                           | PRB-412 y cutover PostgreSQL                                             |
| Workflow               | Estados por Team, con descripción y automatizaciones adicionales.                                                  | Estados por Team con tipo semántico, color, posición y default.                                                                                                                                                                                                     | **Paridad suficiente + gap P1**.                   | No bloquea multi-workspace; revisar después.                             |
| Issue                  | Linear cubre núcleo, fechas, estimates, subscribers, attachments, documents, releases, history y más.              | Núcleo de issue, prioridad, parent, labels, Project/Cycle/Milestone, relations, comments y activity.                                                                                                                                                                | **Parcial**, intencional para MVP.                 | Priorizar solo según producto agent-first.                               |
| Identificador de Issue | `identifier` y `number`; shorthand se resuelve en su organización.                                                 | `TEAM-number`, `UNIQUE(team_id, number)`.                                                                                                                                                                                                                           | **Parcial; scope debe ser explícito**.             | PRB-412 y PRB-414                                                        |
| Relaciones             | `blocks`, `duplicate`, `related`, `similar` e inversas.                                                            | `blocks`, `duplicate_of`, `related` e inversas calculadas; no `similar`. PostgreSQL tiene lectura y mutaciones directas desde PRB-437.                                                                                                                              | **Parcial**.                                       | No bloquear multi-workspace salvo aislamiento de extremos.               |
| Comments/Activity      | Comentarios, historial, notificaciones y más entidades colaborativas.                                              | SQLite tiene Comments y Activity issue-céntricos; PostgreSQL tiene Activity e Inbox derivados, pero Comments no tiene una ruta de persistencia. El event log canónico sigue fuera del runtime.                                                                      | **Parcial + simplificación intencional**.          | PRB-415 para scope; features extra después.                              |
| Projects               | Projects, miembros, labels, documentos, relaciones/dependencias, milestones y updates.                             | Projects multi-Team, lead, estado, target date, milestones, issues y updates.                                                                                                                                                                                       | **Parcial**.                                       | PRB-412/414 para aislamiento; gaps de producto después.                  |
| Initiatives            | Agrupan Projects con más jerarquía, labels, updates y relaciones.                                                  | Agrupan Projects y Teams, con owner, estado, target date y progreso.                                                                                                                                                                                                | **Parcial**.                                       | Scopear ahora; ampliar después.                                          |
| Cycles                 | Cycles por Team con métricas y opciones adicionales.                                                               | Cycles por Team con carry-over y progreso.                                                                                                                                                                                                                          | **Paridad de núcleo**.                             | Scopear en PRB-412/414.                                                  |
| Saved Views            | Custom Views con filtros tipados, scopes, sharing, slug, preferencias y más recursos.                              | Saved Views personal/team/workspace con filtro JSON, orden, agrupación y columnas.                                                                                                                                                                                  | **Parcial**.                                       | Scopear ahora; editor avanzado después.                                  |
| Display options        | Layout, grouping, ordering y propiedades visibles integradas con Views.                                            | Parte de las preferencias existe en UI/localStorage; cobertura y persistencia son menores.                                                                                                                                                                          | **Parcial**.                                       | No bloquear multi-workspace; evitar cache cruzado en PRB-419.            |
| Búsqueda y filtros     | Linear ofrece filtros amplios, sugerencias y búsqueda contextual sobre más propiedades.                            | Hay filtros combinables y FTS5 sobre título y descripción; los comentarios no forman parte del índice FTS actual.                                                                                                                                                   | **Parcial**.                                       | No bloquear multi-workspace; PRB-416 debe conservar el scope del índice. |
| Inbox                  | Notifications con acciones, búsqueda, snooze y preferencias.                                                       | Inbox y receipts personales derivados de Activity.                                                                                                                                                                                                                  | **Parcial + divergencia agent-first**.             | PRB-415; mantener webhooks como canal principal de agentes.              |
| Favorites              | Más tipos de recursos y preferencias personales.                                                                   | Favorite de Project o Saved View por Actor.                                                                                                                                                                                                                         | **Parcial**.                                       | PRB-415/419 para aislamiento.                                            |
| Reviews                | Linear no tiene esta misma cola como núcleo.                                                                       | `Review` es una cola de aprobación propia.                                                                                                                                                                                                                          | **Divergencia intencional**.                       | No forzar equivalencia.                                                  |
| Auth/API keys          | Personal API keys y OAuth; scopes pueden limitarse por operación y Team.                                           | API keys por Actor con read/write/admin y límites por Team; SQLite y PostgreSQL aplican el alcance. PostgreSQL usa `0008` y `0009` para el Workspace de los límites y grants. No OAuth.                                                                             | **Parcial + fuera de alcance OAuth**.              | PRB-413; conservar agent-first.                                          |
| Webhooks               | Más tipos de eventos y administración; se instalan dentro de una Workspace.                                        | SQLite y PostgreSQL persisten scope de Workspace y Team; el dispatcher y el resto de la cobertura siguen en migración incremental.                                                                                                                                  | **Parcial por backend**.                           | PRB-416 y cutover PostgreSQL                                             |
| API GraphQL            | Contrato muy amplio, `Organization`, conexiones Relay y muchas mutaciones (snapshot: 161 queries y 361 mutations). | SDL local vigente: 28 queries y 67 mutations; PostgreSQL tiene paths directos para los dominios migrados y conserva un SQLite efímero o errores explícitos para los restantes.                                                                                      | **Parcial**.                                       | PRB-414/415; paridad total no es objetivo.                               |
| CLI/MCP                | No hay un CLI oficial equivalente; integra API y OAuth.                                                            | CLI `pb` y MCP son superficies constitutivas.                                                                                                                                                                                                                       | **Divergencia agent-first**.                       | PRB-417.                                                                 |
| UI Workspace switcher  | Menú de Workspace permite cambiar, crear o unirse; una cuenta puede tener varias.                                  | La web actual lista y cambia el Workspace con el gate de contexto; crear Workspace sigue siendo una operación GraphQL del camino SQLite.                                                                                                                            | **Parcial por backend**.                           | PRB-418/419 y cutover PostgreSQL                                         |
| Documents/attachments  | Recursos de documentación y archivos integrados.                                                                   | SQLite tiene `Document` y mutations desde `0027`, y PostgreSQL desde `0005`; export/rebuild conserva Markdown y vínculos naturales. Adjuntos ricos, version history, comentarios inline y colaboración siguen ausentes.                                             | **Parcial**.                                       | PRB-541.                                                                 |
| Releases/AI/CRM/Asks   | Superficies actuales de producto y enterprise.                                                                     | No existen en el núcleo.                                                                                                                                                                                                                                            | **Fuera de alcance intencional**.                  | Reabrir solo con requisito de producto.                                  |
| Import/export          | Linear ofrece exportaciones e integraciones; la semántica no es la réplica Git local.                              | Repository Replica versionada en Git; export/rebuild local.                                                                                                                                                                                                         | **Divergencia intencional + gap multi-workspace**. | PRB-417.                                                                 |
| Billing/SSO/SCIM       | Billing, planes, seguridad enterprise, SSO/SCIM y dominios aprobados.                                              | No existen; local-first y sin hosted auth.                                                                                                                                                                                                                          | **Fuera de alcance** (ADR-0020).                   | No incluir en PRB-411–420.                                               |

## Contrato vigente y decisión de multi-Workspace

### Capacidades verificadas en SQLite (2026-08-23)

- Una misma DB puede contener varias Workspaces. `workspace_id`, Memberships, grants de API keys y
  FKs compuestas mantienen el alcance de los recursos en las migraciones `0024`–`0028`.
- GraphQL expone `workspaces` y `workspaceCreate`; `X-Workspace-ID` selecciona el contexto. La CLI y
  la web resuelven el mismo contexto mediante su configuración y su Workspace gate.
- El contrato impide referencias cross-Workspace en las relaciones verificadas. La cobertura de cada
  dominio y cliente sigue siendo incremental; la existencia de una columna o un test no significa que
  todos los flujos tengan la misma superficie.

### Límites verificados en PostgreSQL (2026-08-23)

- `0002_workspace_singleton.sql` impone una única Workspace. `workspaceCreate` devuelve que la
  operación todavía no está migrada y `postgres-viewer.ts` autoriza ese singleton mediante el grant y
  la Membership efectiva.
- El migrador PG tiene nueve versiones. `0005` agrega Documents, `0006` suscriptores, `0007`
  Memberships y grants, `0008` el alcance de Workspace de los límites de Team de API keys y `0009`
  el grant explícito del Workspace efectivo. El servidor usa un SQLite efímero o devuelve un error
  explícito para los dominios todavía no migrados. Comments no tiene ruta PostgreSQL; Relations sí tiene
  lectura y mutaciones directas desde PRB-437. El event log canónico y el proyector Repository Source →
  PostgreSQL siguen pendientes según ADR-0019 y PRB-445/453.
- Por lo tanto, no se debe afirmar que PostgreSQL ofrece multi-Workspace, un cutover completo ni
  paridad de persistencia con SQLite.

### Objetivo de producto (no es una afirmación de implementación completa)

1. Workspace es el contenedor raíz de Teams, actores/usuarios y recursos.
2. Una persona puede operar más de una Workspace y cambiar el contexto desde la navegación.
3. La pertenencia a Workspace y la pertenencia a Team son relaciones distintas.
4. Un recurso de una Workspace no puede aparecer, mutar ni relacionarse desde otra.
5. Las claves y webhooks deben respetar los permisos del usuario y de la Workspace, además de cualquier
   restricción de Team.
6. La réplica, el CLI y el MCP deben conservar el contexto sin mezclar Workspaces.

La implementación actual de ese objetivo es el camino SQLite. PRB-411–420 y el cutover de PostgreSQL
mantienen trabajo pendiente; no se debe usar esta sección para declarar habilitada una capacidad en un
backend que el código todavía limita.

## Cobertura por superficie

Una entidad puede existir en el backend y no tener la misma superficie en todos los clientes. Esta separación
evita cerrar un ticket de API suponiendo que la UI ya tiene paridad. También evita confundir una pérdida del
importer con una ausencia del modelo.

| Superficie          | Prime-board hoy                                                                                                                                                                                        | Diferencia relevante frente a Linear                                                           | Alcance de multi-workspace                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| DB/dominio          | SQLite tiene el modelo operativo y las migraciones `0001`–`0028`; PostgreSQL tiene diez migraciones y cobertura incremental; `0010` agrega `projector_checkpoints` para los dominios con path directo. | Menor cobertura de metadatos y recursos avanzados frente a Linear.                             | El alcance multi-Workspace vigente es SQLite; no asumir cutover PostgreSQL.                        |
| GraphQL             | API interna coherente: 28 queries y 67 mutations en el SDL vigente.                                                                                                                                    | Linear publica 161/361 y conexiones Relay más amplias; no es drop-in.                          | El selector funciona en SQLite; PostgreSQL requiere completar migración.                           |
| CLI                 | `pb` cubre issues, planning, actores, keys, webhooks y selección de Workspace en el camino SQLite.                                                                                                     | Linear no ofrece un CLI oficial equivalente; el CLI local es una ventaja agent-first.          | PostgreSQL ya tiene auth, grants y límites; faltan selección multi-Workspace y dominios restantes. |
| MCP                 | Tools espejo de la API y actor/agente de primera clase; la sesión fija un contexto.                                                                                                                    | Contrato de tools no es el MCP/API de Linear.                                                  | Revisar selección cuando el backend PostgreSQL migre.                                              |
| Web                 | Shell Linear-like, sidebar, listas/board, issue detail, projects, settings, members y gate de Workspace.                                                                                               | Faltan acciones, preferencias, accesibilidad y superficies avanzadas.                          | El switcher actual depende del contrato de Workspaces.                                             |
| Export/rebuild      | Repository Replica Git (`.prime-board`), metadata y rebuild local; no exporta secretos.                                                                                                                | No hay equivalente directo en Linear. Algunos datos de importación tienen política de pérdida. | Mantener namespace y contexto por Workspace.                                                       |
| Auditoría/operación | Activity de Issue, webhooks, comentarios e Inbox receipts. PostgreSQL tiene Activity e Inbox, pero Comments no tiene path PG y el event log canónico de ADR-0019 no está implementado.                 | Linear separa history, notifications y audit entries con más canales.                          | Mantener el modelo compacto y scoped; revisar PG.                                                  |

Lee los documentos de migración (`docs/specs/migracion-linear.md`) como política del importer. Que una
entidad no se importe o se convierta no significa que falte en el dominio operativo.

## Diferencias que no deben tratarse como bugs

Estas diferencias son parte del foco agent-first/local-first y no deben convertirse en trabajo solo para
copiar Linear:

- Actors `AGENT` como usuarios de primera clase, API keys por actor, CLI y MCP.
- Webhooks como canal de notificación operativo para agentes, sin exigir toda la Inbox social de Linear.
- Activity + Inbox receipts como modelo compacto de historial/atención.
- Review como cola propia de aprobación.
- Repository Replica en Git y rebuild local como mecanismo de durabilidad/colaboración.
- Documents Markdown agent-first en SQLite y PostgreSQL, y repos como superficies de colaboración durable; la colaboración en tiempo real de Linear queda fuera del núcleo.
- Ausencia de OAuth, SSO/SCIM, billing, CRM, Releases, AI, Asks, SLAs e integraciones enterprise.
- Layouts, atajos y personalización visual no idénticos, siempre que la semántica operativa y la
  accesibilidad acordadas se mantengan.

## Gaps que sí quedan registrados

Los gaps de paridad general mantienen su backlog propio (por ejemplo PRB-376, PRB-377 y los tickets que
esas auditorías derivaron). Los gaps que bloquean específicamente varios Workspaces son:

| Gap                                            | Ticket  |
| ---------------------------------------------- | ------- |
| Contrato de dominio, selección y no-objetivos  | PRB-411 |
| Migración de tablas, FKs, índices y backfill   | PRB-412 |
| Memberships, grants, invitaciones y auth       | PRB-413 |
| Guards, nested resolvers, filtros y relaciones | PRB-414 |
| GraphQL de listado/creación/contexto           | PRB-415 |
| FTS, eventos, Activity, Inbox y webhooks       | PRB-416 |
| Export/rebuild/Repository Replica              | PRB-417 |
| CLI y MCP                                      | PRB-418 |
| UI, switcher, rutas y cache                    | PRB-419 |
| Matriz de seguridad, rollout y rollback        | PRB-420 |

## Correcciones respecto de notas anteriores

- `docs/audits/linear-paridad-graphql.md` conserva el snapshot 2026-08-18 (166/373/86/80 en su texto).
  El SDL local verificado el 2026-08-23 contiene 28/67/25/14/2; ningún conteo implica compatibilidad
  drop-in.
- `docs/audits/linear-modelo-datos.md` conserva el snapshot de migraciones SQLite hasta `0018`. El
  runner SQLite actual llega a `0028`; el migrador PostgreSQL es independiente y llega a `0009`.
- `docs/research/linear-settings-parity.md` es un snapshot histórico: varios gaps allí descritos ya
  tienen implementación en SQLite, pero no se deben proyectar automáticamente sobre PostgreSQL.
- `docs/relevamiento-linear.md` describe FTS sobre comentarios, pero los índices actuales de SQLite y
  PostgreSQL cubren título y descripción; este documento conserva la observación corregida.

## Documentación anterior consolidada

- [`docs/audits/linear-modelo-datos.md`](linear-modelo-datos.md): mapa de entidades y relaciones.
- [`docs/audits/linear-paridad-graphql.md`](linear-paridad-graphql.md): diferencias del contrato GraphQL.
- [`docs/audits/linear-paridad-visual-usabilidad.md`](linear-paridad-visual-usabilidad.md): UI,
  accesibilidad, atajos y flujo visual.
- [`docs/research/linear-settings-parity.md`](../research/linear-settings-parity.md): configuración,
  roles, miembros, seguridad e integraciones.
- [`docs/relevamiento-linear.md`](../relevamiento-linear.md): inventario histórico de candidatos del MVP.
- [`docs/specs/migracion-linear.md`](../specs/migracion-linear.md): política de importación y pérdidas; no confundirla con el modelo operativo.
- [`CONTEXT.md`](../../CONTEXT.md): vocabulario y límites actuales de dominio.
- [`docs/adr/0003-local-first-single-tenant.md`](../adr/0003-local-first-single-tenant.md) y
  [`docs/adr/0013-frontera-de-autorizacion-de-workspace.md`](../adr/0013-frontera-de-autorizacion-de-workspace.md):
  decisiones de transición que PRB-411 debe actualizar antes de habilitar el segundo Workspace.

## Regla de actualización

Actualiza esta comparación cuando cambie el schema público de Linear, inspeccionemos la aplicación con
acceso verificable, cambie uno de los backends o cerremos una diferencia relevante en prime-board. Marca
cada relevamiento con su fecha y commit. No uses los conteos de campos como objetivo de calidad. La decisión
prioriza semántica útil, aislamiento e interfaz agent-first, no una copia completa de Linear.

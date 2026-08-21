# Diferencias actuales entre prime-board y Linear

> Ticket: [PRB-421](http://localhost:3333/issue/PRB-421)
> Épica relacionada: [Soporte multi-workspace](http://localhost:3333/project/01a0193e-16e4-7000-9836-0e8495aafea6)
> Fecha del relevamiento: 2026-08-19
> Estado: documento canónico de comparación. No promete paridad total ni replica todas las funciones de Linear.

## Propósito

Este documento consolida las notas anteriores sobre las diferencias entre prime-board y Linear. Clasifica cada
diferencia en uno de cuatro casos:

- **Implementado:** prime-board ofrece una capacidad equivalente para su modelo.
- **Parcial:** existe el concepto, pero faltan campos, operaciones o una superficie de cliente.
- **Ausente:** Linear lo ofrece y prime-board todavía no tiene una representación equivalente.
- **Divergencia intencional / fuera de alcance:** la diferencia es una decisión de producto, no una deuda
  que haya que cerrar para llamar “completo” al board para agentes.

La comparación usa como referencias el Linear actual documentado públicamente y el código vigente de
prime-board. Las auditorías anteriores siguen siendo útiles y aparecen enlazadas al final. Este archivo es
el índice de decisión.

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

### Evidencia local

Revisamos el SDL, las migraciones, los dominios, los resolvers y las superficies GraphQL/CLI/MCP/UI.
El snapshot local verificable de esta revisión contiene 25 campos de `Query`, 62 de `Mutation`, 24
campos de `Issue`, 13 de `Project` y 2 de `PageInfo`. Las referencias principales son:

- `packages/schema/src/sdl.ts`
- `apps/server/src/db/migrations/0001_init.sql` a `0023_webhook_team_scope.sql`
- `apps/server/src/auth/viewer.ts`, `apps/server/src/auth/permissions.ts` y
  `apps/server/src/domain/workspace-context.ts`
- `apps/server/src/export/exporter.ts`, `importer.ts`, `replica-metadata.ts` y `repo-sync.ts`
- `apps/cli/src/commands/workspace.ts`, `apps/cli/src/config.ts` y `apps/cli/src/api.ts`
- `apps/mcp/src/api.ts` y `apps/mcp/src/server.ts`
- `apps/web/src/components/Sidebar.tsx`, `App.tsx`, `router.tsx`, `api.ts` y `ui-context.ts`

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

La diferencia estructural más importante para esta épica es la frontera de Workspace: Linear permite varias
Workspaces por cuenta y asigna cada dato a una de ellas. prime-board todavía tiene una tabla
`workspace` tratada como singleton y recursos sin `workspace_id`; sus tickets de implementación son
PRB-411 a PRB-420. La decisión de multi-workspace de prime-board se limita a una DB/proceso compartido,
con aislamiento estricto; no convierte al producto en un servicio hosted ni obliga a copiar OAuth, billing
o todos los roles de Linear.

## Matriz canónica de diferencias

| Área                   | Linear actual                                                                                                      | prime-board actual                                                                                                | Clasificación                                      | Próximo paso                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Workspace              | Una cuenta puede pertenecer a varias Workspaces; cada una tiene miembros, Teams, datos y settings propios.         | Una fila lógica por DB/proceso; no existe selector/creación multi-workspace.                                      | **Gap P0** para esta épica.                        | PRB-411–420                                                              |
| Nombre API             | Producto: Workspace; GraphQL: `Organization`.                                                                      | `Workspace` en dominio y GraphQL.                                                                                 | **Divergencia intencional** de nomenclatura.       | Mantener `Workspace`; adaptar importaciones si hiciera falta.            |
| Identidad              | `User` tiene organización, roles, estado, memberships de Team y variantes guest/app.                               | `Actor` puede ser `human` o `agent`, con API keys; `workspace_role` y status todavía globales.                    | **Parcial + divergencia agent-first**.             | PRB-411 y PRB-413                                                        |
| Workspace Membership   | La pertenencia a la Workspace delimita acceso; invitaciones tienen rol y Teams.                                    | `Workspace Membership` está documentada como futura; solo existe `TeamMembership`.                                | **Gap P0**.                                        | PRB-412–415                                                              |
| Team Membership        | User–Team es una relación separada; Team Owner no es Workspace Admin.                                              | `TeamMembership` separada, roles `owner/member`; Workspace role global.                                           | **Parcial**.                                       | PRB-413–414                                                              |
| Teams                  | Teams pueden ser públicos/privados, tener jerarquía, settings y acceso rico.                                       | Team, states, labels, cycles, memberships, visibilidad y política de acceso ya existen; no hay sub-teams.         | **Parcial; sub-teams fuera de alcance**.           | PRB-414; evaluar sub-teams después.                                      |
| Team keys              | Linear publica `key` y shorthand de Issue; no se asume unicidad global entre Workspaces.                           | `teams.key` es `UNIQUE` global.                                                                                   | **Gap de aislamiento P0**.                         | PRB-412; resolver `TEAM-123` en contexto.                                |
| Workflow               | Estados por Team, con descripción y automatizaciones adicionales.                                                  | Estados por Team con tipo semántico, color, posición y default.                                                   | **Paridad suficiente + gap P1**.                   | No bloquea multi-workspace; revisar después.                             |
| Issue                  | Linear cubre núcleo, fechas, estimates, subscribers, attachments, documents, releases, history y más.              | Núcleo de issue, prioridad, parent, labels, Project/Cycle/Milestone, relations, comments y activity.              | **Parcial**, intencional para MVP.                 | Priorizar solo según producto agent-first.                               |
| Identificador de Issue | `identifier` y `number`; shorthand se resuelve en su organización.                                                 | `TEAM-number`, `UNIQUE(team_id, number)`.                                                                         | **Parcial; scope debe ser explícito**.             | PRB-412 y PRB-414                                                        |
| Relaciones             | `blocks`, `duplicate`, `related`, `similar` e inversas.                                                            | `blocks`, `duplicate_of`, `related` e inversas calculadas; no `similar`.                                          | **Parcial**.                                       | No bloquear multi-workspace salvo aislamiento de extremos.               |
| Comments/Activity      | Comentarios, historial, notificaciones y más entidades colaborativas.                                              | Comments y Activity issue-céntricas; Inbox derivado de Activity + receipts.                                       | **Parcial + simplificación intencional**.          | PRB-415 para scope; features extra después.                              |
| Projects               | Projects, miembros, labels, documentos, relaciones/dependencias, milestones y updates.                             | Projects multi-Team, lead, estado, target date, milestones, issues y updates.                                     | **Parcial**.                                       | PRB-412/414 para aislamiento; gaps de producto después.                  |
| Initiatives            | Agrupan Projects con más jerarquía, labels, updates y relaciones.                                                  | Agrupan Projects y Teams, con owner, estado, target date y progreso.                                              | **Parcial**.                                       | Scopear ahora; ampliar después.                                          |
| Cycles                 | Cycles por Team con métricas y opciones adicionales.                                                               | Cycles por Team con carry-over y progreso.                                                                        | **Paridad de núcleo**.                             | Scopear en PRB-412/414.                                                  |
| Saved Views            | Custom Views con filtros tipados, scopes, sharing, slug, preferencias y más recursos.                              | Saved Views personal/team/workspace con filtro JSON, orden, agrupación y columnas.                                | **Parcial**.                                       | Scopear ahora; editor avanzado después.                                  |
| Display options        | Layout, grouping, ordering y propiedades visibles integradas con Views.                                            | Parte de las preferencias existe en UI/localStorage; cobertura y persistencia son menores.                        | **Parcial**.                                       | No bloquear multi-workspace; evitar cache cruzado en PRB-419.            |
| Búsqueda y filtros     | Linear ofrece filtros amplios, sugerencias y búsqueda contextual sobre más propiedades.                            | Hay filtros combinables y FTS5 sobre título y descripción; los comentarios no forman parte del índice FTS actual. | **Parcial**.                                       | No bloquear multi-workspace; PRB-416 debe conservar el scope del índice. |
| Inbox                  | Notifications con acciones, búsqueda, snooze y preferencias.                                                       | Inbox y receipts personales derivados de Activity.                                                                | **Parcial + divergencia agent-first**.             | PRB-415; mantener webhooks como canal principal de agentes.              |
| Favorites              | Más tipos de recursos y preferencias personales.                                                                   | Favorite de Project o Saved View por Actor.                                                                       | **Parcial**.                                       | PRB-415/419 para aislamiento.                                            |
| Reviews                | Linear no tiene esta misma cola como núcleo.                                                                       | `Review` es una cola de aprobación propia.                                                                        | **Divergencia intencional**.                       | No forzar equivalencia.                                                  |
| Auth/API keys          | Personal API keys y OAuth; scopes pueden limitarse por operación y Team.                                           | API keys por Actor con read/write/admin y límites por Team; no OAuth.                                             | **Parcial + fuera de alcance OAuth**.              | PRB-413; conservar agent-first.                                          |
| Webhooks               | Más tipos de eventos y administración; se instalan dentro de una Workspace.                                        | Suscripciones genéricas con owner y scope opcional de Team; dispatcher aún global.                                | **Gap P0 de aislamiento**.                         | PRB-416.                                                                 |
| API GraphQL            | Contrato muy amplio, `Organization`, conexiones Relay y muchas mutaciones (snapshot: 161 queries y 361 mutations). | Contrato coherente para núcleo, pero no drop-in: 25 queries y 62 mutations en el snapshot local 2026-08-19.       | **Parcial**.                                       | PRB-414/415; paridad total no es objetivo.                               |
| CLI/MCP                | No hay un CLI oficial equivalente; integra API y OAuth.                                                            | CLI `pb` y MCP son superficies constitutivas.                                                                     | **Divergencia agent-first**.                       | PRB-417.                                                                 |
| UI Workspace switcher  | Menú de Workspace permite cambiar, crear o unirse; una cuenta puede tener varias.                                  | Sidebar muestra el Workspace actual, pero no cambia ni crea otro.                                                 | **Gap P0** una vez seguro el backend.              | PRB-418/419.                                                             |
| Documents/attachments  | Recursos de documentación y archivos integrados.                                                                   | Markdown en Issues/repos/Notion; no hay entidad propia.                                                           | **Fuera de alcance actual**.                       | No bloquea multi-workspace.                                              |
| Releases/AI/CRM/Asks   | Superficies actuales de producto y enterprise.                                                                     | No existen en el núcleo.                                                                                          | **Fuera de alcance intencional**.                  | Reabrir solo con requisito de producto.                                  |
| Import/export          | Linear ofrece exportaciones e integraciones; la semántica no es la réplica Git local.                              | Repository Replica versionada en Git; export/rebuild local.                                                       | **Divergencia intencional + gap multi-workspace**. | PRB-417.                                                                 |
| Billing/SSO/SCIM       | Billing, planes, seguridad enterprise, SSO/SCIM y dominios aprobados.                                              | No existen; local-first y sin hosted auth.                                                                        | **Fuera de alcance**.                              | No incluir en PRB-411–420.                                               |

## Decisión específica de multi-workspace

### Lo que toma prime-board de Linear

1. Workspace es el contenedor raíz de Teams, actores/usuarios y recursos.
2. Una persona puede operar más de una Workspace y cambiar el contexto desde la navegación.
3. La pertenencia a Workspace y la pertenencia a Team son relaciones distintas.
4. Un recurso de una Workspace no puede aparecer, mutar ni relacionarse desde otra.
5. Las claves y webhooks deben respetar los permisos del usuario y de la Workspace, además de cualquier
   restricción de Team.

### Lo que prime-board decide para su propio producto

- **Topología:** varias Workspaces en una misma DB/proceso SQLite. Se mantiene la opción local-first;
  una instalación sigue pudiendo usar una sola Workspace sin configuración extra.
- **Actor:** identidad global de humano/agente con `Workspace Membership`; rol y status son por
  Membership. Esto conserva la intención del glosario actual de que un Actor puede operar más de una
  Workspace, aunque el `User` de Linear se exponga como perteneciente a una organización en su API.
- **Credenciales:** API key global del Actor con grants por Workspace, scopes y Team limits scoped al
  grant. El selector (`X-Workspace-ID`, perfil CLI o sesión MCP/UI) se valida contra esos grants; no es
  autoridad por sí solo. Esta es una decisión de prime-board, no una afirmación de que Linear use el mismo
  almacenamiento interno.
- **Identificadores:** UUID global; `urlKey` global; Team key único dentro de Workspace; `TEAM-number`
  se resuelve siempre en el Workspace efectivo.
- **Réplica:** namespace por Workspace en `.prime-board`, con compatibilidad de lectura para el layout
  single-workspace actual. Un rebuild no puede borrar la réplica ni el índice operativo de otra Workspace.
- **No hay cross-workspace:** no se permiten búsquedas, relaciones, movimientos de Issues, Projects
  compartidos ni referencias transitivas entre Workspaces.

PRB-420 bloquea la habilitación. El proyecto [Soporte multi-workspace](http://localhost:3333/project/01a0193e-16e4-7000-9836-0e8495aafea6)
contiene los tickets de implementación y sus dependencias nativas.

## Cobertura por superficie

Una entidad puede existir en el backend y no tener la misma superficie en todos los clientes. Esta separación
evita cerrar un ticket de API suponiendo que la UI ya tiene paridad. También evita confundir una pérdida del
importer con una ausencia del modelo.

| Superficie          | Prime-board hoy                                                                             | Diferencia relevante frente a Linear                                                            | Alcance de multi-workspace                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| DB/dominio          | Modelo SQLite completo para el núcleo; varios recursos agregados después del MVP histórico. | Menor cobertura de metadatos y recursos avanzados.                                              | PRB-412 y PRB-414 agregan scope real, no nuevas features de paridad general.        |
| GraphQL             | API interna coherente: 25 queries y 62 mutations en snapshot local.                         | Linear publica 161/361 y conexiones Relay más amplias; no es drop-in.                           | PRB-415 debe ser autoridad para list/create/select; el resto debe recibir contexto. |
| CLI                 | `pb` cubre issues, planning, actores, keys, webhooks y Workspace actual.                    | Linear no ofrece un CLI oficial equivalente; el CLI local es una ventaja agent-first.           | PRB-418 agrega list/use/create y selector validado.                                 |
| MCP                 | Tools espejo de la API y actor/agente de primera clase.                                     | Contrato de tools no es el MCP/API de Linear.                                                   | PRB-418 fija Workspace por sesión/request e invalida contexto al cambiar.           |
| Web                 | Shell Linear-like, sidebar, listas/board, issue detail, projects, settings y members.       | Faltan acciones, preferencias, accesibilidad y superficies avanzadas; hoy no hay switcher real. | PRB-419 agrega switcher/rutas/cache solo después del backend.                       |
| Export/rebuild      | Repository Replica Git (`.prime-board`), metadata y rebuild local; no exporta secretos.     | No hay equivalente directo en Linear. Algunos datos de importación tienen política de pérdida.  | PRB-417 separa namespaces y evita rebuild destructivo de vecinos.                   |
| Auditoría/operación | Activity de Issue, webhooks, comentarios e Inbox receipts.                                  | Linear separa history, notifications y audit entries con más canales.                           | PRB-416 mantiene el modelo compacto, pero scoped por Workspace.                     |

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
- Markdown/repos/Notion en lugar de Documents colaborativos.
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

- `docs/audits/linear-paridad-graphql.md` conserva el snapshot 2026-08-18 (166/373/86/80 en su texto); los conteos vigentes de esta revisión son los indicados arriba. La conclusión de que no existe compatibilidad drop-in sigue siendo válida.
- `docs/audits/linear-modelo-datos.md` auditaba migraciones solo hasta `0018`; el código llega a `0023` e incluye lifecycle de actores, scopes/rotación de keys, visibilidad de Teams y scope de webhooks.
- `docs/research/linear-settings-parity.md` es un snapshot histórico: varios gaps P0 allí descritos (scopes y límites de API keys, visibilidad/política de Teams y scope de webhooks) ya tienen implementación de backend, aunque esta épica debe extenderlos a Workspaces.
- `docs/relevamiento-linear.md` describe FTS sobre comentarios, pero el índice vigente cubre título y descripción; este documento conserva la observación corregida.

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
acceso verificable o cerremos una diferencia relevante en prime-board. No uses los conteos de campos como
objetivo de calidad. La decisión prioriza semántica útil, aislamiento e interfaz agent-first, no una copia
completa de Linear.

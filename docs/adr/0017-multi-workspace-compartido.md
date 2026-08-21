# ADR-0017: Multi-workspace en una DB/proceso compartido

- Estado: aceptado para implementación; habilitación pendiente
- Fecha: 2026-08-19
- Reemplaza la parte de “no selección/no creación futura” de ADR-0003 y ADR-0013 cuando la implementación de PRB-411–420 llegue a la puerta de habilitación.

## Contexto

prime-board nació como local-first single-workspace. La tabla `workspace` funciona como singleton y la mayoría de las entidades no tiene `workspace_id`. `WorkspaceContext` ya existe como seam, pero hoy se resuelve con la única fila operativa. Agregar una segunda fila sin migrar el resto produciría fugas por IDs, Team keys, Actors, búsquedas, webhooks y rebuilds destructivos.

La comparación con Linear confirma el concepto necesario, no una obligación de copiar toda su implementación. Linear presenta Workspace como la organización raíz, permite que una cuenta cambie entre varios Workspaces y separa la pertenencia a Workspace de la pertenencia a Team. Prime-board conserva el vocabulario `Workspace`, sus Actors `AGENT` y su modelo local/API-first.

## Decisión

### Topología y alcance

1. Una DB/proceso SQLite puede contener varios Workspaces aislados. Una instalación con un solo Workspace conserva el comportamiento actual sin configuración adicional.
2. El Workspace efectivo forma parte inmutable del `WorkspaceContext` de cada request/sesión. Todas las lecturas, mutaciones, nested resolvers, filtros, FTS, eventos, webhooks, exports y réplicas deben recibir o derivar ese contexto.
3. No existe acceso cross-workspace. El sistema no comparte Issues, Projects, Relations, búsquedas ni movimientos entre Workspaces.
4. OAuth, SSO/SCIM, billing, planes, hosted multi-tenant, CRM, Documents completos y borrado irreversible de Workspace quedan fuera de este corte.

### Identidad y autorización

1. `Actor` es una identidad global de una persona o un agente. `Actor.type` no es un rol de autorización.
2. `Workspace Membership` relaciona Actor y Workspace. Contiene, como mínimo, `role` (`admin`/`member`), `status` (`active`/`suspended`/`left`) y fechas del ciclo de acceso. Es la autoridad para roster, permisos de Workspace, último admin y autenticación dentro del Workspace.
3. `Team Membership` continúa siendo una relación distinta. Team Owner no equivale a Workspace Admin.
4. Una API key es global al Actor y tiene grants explícitos a Workspaces. Sus Scopes (`read`, `write`, `admin`) y límites de Team se evalúan dentro del grant y del Workspace efectivo. El rol de Membership puede restringir una key; una key nunca agrega permisos por sí sola.
5. Durante el backfill, cada key existente recibe un grant al único Workspace actual. Con un solo grant o un default válido, los clientes legacy siguen funcionando sin header.

### Selección y contrato

1. Un mecanismo de contexto transporta la selección (`X-Workspace-ID`, perfil CLI o sesión MCP/UI). El sistema la valida contra el Actor, la key y la Membership. El selector no es autoridad: un ID no concedido devuelve un error estable sin revelar si el Workspace existe.
2. Si una credencial tiene varios grants y no hay default o contexto resoluble, la operación falla con `WORKSPACE_REQUIRED` antes de tocar `last_used_at` o ejecutar el resolver.
3. `workspace` y las nuevas operaciones de listado/creación solo exponen Workspaces accesibles. Crear un Workspace siembra en una transacción el Workspace, la Membership admin inicial, el Team default y el Workflow default.
4. `urlKey` es único, global y estable en este corte. La key de un Team es única dentro del Workspace. El sistema resuelve `TEAM-123` siempre dentro del Workspace efectivo. Los UUIDs permanecen como identidad de API.

### Persistencia y réplica

1. `workspace` puede contener varias filas. Los recursos raíz y las tablas puente reciben `workspace_id` o una FK compuesta equivalente. Las migraciones validan que ningún extremo de una relación pertenezca a otro Workspace.
2. `workspace_role`, status y campos de lifecycle globales de Actor solo permanecen como compatibilidad durante el backfill. Dejan de ser la autoridad antes de habilitar el segundo Workspace.
3. La Repository Replica usa un namespace estable por Workspace. El layout single-workspace histórico sigue siendo legible. Un export/rebuild ambiguo con más de un Workspace se rechaza y un rebuild scoped no borra Workspaces vecinos.
4. El sistema no escribe secretos de API keys ni de webhooks en la réplica.

## Mapa de implementación

| Fase          | Entrega                                                       | Ticket  |
| ------------- | ------------------------------------------------------------- | ------- |
| Contrato      | ADR, glossary, errores y decisiones de selección              | PRB-411 |
| Datos         | Memberships, `workspace_id`, FKs/índices, unicidad y backfill | PRB-412 |
| Auth          | Resolución key+grant+Membership, invitaciones y lifecycle     | PRB-413 |
| Aislamiento   | Repositorios, guards, nested resolvers, FTS y relaciones      | PRB-414 |
| API           | List/create/selection y contrato GraphQL compatible           | PRB-415 |
| Integraciones | Activity, Inbox, eventos, FTS y webhooks scoped               | PRB-416 |
| Réplica       | Export/rebuild/sync por Workspace                             | PRB-417 |
| Agentes       | CLI y MCP                                                     | PRB-418 |
| Web           | Switcher, rutas y cache                                       | PRB-419 |
| Puerta        | Matriz negativa, rollout, backup y rollback                   | PRB-420 |
| Comparación   | Documento canónico de diferencias con Linear                  | PRB-421 |

Las relaciones nativas del board expresan el orden de bloqueo. Los tickets PRB-399–405 son la preparación single-workspace ya entregada. No forman parte de la implementación multi-workspace.

## Puerta de habilitación

El equipo no habilita una segunda fila operativa, `workspaceCreate` público ni el switcher hasta que:

- una base existente pase el backfill transaccional y la validación de invariantes;
- una key con Memberships A/B pueda elegir A o B sin fuga ni bypass de admin;
- dos Workspaces puedan reutilizar Team keys, números, Labels y nombres;
- pasen tests negativos de roots, nested resolvers, Relations, FTS, paginación, webhooks, export/rebuild, CLI, MCP y UI;
- existan backup, feature flag/kill switch, rollback y un reporte verificable.

## Consecuencias

- La API gana una frontera real de autorización y puede servir varios Workspaces en un proceso sin mezclar datos.
- La migración es considerable: varias tablas SQLite deben reconstruirse para agregar FKs compuestas y retirar gradualmente campos legacy.
- La selección de Workspace deja de ser una preferencia visual. Cambiarla invalida contexto, cache, Inbox, Favorites, Saved Views y permisos en todos los clientes.
- API keys globales con grants son cómodas para un Actor multi-Workspace, pero exigen que cada operación resuelva el grant. Si esa complejidad resulta innecesaria antes de PRB-413, el ticket debe registrar una decisión alternativa explícita (keys de un solo Workspace) antes de tocar el esquema. El sistema no puede mezclar ambos modelos.

## Referencias

- `CONTEXT.md`
- `docs/adr/0003-local-first-single-tenant.md`
- `docs/adr/0013-frontera-de-autorizacion-de-workspace.md`
- `docs/audits/linear-actual-diferencias.md`
- `apps/server/src/domain/workspace-context.ts`
- Proyecto [Soporte multi-workspace](http://localhost:3333/project/01a0193e-16e4-7000-9836-0e8495aafea6)

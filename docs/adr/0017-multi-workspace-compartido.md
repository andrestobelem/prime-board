# ADR-0017: Multi-workspace en una DB/proceso compartido

- Estado: aceptado para implementación; habilitación pendiente
- Fecha: 2026-08-19
- Reemplaza la parte de “no selección/no creación futura” de ADR-0003 y ADR-0013 cuando la
  implementación de PRB-411–420 llegue a la puerta de habilitación.

## Contexto

prime-board nació como local-first single-workspace: la tabla `workspace` se trata como singleton y
la mayoría de las entidades no tiene `workspace_id`. `WorkspaceContext` ya existe como seam, pero hoy
se resuelve con la única fila operativa. Agregar una segunda fila sin migrar el resto produciría fugas
por IDs, Team keys, actores, búsquedas, webhooks y rebuilds destructivos.

La comparación con Linear confirma el concepto que necesitamos, no una obligación de copiar toda su
implementación: Linear presenta Workspace como la organización raíz, permite que una cuenta cambie entre
varias Workspaces y separa la pertenencia a Workspace de la pertenencia a Team. Prime-board conserva su
vocabulario `Workspace`, sus actores `AGENT` y su modelo local/API-first.

## Decisión

### Topología y alcance

1. Una DB/proceso SQLite puede contener varios Workspaces aislados. Una instalación con un solo Workspace
   mantiene el comportamiento actual sin configuración extra.
2. El Workspace efectivo es parte inmutable del `WorkspaceContext` de cada request/sesión. Todas las
   lecturas, mutaciones, nested resolvers, filtros, FTS, eventos, webhooks, exportaciones y réplicas
   deben recibir o derivar ese contexto.
3. No existe acceso cross-workspace: no se comparten Issues, Projects, relaciones, búsquedas ni
   movimientos entre Workspaces.
4. OAuth, SSO/SCIM, billing, planes, hosted multi-tenant, CRM, Documents completos y borrado
   irreversible de Workspace quedan fuera de este corte.

### Identidad y autorización

1. `Actor` es una identidad global de humano o agente. `Actor.type` no es un rol de autorización.
2. `Workspace Membership` relaciona Actor y Workspace y contiene, como mínimo, `role` (`admin`/`member`),
   `status` (`active`/`suspended`/`left`) y fechas de ciclo de acceso. Es la autoridad para roster,
   permisos de Workspace, último admin y autenticación dentro del Workspace.
3. `Team Membership` continúa siendo una relación distinta. Team Owner no equivale a Workspace Admin.
4. Una API key es global al Actor y tiene grants explícitos a Workspaces. Sus scopes (`read`, `write`,
   `admin`) y límites de Team se evalúan siempre dentro del grant/Workspace efectivo. El rol de
   Membership puede restringir una key; una key nunca agrega permisos por sí sola.
5. Una key existente recibe durante el backfill un grant al Workspace único actual. Con un único grant o
   un default válido, los clientes legacy siguen funcionando sin header.

### Selección y contrato

1. La selección se transporta por un mecanismo de contexto (`X-Workspace-ID`, perfil CLI o sesión
   MCP/UI) y se valida contra el Actor, la key y la Membership. El selector no es autoridad: enviar un
   ID no concedido devuelve un error estable sin revelar si el Workspace existe.
2. Si una credencial tiene varios grants y no hay default/contexto resoluble, la operación falla con
   `WORKSPACE_REQUIRED` antes de tocar `last_used_at` o ejecutar el resolver.
3. `workspace` y las nuevas operaciones de listado/creación solo exponen Workspaces accesibles. Crear un
   Workspace siembra, en una transacción, el Workspace, Membership admin inicial, Team default y
   workflow default.
4. `urlKey` es único global y estable en este corte. Team `key` es único dentro de Workspace; `TEAM-123`
   se resuelve siempre dentro del Workspace efectivo. UUIDs permanecen como identidad de API.

### Persistencia y réplica

1. `workspace` puede contener varias filas. Los recursos raíz y las tablas puente reciben `workspace_id`
   o una FK compuesta equivalente; las migraciones validan que ningún extremo de una relación pertenezca
   a otro Workspace.
2. `workspace_role`, status y campos de lifecycle globales de Actor se conservan solo como compatibilidad
   durante el backfill y dejan de ser la autoridad antes de habilitar el segundo Workspace.
3. La Repository Replica usa un namespace estable por Workspace. El layout single-workspace histórico
   sigue siendo legible; un export/rebuild ambiguo con más de un Workspace se rechaza, y un rebuild
   scoped no borra vecinos.
4. Secretos de API keys y webhooks no se escriben en la réplica.

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

Las relaciones nativas del board expresan el orden de bloqueo. Los tickets PRB-399–405 son la
preparación single-workspace ya entregada; no se consideran implementación multi-workspace.

## Puerta de habilitación

No se habilita una segunda fila operativa, `workspaceCreate` público ni el switcher hasta que:

- una base existente haya pasado backfill transaccional y validación de invariantes;
- una key con Memberships A/B pueda elegir A o B sin fuga ni bypass de admin;
- dos Workspaces puedan reutilizar Team keys, números, labels y nombres;
- pasen tests negativos de roots, nested resolvers, relaciones, FTS, paginación, webhooks, export/rebuild,
  CLI, MCP y UI;
- exista backup, feature flag/kill switch, rollback y reporte verificable.

## Consecuencias

- La API gana una frontera real de autorización y puede servir varias organizaciones en un proceso sin
  mezclar datos.
- La migración es considerable: hay que reconstruir varias tablas SQLite para agregar FKs compuestas y
  retirar gradualmente campos legacy.
- La selección de Workspace deja de ser una preferencia visual: cambiarla invalida contexto, cache,
  Inbox, favoritos, vistas y permisos en todos los clientes.
- API keys globales con grants son más cómodas para un Actor multi-Workspace, pero exigen que cada
  operación resuelva el grant. Si la complejidad resulta innecesaria antes de implementar PRB-413, el
  ticket debe registrar una decisión alternativa explícita (keys de un solo Workspace) antes de tocar
  el esquema; no se puede mezclar ambos modelos.

## Referencias

- `CONTEXT.md`
- `docs/adr/0003-local-first-single-tenant.md`
- `docs/adr/0013-frontera-de-autorizacion-de-workspace.md`
- `docs/audits/linear-actual-diferencias.md`
- `apps/server/src/domain/workspace-context.ts`
- Proyecto [Soporte multi-workspace](http://localhost:3333/project/01a0193e-16e4-7000-9836-0e8495aafea6)

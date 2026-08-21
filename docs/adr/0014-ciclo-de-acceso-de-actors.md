# ADR-0014: Ciclo de acceso de Actors

- Estado: aceptado
- Fecha: 2026-08-19
- Issue: PRB-379

## Decisión

La base SQLite de la instalación conserva el ciclo de acceso de un Actor. El ciclo no depende de OAuth ni de un proveedor externo. `Actor.status` puede ser `active`, `suspended` o `left`:

- `active` permite autenticarse y operar.
- `suspended` bloquea la autenticación y las operaciones. Un Workspace Admin puede revertirlo.
- `left` termina el acceso. Puede representar la salida voluntaria (`actorLeave`) o la revocación administrativa (`actorRevoke`). El sistema no borra el Actor ni altera sus Issues, Comments, Activity, Memberships o autoría histórica.

La resolución de una API key siempre comprueba el estado del Actor antes de actualizar `last_used_at`. La suspensión conserva las keys para que la reactivación restaure el acceso. La salida y la revocación aplican `revoked_at` a las keys existentes. El sistema no crea nuevas keys para un Actor que no esté `active`.

## Invitaciones

`actorInvite` es una operación exclusiva de Workspace Admin. SQLite guarda solo el hash del bearer token, junto con email, nombre, tipo, expiración y estado. El sistema entrega el token una sola vez. `actorInvitationAccept` no requiere una sesión previa: valida el token, crea el Actor member y entrega una API key una sola vez. La aceptación reserva la invitación dentro de una transacción para impedir que un token cree dos Actors. Los tokens inexistentes, expirados, aceptados o revocados responden `UNAUTHORIZED` sin revelar su estado.

Solo un Workspace Admin puede consultar y revocar invitaciones. El modelo sigue siendo local-first y single-workspace; las invitaciones no agregan un segundo Workspace ni una relación Membership operativa multi-tenant.

## Consecuencias

- La identidad de un Actor permanece aunque pierda acceso. Por eso las referencias históricas siguen resolviendo.
- El último Workspace Admin no puede suspenderse, revocarse ni salir.
- El sistema exporta y reconstruye el estado del Actor junto con la metadata de Actors. Nunca escribe secretos de API keys o tokens en la réplica.

# ADR-0014: ciclo de acceso de Actors

- Estado: aceptado
- Fecha: 2026-08-19
- Issue: PRB-379

## Decisión

El ciclo de acceso de un Actor se conserva en la base SQLite de la instalación y no depende de
OAuth ni de un proveedor externo. `Actor.status` puede ser `active`, `suspended` o `left`:

- `active` permite autenticarse y operar.
- `suspended` bloquea la autenticación y las operaciones, pero es reversible por un Workspace Admin.
- `left` es terminal para el acceso. Puede representar la salida voluntaria (`actorLeave`) o la
  revocación administrativa (`actorRevoke`). No se borra el Actor ni se alteran sus Issues,
  comentarios, actividad, memberships ni autoría histórica.

La resolución de una API key cruza siempre la key con el estado del Actor antes de actualizar
`last_used_at`. La suspensión conserva las keys para que la reactivación devuelva el acceso; la
salida y la revocación aplican `revoked_at` a las keys existentes. No se crean nuevas keys para un
Actor que no esté `active`.

## Invitaciones

`actorInvite` es una operación exclusiva de Workspace Admin. Guarda en SQLite únicamente el hash
del token bearer, junto con email, nombre, tipo, expiración y estado. El token se entrega una sola
vez. `actorInvitationAccept` no requiere una sesión previa: valida el token, crea el Actor member y
entrega una API key una sola vez. La aceptación reserva la invitación dentro de una transacción para
que un token no pueda crear dos Actors. Tokens inexistentes, expirados, aceptados o revocados
responden `UNAUTHORIZED` sin revelar el estado del token.

Las invitaciones se consultan y revocan solo con capacidad de Workspace Admin. El modelo sigue
siendo local-first y single-workspace; las invitaciones no agregan un segundo Workspace ni una
relación Membership operativa multi-tenant.

## Consecuencias

- La identidad de un Actor es estable aunque pierda acceso, por lo que las referencias históricas
  siguen resolviendo.
- El último Workspace Admin no puede suspenderse, revocarse ni salir.
- El estado del Actor se exporta y reconstruye junto con la metadata de actores; los secretos de
  API keys y tokens nunca se escriben en la réplica.

# Autenticación y credenciales PostgreSQL

- **Ticket:** PRB-431
- **Implementación:** `apps/server/src/auth/postgres-viewer.ts` y
  `apps/server/src/domain/postgres-credentials.ts`

## Contrato

El adaptador normaliza y hashea las Bearer keys con el mismo SHA-256 que SQLite. La resolución cruza `api_keys` con `actors`, rechaza keys revocadas o expiradas y las de Actors no activos, actualiza `last_used_at` y carga Scopes y límites desde PostgreSQL. Si una key no tiene filas de Scopes, el adaptador conserva el fallback legacy (read/write/admin). Si no tiene límites, conserva el acceso global.

Creación, rotación y revocación mantienen la semántica existente:

- Solo los Actors activos reciben keys.
- El sistema devuelve el plaintext solo en el payload de creación, rotación o aceptación. Solo persiste el hash.
- El sistema normaliza los Scopes y Team limits, los valida contra las tablas PG y no permite superar las capacidades de la key padre.
- La rotación inserta la key reemplazante y revoca la anterior en una sola transacción. Una carrera no puede dejar dos keys activas para la misma operación.
- Borrar una key existente es idempotente y conserva su fila para trazabilidad.

Cuando el backend es PostgreSQL, las operaciones API key no migradas ya no usan el SQLite efímero. El adaptador rechaza las operaciones restantes antes de tocarlo.

## Invitaciones concurrentes

Las invitaciones usan `token_hash`, nunca el token plaintext, y el índice único
parcial PostgreSQL sobre email pendiente sigue siendo el árbitro final de dos
creaciones concurrentes; una invitación pendiente vencida se marca `expired`
antes de insertar otra para el mismo email. La aceptación reserva la fila con `FOR UPDATE`, cambia
el estado dentro de la transacción, crea actor y key, y enlaza `actor_id` y
`accepted_at`. Si falla cualquier paso, el rollback deja la invitación pendiente
y no deja actor/key parciales.

La key que crea la aceptación usa el mismo hash y puede resolver `viewer` de inmediato. La segunda aceptación del token recibe `UNAUTHORIZED`.

## Seguridad operativa

El sistema no escribe keys plaintext en logs, exportaciones ni metadata. Las scripts de validación tampoco imprimen payloads. La URL PostgreSQL solo entra por `PRIME_BOARD_POSTGRES_URL` o secretos del entorno.

## Validación reproducible

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-actors.ts
```

La validación contra PostgreSQL efímero cubre autenticación positiva y negativa,
expiración, scopes, límite de Team, rotación, revocación, aceptación concurrente,
creación concurrente de invitaciones y la key resultante:

```json
{
  "passed": true,
  "report": {
    "graphql": true,
    "identity": true,
    "lifecycle": true,
    "credentials": true,
    "invitations": true,
    "updatedWorkspace": true,
    "authorization": true
  }
}
```

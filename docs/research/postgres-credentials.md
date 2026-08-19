# Autenticación y credenciales PostgreSQL

- **Ticket:** PRB-431
- **Implementación:** `apps/server/src/auth/postgres-viewer.ts` y
  `apps/server/src/domain/postgres-credentials.ts`

## Contrato

Bearer keys se normalizan y hashean con el mismo SHA-256 que SQLite; la
resolución cruza `api_keys` con `actors`, rechaza keys revocadas, expiradas o de
actors no activos, actualiza `last_used_at` y carga scopes/límites desde
PostgreSQL. Si una key no tiene filas de scopes se conserva el fallback legacy
(read/write/admin), y si no tiene límites conserva el acceso global.

Creación, rotación y revocación mantienen la semántica existente:

- Solo actors activos reciben keys.
- El plaintext se devuelve únicamente en el payload de creación/rotación/
  aceptación; solo se persiste el hash.
- Scopes y Team limits se normalizan, validan contra las tablas PG y no pueden
  exceder las capacidades de la key padre.
- Rotación inserta la reemplazante y revoca la anterior en una única transacción;
  una carrera no puede dejar dos keys activas para la misma operación.
- Borrar una key es idempotente para una key existente y conserva su fila para
  trazabilidad.

Las operaciones API key no migradas ya no caen en el SQLite efímero cuando el
backend es PostgreSQL. Las operaciones restantes se rechazan antes de tocarlo.

## Invitaciones concurrentes

Las invitaciones usan `token_hash`, nunca el token plaintext, y el índice único
parcial PostgreSQL sobre email pendiente sigue siendo el árbitro final de dos
creaciones concurrentes. La aceptación reserva la fila con `FOR UPDATE`, cambia
el estado dentro de la transacción, crea actor y key, y enlaza `actor_id` y
`accepted_at`. Si falla cualquier paso, el rollback deja la invitación pendiente
y no deja actor/key parciales.

La key creada al aceptar usa el mismo hash y se puede usar inmediatamente para
resolver `viewer`. La segunda aceptación del token recibe `UNAUTHORIZED`.

## Seguridad operativa

No se escriben keys plaintext en logs, exportaciones ni metadata; las scripts de
validación tampoco imprimen payloads. La URL PostgreSQL solo entra por
`PRIME_BOARD_POSTGRES_URL`/secretos del entorno.

## Validación reproducible

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-actors.ts
```

La validación contra PostgreSQL efímero cubre auth positiva/negativa,
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

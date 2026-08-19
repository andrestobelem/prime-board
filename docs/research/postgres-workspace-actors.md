# Workspace y ciclo de vida de Actors en PostgreSQL

- **Ticket:** PRB-430
- **Implementación:** `apps/server/src/domain/postgres-actors.ts`

## Frontera migrada

El modo `PRIME_BOARD_PERSISTENCE=postgres` inicializa el baseline con el
migrator, crea el singleton Workspace, el Team inicial, sus workflow states, el
actor admin y su API key. `createApp` conserva un SQLite efímero solo como seam
para los dominios aún no migrados; Workspace y Actors no lo consultan ni lo
modifican.

Las operaciones GraphQL migradas son `workspace`, `workspaceUpdate`, `viewer`,
`actors`, `actorCreate`, `actorUpdate`, `actorSuspend`, `actorReactivate`,
`actorRevoke` y `actorLeave`. La lectura de `Actor.apiKeys` también cruza el
adaptador PostgreSQL. Las operaciones restantes se rechazan explícitamente con
`VALIDATION_FAILED` para no escribir accidentalmente en el SQLite de
compatibilidad; su migración corresponde a los tickets siguientes.

## Invariantes

- Se conserva el `id`, `url_key`, `created_at` y la fila única del Workspace;
  actualizar solo cambia `name` y `updated_at`.
- Los IDs de Actors no se regeneran al actualizar, suspender, reactivar o dejar;
  las referencias históricas siguen apuntando al mismo actor.
- Los checks PostgreSQL mantienen tipos, roles y estados válidos.
- Suspender o revocar el último admin activo falla dentro de una transacción.
  Revocar marca `left` y revoca sus API keys sin borrar identidad.
- El resolver obtiene la identidad y permisos desde la API key PostgreSQL. Las
  comprobaciones de scope siguen siendo las existentes y un miembro no puede
  ejecutar mutaciones de admin.
- Las operaciones de escritura usan `RETURNING`; el adaptador conserva el
  contrato `Persistence` y convierte el `count` de Bun.SQL en `rowCount`.

## Configuración

```bash
PRIME_BOARD_PERSISTENCE=postgres \
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run apps/server/src/index.ts
```

La URL se toma únicamente de la variable de entorno y nunca se imprime. En el
primer arranque se muestra la API key admin una sola vez, igual que en SQLite.
La migración del siguiente grupo (API keys, invitaciones y autenticación
administrativa completa) es PRB-431; el soporte actual conserva la key de
bootstrap y la lectura de metadata necesaria para autenticar.

## Validación

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-actors.ts
```

Contra PostgreSQL efímero se verifican GraphQL, identidad Workspace, creación,
actualización, suspensión, reactivación, revocación, self-leave y autorización
(scope admin vs. member):

```json
{
  "passed": true,
  "report": {
    "graphql": true,
    "identity": true,
    "lifecycle": true,
    "updatedWorkspace": true,
    "authorization": true
  }
}
```

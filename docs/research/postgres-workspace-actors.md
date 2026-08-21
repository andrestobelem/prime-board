# Workspace y ciclo de vida de Actors en PostgreSQL

- **Ticket:** PRB-430
- **Implementación:** `apps/server/src/domain/postgres-actors.ts`

## Frontera migrada

Con `PRIME_BOARD_PERSISTENCE=postgres`, el migrator inicializa el baseline y crea el Workspace singleton, el Team inicial, sus Workflow States, el Actor admin y su API key. `createApp` conserva un SQLite efímero como seam para los dominios aún no migrados. Workspace y Actors no lo consultan ni lo modifican.

Las operaciones GraphQL migradas son `workspace`, `workspaceUpdate`, `viewer`, `actors`, `actorCreate`, `actorUpdate`, `actorSuspend`, `actorReactivate`, `actorRevoke` y `actorLeave`. La lectura de `Actor.apiKeys` también usa el adaptador PostgreSQL. El sistema rechaza las operaciones restantes con `VALIDATION_FAILED` para no escribir en el SQLite de compatibilidad. Los tickets siguientes harán esa migración.

## Invariantes

- El sistema conserva `id`, `url_key`, `created_at` y la fila única del Workspace. Actualizar solo cambia `name` y `updated_at`.
- El sistema no regenera los IDs de Actors al actualizar, suspender, reactivar o dejar. Las referencias históricas siguen apuntando al mismo Actor.
- Los checks de PostgreSQL mantienen tipos, roles y estados válidos.
- Suspender o revocar el último admin activo falla dentro de una transacción. Revocar marca `left` y revoca sus API keys sin borrar la identidad.
- El resolver obtiene identidad y permisos desde la API key de PostgreSQL. Mantiene las comprobaciones de Scope existentes y no permite que un member ejecute mutaciones de admin.
- Las operaciones de escritura usan `RETURNING`. El adaptador conserva el contrato `Persistence` y convierte el `count` de Bun.SQL en `rowCount`.

## Configuración

```bash
PRIME_BOARD_PERSISTENCE=postgres \
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run apps/server/src/index.ts
```

El proceso toma la URL solo de la variable de entorno y nunca la imprime. En el primer arranque muestra la API key admin una sola vez, igual que SQLite.
PRB-431 cubre el siguiente grupo (API keys, invitaciones y autenticación administrativa completa). El soporte actual conserva la key de bootstrap y la metadata necesaria para autenticar.

## Validación

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-actors.ts
```

El smoke contra PostgreSQL efímero verifica GraphQL, identidad de Workspace, creación, actualización, suspensión, reactivación, revocación, self-leave y autorización (Scope admin frente a member):

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

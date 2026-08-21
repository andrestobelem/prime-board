# Teams y workflow states en PostgreSQL

- **Ticket:** PRB-432
- **Implementación:** `apps/server/src/domain/postgres-teams.ts`

## Alcance

Con el modo PostgreSQL, el sistema puede consultar Teams, crear/actualizar/archivar/restaurar y borrar Teams vacíos. También puede crear, actualizar y borrar Workflow States. Cada Team nuevo recibe el Workflow default completo y una Membership `owner` para el Actor creador. La autorización de la configuración usa esa Membership. La API de Memberships (listado, alta y baja) también se resuelve en PostgreSQL y conserva al menos un owner.

El adaptador valida `visibility` y `access_policy` con las mismas reglas que SQLite: un Team privado exige `team_members`. PostgreSQL aplica el alcance en las lecturas de Teams: los admins descubren todos, los Teams públicos son descubribles y los privados solo aparecen para Memberships activas. Las operaciones de Labels, Projects y Cycles todavía no migradas fallan explícitamente y no usan el SQLite efímero.

## Invariantes

- Archivar o restaurar conserva IDs, key, visibilidad y referencias. Un Team archivado solo se consulta con `includeArchived` y bloquea cambios operativos.
- Las keys conservan el formato y la unicidad case-insensitive mediante normalización a mayúsculas. Los nombres de Workflow States son únicos dentro de su Team.
- Cada Team conserva al menos un Workflow State y al menos uno de tipo `completed`.
- El Workflow State default siempre pertenece al Team. Al borrar el default, el sistema lo reasigna al estado indicado o al estado restante de menor posición.
- Borrar un Workflow State que tiene Issues exige `moveToStateId`. El sistema actualiza las Issues en una transacción, registra Activity `state_changed` y conserva referencias históricas como `TEAM/State`.
- Antes de borrar un Team, el sistema comprueba blockers (Issues, Projects, Cycles, Labels, Saved Views, Initiatives y allowlists). Después elimina Memberships y Workflow States.

## Validación

El smoke GraphQL compartido se ejecuta contra PostgreSQL efímero:

```bash
PRIME_BOARD_POSTGRES_URL='postgres://...' \
bun run scripts/validate-postgres-actors.ts
```

El smoke verifica la creación con Workflow, la visibilidad privada para otro Actor, el alta/listado/autorización de Memberships, el rechazo explícito de un nested resolver no migrado, la actualización de Team/default, la creación y actualización de Workflow State, el borrado de estado, el archivado/restauración y el delete con confirmación. El reporte incluye `teams: true`, auth, credentials e invitaciones.
